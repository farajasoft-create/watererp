'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, compare, formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { FiscalYear } from '@/modules/finance/ui/lib/types';
import { downloadCsv } from './report-filters';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from './ui';

type Tab = 'submissions' | 'consolidation' | 'changes' | 'balances';
const amountPattern = /^-?\d*(\.\d*)?$/;
const positive = /^\d*(\.\d*)?$/;

interface WorkplanRow { activity: string; output: string; indicator: string; target: string; quarters: number[]; cost: string }
interface SubmissionLine { accountId: string; amounts: string[] }
interface Submission {
  id: string;
  number: string;
  fiscalYearId: string;
  departmentId: string;
  title: string;
  objectives?: string;
  workplan?: WorkplanRow[];
  lines?: SubmissionLine[];
  total: string;
  status: string;
  rejectionReason?: string;
  budgetId?: string | null;
  createdBy: string;
  submittedBy?: string | null;
}
interface Consolidation {
  currency: string;
  readyToConsolidate: number;
  approvedTotal: string;
  rows: { departmentId: string; code: string; name: string; submissions: number; approvedTotal: string; latest: { id: string; number: string; title: string; status: string; total: string; budgetId: string | null } | null }[];
}
interface ChangeLine { accountId: string; departmentId: string | null; period: number; change: string }
interface Change {
  id: string;
  number: string;
  budgetId: string;
  date: string;
  kind: 'REALLOCATION' | 'SUPPLEMENTARY' | 'REDUCTION';
  reason: string;
  lines: ChangeLine[];
  increase: string;
  decrease: string;
  status: string;
  rejectionReason?: string;
  createdBy: string;
  submittedBy?: string | null;
}
interface BudgetSummary { id: string; name: string; kind: string; status: string; fiscalYearId: string; total: string; revisions?: number }
interface Balances {
  currency: string;
  budget: { id: string; name: string; revisions: number } | null;
  departments: { departmentId: string | null; department: string; annual: string; spent: string; committed: string; available: string; usedPercent: string | null }[];
  rows: { departmentId: string | null; department: string; code: string; name: string; annual: string; toDate: string; spent: string; committed: string; available: string; usedPercent: string | null }[];
}

const KIND_LABEL: Record<Change['kind'], string> = { REALLOCATION: 'Reallocation', SUPPLEMENTARY: 'Supplementary', REDUCTION: 'Reduction' };
const emptyActivity = (): WorkplanRow => ({ activity: '', output: '', indicator: '', target: '', quarters: [], cost: '' });

function useYears() {
  const { entity } = useSession();
  return useQuery({ queryKey: ['fiscal-years', entity?.id], queryFn: () => api.get<FiscalYear[]>('/fiscal-years', { entityId: entity!.id }), enabled: !!entity });
}

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

/** Asks for the reason before rejecting or cancelling. */
function ReasonModal({ title, onClose, onConfirm, pending }: { title: string | null; onClose: () => void; onConfirm: (reason: string) => void; pending: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open={!!title}
      onClose={onClose}
      title={title ?? ''}
      footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" disabled={!reason.trim()} loading={pending} onClick={() => onConfirm(reason.trim())}>Confirm</Button></>}
    >
      <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export function BudgetPlanningPage({ initialTab, openSubmission, openChange }: { initialTab?: string; openSubmission?: string; openChange?: string }) {
  const [tab, setTab] = useState<Tab>((['submissions', 'consolidation', 'changes', 'balances'] as Tab[]).includes(initialTab as Tab) ? (initialTab as Tab) : openChange ? 'changes' : 'submissions');
  const years = useYears();
  const [fiscalYearId, setFiscalYearId] = useState('');
  const fy = years.data?.find((y) => y.id === fiscalYearId) ?? years.data?.[0];
  return (
    <>
      <PageHeader
        title="Budget planning"
        description="Departments submit budgets backed by their workplans; approved submissions are consolidated into the entity budget. Once approved, the budget changes only through reallocations, supplementary budgets and reductions."
        actions={
          <>
            {tab !== 'balances' && tab !== 'changes' && (
              <Select className="w-40" value={fy?.id ?? ''} onChange={(e) => setFiscalYearId(e.target.value)} aria-label="Fiscal year">
                {years.data?.map((y) => (<option key={y.id} value={y.id}>{y.name}</option>))}
              </Select>
            )}
            <LinkButton href="/finance/budgets">Budgets</LinkButton>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'submissions', label: 'Department submissions' },
          { id: 'consolidation', label: 'Consolidation' },
          { id: 'changes', label: 'Reallocations & supplementary' },
          { id: 'balances', label: 'Department balances' },
        ]}
      />
      {years.isLoading ? <Loading /> : !fy ? <Empty title="Set up a fiscal year first" /> : null}
      {fy && tab === 'submissions' && <Submissions fy={fy} openId={openSubmission} />}
      {fy && tab === 'consolidation' && <ConsolidationTab fy={fy} />}
      {tab === 'changes' && <Changes openId={openChange} />}
      {tab === 'balances' && <BalancesTab />}
    </>
  );
}

