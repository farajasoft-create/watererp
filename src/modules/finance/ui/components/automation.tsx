'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, formatAmount, formatDate, formatDateTime, isZero, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { AccountOptions } from './commercial/shared';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap, Textarea } from './ui';

const amountPattern = /^\d*(\.\d*)?$/;

// ---------------------------------------------------------------------------------------------
// Recurring journals
// ---------------------------------------------------------------------------------------------

interface TemplateLine {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}
interface Recurring {
  id: string;
  entityId: string;
  branchId: string;
  name: string;
  description: string;
  reference: string;
  type: 'STANDARD' | 'ACCRUAL';
  autoReverse: boolean;
  lines: { accountId: string; description: string; debit: string | null; credit: string | null }[];
  frequency: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
  interval: number;
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  action: 'DRAFT' | 'SUBMIT';
  nextRunDate: string | null;
  occurrences: number;
  lastError: string;
  runs: { date: string; journalId: string | null; journalNumber: string | null; status: string; error: string; at: string }[];
  isActive: boolean;
  total: string;
  schedule?: string[];
}
type RecurringForm = Omit<Recurring, 'id' | 'lines' | 'nextRunDate' | 'occurrences' | 'lastError' | 'runs' | 'total' | 'schedule' | 'endDate' | 'maxOccurrences'> & { id?: string; lines: TemplateLine[]; endDate: string; maxOccurrences: string };

const FREQ: Record<Recurring['frequency'], string> = { WEEKLY: 'week', MONTHLY: 'month', QUARTERLY: 'quarter', ANNUALLY: 'year' };
const every = (r: { frequency: Recurring['frequency']; interval: number; dayOfMonth: number }) =>
  `Every ${r.interval > 1 ? `${r.interval} ${FREQ[r.frequency]}s` : FREQ[r.frequency]}${r.frequency === 'WEEKLY' ? '' : ` on the ${r.dayOfMonth === 31 ? 'last day' : `${r.dayOfMonth}${[, 'st', 'nd', 'rd'][r.dayOfMonth % 10 > 3 || Math.floor(r.dayOfMonth / 10) === 1 ? 0 : r.dayOfMonth % 10] ?? 'th'}`}`}`;

