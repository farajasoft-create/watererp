'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, formatAmount } from '@/modules/finance/ui/lib/format';
import { useAccounts, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { FiscalYear } from '@/modules/finance/ui/lib/types';
import { downloadCsv } from '../report-filters';
import { Badge, Button, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from '../ui';
import { AccountOptions } from './shared';

const CATEGORIES = [['GOODS', 'Goods'], ['WORKS', 'Works'], ['SERVICES', 'Services'], ['CONSULTANCY', 'Consultancy']] as const;
const METHODS = [
  ['OPEN_TENDER', 'Open tender'],
  ['RESTRICTED_TENDER', 'Restricted tender'],
  ['REQUEST_FOR_QUOTATION', 'Request for quotation'],
  ['REQUEST_FOR_PROPOSAL', 'Request for proposal'],
  ['DIRECT', 'Direct procurement'],
  ['LOW_VALUE', 'Low-value procurement'],
  ['FRAMEWORK', 'Framework agreement'],
  ['SPECIALLY_PERMITTED', 'Specially permitted'],
] as const;
const label = (list: readonly (readonly [string, string])[], k: string) => list.find(([x]) => x === k)?.[1] ?? k;
const decimal = /^\d*(\.\d*)?$/;

interface Item { id?: string; description: string; category: string; method: string; departmentId: string; accountId: string; quantity: string; unit: string; estimatedCost: string; quarter: number; sourceOfFunds: string; agpo: boolean }
interface Plan {
  id: string;
  number: string;
  fiscalYearId: string;
  title: string;
  notes?: string;
  version: number;
  revisionOf: string | null;
  items?: (Omit<Item, 'departmentId'> & { id: string; itemNo: number; departmentId: string | null })[];
  total: string;
  status: string;
  rejectionReason?: string;
  createdBy: string;
  submittedBy?: string | null;
  budgetCheck?: { budgetName: string | null; ok: boolean; rows: { code: string; name: string; departmentId: string | null; planned: string; budget: string | null; over: boolean }[] };
}
interface Execution {
  rows: { id: string; itemNo: number; description: string; category: string; method: string; quarter: number; departmentId: string | null; agpo: boolean; planned: string; requisitioned: string; ordered: string; left: string; requisitions: string[]; orders: string[]; status: string }[];
  totals: { planned: string; requisitioned: string; ordered: string; agpo: string; agpoPercent: string | null };
}
const blankItem = (): Item => ({ description: '', category: 'GOODS', method: 'REQUEST_FOR_QUOTATION', departmentId: '', accountId: '', quantity: '1', unit: '', estimatedCost: '', quarter: 1, sourceOfFunds: '', agpo: false });
const EXEC_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { COMPLETE: 'green', IN_PROGRESS: 'amber', BEHIND: 'red', NOT_STARTED: 'gray' };

export function ProcurementPlanPage() {
  const { entity, me, can } = useSession();
  const precision = usePrecision();
  const qc = useQueryClient();
  const fp = precision(entity?.functionalCurrency);
  const { data: accounts = [] } = useAccounts(entity?.id);
  const { data: dimensions = [] } = useDimensions();
  const departments = dimensions.filter((d) => d.type === 'DEPARTMENT' && d.isActive);
  const deptName = (id: string | null) => (id ? (departments.find((d) => d.id === id)?.name ?? '') : '');
  const years = useQuery({ queryKey: ['fiscal-years', entity?.id], queryFn: () => api.get<FiscalYear[]>('/fiscal-years', { entityId: entity!.id }), enabled: !!entity });
  const [yearId, setYearId] = useState('');
  const fy = years.data?.find((y) => y.id === yearId) ?? years.data?.[0];
  const list = useQuery({ queryKey: ['procurement-plans', entity?.id, fy?.id], queryFn: () => api.get<Plan[]>('/procurement-plans', { entityId: entity!.id, fiscalYearId: fy!.id }), enabled: !!fy });
  const current = list.data?.find((p) => p.status === 'APPROVED');
  const [selected, setSelected] = useState<string | null>(null);
  const shownId = selected ?? current?.id ?? list.data?.[0]?.id ?? null;
  const shown = useQuery({ queryKey: ['procurement-plan', shownId], queryFn: () => api.get<Plan>(`/procurement-plans/${shownId}`), enabled: !!shownId });
  const exec = useQuery({ queryKey: ['procurement-plan-exec', shownId], queryFn: () => api.get<Execution>(`/procurement-plans/${shownId}/execution`), enabled: !!shownId });
  const [tab, setTab] = useState<'plan' | 'execution'>('plan');
  const [editing, setEditing] = useState<null | { id?: string; title: string; notes: string; items: Item[] }>(null);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => ['procurement-plans', 'procurement-plan', 'procurement-plan-exec'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const p = shown.data;
  const mine = !!p && (p.createdBy === me.id || p.submittedBy === me.id);

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const e = editing!;
      const body = { entityId: entity!.id, fiscalYearId: fy!.id, title: e.title, notes: e.notes, items: e.items.filter((i) => i.description.trim()).map((i) => ({ ...i, id: i.id || null, departmentId: i.departmentId || null })) };
      const saved = e.id ? await api.patch<Plan>(`/procurement-plans/${e.id}`, body) : await api.post<Plan>('/procurement-plans', body);
      setEditing({ ...e, id: saved.id });
      setSelected(saved.id);
      if (submit) await api.post(`/procurement-plans/${saved.id}/submit`);
    },
    onSuccess: () => (setEditing(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: async ({ action, r }: { action: string; r?: string }) => {
      const res = await api.post<Plan>(`/procurement-plans/${p!.id}/${action}`, r ? { reason: r } : {});
      if (action === 'revise') setSelected(res.id);
    },
    onSuccess: () => (setError(null), setReturning(false), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const edit = (plan: Plan) =>
    setEditing({ id: plan.id, title: plan.title, notes: plan.notes ?? '', items: (plan.items ?? []).map((i) => ({ ...i, departmentId: i.departmentId ?? '', unit: i.unit ?? '', sourceOfFunds: i.sourceOfFunds ?? '' })) });

  return (
    <>
      <PageHeader
        title="Annual procurement plan"
        description="What each department will procure in the year, by category, method and quarter. The plan must fit the approved budget; requisitions then draw on its items."
        actions={
          <>
            <Select className="w-40" value={fy?.id ?? ''} onChange={(e) => (setYearId(e.target.value), setSelected(null))} aria-label="Fiscal year">
              {years.data?.map((y) => (<option key={y.id} value={y.id}>{y.name}</option>))}
            </Select>
            {can('procurement.manage') && fy && !list.data?.length && <Button variant="primary" onClick={() => (setError(null), setEditing({ title: `${fy.name} procurement plan`, notes: '', items: [blankItem()] }))}>New plan</Button>}
          </>
        }
      />
      <ErrorBanner error={!editing && !returning ? error : null} className="mb-3" />
      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <Empty title="No procurement plan for this year" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Versions:</span>
            {list.data.map((v) => (
              <button key={v.id} onClick={() => setSelected(v.id)} className={cx('rounded border px-2 py-0.5', v.id === shownId ? 'border-brand-600 bg-brand-50' : 'border-line')}>
                {v.number} v{v.version} · <span className="text-xs">{v.status.toLowerCase()}</span>
              </button>
            ))}
          </div>
          {p && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{p.title} <StatusBadge status={p.status === 'REJECTED' ? 'RETURNED' : p.status} /></p>
                <p className="text-sm text-muted">{formatAmount(p.total, fp)} · {p.items?.length ?? 0} items{p.status === 'REJECTED' && p.rejectionReason ? ` · returned: ${p.rejectionReason}` : ''}</p>
              </div>
              <div className="flex gap-2">
                {['DRAFT', 'REJECTED'].includes(p.status) && can('procurement.manage') && <Button onClick={() => edit(p)}>Edit</Button>}
                {['DRAFT', 'REJECTED'].includes(p.status) && can('procurement.manage') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'submit' })}>Submit</Button>}
                {p.status === 'SUBMITTED' && can('procurement.approve') && (
                  <>
                    <Button onClick={() => (setReason(''), setReturning(true))}>Return</Button>
                    <Button variant="primary" disabled={mine} title={mine ? 'You prepared or submitted this plan' : undefined} loading={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>Approve</Button>
                  </>
                )}
                {p.status === 'APPROVED' && can('procurement.manage') && <Button loading={act.isPending} onClick={() => act.mutate({ action: 'revise' })}>Revise plan</Button>}
              </div>
            </div>
          )}
          {p?.budgetCheck && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(p.status) && (
            <div className="mb-3">
              {!p.budgetCheck.budgetName ? (
                <Notice tone="amber">There is no approved budget for this year yet; the plan cannot be submitted until there is.</Notice>
              ) : p.budgetCheck.ok ? (
                <Notice tone="green">Within the approved budget “{p.budgetCheck.budgetName}”.</Notice>
              ) : (
                <Notice tone="amber">
                  Over the approved budget on:{' '}
                  {p.budgetCheck.rows.filter((r) => r.over).map((r) => `${r.code} ${deptName(r.departmentId)} (${formatAmount(r.planned, fp)} planned, ${formatAmount(r.budget, fp)} budgeted)`).join('; ')}
                </Notice>
              )}
            </div>
          )}
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'plan', label: 'Plan' }, { id: 'execution', label: 'Execution' }]} />
          {tab === 'plan' && p && (
            <TableWrap>
              <table className="table-base">
                <thead><tr><th>#</th><th>Item</th><th>Category</th><th>Method</th><th>Department</th><th>Quarter</th><th className="num">Qty</th><th className="num">Estimated cost</th><th>Funds</th><th>AGPO</th></tr></thead>
                <tbody>
                  {(p.items ?? []).map((i) => (
                    <tr key={i.id}>
                      <td>{i.itemNo}</td>
                      <td>{i.description}</td>
                      <td>{label(CATEGORIES, i.category)}</td>
                      <td>{label(METHODS, i.method)}</td>
                      <td>{deptName(i.departmentId)}</td>
                      <td>Q{i.quarter}</td>
                      <td className="num">{i.quantity} {i.unit}</td>
                      <td className="num">{formatAmount(i.estimatedCost, fp)}</td>
                      <td>{i.sourceOfFunds}</td>
                      <td>{i.agpo ? 'Yes' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {tab === 'execution' && (
            <>
              {exec.data && (
                <div className="mb-2 flex items-center justify-between text-sm">
                  <p className="text-muted">
                    Planned {formatAmount(exec.data.totals.planned, fp)} · requisitioned {formatAmount(exec.data.totals.requisitioned, fp)} · ordered {formatAmount(exec.data.totals.ordered, fp)} · reserved for AGPO {formatAmount(exec.data.totals.agpo, fp)}
                    {exec.data.totals.agpoPercent !== null && ` (${exec.data.totals.agpoPercent}%)`}
                  </p>
                  <Button size="sm" onClick={() => downloadCsv(`procurement-plan-execution-${p?.number}.csv`, ['#', 'Item', 'Category', 'Method', 'Department', 'Quarter', 'Planned', 'Requisitioned', 'Ordered', 'Left', 'Status', 'Requisitions', 'Orders'], exec.data!.rows.map((r) => [r.itemNo, r.description, r.category, r.method, deptName(r.departmentId), r.quarter, r.planned, r.requisitioned, r.ordered, r.left, r.status, r.requisitions.join(' '), r.orders.join(' ')]))}>
                    Export CSV
                  </Button>
                </div>
              )}
              <TableWrap>
                {!exec.data ? (
                  <Loading />
                ) : (
                  <table className="table-base">
                    <thead><tr><th>#</th><th>Item</th><th>Quarter</th><th className="num">Planned</th><th className="num">Requisitioned</th><th className="num">Ordered</th><th className="num">Left</th><th>Status</th><th>Documents</th></tr></thead>
                    <tbody>
                      {exec.data.rows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.itemNo}</td>
                          <td>{r.description}<div className="text-xs text-muted">{label(METHODS, r.method)}{r.departmentId ? ` · ${deptName(r.departmentId)}` : ''}</div></td>
                          <td>Q{r.quarter}</td>
                          <td className="num">{formatAmount(r.planned, fp)}</td>
                          <td className="num">{formatAmount(r.requisitioned, fp)}</td>
                          <td className="num">{formatAmount(r.ordered, fp)}</td>
                          <td className="num">{formatAmount(r.left, fp)}</td>
                          <td><Badge tone={EXEC_TONE[r.status]}>{r.status === 'BEHIND' ? 'Behind schedule' : r.status.charAt(0) + r.status.slice(1).toLowerCase().replace('_', ' ')}</Badge></td>
                          <td className="text-xs">{[...r.requisitions, ...r.orders].join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </TableWrap>
            </>
          )}
        </>
      )}

      <Modal open={returning} onClose={() => setReturning(false)} title="Return the plan" footer={<><Button onClick={() => setReturning(false)}>Back</Button><Button variant="primary" disabled={!reason.trim()} loading={act.isPending} onClick={() => act.mutate({ action: 'reject', r: reason.trim() })}>Return</Button></>}>
        <ErrorBanner error={returning ? error : null} />
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit procurement plan' : 'New procurement plan'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>}
      >
        {editing && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <Field label="Title"><Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            <div className="max-h-[55vh] overflow-auto">
              <table className="table-base">
                <thead><tr><th className="min-w-52">Item</th><th>Category</th><th>Method</th><th>Department</th><th className="min-w-44">Account</th><th className="num">Qty</th><th>Unit</th><th className="num">Est. cost</th><th>Quarter</th><th>Funds</th><th>AGPO</th><th /></tr></thead>
                <tbody>
                  {editing.items.map((it, n) => {
                    const set = (patch: Partial<Item>) => setEditing({ ...editing, items: editing.items.map((x, j) => (j === n ? { ...x, ...patch } : x)) });
                    return (
                      <tr key={it.id ?? `new${n}`}>
                        <td><Input className="h-8 text-xs" value={it.description} onChange={(e) => set({ description: e.target.value })} aria-label="Item" /></td>
                        <td><Select className="h-8 text-xs" value={it.category} onChange={(e) => set({ category: e.target.value })} aria-label="Category">{CATEGORIES.map(([k, l]) => (<option key={k} value={k}>{l}</option>))}</Select></td>
                        <td><Select className="h-8 text-xs" value={it.method} onChange={(e) => set({ method: e.target.value })} aria-label="Method">{METHODS.map(([k, l]) => (<option key={k} value={k}>{l}</option>))}</Select></td>
                        <td>
                          <Select className="h-8 text-xs" value={it.departmentId} onChange={(e) => set({ departmentId: e.target.value })} aria-label="Department">
                            <option value="">—</option>
                            {departments.map((d) => (<option key={d.id} value={d.id}>{d.code}</option>))}
                          </Select>
                        </td>
                        <td><Select className="h-8 text-xs" value={it.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account"><AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES', 'ASSET']} /></Select></td>
                        <td><Input className="h-8 w-16 text-right text-xs" value={it.quantity} onChange={(e) => decimal.test(e.target.value) && set({ quantity: e.target.value })} aria-label="Quantity" /></td>
                        <td><Input className="h-8 w-16 text-xs" value={it.unit} onChange={(e) => set({ unit: e.target.value })} aria-label="Unit" /></td>
                        <td><Input className="h-8 w-28 text-right text-xs" value={it.estimatedCost} onChange={(e) => decimal.test(e.target.value) && set({ estimatedCost: e.target.value })} aria-label="Estimated cost" /></td>
                        <td><Select className="h-8 text-xs" value={it.quarter} onChange={(e) => set({ quarter: Number(e.target.value) })} aria-label="Quarter">{[1, 2, 3, 4].map((q) => (<option key={q} value={q}>Q{q}</option>))}</Select></td>
                        <td><Input className="h-8 w-28 text-xs" value={it.sourceOfFunds} onChange={(e) => set({ sourceOfFunds: e.target.value })} aria-label="Source of funds" /></td>
                        <td className="text-center"><input type="checkbox" checked={it.agpo} onChange={(e) => set({ agpo: e.target.checked })} aria-label="Reserved for AGPO" /></td>
                        <td><Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, items: editing.items.filter((_, j) => j !== n) })} aria-label="Remove">×</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button size="sm" onClick={() => setEditing({ ...editing, items: [...editing.items, blankItem()] })}>Add item</Button>
              <p className="text-sm text-muted">Total {formatAmount(addAll(editing.items.map((i) => i.estimatedCost)), fp)}</p>
            </div>
            <Field label="Notes"><Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}