// ----- Submissions -------------------------------------------------------------------------------

function Submissions({ fy, openId }: { fy: FiscalYear; openId?: string }) {
  const { entity, me, can } = useSession();
  const precision = usePrecision();
  const invalidate = useInvalidate();
  const { data: dimensions = [] } = useDimensions();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const departments = dimensions.filter((d) => d.type === 'DEPARTMENT' && d.isActive && (!d.entityId || d.entityId === entity?.id));
  const plAccounts = accounts.filter((a) => a.isPostable && ['REVENUE', 'COST_OF_SALES', 'EXPENSE'].includes(a.accountClass));
  const fp = precision(entity?.functionalCurrency);
  const months = fy.periods.map((p) => p.name.slice(0, 3));
  const blankLine = (): SubmissionLine => ({ accountId: '', amounts: Array(fy.periods.length).fill('') });
  const list = useQuery({ queryKey: ['budget-submissions', entity?.id, fy.id], queryFn: () => api.get<Submission[]>('/budget-submissions', { entityId: entity!.id, fiscalYearId: fy.id }), enabled: !!entity });
  const [editing, setEditing] = useState<null | { id?: string; departmentId: string; title: string; objectives: string; workplan: WorkplanRow[]; lines: SubmissionLine[] }>(null);
  const [viewing, setViewing] = useState<Submission | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? dimensions.find((d) => d.id === id)?.name ?? '';

  const load = async (id: string) => {
    setError(null);
    const s = await api.get<Submission>(`/budget-submissions/${id}`);
    if (['DRAFT', 'REJECTED'].includes(s.status) && can('budgets.manage')) {
      setEditing({ id, departmentId: s.departmentId, title: s.title, objectives: s.objectives ?? '', workplan: s.workplan?.length ? s.workplan : [emptyActivity()], lines: s.lines?.length ? s.lines : [blankLine()] });
    } else setViewing(s);
  };
  if (openId && !opened && list.data) {
    setOpened(true);
    void load(openId);
  }

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const e = editing!;
      const body = {
        entityId: entity!.id,
        fiscalYearId: fy.id,
        departmentId: e.departmentId,
        title: e.title,
        objectives: e.objectives,
        workplan: e.workplan.filter((w) => w.activity.trim()).map((w) => ({ ...w, cost: w.cost || '0' })),
        lines: e.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, amounts: l.amounts.map((a) => a || '0') })),
      };
      const saved = e.id ? await api.patch<Submission>(`/budget-submissions/${e.id}`, body) : await api.post<Submission>('/budget-submissions', body);
      setEditing({ ...e, id: saved.id });
      if (submit) await api.post(`/budget-submissions/${saved.id}/submit`);
    },
    onSuccess: () => (setEditing(null), setError(null), invalidate('budget-submissions', 'budget-consolidation')),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: string; reason?: string }) => api.post<{ approval?: unknown }>(`/budget-submissions/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: (res) => (setError(null), setRejecting(null), setViewing(null), setNote(res?.approval ? 'Approved at this step; the next approver has been notified.' : null), invalidate('budget-submissions', 'budget-consolidation')),
    onError: (err) => setError(errorMessage(err)),
  });
  const template = async () => {
    if (!editing?.departmentId) return setError('Choose the department first');
    try {
      const t = await api.get<{ source: string; lines: SubmissionLine[] }>('/budget-submissions/template', { entityId: entity!.id, fiscalYearId: fy.id, departmentId: editing.departmentId });
      if (!t.lines.length) return setError('There is no earlier approved budget for this department to start from.');
      setError(null);
      setNote(`Lines copied from ${t.source}.`);
      setEditing({ ...editing, lines: t.lines.map((l) => ({ accountId: l.accountId, amounts: l.amounts })) });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const planTotal = editing ? addAll(editing.workplan.map((w) => w.cost)) : '0';
  const linesTotal = editing ? addAll(editing.lines.flatMap((l) => l.amounts)) : '0';

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Each department prepares its budget for {fy.name} with the workplan activities it pays for. The workplan and the lines must agree before it can be submitted.</p>
        {can('budgets.manage') && (
          <Button variant="primary" onClick={() => (setError(null), setEditing({ departmentId: departments[0]?.id ?? '', title: `${fy.name} budget`, objectives: '', workplan: [emptyActivity()], lines: [blankLine()] }))}>
            New submission
          </Button>
        )}
      </div>
      {note && <div className="mb-3"><Notice tone="green">{note}</Notice></div>}
      <ErrorBanner error={!editing && !rejecting ? error : null} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No department submissions for this year" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Number</th><th>Department</th><th>Title</th><th>Status</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {list.data.map((s) => {
                const mine = s.createdBy === me.id || s.submittedBy === me.id;
                return (
                  <tr key={s.id}>
                    <td><button className="font-mono text-xs text-accent hover:underline" onClick={() => load(s.id)}>{s.number}</button></td>
                    <td>{deptName(s.departmentId)}</td>
                    <td>{s.title}</td>
                    <td>
                      <StatusBadge status={s.status === 'REJECTED' ? 'RETURNED' : s.status} />
                      {s.status === 'CONSOLIDATED' && s.budgetId && <Link className="ml-2 text-xs text-accent hover:underline" href="/finance/budgets">in budget</Link>}
                    </td>
                    <td className="num">{formatAmount(s.total, fp)}</td>
                    <td className="whitespace-nowrap text-right">
                      {['DRAFT', 'REJECTED'].includes(s.status) && can('budgets.manage') && <Button size="sm" variant="ghost" onClick={() => load(s.id)}>Edit</Button>}
                      {s.status === 'SUBMITTED' && can('budgets.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => (setError(null), setRejecting(s.id))}>Return</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'You prepared or submitted this' : undefined} loading={act.isPending && act.variables?.id === s.id} onClick={() => act.mutate({ id: s.id, action: 'approve' })}>Approve</Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <ReasonModal key={rejecting ?? 'none'} title={rejecting ? 'Return the submission to the department' : null} onClose={() => setRejecting(null)} pending={act.isPending} onConfirm={(reason) => act.mutate({ id: rejecting!, action: 'reject', reason })} />

      <Modal wide open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `${viewing.number} · ${deptName(viewing.departmentId)}` : ''}>
        {viewing && (
          <div className="space-y-3 text-sm">
            <p><StatusBadge status={viewing.status} /> <span className="ml-2 font-medium">{viewing.title}</span></p>
            {viewing.objectives && <p className="whitespace-pre-wrap text-muted">{viewing.objectives}</p>}
            <WorkplanTable rows={viewing.workplan ?? []} fp={fp} />
            <TableWrap>
              <table className="table-base">
                <thead><tr><th>Account</th>{months.map((m, i) => (<th key={i} className="num">{m}</th>))}<th className="num">Year</th></tr></thead>
                <tbody>
                  {(viewing.lines ?? []).map((l, i) => {
                    const a = accounts.find((x) => x.id === l.accountId);
                    return (
                      <tr key={i}>
                        <td className="whitespace-nowrap">{a ? `${a.code} · ${a.name}` : ''}</td>
                        {l.amounts.map((v, j) => (<td key={j} className="num text-xs">{formatAmount(v, fp)}</td>))}
                        <td className="num text-xs font-medium">{formatAmount(addAll(l.amounts), fp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
      </Modal>

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit department budget' : 'New department budget'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>}
      >
        {editing && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Department">
                <Select value={editing.departmentId} onChange={(e) => setEditing({ ...editing, departmentId: e.target.value })}>
                  <option value="">Select…</option>
                  {departments.map((d) => (<option key={d.id} value={d.id}>{d.code} · {d.name}</option>))}
                </Select>
              </Field>
              <Field label="Title" className="sm:col-span-2"><Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            </div>
            <Field label="Objectives"><Textarea rows={2} value={editing.objectives} onChange={(e) => setEditing({ ...editing, objectives: e.target.value })} /></Field>

            <div>
              <h3 className="mb-2 text-sm font-semibold">Workplan</h3>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th className="min-w-48">Activity</th><th>Output</th><th>Indicator</th><th>Target</th><th>Quarters</th><th className="num">Cost</th><th /></tr></thead>
                  <tbody>
                    {editing.workplan.map((w, i) => {
                      const set = (p: Partial<WorkplanRow>) => setEditing({ ...editing, workplan: editing.workplan.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                      return (
                        <tr key={i}>
                          <td><Input className="h-8 text-xs" value={w.activity} onChange={(e) => set({ activity: e.target.value })} aria-label="Activity" /></td>
                          <td><Input className="h-8 text-xs" value={w.output} onChange={(e) => set({ output: e.target.value })} aria-label="Output" /></td>
                          <td><Input className="h-8 text-xs" value={w.indicator} onChange={(e) => set({ indicator: e.target.value })} aria-label="Indicator" /></td>
                          <td><Input className="h-8 w-20 text-xs" value={w.target} onChange={(e) => set({ target: e.target.value })} aria-label="Target" /></td>
                          <td className="whitespace-nowrap">
                            {[1, 2, 3, 4].map((q) => (
                              <label key={q} className="mr-1 inline-flex items-center gap-0.5 text-xs">
                                <input type="checkbox" checked={w.quarters.includes(q)} onChange={(e) => set({ quarters: e.target.checked ? [...w.quarters, q].sort() : w.quarters.filter((x) => x !== q) })} />Q{q}
                              </label>
                            ))}
                          </td>
                          <td><Input className="h-8 w-28 text-right text-xs" inputMode="decimal" value={w.cost} onChange={(e) => positive.test(e.target.value) && set({ cost: e.target.value })} aria-label="Cost" /></td>
                          <td><Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, workplan: editing.workplan.filter((_, j) => j !== i) })} aria-label="Remove activity">×</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Button size="sm" className="mt-2" onClick={() => setEditing({ ...editing, workplan: [...editing.workplan, emptyActivity()] })}>Add activity</Button>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Budget lines</h3>
                <Button size="sm" onClick={template}>Start from the last approved budget</Button>
              </div>
              <div className="max-h-[40vh] overflow-auto">
                <table className="table-base">
                  <thead><tr><th className="min-w-52">Account</th>{months.map((m, i) => (<th key={i} className="num">{m}</th>))}<th className="num">Year</th><th /></tr></thead>
                  <tbody>
                    {editing.lines.map((l, i) => {
                      const set = (p: Partial<SubmissionLine>) => setEditing({ ...editing, lines: editing.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                      return (
                        <tr key={i}>
                          <td>
                            <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
                              <option value="">Select…</option>
                              {plAccounts.map((a) => (<option key={a.id} value={a.id}>{a.code} · {a.name}</option>))}
                            </Select>
                          </td>
                          {months.map((_, m) => (
                            <td key={m}>
                              <Input className="h-8 w-24 text-right text-xs" inputMode="decimal" value={l.amounts[m] ?? ''} onChange={(e) => positive.test(e.target.value) && set({ amounts: l.amounts.map((x, k) => (k === m ? e.target.value : x)) })} aria-label={`${months[m]} amount`} />
                            </td>
                          ))}
                          <td className="num text-xs">{formatAmount(addAll(l.amounts), fp)}</td>
                          <td><Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, lines: editing.lines.filter((_, j) => j !== i) })} aria-label="Remove line">×</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Button size="sm" className="mt-2" onClick={() => setEditing({ ...editing, lines: [...editing.lines, blankLine()] })}>Add line</Button>
            </div>
            <p className={cx('text-sm', compare(planTotal, linesTotal) === 0 ? 'text-muted' : 'text-amber-700')}>
              Workplan {formatAmount(planTotal, fp)} · budget lines {formatAmount(linesTotal, fp)}
              {compare(planTotal, linesTotal) !== 0 && ' — these must agree before you submit'}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}

function WorkplanTable({ rows, fp }: { rows: WorkplanRow[]; fp: number }) {
  if (!rows.length) return <p className="text-muted">No workplan activities.</p>;
  return (
    <TableWrap>
      <table className="table-base">
        <thead><tr><th>Activity</th><th>Output</th><th>Indicator</th><th>Target</th><th>Quarters</th><th className="num">Cost</th></tr></thead>
        <tbody>
          {rows.map((w, i) => (
            <tr key={i}>
              <td>{w.activity}</td>
              <td>{w.output}</td>
              <td>{w.indicator}</td>
              <td>{w.target}</td>
              <td>{w.quarters.map((q) => `Q${q}`).join(', ')}</td>
              <td className="num">{formatAmount(w.cost, fp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ----- Consolidation -----------------------------------------------------------------------------

function ConsolidationTab({ fy }: { fy: FiscalYear }) {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const invalidate = useInvalidate();
  const fp = precision(entity?.functionalCurrency);
  const [name, setName] = useState(`${fy.name} approved estimates`);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const data = useQuery({ queryKey: ['budget-consolidation', entity?.id, fy.id], queryFn: () => api.get<Consolidation>('/budget-submissions/consolidation', { entityId: entity!.id, fiscalYearId: fy.id }), enabled: !!entity });
  const consolidate = useMutation({
    mutationFn: () => api.post<{ id: string; total: string }>('/budget-submissions/consolidate', { entityId: entity!.id, fiscalYearId: fy.id, name }),
    onSuccess: (b) => (setError(null), setDone(`Draft budget “${name}” created for ${formatAmount(b.total, fp)}. Submit it for approval on the Budgets page.`), invalidate('budget-consolidation', 'budget-submissions', 'budgets')),
    onError: (err) => setError(errorMessage(err)),
  });
  const d = data.data;
  return (
    <div className="space-y-3">
      <ErrorBanner error={error} />
      {done && <Notice tone="green">{done} <Link className="underline" href="/finance/budgets">Open budgets</Link></Notice>}
      {can('budgets.manage') && d && (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Consolidated budget name" className="min-w-72 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button variant="primary" disabled={!d.readyToConsolidate || !name.trim()} loading={consolidate.isPending} onClick={() => consolidate.mutate()}>
              Consolidate {d.readyToConsolidate} approved ({formatAmount(d.approvedTotal, fp)})
            </Button>
          </div>
        </Card>
      )}
      <TableWrap>
        {!d ? (
          <Loading />
        ) : !d.rows.length ? (
          <Empty title="No departments set up">Add departments under Setup → Structure → Dimensions.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Department</th><th>Latest submission</th><th>Status</th><th className="num">Submitted total</th><th className="num">Approved, not yet consolidated</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.departmentId}>
                  <td className="font-medium">{r.code} · {r.name}</td>
                  <td>{r.latest ? <span className="font-mono text-xs">{r.latest.number}</span> : <span className="text-muted">None yet</span>}</td>
                  <td>{r.latest ? <StatusBadge status={r.latest.status === 'REJECTED' ? 'RETURNED' : r.latest.status} /> : <Badge tone="amber">Missing</Badge>}</td>
                  <td className="num">{r.latest ? formatAmount(r.latest.total, fp) : ''}</td>
                  <td className="num">{formatAmount(r.approvedTotal, fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </div>
  );
}

// ----- Reallocations & supplementary -------------------------------------------------------------

function Changes({ openId }: { openId?: string }) {
  const { entity, me, can } = useSession();
  const precision = usePrecision();
  const invalidate = useInvalidate();
  const years = useYears();
  const { data: dimensions = [] } = useDimensions();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const fp = precision(entity?.functionalCurrency);
  const departments = dimensions.filter((d) => d.type === 'DEPARTMENT' && (!d.entityId || d.entityId === entity?.id));
  const plAccounts = accounts.filter((a) => a.isPostable && ['REVENUE', 'COST_OF_SALES', 'EXPENSE'].includes(a.accountClass));
  const budgets = useQuery({ queryKey: ['budgets', entity?.id], queryFn: () => api.get<BudgetSummary[]>('/budgets', { entityId: entity!.id }), enabled: !!entity });
  const approved = (budgets.data ?? []).filter((b) => b.status === 'APPROVED');
  const list = useQuery({ queryKey: ['budget-changes', entity?.id], queryFn: () => api.get<Change[]>('/budget-changes', { entityId: entity!.id }), enabled: !!entity });
  const [editing, setEditing] = useState<null | { id?: string; budgetId: string; date: string; kind: Change['kind']; reason: string; lines: ChangeLine[] }>(null);
  const [reasonFor, setReasonFor] = useState<null | { id: string; action: 'reject' | 'cancel' }>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const budgetOf = (id: string) => budgets.data?.find((b) => b.id === id);
  const periodsOf = (budgetId: string) => years.data?.find((y) => y.id === budgetOf(budgetId)?.fiscalYearId)?.periods ?? [];
  const blank = (): ChangeLine => ({ accountId: '', departmentId: null, period: 0, change: '' });

  const open = (c?: Change) => {
    setError(null);
    if (!c) return setEditing({ budgetId: approved[0]?.id ?? '', date: today(), kind: 'REALLOCATION', reason: '', lines: [blank(), blank()] });
    setEditing({ id: c.id, budgetId: c.budgetId, date: c.date.slice(0, 10), kind: c.kind, reason: c.reason, lines: c.lines.map((l) => ({ ...l, departmentId: l.departmentId ?? null })) });
  };
  if (openId && !opened && list.data) {
    setOpened(true);
    const c = list.data.find((x) => x.id === openId);
    if (c && ['DRAFT', 'REJECTED'].includes(c.status) && can('budgets.manage')) open(c);
  }

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const e = editing!;
      const body = { budgetId: e.budgetId, date: e.date, kind: e.kind, reason: e.reason, lines: e.lines.filter((l) => l.accountId && l.change).map((l) => ({ ...l, departmentId: l.departmentId || null })) };
      const saved = e.id ? await api.patch<Change>(`/budget-changes/${e.id}`, body) : await api.post<Change>('/budget-changes', body);
      setEditing({ ...e, id: saved.id });
      if (submit) await api.post(`/budget-changes/${saved.id}/submit`);
    },
    onSuccess: () => (setEditing(null), setError(null), invalidate('budget-changes')),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: string; reason?: string }) => api.post(`/budget-changes/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: () => (setError(null), setReasonFor(null), invalidate('budget-changes', 'budgets', 'budget-balances')),
    onError: (err) => setError(errorMessage(err)),
  });

  const net = editing ? addAll(editing.lines.map((l) => l.change)) : '0';
  const months = editing ? periodsOf(editing.budgetId) : [];

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted">A reallocation moves budget between lines and must net to zero. Supplementary budgets add; reductions take away. Money already spent or committed on a line cannot be moved off it.</p>
        {can('budgets.manage') && <Button variant="primary" disabled={!approved.length} title={approved.length ? undefined : 'Approve a budget first'} onClick={() => open()}>New change</Button>}
      </div>
      <ErrorBanner error={!editing && !reasonFor ? error : null} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No budget changes yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Budget</th><th>Reason</th><th>Status</th><th className="num">Added</th><th className="num">Taken</th><th /></tr></thead>
            <tbody>
              {list.data.map((c) => {
                const mine = c.createdBy === me.id || c.submittedBy === me.id;
                return (
                  <tr key={c.id} className={cx(c.id === openId && 'bg-accent/5')}>
                    <td className="font-mono text-xs">{c.number}</td>
                    <td>{formatDate(c.date)}</td>
                    <td>{KIND_LABEL[c.kind]}</td>
                    <td>{budgetOf(c.budgetId)?.name}</td>
                    <td className="max-w-64 truncate" title={c.reason}>{c.reason}</td>
                    <td><StatusBadge status={c.status === 'REJECTED' ? 'RETURNED' : c.status} /></td>
                    <td className="num">{formatAmount(c.increase, fp)}</td>
                    <td className="num">{formatAmount(c.decrease, fp)}</td>
                    <td className="whitespace-nowrap text-right">
                      {['DRAFT', 'REJECTED'].includes(c.status) && can('budgets.manage') && <Button size="sm" variant="ghost" onClick={() => open(c)}>Edit</Button>}
                      {['DRAFT', 'REJECTED', 'SUBMITTED'].includes(c.status) && can('budgets.manage') && <Button size="sm" variant="ghost" onClick={() => setReasonFor({ id: c.id, action: 'cancel' })}>Cancel</Button>}
                      {c.status === 'SUBMITTED' && can('budgets.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setReasonFor({ id: c.id, action: 'reject' })}>Return</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'You prepared or submitted this' : undefined} loading={act.isPending && act.variables?.id === c.id} onClick={() => act.mutate({ id: c.id, action: 'approve' })}>Approve</Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <ReasonModal
        key={reasonFor ? `${reasonFor.id}${reasonFor.action}` : 'none'}
        title={reasonFor ? (reasonFor.action === 'reject' ? 'Return the change' : 'Cancel the change') : null}
        onClose={() => setReasonFor(null)}
        pending={act.isPending}
        onConfirm={(reason) => act.mutate({ id: reasonFor!.id, action: reasonFor!.action, reason })}
      />

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit budget change' : 'New budget change'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>}
      >
        {editing && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Budget" className="sm:col-span-2">
                <Select value={editing.budgetId} onChange={(e) => setEditing({ ...editing, budgetId: e.target.value })}>
                  {approved.map((b) => (<option key={b.id} value={b.id}>{b.name}{b.kind === 'FORECAST' ? ' (forecast)' : ''}</option>))}
                </Select>
              </Field>
              <Field label="Type">
                <Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Change['kind'] })}>
                  {(Object.keys(KIND_LABEL) as Change['kind'][]).map((k) => (<option key={k} value={k}>{KIND_LABEL[k]}</option>))}
                </Select>
              </Field>
              <Field label="Date"><Input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></Field>
            </div>
            <Field label="Reason"><Textarea rows={2} value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} /></Field>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th className="min-w-52">Account</th><th>Department</th><th>Period</th><th className="num">{editing.kind === 'REALLOCATION' ? 'Change (− takes, + adds)' : editing.kind === 'REDUCTION' ? 'Reduce by' : 'Add'}</th><th /></tr></thead>
                <tbody>
                  {editing.lines.map((l, i) => {
                    const set = (p: Partial<ChangeLine>) => setEditing({ ...editing, lines: editing.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    const shown = editing.kind === 'REDUCTION' ? l.change.replace(/^-/, '') : l.change;
                    return (
                      <tr key={i}>
                        <td>
                          <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
                            <option value="">Select…</option>
                            {plAccounts.map((a) => (<option key={a.id} value={a.id}>{a.code} · {a.name}</option>))}
                          </Select>
                        </td>
                        <td>
                          <Select className="h-8 text-xs" value={l.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value || null })} aria-label="Department">
                            <option value="">None</option>
                            {departments.map((d) => (<option key={d.id} value={d.id}>{d.code} · {d.name}</option>))}
                          </Select>
                        </td>
                        <td>
                          <Select className="h-8 text-xs" value={l.period} onChange={(e) => set({ period: Number(e.target.value) })} aria-label="Period">
                            {months.map((p, k) => (<option key={p.id} value={k}>{p.name}</option>))}
                          </Select>
                        </td>
                        <td>
                          <Input
                            className="h-8 w-32 text-right text-xs"
                            inputMode="decimal"
                            value={shown}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (editing.kind === 'REALLOCATION' ? amountPattern.test(v) : positive.test(v)) set({ change: editing.kind === 'REDUCTION' && v ? `-${v}` : v });
                            }}
                            aria-label="Amount"
                          />
                        </td>
                        <td><Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, lines: editing.lines.filter((_, j) => j !== i) })} aria-label="Remove line">×</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button size="sm" onClick={() => setEditing({ ...editing, lines: [...editing.lines, blank()] })}>Add line</Button>
              {editing.kind === 'REALLOCATION' && (
                <p className={cx('text-sm', compare(net, '0') === 0 ? 'text-muted' : 'text-amber-700')}>Net {formatAmount(net, fp)}{compare(net, '0') !== 0 && ' — a reallocation must net to zero'}</p>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ----- Balances ----------------------------------------------------------------------------------

function BalancesTab() {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: dimensions = [] } = useDimensions();
  const fp = precision(entity?.functionalCurrency);
  const [asOf, setAsOf] = useState(today());
  const [departmentId, setDepartmentId] = useState('');
  const [nearOnly, setNearOnly] = useState(false);
  const data = useQuery({
    queryKey: ['budget-balances', entity?.id, asOf, departmentId],
    queryFn: () => api.get<Balances>('/budget-balances', { entityId: entity!.id, asOf, departmentId: departmentId || undefined }),
    enabled: !!entity,
  });
  const d = data.data;
  const pct = (v: string | null) => (v === null ? '—' : `${v}%`);
  const tone = (v: string | null) => (v === null ? '' : Number(v) >= 100 ? 'text-red-700 font-semibold' : Number(v) >= 80 ? 'text-amber-700' : '');
  const rows = (d?.rows ?? []).filter((r) => !nearOnly || (r.usedPercent !== null && Number(r.usedPercent) >= 80));
  return (
    <div className="space-y-3">
      <div className="no-print flex flex-wrap items-end gap-2">
        <Field label="As of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label="Department">
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">All</option>
            {dimensions.filter((x) => x.type === 'DEPARTMENT').map((x) => (<option key={x.id} value={x.id}>{x.code} · {x.name}</option>))}
          </Select>
        </Field>
        <Checkbox label="Only lines 80% or more used" checked={nearOnly} onChange={setNearOnly} />
        <Button onClick={() => window.print()}>Print</Button>
        {d && (
          <Button onClick={() => downloadCsv(`budget-balances-${asOf}.csv`, ['Department', 'Account', 'Name', 'Annual budget', 'Budget to date', 'Spent', 'Committed', 'Available', 'Used %'], rows.map((r) => [r.department, r.code, r.name, r.annual, r.toDate, r.spent, r.committed, r.available, r.usedPercent]))}>
            Export CSV
          </Button>
        )}
      </div>
      <ErrorBanner error={data.error} />
      {!d ? (
        <Loading />
      ) : !d.budget ? (
        <Empty title="No approved budget for this date" />
      ) : (
        <>
          <p className="text-sm text-muted">{d.budget.name}{d.budget.revisions ? ` · revised ${d.budget.revisions} time${d.budget.revisions === 1 ? '' : 's'}` : ''} · {d.currency}</p>
          <TableWrap>
            <table className="table-base">
              <thead><tr><th>Department</th><th className="num">Budget</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Available</th><th className="num">Used</th></tr></thead>
              <tbody>
                {d.departments.map((x) => (
                  <tr key={String(x.departmentId)}>
                    <td className="font-medium">{x.department}</td>
                    <td className="num">{formatAmount(x.annual, fp)}</td>
                    <td className="num">{formatAmount(x.spent, fp)}</td>
                    <td className="num">{formatAmount(x.committed, fp)}</td>
                    <td className="num">{formatAmount(x.available, fp, { parens: true })}</td>
                    <td className={cx('num', tone(x.usedPercent))}>{pct(x.usedPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <TableWrap>
            <table className="table-base">
              <thead><tr><th>Department</th><th>Account</th><th className="num">Annual budget</th><th className="num">Budget to date</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Available</th><th className="num">Used</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.department}</td>
                    <td className="whitespace-nowrap">{r.code} · {r.name}</td>
                    <td className="num">{formatAmount(r.annual, fp)}</td>
                    <td className="num">{formatAmount(r.toDate, fp)}</td>
                    <td className="num">{formatAmount(r.spent, fp)}</td>
                    <td className="num">{formatAmount(r.committed, fp)}</td>
                    <td className="num">{formatAmount(r.available, fp, { parens: true })}</td>
                    <td className={cx('num', tone(r.usedPercent))}>{pct(r.usedPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