export function RecurringJournalsPage() {
  const { entity, can } = useSession();
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const { data: branches = [] } = useBranches(entity?.id);
  const list = useQuery({ queryKey: ['recurring', entity?.id], queryFn: () => api.get<Recurring[]>('/recurring-journals', { entityId: entity!.id }) });
  const [form, setForm] = useState<RecurringForm | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['recurring-detail', viewing], queryFn: () => api.get<Recurring>(`/recurring-journals/${viewing}`), enabled: !!viewing });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => (queryClient.invalidateQueries({ queryKey: ['recurring'] }), queryClient.invalidateQueries({ queryKey: ['recurring-detail'] }));
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const body = {
        ...f,
        id: undefined,
        reference: f.reference || undefined,
        endDate: f.endDate || null,
        maxOccurrences: f.maxOccurrences ? Number(f.maxOccurrences) : null,
        lines: f.lines.filter((l) => l.accountId && (l.debit || l.credit)).map((l) => ({ accountId: l.accountId, description: l.description || undefined, debit: l.debit || null, credit: l.credit || null })),
      };
      return f.id ? api.patch(`/recurring-journals/${f.id}`, body) : api.post('/recurring-journals', body);
    },
    onSuccess: () => (setForm(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'skip' | 'run' }) => api.post<{ number?: string }>(`/recurring-journals/${id}/${action}`),
    onSuccess: () => (setError(null), refresh(), queryClient.invalidateQueries({ queryKey: ['journals'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  const fp = precision(entity?.functionalCurrency);
  const blank = (): RecurringForm => ({
    entityId: entity!.id,
    branchId: branches[0]?.id ?? '',
    name: '',
    description: '{period}',
    reference: '',
    type: 'STANDARD',
    autoReverse: false,
    lines: [
      { accountId: '', description: '', debit: '', credit: '' },
      { accountId: '', description: '', debit: '', credit: '' },
    ],
    frequency: 'MONTHLY',
    interval: 1,
    dayOfMonth: 31,
    startDate: today(),
    endDate: '',
    maxOccurrences: '',
    action: 'SUBMIT',
    isActive: true,
  });
  const edit = (r: Recurring) =>
    setForm({ ...r, endDate: r.endDate?.slice(0, 10) ?? '', maxOccurrences: r.maxOccurrences ? String(r.maxOccurrences) : '', startDate: r.startDate.slice(0, 10), lines: r.lines.map((l) => ({ accountId: l.accountId, description: l.description, debit: l.debit ?? '', credit: l.credit ?? '' })) });
  const debit = form ? addAll(form.lines.map((l) => l.debit)) : '0';
  const credit = form ? addAll(form.lines.map((l) => l.credit)) : '0';
  const d = detail.data;
  return (
    <>
      <PageHeader
        title="Recurring journals"
        description="Journals that repeat on a schedule — rent, insurance, management fees, monthly accruals. Each occurrence is an ordinary journal in the owner's name, so period locks and approval still apply. Use {period}, {monthName}, {month}, {year} or {date} in descriptions."
        actions={can('journal.create') && <Button variant="primary" onClick={() => (setError(null), setForm(blank()))}>New recurring journal</Button>}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No recurring journals" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Name</th><th>Schedule</th><th className="num">Amount</th><th>Next</th><th>Then</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'opacity-60'}>
                  <td>
                    <button className="font-medium text-brand-700 hover:underline" onClick={() => setViewing(r.id)}>{r.name}</button>
                    <p className="text-xs text-muted">{r.occurrences} created</p>
                  </td>
                  <td className="text-xs">{every(r)}</td>
                  <td className="num">{formatAmount(r.total, fp)}</td>
                  <td className="whitespace-nowrap">{r.nextRunDate ? formatDate(r.nextRunDate) : 'finished'}</td>
                  <td className="text-xs">{r.action === 'SUBMIT' ? 'Submit for approval' : 'Leave as draft'}</td>
                  <td>
                    {r.lastError ? <Badge tone="red">failing</Badge> : r.isActive ? <Badge tone="green">active</Badge> : <Badge tone="gray">paused</Badge>}
                    {r.lastError && <p className="max-w-xs truncate text-[11px] text-red-700" title={r.lastError}>{r.lastError}</p>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {can('journal.create') && (
                      <>
                        {r.isActive && r.nextRunDate && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'run' })}>Create now</Button>}
                        {r.isActive && r.nextRunDate && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'skip' })}>Skip next</Button>}
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: r.isActive ? 'pause' : 'resume' })}>{r.isActive ? 'Pause' : 'Resume'}</Button>
                        <Button size="sm" variant="ghost" onClick={() => (setError(null), edit(r))}>Edit</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={d?.name ?? 'Recurring journal'} wide>
        {!d ? (
          <Loading />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-semibold">Coming up</p>
              {d.schedule?.length ? <ul className="text-sm">{d.schedule.map((s) => (<li key={s}>{formatDate(s)}</li>))}</ul> : <p className="text-sm text-muted">No further occurrences.</p>}
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">History</p>
              {!d.runs.length ? (
                <p className="text-sm text-muted">Nothing created yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {[...d.runs].reverse().map((r, i) => (
                    <li key={i}>
                      {formatDate(r.date)} · {r.journalId ? <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/journals/${r.journalId}`}>{r.journalNumber}</Link> : null} <Badge tone={r.status === 'FAILED' ? 'red' : r.status === 'SKIPPED' ? 'gray' : 'green'}>{r.status.toLowerCase()}</Badge>
                      {r.error && <span className="block text-xs text-muted">{r.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit recurring journal' : 'New recurring journal'}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}
      >
        {form && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name" className="sm:col-span-2"><Input value={form.name} placeholder="e.g. Office rent" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Branch">
                <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  {branches.map((b) => (<option key={b.id} value={b.id}>{b.code}</option>))}
                </Select>
              </Field>
              <Field label="Journal type">
                <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'STANDARD' | 'ACCRUAL', autoReverse: e.target.value === 'ACCRUAL' })}>
                  <option value="STANDARD">Standard</option>
                  <option value="ACCRUAL">Accrual</option>
                </Select>
              </Field>
              <Field label="Description" className="sm:col-span-3" hint="e.g. Rent for {period}"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
              <Field label="Reference"><Input value={form.reference} placeholder="e.g. RENT-{year}-{month}" onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
            </div>
            <table className="table-base">
              <thead><tr><th className="min-w-56">Account</th><th>Line description</th><th className="num w-32">Debit</th><th className="num w-32">Credit</th><th className="w-8" /></tr></thead>
              <tbody>
                {form.lines.map((l, i) => {
                  const set = (p: Partial<TemplateLine>) => setForm({ ...form, lines: form.lines.map((x, k) => (k === i ? { ...x, ...p } : x)) });
                  return (
                    <tr key={i}>
                      <td>
                        <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
                          <AccountOptions accounts={accounts.filter((a) => a.allowManualPosting)} placeholder="Select account…" />
                        </Select>
                      </td>
                      <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Line description" /></td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.debit} onChange={(e) => amountPattern.test(e.target.value) && set({ debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label="Debit" /></td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.credit} onChange={(e) => amountPattern.test(e.target.value) && set({ credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label="Credit" /></td>
                      <td><Button size="sm" variant="ghost" disabled={form.lines.length <= 2} onClick={() => setForm({ ...form, lines: form.lines.filter((_, k) => k !== i) })} aria-label="Remove line">✕</Button></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td><Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: [...form.lines, { accountId: '', description: '', debit: '', credit: '' }] })}>+ Add line</Button></td>
                  <td className="text-right text-xs">{isZero(addAll([debit, `-${credit}`.replace('--', '')])) ? <span className="text-emerald-700">Balanced</span> : <span className="text-red-700">Out by {formatAmount(addAll([debit, `-${credit}`.replace('--', '')]), fp, { parens: true })}</span>}</td>
                  <td className="num">{formatAmount(debit, fp)}</td>
                  <td className="num">{formatAmount(credit, fp)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Repeat every">
                <div className="flex gap-1">
                  <Input className="w-14" inputMode="numeric" value={form.interval} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setForm({ ...form, interval: Math.max(1, Number(e.target.value || 1)) })} />
                  <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Recurring['frequency'] })}>
                    <option value="WEEKLY">week(s)</option>
                    <option value="MONTHLY">month(s)</option>
                    <option value="QUARTERLY">quarter(s)</option>
                    <option value="ANNUALLY">year(s)</option>
                  </Select>
                </div>
              </Field>
              {form.frequency !== 'WEEKLY' && (
                <Field label="On day">
                  <Select value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (<option key={n} value={n}>{n}</option>))}
                    <option value={31}>Last day of the month</option>
                  </Select>
                </Field>
              )}
              <Field label="Starting"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="Ending (optional)"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
              <Field label="Or after (occurrences)"><Input inputMode="numeric" value={form.maxOccurrences} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setForm({ ...form, maxOccurrences: e.target.value })} /></Field>
              <Field label="When created" className="sm:col-span-2">
                <Select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as 'DRAFT' | 'SUBMIT' })}>
                  <option value="SUBMIT">Submit for approval</option>
                  <option value="DRAFT">Leave as a draft to review</option>
                </Select>
              </Field>
              {form.type === 'ACCRUAL' && <Field label="Reversal"><Checkbox label="Reverse on the 1st of the next month" checked={form.autoReverse} onChange={(v) => setForm({ ...form, autoReverse: v })} /></Field>}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------

interface CollectionRow {
  customerId: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  overdue: string;
  total: string;
  oldestDaysOverdue: number;
  overdueInvoices: number;
  creditLimitUsedPercent: number | null;
  onHold: boolean;
  averageDaysLate: number | null;
  lastPaymentDate: string | null;
  lastContact: { type: string; at: string; by: string; note: string } | null;
  followUpDate: string | null;
  promise: { date: string; amount: string | null; broken: boolean } | null;
  disputed: boolean;
  priority: 'high' | 'medium' | 'low';
  action: string;
}
interface Letter {
  stage: 'friendly' | 'firm' | 'final';
  date: string;
  from: { name: string; organisation: string; taxId: string; country: string };
  to: { name: string; legalName: string; address: string; city: string; country: string; email: string };
  subject: string;
  paragraphs: string[];
  currency: string;
  items: { number: string; date: string; dueDate: string; daysOverdue: number; reference: string; open: string }[];
  total: string;
  payBy: string;
  signedBy: string;
}

export function CollectionsPage() {
  const { entity, can } = useSession();
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const [asOf, setAsOf] = useState(today());
  const { data, isLoading, error } = useQuery({ queryKey: ['collections', entity?.id, asOf], queryFn: () => api.get<{ currency: string; totals: { overdue: string; customers: number; high: number; brokenPromises: number }; rows: CollectionRow[] }>('/collections', { entityId: entity!.id, asOf }) });
  const [logging, setLogging] = useState<CollectionRow | null>(null);
  const [letterFor, setLetterFor] = useState<CollectionRow | null>(null);
  const [act, setAct] = useState({ type: 'CALL', note: '', promiseDate: '', promiseAmount: '', followUpDate: '' });
  const [err, setErr] = useState<string | null>(null);
  const letter = useQuery({ queryKey: ['letter', letterFor?.customerId, asOf], queryFn: () => api.get<Letter>(`/collections/${letterFor!.customerId}/letter`, { entityId: entity!.id, asOf }), enabled: !!letterFor });
  const history = useQuery({ queryKey: ['collection-activities', logging?.customerId], queryFn: () => api.get<{ id: string; type: string; note: string; promiseDate: string | null; createdByName: string; createdAt: string }[]>(`/collections/${logging!.customerId}/activities`, { entityId: entity!.id }), enabled: !!logging });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/collections/${body.customerId}/activities`, { ...body, customerId: undefined, entityId: entity!.id }),
    onSuccess: () => (setLogging(null), setErr(null), queryClient.invalidateQueries({ queryKey: ['collections'] }), queryClient.invalidateQueries({ queryKey: ['collection-activities'] })),
    onError: (e) => setErr(errorMessage(e)),
  });
  const emailLetter = useMutation({
    mutationFn: () => {
      const to = letter.data?.to.email || window.prompt('Send the reminder to which email address?') || '';
      if (!to) throw new Error('No email address');
      return api.post<{ sentTo: string }>(`/collections/${letterFor!.customerId}/send-reminder`, { entityId: entity!.id, asOf, to });
    },
    onSuccess: (r) => (setLetterFor(null), setNotice(`Reminder emailed to ${r.sentTo}.`), queryClient.invalidateQueries({ queryKey: ['collections'] })),
    onError: (e) => setErr(errorMessage(e)),
  });
  const textReminder = useMutation({
    mutationFn: (customerId: string) => api.post<{ sentTo: string; stage: string }>(`/collections/${customerId}/sms-reminder`, { entityId: entity!.id, asOf }),
    onSuccess: (r) => (setErr(null), setNotice(`${r.stage === 'final' ? 'Final notice' : 'Reminder'} texted to ${r.sentTo}.`), queryClient.invalidateQueries({ queryKey: ['collections'] })),
    onError: (e) => setErr(errorMessage(e)),
  });
  const [notice, setNotice] = useState<string | null>(null);
  const fp = precision(data?.currency);
  const tone = { high: 'red', medium: 'amber', low: 'gray' } as const;
  return (
    <>
      <PageHeader
        title="Collections"
        description="Customers with overdue balances, ranked by how much is owed, how late it is and whether promises were kept. Log calls and promises to pay, and print reminder letters whose tone follows the age of the debt."
        actions={<Field label="As at"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>}
      />
      <ErrorBanner error={error ?? (letterFor ? null : err)} className="mb-3" />
      {notice && <div className="mb-3"><Notice tone="green">{notice}</Notice></div>}
      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          {(
            [
              ['Overdue', formatAmount(data.totals.overdue, fp)],
              ['Customers', String(data.totals.customers)],
              ['High priority', String(data.totals.high)],
              ['Broken promises', String(data.totals.brokenPromises)],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="rounded-lg border border-line bg-white p-3 shadow-xs">
              <p className="text-xs text-muted">{label}</p>
              <p className="text-lg font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
      )}
      <TableWrap>
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <Empty title="Nothing overdue" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Priority</th><th>Customer</th><th className="num">Overdue</th><th className="num">Oldest</th><th>Pays</th><th>Last contact</th><th>Next step</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.customerId}>
                  <td><Badge tone={tone[r.priority]}>{r.priority}</Badge></td>
                  <td>
                    <Link className="font-medium text-brand-700 hover:underline" href={`/finance/sales/customers/${r.customerId}`}>{r.name}</Link>
                    <p className="text-[11px] text-muted">{r.phone || r.email}{r.onHold && ' · on hold'}{r.creditLimitUsedPercent !== null && ` · ${r.creditLimitUsedPercent}% of limit`}</p>
                  </td>
                  <td className="num">{formatAmount(r.overdue, fp)}<p className="text-[11px] text-muted">{r.overdueInvoices} invoice{r.overdueInvoices === 1 ? '' : 's'}</p></td>
                  <td className={cx('num', r.oldestDaysOverdue > 60 && 'text-red-700')}>{r.oldestDaysOverdue} d</td>
                  <td className="text-xs">{r.averageDaysLate === null ? '—' : r.averageDaysLate <= 0 ? 'on time' : `~${r.averageDaysLate} d late`}<p className="text-[11px] text-muted">{r.lastPaymentDate ? `last ${formatDate(r.lastPaymentDate)}` : 'no payments'}</p></td>
                  <td className="text-xs">
                    {r.lastContact ? `${r.lastContact.type.toLowerCase()} · ${formatDate(r.lastContact.at)}` : '—'}
                    {r.promise && <p className={cx('text-[11px]', r.promise.broken ? 'text-red-700' : 'text-emerald-700')}>promised {formatDate(r.promise.date)}{r.promise.broken ? ' · broken' : ''}</p>}
                  </td>
                  <td className="text-xs">{r.action}</td>
                  <td className="whitespace-nowrap text-right">
                    {can('ar.manage') && <Button size="sm" variant="ghost" onClick={() => (setErr(null), setAct({ type: 'CALL', note: '', promiseDate: '', promiseAmount: '', followUpDate: '' }), setLogging(r))}>Log contact</Button>}
                    {can('ar.manage') && r.phone && <Button size="sm" variant="ghost" loading={textReminder.isPending && textReminder.variables === r.customerId} onClick={() => textReminder.mutate(r.customerId)}>Text</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setLetterFor(r)}>Letter</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        open={!!logging}
        onClose={() => setLogging(null)}
        title={`Contact with ${logging?.name ?? ''}`}
        footer={<><Button onClick={() => setLogging(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ customerId: logging!.customerId, type: act.type, note: act.note || undefined, promiseDate: act.promiseDate || null, promiseAmount: act.promiseAmount || null, followUpDate: act.followUpDate || null })}>Save</Button></>}
      >
        {logging && (
          <div className="space-y-3">
            <ErrorBanner error={err} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="What happened">
                <Select value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })}>
                  {[['CALL', 'Phone call'], ['EMAIL', 'Email'], ['LETTER', 'Letter sent'], ['MEETING', 'Meeting'], ['PROMISE', 'Promise to pay'], ['DISPUTE', 'Dispute raised'], ['NOTE', 'Note']].map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
                </Select>
              </Field>
              <Field label="Follow up on"><Input type="date" value={act.followUpDate} onChange={(e) => setAct({ ...act, followUpDate: e.target.value })} /></Field>
              {act.type === 'PROMISE' && (
                <>
                  <Field label="Promised date"><Input type="date" value={act.promiseDate} onChange={(e) => setAct({ ...act, promiseDate: e.target.value })} /></Field>
                  <Field label="Promised amount"><Input inputMode="decimal" value={act.promiseAmount} onChange={(e) => amountPattern.test(e.target.value) && setAct({ ...act, promiseAmount: e.target.value })} /></Field>
                </>
              )}
              <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} /></Field>
            </div>
            {!!history.data?.length && (
              <div>
                <p className="mb-1 text-sm font-semibold">History</p>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                  {history.data.map((h) => (
                    <li key={h.id}><span className="text-muted">{formatDateTime(h.createdAt)} · {h.createdByName} ·</span> {h.type.toLowerCase()}{h.promiseDate && ` (promised ${formatDate(h.promiseDate)})`}{h.note && ` — ${h.note}`}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        wide
        open={!!letterFor}
        onClose={() => setLetterFor(null)}
        title="Reminder letter"
        footer={
          <>
            <Button onClick={() => setLetterFor(null)}>Close</Button>
            {can('ar.manage') && letter.data && <Button onClick={() => save.mutate({ customerId: letterFor!.customerId, type: 'LETTER', note: letter.data!.subject })}>Record as posted</Button>}
            {can('ar.manage') && letter.data && (
              <Button loading={emailLetter.isPending} onClick={() => emailLetter.mutate()}>
                {letter.data.to.email ? `Email to ${letter.data.to.email}` : 'Email…'}
              </Button>
            )}
            <Button variant="primary" disabled={!letter.data} onClick={() => window.print()}>Print</Button>
          </>
        }
      >
        {letter.isLoading ? (
          <Loading />
        ) : letter.error ? (
          <ErrorBanner error={letter.error} />
        ) : (
          letter.data && (
            <div className="print-area space-y-4 text-sm">
              <div className="flex justify-between">
                <div>
                  <p className="font-semibold">{letter.data.from.name}</p>
                  <p className="text-xs text-muted">{letter.data.from.country}{letter.data.from.taxId && ` · PIN ${letter.data.from.taxId}`}</p>
                </div>
                <p>{formatDate(letter.data.date)}</p>
              </div>
              <div>
                <p className="font-medium">{letter.data.to.legalName || letter.data.to.name}</p>
                {letter.data.to.address && <p>{letter.data.to.address}</p>}
                <p>{[letter.data.to.city, letter.data.to.country].filter(Boolean).join(', ')}</p>
              </div>
              <p className="font-semibold">{letter.data.subject}</p>
              <p>Dear {letter.data.to.name},</p>
              {letter.data.paragraphs.slice(0, 1).map((p, i) => (<p key={i}>{p}</p>))}
              <table className="w-full text-xs">
                <thead><tr className="border-b border-line text-left"><th className="py-1">Invoice</th><th>Date</th><th>Due</th><th className="text-right">Days overdue</th><th className="text-right">Amount due ({letter.data.currency})</th></tr></thead>
                <tbody>
                  {letter.data.items.map((it) => (
                    <tr key={it.number} className="border-b border-line/60"><td className="py-1">{it.number}{it.reference && ` (${it.reference})`}</td><td>{formatDate(it.date)}</td><td>{formatDate(it.dueDate)}</td><td className="text-right">{it.daysOverdue}</td><td className="text-right tabular-nums">{formatAmount(it.open, 2)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold"><td colSpan={4} className="py-1">Total overdue</td><td className="text-right tabular-nums">{formatAmount(letter.data.total, 2)}</td></tr></tfoot>
              </table>
              {letter.data.paragraphs.slice(1).map((p, i) => (<p key={i}>{p}</p>))}
              <p>Yours sincerely,</p>
              <p className="font-medium">{letter.data.signedBy}<br /><span className="font-normal text-muted">{letter.data.from.name}</span></p>
            </div>
          )
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Bank reconciliation suggestions
// ---------------------------------------------------------------------------------------------

interface BankSuggestion {
  statementLineIds: string[];
  ledgerEntryIds: string[];
  kind: 'one-to-one' | 'one-to-many' | 'many-to-one';
  confidence: number;
  reasons: string[];
}

/** Scored matches with the evidence behind them; nothing is matched until the user accepts. */
export function BankSuggestions({ bankId, describeLine, describeEntry, onChange }: { bankId: string; describeLine: (id: string) => string; describeEntry: (id: string) => string; onChange: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['bank-suggestions', bankId], queryFn: () => api.get<{ matches: BankSuggestion[]; adjustments: { statementLineId: string; accountId: string; confidence: number; reason: string; account: { code: string; name: string } | null }[] }>(`/bank-accounts/${bankId}/suggestions`) });
  const [error, setError] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: (v: { match?: BankSuggestion; adjust?: { statementLineId: string; accountId: string } }) =>
      v.match ? api.post(`/bank-accounts/${bankId}/matches`, { statementLineIds: v.match.statementLineIds, ledgerEntryIds: v.match.ledgerEntryIds }) : api.post(`/bank-accounts/${bankId}/adjustments`, v.adjust),
    onSuccess: () => (setError(null), queryClient.invalidateQueries({ queryKey: ['bank-suggestions'] }), onChange()),
    onError: (err) => setError(errorMessage(err)),
  });
  if (!data || (!data.matches.length && !data.adjustments.length)) return null;
  const tone = (c: number) => (c >= 80 ? 'green' : c >= 55 ? 'amber' : 'gray');
  return (
    <Card title={`Suggested matches (${data.matches.length + data.adjustments.length})`} padded={false}>
      {error && <div className="p-3"><ErrorBanner error={error} /></div>}
      <table className="table-base">
        <tbody>
          {data.matches.map((m, i) => (
            <tr key={i}>
              <td className="w-16"><Badge tone={tone(m.confidence)}>{m.confidence}%</Badge></td>
              <td className="text-xs">
                <p>{m.statementLineIds.map(describeLine).join(' + ')}</p>
                <p className="text-muted">↔ {m.ledgerEntryIds.map(describeEntry).join(' + ')}</p>
                <p className="text-[11px] text-muted">{m.reasons.join(' · ')}</p>
              </td>
              <td className="text-right"><Button size="sm" onClick={() => accept.mutate({ match: m })}>Match</Button></td>
            </tr>
          ))}
          {data.adjustments.map((a) => (
            <tr key={a.statementLineId}>
              <td className="w-16"><Badge tone={tone(a.confidence)}>{a.confidence}%</Badge></td>
              <td className="text-xs">
                <p>{describeLine(a.statementLineId)}</p>
                <p className="text-muted">Post to {a.account ? `${a.account.code} ${a.account.name}` : 'account'} · {a.reason}</p>
              </td>
              <td className="text-right"><Button size="sm" onClick={() => accept.mutate({ adjust: { statementLineId: a.statementLineId, accountId: a.accountId } })}>Post & match</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Account suggestion for a document line
// ---------------------------------------------------------------------------------------------

/** A clickable hint with the account most likely for this line, learned from earlier documents. */
export function AccountHint({ side, partyId, description, onPick }: { side: 'purchase' | 'sales'; partyId: string; description: string; onPick: (accountId: string) => void }) {
  const [debounced, setDebounced] = useState(description);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(description), 400);
    return () => clearTimeout(t);
  }, [description]);
  const { data } = useQuery({
    queryKey: ['account-hint', side, partyId, debounced],
    queryFn: () => api.get<{ accountId: string; code: string; name: string; confidence: number; reason: string }[]>('/suggestions/accounts', { side, partyId: partyId || undefined, description: debounced || undefined }),
    enabled: !!(partyId || debounced.trim().length >= 3),
    staleTime: 60_000,
  });
  const top = data?.[0];
  if (!top || top.confidence < 30) return null;
  return (
    <button type="button" className="mt-0.5 block text-left text-[11px] text-brand-700 hover:underline" title={top.reason} onClick={() => onPick(top.accountId)}>
      Suggested: {top.code} {top.name} ({top.confidence}%)
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Cash forecast scenarios
// ---------------------------------------------------------------------------------------------

export function ForecastScenario({ minimumCash }: { minimumCash: string }) {
  const { entity } = useSession();
  const precision = usePrecision();
  const [levers, setLevers] = useState({ delayDays: '0', receiptsPercent: '0', paymentsPercent: '0' });
  const [items, setItems] = useState<{ date: string; amount: string; description: string }[]>([]);
  const [result, setResult] = useState<null | { base: { weeks: { week: number; weekStart: string; closing: string }[]; lowest: { balance: string; weekStart: string } }; scenario: { weeks: { week: number; closing: string }[]; lowest: { balance: string; weekStart: string } } }>(null);
  const run = useMutation({
    mutationFn: () =>
      api.post<NonNullable<typeof result>>('/analytics/cash-forecast/scenario', {
        entityId: entity!.id,
        minimumCash: minimumCash || undefined,
        delayDays: Number(levers.delayDays) || 0,
        receiptsPercent: Number(levers.receiptsPercent) || 0,
        paymentsPercent: Number(levers.paymentsPercent) || 0,
        items: items.filter((i) => i.date && i.amount && i.amount !== '-').map((i) => ({ ...i })),
      }),
    onSuccess: setResult,
  });
  const fp = precision(entity?.functionalCurrency);
  return (
    <Card title="What if…">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customers pay later by (days)"><Input inputMode="numeric" value={levers.delayDays} onChange={(e) => /^-?\d{0,3}$/.test(e.target.value) && setLevers({ ...levers, delayDays: e.target.value })} /></Field>
          <Field label="Other receipts change (%)"><Input inputMode="numeric" value={levers.receiptsPercent} onChange={(e) => /^-?\d{0,3}$/.test(e.target.value) && setLevers({ ...levers, receiptsPercent: e.target.value })} /></Field>
          <Field label="Other payments change (%)"><Input inputMode="numeric" value={levers.paymentsPercent} onChange={(e) => /^-?\d{0,3}$/.test(e.target.value) && setLevers({ ...levers, paymentsPercent: e.target.value })} /></Field>
        </div>
        <div>
          <p className="mb-1 text-xs text-muted">One-off items (negative for payments, e.g. a tax payment or loan repayment)</p>
          {items.map((it, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <Input type="date" className="w-40" value={it.date} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, date: e.target.value } : x)))} aria-label="Date" />
              <Input className="w-36 text-right" inputMode="decimal" placeholder="-500000" value={it.amount} onChange={(e) => /^-?\d*(\.\d*)?$/.test(e.target.value) && setItems(items.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} aria-label="Amount" />
              <Input placeholder="Description" value={it.description} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} aria-label="Description" />
              <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, k) => k !== i))} aria-label="Remove">✕</Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setItems([...items, { date: today(), amount: '', description: '' }])}>+ Add item</Button>
        </div>
        <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>Run scenario</Button>
        {run.error && <ErrorBanner error={run.error} />}
        {result && (
          <div>
            <p className="mb-2 text-sm">
              Lowest point: <span className="font-semibold">{formatAmount(result.scenario.lowest.balance, fp, { parens: true })}</span> in the week of {formatDate(result.scenario.lowest.weekStart)}, against {formatAmount(result.base.lowest.balance, fp, { parens: true })} in the base case.
            </p>
            <table className="table-base text-xs">
              <thead><tr><th>Week</th><th className="num">Base</th><th className="num">Scenario</th><th className="num">Difference</th></tr></thead>
              <tbody>
                {result.base.weeks.map((w, i) => {
                  const s = result.scenario.weeks[i];
                  const diff = addAll([s.closing, `-${w.closing}`.replace('--', '')]);
                  return (
                    <tr key={w.week}>
                      <td>W{w.week} <span className="text-muted">{formatDate(w.weekStart)}</span></td>
                      <td className="num">{formatAmount(w.closing, 0, { parens: true })}</td>
                      <td className={cx('num font-medium', s.closing.startsWith('-') && 'text-red-700')}>{formatAmount(s.closing, 0, { parens: true })}</td>
                      <td className={cx('num', diff.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(diff, 0, { parens: true, blankZero: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// AI assistance
// ---------------------------------------------------------------------------------------------

interface AiStatus {
  configured: boolean;
  enabled: boolean;
  allowed: boolean;
  model: string | null;
}
export function useAiStatus() {
  return useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/ai/status'), staleTime: 60_000 });
}

function AiUnavailable({ status }: { status: AiStatus }) {
  return (
    <Notice tone="amber">
      {!status.allowed
        ? 'Your role does not include AI assistance.'
        : !status.configured
          ? 'AI assistance is not configured on this server (an ANTHROPIC_API_KEY is needed).'
          : 'AI assistance is turned off for your organisation. An administrator can turn it on in Setup → Organisation.'}
    </Notice>
  );
}

interface Proposal {
  supplier: { id: string; code: string; name: string; match: 'tax_id' | 'name' } | null;
  read: { supplierName: string | null; supplierTaxId: string | null; invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null; currency: string; subtotal: string | null; taxTotal: string | null; total: string | null; pricesIncludeTax: boolean };
  lines: { description: string; quantity: string; unitPrice: string; amount: string | null; taxCodeId: string | null; taxCode: string | null; accountId: string | null; account: string | null; accountConfidence: number | null }[];
  warnings: string[];
  model: string;
}

/** Reads a supplier invoice with AI, then creates a draft bill with the file attached, for review. */
export function CaptureInvoicePage() {
  const { entity } = useSession();
  const status = useAiStatus();
  const precision = usePrecision();
  const { data: branches = [] } = useBranches(entity?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suppliers = useQuery({ queryKey: ['parties', 'SUPPLIER'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/suppliers') });
  const read = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 4 * 1024 * 1024) throw new Error('Invoice files can be at most 4 MB here; attach larger scans to a bill and read them from there');
      const res = await fetch(`/api/v1/finance/ai/invoice-capture?entityId=${entity!.id}&contentType=${encodeURIComponent(f.type)}`, { method: 'POST', body: f, credentials: 'same-origin', headers: { 'content-type': f.type || 'application/octet-stream' } });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText);
      return data as Proposal;
    },
    onSuccess: (p) => (setProposal(p), setSupplierId(p.supplier?.id ?? ''), setError(null)),
    onError: (err) => setError(errorMessage(err)),
  });
  const create = useMutation({
    mutationFn: async () => {
      const p = proposal!;
      const bill = await api.post<{ id: string }>('/invoices', {
        entityId: entity!.id,
        branchId: branches[0]?.id,
        kind: 'PURCHASE_BILL',
        partyId: supplierId,
        date: p.read.invoiceDate ?? today(),
        dueDate: p.read.dueDate ?? undefined,
        supplierInvoiceNumber: p.read.invoiceNumber ?? undefined,
        priceIncludesTax: p.read.pricesIncludeTax,
        notes: `Read from ${file?.name ?? 'the attached invoice'} with AI; check before submitting.`,
        lines: p.lines.map((l) => ({ description: l.description, quantity: l.quantity || '1', unitPrice: l.unitPrice || '0', accountId: l.accountId, taxCodeId: l.taxCodeId })),
      });
      if (file) {
        const ticket = await api.get<{ directUploads: boolean }>('/attachments', { recordType: 'Invoice', recordId: bill.id });
        if (ticket.directUploads) {
          const up = await api.post<{ id: string; uploadUrl: string; headers: Record<string, string> }>('/attachments/uploads', { recordType: 'Invoice', recordId: bill.id, name: file.name, size: file.size, category: 'INVOICE' });
          await fetch(up.uploadUrl, { method: 'PUT', body: file, headers: up.headers });
          await api.post(`/attachments/uploads/${up.id}/complete`);
        } else {
          await fetch(`/api/v1/finance/attachments?recordType=Invoice&recordId=${bill.id}&name=${encodeURIComponent(file.name)}&category=INVOICE`, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' } });
        }
      }
      return bill;
    },
    onSuccess: (bill) => (window.location.href = `/finance/purchases/bills/${bill.id}/edit`),
    onError: (err) => setError(errorMessage(err)),
  });
  if (!status.data) return <Loading />;
  const fp = precision(proposal?.read.currency);
  return (
    <>
      <PageHeader title="Capture a supplier invoice" description="Upload a PDF or photo of a supplier invoice. AI reads it into a draft bill with suggested accounts and tax codes, flags anything that does not add up, and attaches the original. Nothing is posted until the bill goes through normal approval." />
      {!(status.data.configured && status.data.enabled && status.data.allowed) ? (
        <AiUnavailable status={status.data} />
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => fileRef.current?.click()}>{file ? 'Choose another file' : 'Choose invoice (PDF or image)'}</Button>
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  setProposal(null);
                  read.mutate(f);
                }
                e.target.value = '';
              }} />
              {file && <span className="text-sm">{file.name}</span>}
              {read.isPending && <span className="text-sm text-muted">Reading the invoice…</span>}
            </div>
            <ErrorBanner error={error} className="mt-3" />
          </Card>
          {proposal && (
            <Card title="Proposed bill">
              <div className="space-y-4">
                {proposal.warnings.length > 0 && (
                  <Notice tone="amber">
                    <ul className="list-disc pl-4">{proposal.warnings.map((w, i) => (<li key={i}>{w}</li>))}</ul>
                  </Notice>
                )}
                <div className="grid gap-3 text-sm sm:grid-cols-4">
                  <Field label="Supplier" className="sm:col-span-2" hint={proposal.supplier ? `Matched by ${proposal.supplier.match === 'tax_id' ? 'tax number' : 'name'} to "${proposal.read.supplierName ?? ''}"` : `Read as "${proposal.read.supplierName ?? '—'}"${proposal.read.supplierTaxId ? `, PIN ${proposal.read.supplierTaxId}` : ''}`}>
                    <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                      <option value="">Choose supplier…</option>
                      {suppliers.data?.map((s) => (<option key={s.id} value={s.id}>{s.code} · {s.name}</option>))}
                    </Select>
                  </Field>
                  <div><p className="text-xs text-muted">Invoice</p><p className="font-medium">{proposal.read.invoiceNumber ?? '—'}</p></div>
                  <div><p className="text-xs text-muted">Date · due</p><p>{formatDate(proposal.read.invoiceDate) || '—'} · {formatDate(proposal.read.dueDate) || '—'}</p></div>
                </div>
                <table className="table-base text-xs">
                  <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th><th>Tax</th><th>Account (suggested)</th></tr></thead>
                  <tbody>
                    {proposal.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{l.description}</td>
                        <td className="num">{l.quantity}</td>
                        <td className="num">{l.unitPrice ? formatAmount(l.unitPrice, fp) : '?'}</td>
                        <td className="num">{l.amount ? formatAmount(l.amount, fp) : ''}</td>
                        <td>{l.taxCode ?? '—'}</td>
                        <td>{l.account ? <>{l.account} <span className="text-muted">({l.accountConfidence}%)</span></> : <span className="text-amber-700">choose on the bill</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={3}>As printed: subtotal {proposal.read.subtotal ?? '—'} · tax {proposal.read.taxTotal ?? '—'}</td><td className="num">{proposal.read.total ? formatAmount(proposal.read.total, fp) : ''}</td><td colSpan={2}>{proposal.read.currency}</td></tr>
                  </tfoot>
                </table>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted">Read by {proposal.model}. Check every figure against the document before submitting.</p>
                  <Button variant="primary" disabled={!supplierId} loading={create.isPending} onClick={() => create.mutate()}>Create draft bill</Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

const EXAMPLES = ['What was our gross margin last month, and how does it compare with the month before?', 'Which customers owe us the most, and how much of it is overdue?', 'Are we over budget anywhere this year?', 'Will cash dip below KES 5 million in the next quarter?'];

/** Questions about the books, answered from read-only reports the user is allowed to run. */
export function AskPage() {
  const { entity } = useSession();
  const status = useAiStatus();
  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; content: string; tools?: { tool: string; ok: boolean }[] }[]>([]);
  const ask = useMutation({
    mutationFn: (q: string) => api.post<{ answer: string; tools: { tool: string; ok: boolean }[] }>('/ai/ask', { entityId: entity!.id, question: q, history: thread.map(({ role, content }) => ({ role, content })) }),
    onSuccess: (r) => setThread((t) => [...t, { role: 'assistant', content: r.answer, tools: r.tools }]),
    onError: (err) => setThread((t) => [...t, { role: 'assistant', content: `Sorry — ${errorMessage(err)}` }]),
  });
  const submit = (e?: FormEvent, q = question) => {
    e?.preventDefault();
    if (!q.trim() || ask.isPending) return;
    setThread((t) => [...t, { role: 'user', content: q.trim() }]);
    setQuestion('');
    ask.mutate(q.trim());
  };
  if (!status.data) return <Loading />;
  return (
    <>
      <PageHeader title="Ask about the books" description={`Plain-English questions about ${entity?.name ?? 'this entity'}, answered from the same reports you can open yourself — never more than your role allows. Figures come only from those reports.`} />
      {!(status.data.configured && status.data.enabled && status.data.allowed) ? (
        <AiUnavailable status={status.data} />
      ) : (
        <div className="mx-auto max-w-3xl space-y-4">
          {!thread.length && (
            <div className="grid gap-2 sm:grid-cols-2">
              {EXAMPLES.map((q) => (
                <button key={q} className="rounded-lg border border-line bg-white p-3 text-left text-sm hover:bg-gray-50" onClick={() => submit(undefined, q)}>{q}</button>
              ))}
            </div>
          )}
          {thread.map((m, i) => (
            <div key={i} className={cx('rounded-lg p-3 text-sm', m.role === 'user' ? 'ml-12 bg-brand-50' : 'mr-12 border border-line bg-white')}>
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.tools && m.tools.length > 0 && <p className="mt-2 text-[11px] text-muted">Sources: {m.tools.map((t) => `${t.tool.replace(/_/g, ' ')}${t.ok ? '' : ' (failed)'}`).join(', ')}</p>}
            </div>
          ))}
          {ask.isPending && <p className="text-sm text-muted">Looking at the figures…</p>}
          <form onSubmit={submit} className="flex gap-2">
            <Input className="flex-1" placeholder="Ask a question about revenue, costs, cash, customers, budgets…" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <Button variant="primary" type="submit" disabled={!question.trim()} loading={ask.isPending}>Ask</Button>
            {thread.length > 0 && <Button type="button" onClick={() => setThread([])}>New</Button>}
          </form>
          <p className="text-center text-[11px] text-muted">Answers are generated by {status.data.model}. Check important figures in the reports themselves.</p>
        </div>
      )}
    </>
  );
}

