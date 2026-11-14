'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useBankAccounts } from '@/modules/finance/ui/lib/commercial-hooks';
import { addAll, formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useBranches, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { downloadCsv } from './report-filters';
import { Badge, Button, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs } from './ui';
import { ApprovalHistory } from './workflow';
import { AttachmentsCard } from './attachments';

const positive = /^\d*(\.\d*)?$/;

interface ImprestType {
  id: string;
  code: string;
  name: string;
  description: string;
  maxAmount: string | null;
  surrenderDays: number;
  isActive: boolean;
}

interface Imprest {
  id: string;
  number: string;
  typeName: string;
  applicantId: string;
  applicantName: string;
  purpose: string;
  destination: string;
  startDate: string;
  endDate: string;
  currency: string;
  amount: string;
  status: string;
  surrenderDue: string | null;
  outstanding: string | null;
  owedToApplicant: string | null;
  rejectionReason: string;
  lines?: { description: string; amount: string }[];
  issue?: { date: string | null; journalId: string | null } | null;
  surrender?: {
    date: string | null;
    lines: { lineNo: number; date: string; categoryId: string; description: string; receiptReference: string; amount: string }[];
    spent: string | null;
    cashReturned: string | null;
    refundReference: string;
    notes: string;
    rejectionReason: string;
    journalId: string | null;
  } | null;
  balancePayment?: { journalId: string | null } | null;
  recovery?: { fromPeriod: string | null; installment: string | null; amount: string | null; journalId: string | null } | null;
  reminders?: { count: number; lastAt: string | null } | null;
}

interface OutstandingRow {
  id: string;
  number: string;
  applicantName: string;
  typeName: string;
  purpose: string;
  status: string;
  issuedOn: string | null;
  surrenderDue: string | null;
  outstanding: string;
  daysOverdue: number;
  reminders: number;
}

type RequestForm = { typeId: string; branchId: string; purpose: string; destination: string; startDate: string; endDate: string; projectId: string; lines: { description: string; amount: string }[] };
type SurrenderForm = { date: string; lines: { date: string; categoryId: string; description: string; receiptReference: string; amount: string }[]; cashReturned: string; refundBankAccountId: string; refundReference: string; notes: string };

const overdue = (x: Imprest) => x.status === 'ISSUED' && !!x.surrenderDue && x.surrenderDue.slice(0, 10) < today();

/**
 * Staff imprest: apply for an advance, get it approved and issued, then surrender it with receipts and
 * any unspent cash. Finance sees what is outstanding, chases overdue imprest and can recover it from salary.
 */
export function ImprestPage() {
  const { entity, me, can } = useSession();
  const queryClient = useQueryClient();
  const invalidate = () => ['imprests', 'imprest', 'imprest-outstanding'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const precision = usePrecision();
  const router = useRouter();
  const params = useSearchParams();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data: banks = [] } = useBankAccounts(entity?.id);
  const { data: dimensions = [] } = useDimensions();
  const types = useQuery({ queryKey: ['imprest-types'], queryFn: () => api.get<ImprestType[]>('/imprest-types') });
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<{ id: string; code: string; name: string; requiresReceipt: boolean; isActive: boolean }[]>('/expense-categories') });
  const reviewer = can('expenses.approve') || can('expenses.pay');
  const [tab, setTab] = useState<'mine' | 'all' | 'outstanding'>('mine');
  const list = useQuery({ queryKey: ['imprests', entity?.id, tab], queryFn: () => api.get<Imprest[]>('/imprests', { entityId: entity!.id, mine: tab === 'mine' ? 'true' : undefined }), enabled: tab !== 'outstanding' });
  const outstanding = useQuery({ queryKey: ['imprest-outstanding', entity?.id], queryFn: () => api.get<OutstandingRow[]>('/imprests/outstanding', { entityId: entity!.id }), enabled: tab === 'outstanding' });
  const viewing = params.get('open');
  const view = (id: string | null) => router.replace(id ? `/finance/imprest?open=${id}` : '/finance/imprest');
  const detail = useQuery({ queryKey: ['imprest', viewing], queryFn: () => api.get<Imprest>(`/imprests/${viewing}`), enabled: !!viewing });
  const [form, setForm] = useState<RequestForm | null>(null);
  const [surrender, setSurrender] = useState<SurrenderForm | null>(null);
  const [comment, setComment] = useState('');
  const [pay, setPay] = useState({ bankAccountId: '', date: today(), reference: '' });
  const [recovery, setRecovery] = useState({ fromPeriod: '', installment: '' });
  const [editingTypes, setEditingTypes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fp = precision(entity?.functionalCurrency);
  const activeBanks = banks.filter((b) => b.isActive && b.currency === entity?.functionalCurrency);
  const bankId = pay.bankAccountId || activeBanks[0]?.id || '';

  const create = useMutation({
    mutationFn: async () => {
      const f = form!;
      const doc = await api.post<Imprest>('/imprests', {
        entityId: entity!.id,
        branchId: f.branchId || branches[0]?.id,
        typeId: f.typeId || types.data?.find((t) => t.isActive)?.id,
        purpose: f.purpose,
        destination: f.destination || undefined,
        startDate: f.startDate,
        endDate: f.endDate,
        projectId: f.projectId || null,
        lines: f.lines.filter((l) => l.amount && l.description),
      });
      await api.post(`/imprests/${doc.id}/submit`);
    },
    onSuccess: () => (setForm(null), setError(null), invalidate()),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => api.post(`/imprests/${viewing}/${action}`, body ?? {}),
    onSuccess: () => (setError(null), setComment(''), setSurrender(null), invalidate()),
    onError: (err) => setError(errorMessage(err)),
  });
  const remind = useMutation({
    mutationFn: () => api.post<{ overdue: number; reminded: number }>('/imprests/remind-overdue'),
    onSuccess: (r) => (setError(null), setNotice(`${r.reminded} reminder${r.reminded === 1 ? '' : 's'} sent (${r.overdue} overdue; holders are reminded at most every 3 days).`), invalidate()),
    onError: (err) => setError(errorMessage(err)),
  });
  const [notice, setNotice] = useState<string | null>(null);

  const x = detail.data;
  const mine = x?.applicantId === me.id;
  const catName = (id: string) => categories.data?.find((c) => c.id === id)?.name ?? '';
  const requestTotal = form ? addAll(form.lines.map((l) => l.amount)) : '0';
  const spentTotal = surrender ? addAll(surrender.lines.map((l) => l.amount)) : '0';
  const accounted = surrender ? addAll([spentTotal, surrender.cashReturned]) : '0';
  const blankSpend = () => ({ date: today(), categoryId: categories.data?.find((c) => c.isActive)?.id ?? '', description: '', receiptReference: '', amount: '' });
  const type = types.data?.find((t) => t.id === (form?.typeId || types.data?.find((t) => t.isActive)?.id));

  return (
    <>
      <PageHeader
        title="Staff imprest"
        description="Cash advances for official work. Apply, get approval, and surrender the imprest with receipts and any unspent cash by the due date. Overdue imprest is chased by email and SMS and can be recovered from salary."
        actions={
          <>
            {can('expenses.pay') && <Button onClick={() => setEditingTypes(true)}>Imprest types</Button>}
            {can('expenses.submit') && (
              <Button variant="primary" onClick={() => (setError(null), setForm({ typeId: '', branchId: '', purpose: '', destination: '', startDate: today(), endDate: today(), projectId: '', lines: [{ description: 'Per diem', amount: '' }] }))}>
                Apply for imprest
              </Button>
            )}
          </>
        }
      />
      {reviewer && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'mine', label: 'My imprest' },
            { id: 'all', label: 'All imprest' },
            ...(can('expenses.pay') ? [{ id: 'outstanding' as const, label: 'Outstanding' }] : []),
          ]}
        />
      )}
      <ErrorBanner error={error} className="mb-3" />
      {notice && <div className="mb-3"><Notice tone="green">{notice}</Notice></div>}

      {tab === 'outstanding' ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button loading={remind.isPending} onClick={() => (setNotice(null), remind.mutate())}>Send overdue reminders now</Button>
            <Button
              disabled={!outstanding.data?.length}
              onClick={() =>
                downloadCsv(
                  'imprest-outstanding.csv',
                  ['Number', 'Holder', 'Type', 'Purpose', 'Status', 'Issued', 'Surrender due', 'Days overdue', 'Outstanding', 'Reminders'],
                  (outstanding.data ?? []).map((r) => [r.number, r.applicantName, r.typeName, r.purpose, r.status, r.issuedOn?.slice(0, 10) ?? '', r.surrenderDue?.slice(0, 10) ?? '', String(r.daysOverdue), r.outstanding, String(r.reminders)]),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          <TableWrap>
            {outstanding.isLoading ? (
              <Loading />
            ) : !outstanding.data?.length ? (
              <Empty title="No imprest outstanding" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr><th>Number</th><th>Holder</th><th>Purpose</th><th>Status</th><th>Surrender due</th><th>Overdue</th><th className="num">Outstanding</th></tr>
                </thead>
                <tbody>
                  {outstanding.data.map((r) => (
                    <tr key={r.id} className="cursor-pointer" onClick={() => (setError(null), view(r.id))}>
                      <td className="whitespace-nowrap font-mono text-xs text-brand-700">{r.number}</td>
                      <td>{r.applicantName}</td>
                      <td>{r.purpose}<div className="text-xs text-muted">{r.typeName}</div></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{formatDate(r.surrenderDue)}</td>
                      <td>{r.daysOverdue > 0 ? <Badge tone="red">{r.daysOverdue} days</Badge> : <span className="text-xs text-muted">Not yet due</span>}{r.reminders > 0 && <span className="ml-1 text-xs text-muted">· {r.reminders} reminder(s)</span>}</td>
                      <td className="num">{formatAmount(r.outstanding, fp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
        </>
      ) : (
        <TableWrap>
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.length ? (
            <Empty title="No imprest yet" />
          ) : (
            <table className="table-base">
              <thead>
                <tr><th>Number</th><th>Holder</th><th>Purpose</th><th>Dates</th><th>Status</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => (setError(null), view(r.id))}>
                    <td className="whitespace-nowrap font-mono text-xs text-brand-700">{r.number}</td>
                    <td>{r.applicantName}</td>
                    <td>{r.purpose}<div className="text-xs text-muted">{r.typeName}{r.destination && ` · ${r.destination}`}</div></td>
                    <td className="whitespace-nowrap text-xs">{formatDate(r.startDate)} – {formatDate(r.endDate)}</td>
                    <td><StatusBadge status={r.status} />{overdue(r) && <span className="ml-1"><Badge tone="red">Overdue</Badge></span>}</td>
                    <td className="num">{formatAmount(r.amount, fp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      )}

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title="Apply for imprest"
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Submit · {formatAmount(requestTotal, fp)}</Button></>}
      >
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Type">
                <Select value={form.typeId || type?.id || ''} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
                  {types.data?.filter((t) => t.isActive).map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
                </Select>
              </Field>
              <Field label="Purpose" className="sm:col-span-2"><Input value={form.purpose} placeholder="e.g. Meter audit in Kapsabet zone" onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
              <Field label="Destination"><Input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} /></Field>
              <Field label="From"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="To"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
              <Field label="Branch">
                <Select value={form.branchId || branches[0]?.id || ''} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  {branches.map((b) => (<option key={b.id} value={b.id}>{b.code}</option>))}
                </Select>
              </Field>
              <Field label="Project">
                <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                  <option value="">—</option>
                  {dimensions.filter((d) => d.type === 'PROJECT' && d.isActive).map((d) => (<option key={d.id} value={d.id}>{d.code} · {d.name}</option>))}
                </Select>
              </Field>
            </div>
            <table className="table-base">
              <thead><tr><th>Estimate</th><th className="w-44 num">Amount</th></tr></thead>
              <tbody>
                {form.lines.map((l, i) => {
                  const set = (p: Partial<typeof l>) => setForm({ ...form, lines: form.lines.map((y, j) => (j === i ? { ...y, ...p } : y)) });
                  return (
                    <tr key={i}>
                      <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.amount} onChange={(e) => positive.test(e.target.value) && set({ amount: e.target.value })} aria-label="Amount" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: [...form.lines, { description: '', amount: '' }] })}>+ Add line</Button>
            <p className="text-xs text-muted">
              {type ? `${type.name}: surrender within ${type.surrenderDays} days of the end date${type.maxAmount ? `, up to ${formatAmount(type.maxAmount, fp)}` : ''}. ` : ''}
              You cannot apply for another imprest while one is still to be surrendered.
            </p>
          </div>
        )}
      </Modal>

      <Modal wide open={!!viewing} onClose={() => (view(null), setSurrender(null))} title={x ? `${x.number} · ${x.purpose}` : 'Imprest'}>
        {!x ? (
          <Loading />
        ) : (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <p className="text-sm">
              <StatusBadge status={x.status} /> {x.applicantName} · {x.typeName} · {formatAmount(x.amount, fp)} {x.currency}
              {x.destination && <span className="text-muted"> · {x.destination}</span>}
              <span className="text-muted"> · {formatDate(x.startDate)} – {formatDate(x.endDate)}</span>
            </p>
            {x.status === 'REJECTED' && <Notice tone="amber">Rejected: {x.rejectionReason}</Notice>}
            {x.status !== 'DRAFT' && (
              <div className="flex justify-end">
                <Button size="sm" onClick={() => window.open(`/api/v1/finance/imprests/${x.id}/voucher`, '_blank', 'noopener')}>Imprest voucher</Button>
              </div>
            )}
            {x.status === 'ISSUED' && x.surrenderDue && (
              <Notice tone={overdue(x) ? 'amber' : 'blue'}>
                Surrender by {formatDate(x.surrenderDue)}{overdue(x) ? ' — overdue' : ''}. Outstanding {formatAmount(x.outstanding ?? x.amount, fp)}.
                {x.surrender?.rejectionReason && <> Last surrender returned: {x.surrender.rejectionReason}</>}
              </Notice>
            )}
            {x.status === 'SURRENDERED' && Number(x.outstanding ?? 0) > 0 && <Notice tone="amber">{formatAmount(x.outstanding!, fp)} is still unaccounted for.</Notice>}
            {x.owedToApplicant && Number(x.owedToApplicant) > 0 && (
              <Notice tone={x.balancePayment?.journalId ? 'green' : 'blue'}>
                {formatAmount(x.owedToApplicant, fp)} spent beyond the advance {x.balancePayment?.journalId ? 'has been paid to the holder.' : 'is owed to the holder.'}
              </Notice>
            )}
            {x.status === 'RECOVERING' && x.recovery && (
              <Notice tone="amber">{formatAmount(x.recovery.amount ?? '0', fp)} is being recovered through payroll from {x.recovery.fromPeriod}, {formatAmount(x.recovery.installment ?? '0', fp)} a month.</Notice>
            )}

            <table className="table-base">
              <thead><tr><th>Estimate</th><th className="num">Amount</th></tr></thead>
              <tbody>{x.lines?.map((l, i) => (<tr key={i}><td>{l.description}</td><td className="num">{formatAmount(l.amount, fp)}</td></tr>))}</tbody>
            </table>

            {x.surrender?.date && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Surrender of {formatDate(x.surrender.date)}</h3>
                <table className="table-base">
                  <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Receipt</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {x.surrender.lines.map((l) => (
                      <tr key={l.lineNo}><td>{formatDate(l.date)}</td><td>{catName(l.categoryId)}</td><td>{l.description}</td><td className="text-xs">{l.receiptReference || '—'}</td><td className="num">{formatAmount(l.amount, fp)}</td></tr>
                    ))}
                    <tr><td colSpan={4} className="text-right text-xs text-muted">Spent</td><td className="num">{formatAmount(x.surrender.spent ?? '0', fp)}</td></tr>
                    <tr><td colSpan={4} className="text-right text-xs text-muted">Cash returned{x.surrender.refundReference && ` (${x.surrender.refundReference})`}</td><td className="num">{formatAmount(x.surrender.cashReturned ?? '0', fp)}</td></tr>
                  </tbody>
                </table>
                {x.surrender.notes && <p className="mt-1 text-xs text-muted">{x.surrender.notes}</p>}
              </div>
            )}
            <p className="flex flex-wrap gap-3 text-xs">
              {x.issue?.journalId && <Link className="text-brand-700 hover:underline" href={`/finance/journals/${x.issue.journalId}`}>Issue journal</Link>}
              {x.surrender?.journalId && <Link className="text-brand-700 hover:underline" href={`/finance/journals/${x.surrender.journalId}`}>Surrender journal</Link>}
              {x.balancePayment?.journalId && <Link className="text-brand-700 hover:underline" href={`/finance/journals/${x.balancePayment.journalId}`}>Overspend payment</Link>}
              {x.recovery?.journalId && <Link className="text-brand-700 hover:underline" href={`/finance/journals/${x.recovery.journalId}`}>Payroll recovery journal</Link>}
            </p>
            <ApprovalHistory documentType="IMPREST" documentId={x.id} />
            {x.surrender?.date && <ApprovalHistory documentType="IMPREST_SURRENDER" documentId={x.id} />}
            <AttachmentsCard recordType="Imprest" recordId={x.id} compact />

            {/* Request approval */}
            {x.status === 'SUBMITTED' && can('expenses.approve') && !mine && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Comment" className="min-w-72 flex-1"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                <Button onClick={() => act.mutate({ action: 'reject', body: { reason: comment || 'Rejected' } })}>Reject</Button>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'approve', body: { comment: comment || undefined } })}>Approve</Button>
              </div>
            )}
            {['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED'].includes(x.status) && (mine || can('expenses.approve')) && (
              <Button size="sm" variant="ghost" onClick={() => act.mutate({ action: 'cancel', body: { reason: comment || 'Cancelled' } })}>Cancel request</Button>
            )}

            {/* Issue */}
            {x.status === 'APPROVED' && can('expenses.pay') && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Pay from">
                  <Select value={bankId} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}>
                    {activeBanks.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
                  </Select>
                </Field>
                <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
                <Field label="Reference"><Input value={pay.reference} placeholder="Cheque / M-Pesa / EFT" onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'issue', body: { date: pay.date, bankAccountId: bankId, reference: pay.reference || undefined } })}>Issue imprest</Button>
              </div>
            )}

            {/* Surrender */}
            {x.status === 'ISSUED' && mine && !surrender && (
              <Button variant="primary" onClick={() => (setError(null), setSurrender({ date: today(), lines: [blankSpend()], cashReturned: '', refundBankAccountId: '', refundReference: '', notes: '' }))}>Surrender imprest</Button>
            )}
            {surrender && (
              <div className="space-y-2 rounded-md border border-line p-3">
                <h3 className="text-sm font-semibold">Surrender</h3>
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead><tr><th>Date</th><th className="min-w-40">Category</th><th className="min-w-40">Description</th><th>Receipt ref</th><th className="w-36 num">Amount</th></tr></thead>
                    <tbody>
                      {surrender.lines.map((l, i) => {
                        const set = (p: Partial<typeof l>) => setSurrender({ ...surrender, lines: surrender.lines.map((y, j) => (j === i ? { ...y, ...p } : y)) });
                        return (
                          <tr key={i}>
                            <td><Input type="date" className="h-8 text-xs" value={l.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date" /></td>
                            <td>
                              <Select className="h-8 text-xs" value={l.categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Category">
                                {categories.data?.filter((c) => c.isActive).map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                              </Select>
                            </td>
                            <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></td>
                            <td><Input className="h-8 text-xs" value={l.receiptReference} onChange={(e) => set({ receiptReference: e.target.value })} aria-label="Receipt reference" /></td>
                            <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.amount} onChange={(e) => positive.test(e.target.value) && set({ amount: e.target.value })} aria-label="Amount" /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setSurrender({ ...surrender, lines: [...surrender.lines, blankSpend()] })}>+ Add expense</Button>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Surrender date"><Input type="date" value={surrender.date} onChange={(e) => setSurrender({ ...surrender, date: e.target.value })} /></Field>
                  <Field label="Unspent cash returned"><Input inputMode="decimal" value={surrender.cashReturned} onChange={(e) => positive.test(e.target.value) && setSurrender({ ...surrender, cashReturned: e.target.value })} /></Field>
                  <Field label="Paid into">
                    <Select value={surrender.refundBankAccountId || activeBanks[0]?.id || ''} onChange={(e) => setSurrender({ ...surrender, refundBankAccountId: e.target.value })}>
                      {activeBanks.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
                    </Select>
                  </Field>
                  <Field label="Deposit reference"><Input value={surrender.refundReference} onChange={(e) => setSurrender({ ...surrender, refundReference: e.target.value })} /></Field>
                </div>
                <Field label="Notes"><Input value={surrender.notes} onChange={(e) => setSurrender({ ...surrender, notes: e.target.value })} /></Field>
                <p className="text-xs text-muted">
                  Accounted for {formatAmount(accounted, fp)} of {formatAmount(x.outstanding ?? x.amount, fp)}.
                  {Number(accounted) < Number(x.outstanding ?? x.amount) && ' Anything not accounted for can be recovered from your salary.'}
                  {Number(accounted) > Number(x.outstanding ?? x.amount) && ' The extra you spent will be refunded to you.'} Attach the receipts below.
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => setSurrender(null)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={act.isPending}
                    onClick={() =>
                      act.mutate({
                        action: 'surrender',
                        body: {
                          date: surrender.date,
                          lines: surrender.lines.filter((l) => l.amount).map((l) => ({ ...l, receiptReference: l.receiptReference || undefined })),
                          cashReturned: surrender.cashReturned || null,
                          refundBankAccountId: surrender.cashReturned ? surrender.refundBankAccountId || activeBanks[0]?.id : null,
                          refundReference: surrender.refundReference || undefined,
                          notes: surrender.notes || undefined,
                        },
                      })
                    }
                  >
                    Submit surrender
                  </Button>
                </div>
              </div>
            )}

            {/* Surrender approval */}
            {x.status === 'SURRENDER_SUBMITTED' && can('expenses.approve') && !mine && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Comment" className="min-w-72 flex-1"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                <Button onClick={() => act.mutate({ action: 'surrender/reject', body: { reason: comment || 'Receipts incomplete' } })}>Return to holder</Button>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'surrender/approve', body: { comment: comment || undefined } })}>Approve & post</Button>
              </div>
            )}

            {/* Overspend */}
            {x.status === 'SURRENDERED' && Number(x.owedToApplicant ?? 0) > 0 && !x.balancePayment?.journalId && can('expenses.pay') && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Pay from">
                  <Select value={bankId} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}>
                    {activeBanks.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
                  </Select>
                </Field>
                <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'pay-balance', body: { date: pay.date, bankAccountId: bankId } })}>Pay {formatAmount(x.owedToApplicant!, fp)} to holder</Button>
              </div>
            )}

            {/* Recovery through payroll */}
            {(overdue(x) || (x.status === 'SURRENDERED' && Number(x.outstanding ?? 0) > 0)) && can('expenses.pay') && (
              <div className="space-y-2 rounded-md border border-amber-200 p-3">
                <h3 className="text-sm font-semibold">Recover from salary</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="First payroll month"><Input type="month" value={recovery.fromPeriod} onChange={(e) => setRecovery({ ...recovery, fromPeriod: e.target.value })} /></Field>
                  <Field label="Monthly instalment (blank: all at once)"><Input inputMode="decimal" value={recovery.installment} onChange={(e) => positive.test(e.target.value) && setRecovery({ ...recovery, installment: e.target.value })} /></Field>
                  <Button loading={act.isPending} onClick={() => act.mutate({ action: 'recover', body: { date: today(), fromPeriod: recovery.fromPeriod || undefined, installment: recovery.installment || null } })}>
                    Send {formatAmount(x.outstanding ?? x.amount, fp)} to payroll
                  </Button>
                </div>
                <p className="text-xs text-muted">Adds a deduction to the holder&apos;s pay that stops once the balance is recovered. The holder must have an employee record linked to their sign-in.</p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ImprestTypesModal open={editingTypes} onClose={() => setEditingTypes(false)} types={types.data ?? []} />
    </>
  );
}

function ImprestTypesModal({ open, onClose, types }: { open: boolean; onClose: () => void; types: ImprestType[] }) {
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<null | { id?: string; code: string; name: string; maxAmount: string; surrenderDays: string; isActive: boolean }>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const e = edit!;
      const body = { code: e.code, name: e.name, maxAmount: e.maxAmount || null, surrenderDays: Number(e.surrenderDays || 0), isActive: e.isActive };
      return e.id ? api.patch(`/imprest-types/${e.id}`, body) : api.post('/imprest-types', body);
    },
    onSuccess: () => (setEdit(null), setError(null), queryClient.invalidateQueries({ queryKey: ['imprest-types'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal open={open} onClose={onClose} title="Imprest types" wide>
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <table className="table-base">
          <thead><tr><th>Code</th><th>Name</th><th className="num">Surrender within</th><th className="num">Ceiling</th><th>Status</th><th /></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id}>
                <td className="font-mono text-xs">{t.code}</td>
                <td>{t.name}</td>
                <td className="num">{t.surrenderDays} days</td>
                <td className="num">{t.maxAmount ? formatAmount(t.maxAmount, 0) : '—'}</td>
                <td><StatusBadge status={t.isActive ? 'ACTIVE' : 'CLOSED'} /></td>
                <td><Button size="sm" variant="ghost" onClick={() => setEdit({ id: t.id, code: t.code, name: t.name, maxAmount: t.maxAmount ?? '', surrenderDays: String(t.surrenderDays), isActive: t.isActive })}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {edit ? (
          <div className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-5">
            <Field label="Code"><Input value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Name" className="sm:col-span-2"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Surrender within (days)"><Input inputMode="numeric" value={edit.surrenderDays} onChange={(e) => /^\d*$/.test(e.target.value) && setEdit({ ...edit, surrenderDays: e.target.value })} /></Field>
            <Field label="Ceiling"><Input inputMode="decimal" value={edit.maxAmount} onChange={(e) => positive.test(e.target.value) && setEdit({ ...edit, maxAmount: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Active
            </label>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEdit({ code: '', name: '', maxAmount: '', surrenderDays: '7', isActive: true })}>+ Add type</Button>
        )}
      </div>
    </Modal>
  );
}
