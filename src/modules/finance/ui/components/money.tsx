'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useBankAccounts, useParties } from '@/modules/finance/ui/lib/commercial-hooks';
import { addAll, formatAmount, formatDate, formatDateTime, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { AccountOptions, ReasonDialog } from './commercial/shared';
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Textarea } from './ui';

const amountPattern = /^\d*(\.\d*)?$/;
const PAYOUT_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = { COMPLETED: 'green', SENT: 'blue', QUEUED: 'blue', FAILED: 'red', CHECK: 'amber', CANCELLED: 'gray' };
const PAYOUT_LABEL: Record<string, string> = { COMPLETED: 'Paid', SENT: 'Sent', QUEUED: 'Queued', FAILED: 'Failed', CHECK: 'Unconfirmed', CANCELLED: 'Cancelled' };

// ---------------------------------------------------------------------------------------------
// Customer refunds
// ---------------------------------------------------------------------------------------------

interface Refund {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  date: string;
  bankAccountId: string;
  method: string;
  payeePhone: string;
  reference: string;
  currency: string;
  amount: string;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  createdBy: string;
  sources: { type: 'PAYMENT' | 'CREDIT_NOTE'; id: string; number: string; amount: string }[];
  voidReason: string;
  payout?: { status: string; transactionId: string | null; resultDescription: string } | null;
}
interface Credit {
  type: 'PAYMENT' | 'CREDIT_NOTE';
  id: string;
  number: string;
  date: string;
  currency: string;
  available: string;
  description: string;
}

/** Money paid back to customers out of their receipts on account and unused credit notes. */
export function RefundsPage() {
  const { entity, can, me } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Refund | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ['refunds', entity?.id], queryFn: () => api.get<Refund[]>('/refunds', { entityId: entity!.id }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['refunds'] });
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'approve' | 'void' | 'delete'; body?: object }) => (action === 'delete' ? api.delete(`/refunds/${id}`) : api.post(`/refunds/${id}/${action}`, body ?? {})),
    onSuccess: () => (setError(null), setVoiding(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <>
      <PageHeader
        title="Customer refunds"
        description="Pay customers back out of receipts held on account or unused credit notes. A second person approves; from an M-Pesa account with payouts on, the money is sent to the customer's phone."
        actions={can('ar.manage') && <Button variant="primary" onClick={() => setCreating(true)}>New refund</Button>}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No refunds" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Refunding</th>
                <th>Method</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap font-mono text-xs">{r.number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{r.partyName}</td>
                  <td className="text-xs">{r.sources.map((s) => s.number).join(', ')}</td>
                  <td className="text-xs">{r.method === 'MOBILE_MONEY' ? `M-Pesa ${r.payeePhone}` : r.method.toLowerCase().replace('_', ' ')}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.voidReason && <div className="text-xs text-muted">{r.voidReason}</div>}
                  </td>
                  <td className="num">{formatAmount(r.amount, precision(r.currency))} <span className="text-xs text-muted">{r.currency}</span></td>
                  <td className="whitespace-nowrap text-right">
                    {r.status === 'DRAFT' && can('ar.manage') && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'delete' })}>Delete</Button>}
                    {r.status === 'DRAFT' && can('payments.approve') && (
                      <Button size="sm" variant="primary" disabled={r.createdBy === me.id} title={r.createdBy === me.id ? 'Someone else must approve' : undefined} loading={act.isPending && act.variables?.id === r.id} onClick={() => act.mutate({ id: r.id, action: 'approve' })}>
                        Approve & pay
                      </Button>
                    )}
                    {r.status === 'POSTED' && can('payments.approve') && <Button size="sm" variant="ghost" onClick={() => setVoiding(r)}>Void</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {creating && <RefundForm onClose={() => setCreating(false)} onDone={() => (setCreating(false), refresh())} />}
      <ReasonDialog
        open={!!voiding}
        withDate
        minDate={voiding?.date.slice(0, 10)}
        title={`Void ${voiding?.number ?? ''}`}
        description="The credits become available to the customer again. A refund paid out through M-Pesa cannot be voided."
        confirmLabel="Void refund"
        busy={act.isPending}
        onClose={() => setVoiding(null)}
        onConfirm={({ reason, date }) => voiding && act.mutate({ id: voiding.id, action: 'void', body: { reason, date } })}
      />
    </>
  );
}

function RefundForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: customers = [] } = useParties('CUSTOMER');
  const { data: banks = [] } = useBankAccounts();
  const [customerId, setCustomerId] = useState('');
  const [f, setF] = useState({ date: today(), bankAccountId: '', method: 'BANK_TRANSFER', payeePhone: '', reference: '', description: '' });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const customer = customers.find((c) => c.id === customerId);
  const credits = useQuery({ queryKey: ['refund-credits', customerId, entity?.id], queryFn: () => api.get<Credit[]>('/refunds/credits', { customerId, entityId: entity!.id }), enabled: !!customerId });
  const accounts = banks.filter((b) => b.entityId === entity?.id && b.isActive && (!customer || b.currency === customer.currency));
  const total = addAll(Object.values(amounts).filter(Boolean));
  const save = useMutation({
    mutationFn: () =>
      api.post('/refunds', {
        entityId: entity!.id,
        partyId: customerId,
        date: f.date,
        bankAccountId: f.bankAccountId || accounts[0]?.id,
        method: f.method,
        payeePhone: f.payeePhone || undefined,
        reference: f.reference || undefined,
        description: f.description || undefined,
        sources: (credits.data ?? []).filter((c) => amounts[c.id] && Number(amounts[c.id]) > 0).map((c) => ({ type: c.type, id: c.id, amount: amounts[c.id] })),
      }),
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title="New refund"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!customerId || Number(total) <= 0} loading={save.isPending} onClick={() => save.mutate()}>Save for approval</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customer" className="sm:col-span-2">
            <Select value={customerId} onChange={(e) => (setCustomerId(e.target.value), setAmounts({}))}>
              <option value="">Select customer…</option>
              {customers.filter((c) => c.isActive).map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.currency}</option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Pay from">
            <Select value={f.bankAccountId || accounts[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
              {accounts.map((b) => (
                <option key={b.id} value={b.id}>{b.name} · {b.currency}</option>
              ))}
            </Select>
          </Field>
          <Field label="Method">
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="MOBILE_MONEY">M-Pesa</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CASH">Cash</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          {f.method === 'MOBILE_MONEY' ? (
            <Field label="Safaricom number" hint="Blank uses the customer's phone">
              <Input inputMode="tel" value={f.payeePhone} onChange={(e) => setF({ ...f, payeePhone: e.target.value })} />
            </Field>
          ) : (
            <Field label="Reference">
              <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
            </Field>
          )}
        </div>
        {customerId && (
          <>
            <h3 className="text-sm font-semibold">Credits to refund</h3>
            {credits.isLoading ? (
              <Loading />
            ) : !credits.data?.length ? (
              <Notice tone="amber">{customer?.name} has no receipts on account or unused credit notes.</Notice>
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Date</th>
                    <th className="num">Available</th>
                    <th className="num w-36">Refund</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.data.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <span className="font-mono text-xs">{c.number}</span> <span className="text-xs text-muted">{c.type === 'PAYMENT' ? 'receipt on account' : 'credit note'}</span>
                      </td>
                      <td>{formatDate(c.date)}</td>
                      <td className="num">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => setAmounts((a) => ({ ...a, [c.id]: c.available }))}>{formatAmount(c.available, precision(c.currency))}</button>
                      </td>
                      <td>
                        <Input className="h-8 text-right text-xs" inputMode="decimal" value={amounts[c.id] ?? ''} onChange={(e) => amountPattern.test(e.target.value) && setAmounts((a) => ({ ...a, [c.id]: e.target.value }))} aria-label={`Refund from ${c.number}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="text-right">Total refund ({customer?.currency})</td>
                    <td className="num">{formatAmount(total, precision(customer?.currency))}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Salary runs
// ---------------------------------------------------------------------------------------------

interface SalaryRun {
  id: string;
  number: string;
  period: string;
  date: string;
  description: string;
  bankAccountId: string;
  total: string;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  createdBy: string;
  voidReason: string;
  lines?: { lineNo: number; employeeNumber: string; employeeName: string; phone: string; amount: string }[];
  payouts?: { sourceLine: number; status: string; transactionId: string | null; resultDescription: string; note: string; charge: string | null }[];
}

/** Parses pasted rows: employee number, name, phone, amount (tab or comma separated; a header row is skipped). */
function parseRows(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/\t|,/).map((c) => c.trim()))
    .filter((c) => c.length >= 3 && c.some(Boolean))
    .filter((c) => /\d/.test(c[c.length - 1] ?? ''))
    .map((c) => {
      const amount = c[c.length - 1].replace(/[^\d.]/g, '');
      return c.length >= 4 ? { employeeNumber: c[0], employeeName: c[1], phone: c[2], amount } : { employeeNumber: '', employeeName: c[0], phone: c[1], amount };
    });
}

/** Paying net salaries for a month, by M-Pesa (one payout per employee) or by bank. */
export function SalaryRunsPage() {
  const { entity, can, me } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const fp = precision(entity?.functionalCurrency);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: banks = [] } = useBankAccounts();
  const { data = [], isLoading } = useQuery({ queryKey: ['salary-runs', entity?.id], queryFn: () => api.get<SalaryRun[]>('/salary-runs', { entityId: entity!.id }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['salary-runs'] });
  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/salary-runs/${id}/approve`),
    onSuccess: () => (setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <>
      <PageHeader
        title="Salary payments"
        description="Net pay worked out in your payroll is paid here: each employee clears Net Salaries Payable. From an M-Pesa account with payouts on, every employee is paid to their phone and each payment is matched on the statement."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New salary run</Button>}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No salary runs" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Period</th>
                <th>Pay date</th>
                <th>Paid from</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => setViewing(r.id)}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{r.number}</td>
                  <td>{r.period}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{banks.find((b) => b.id === r.bankAccountId)?.name}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="num">{formatAmount(r.total, fp)}</td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'DRAFT' && can('payments.approve') && (
                      <Button size="sm" variant="primary" disabled={r.createdBy === me.id} title={r.createdBy === me.id ? 'Someone else must approve' : undefined} loading={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)}>
                        Approve & pay
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {creating && <SalaryRunForm onClose={() => setCreating(false)} onDone={() => (setCreating(false), refresh())} />}
      {viewing && <SalaryRunDetail id={viewing} onClose={() => setViewing(null)} onChanged={refresh} />}
    </>
  );
}

function SalaryRunForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { entity } = useSession();
  const { data: banks = [] } = useBankAccounts();
  const accounts = banks.filter((b) => b.entityId === entity?.id && b.isActive && b.currency === entity?.functionalCurrency);
  const month = today().slice(0, 7);
  const [f, setF] = useState({ period: month, date: today(), bankAccountId: '', description: '' });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rows = parseRows(text);
  const total = addAll(rows.map((r) => r.amount || '0'));
  const save = useMutation({
    mutationFn: () => api.post('/salary-runs', { entityId: entity!.id, ...f, bankAccountId: f.bankAccountId || accounts[0]?.id, description: f.description || undefined, lines: rows }),
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title="New salary run"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!rows.length} loading={save.isPending} onClick={() => save.mutate()}>Save for approval</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Period">
            <Input type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} />
          </Field>
          <Field label="Pay date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Pay from" className="sm:col-span-2">
            <Select value={f.bankAccountId || accounts[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
              {accounts.map((b) => (
                <option key={b.id} value={b.id}>{b.name}{b.type === 'MOBILE_MONEY' ? ' (M-Pesa)' : ''}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Employees" hint="Paste from your payroll: employee number, name, Safaricom number, net pay — one per line (tab or comma separated)">
          <Textarea rows={8} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'E001, Achieng Otieno, 0722000001, 42000\nE002, Kamau Njoroge, 0722000002, 38500'} />
        </Field>
        {rows.length > 0 && (
          <p className="text-sm text-muted">
            {rows.length} employee{rows.length === 1 ? '' : 's'} · total {formatAmount(total, 2)} {entity?.functionalCurrency}
          </p>
        )}
      </div>
    </Modal>
  );
}

function SalaryRunDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: r } = useQuery({ queryKey: ['salary-run', id], queryFn: () => api.get<SalaryRun>(`/salary-runs/${id}`), refetchInterval: (q) => (q.state.data?.payouts?.some((p) => ['QUEUED', 'SENT'].includes(p.status)) ? 10_000 : false) });
  const voidRun = useMutation({
    mutationFn: (v: { reason: string; date: string }) => api.post(`/salary-runs/${id}/void`, v),
    onSuccess: () => (setVoiding(false), setError(null), queryClient.invalidateQueries({ queryKey: ['salary-run', id] }), onChanged()),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={r ? `${r.number} · salaries ${r.period}` : 'Salary run'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {r?.status === 'POSTED' && can('payments.approve') && <Button variant="ghost" onClick={() => setVoiding(true)}>Void</Button>}
        </>
      }
    >
      {!r ? (
        <Loading />
      ) : (
        <div className="space-y-3 text-sm">
          <ErrorBanner error={error} />
          <p className="flex items-center gap-2">
            <StatusBadge status={r.status} /> {formatAmount(r.total, fp)} {entity?.functionalCurrency} · paid {formatDate(r.date)}
          </p>
          {r.voidReason && <Notice tone="amber">Voided: {r.voidReason}</Notice>}
          <table className="table-base">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Phone</th>
                <th className="num">Net pay</th>
                <th>M-Pesa</th>
              </tr>
            </thead>
            <tbody>
              {r.lines?.map((l) => {
                const p = r.payouts?.find((x) => x.sourceLine === l.lineNo);
                return (
                  <tr key={l.lineNo}>
                    <td>
                      {l.employeeName} {l.employeeNumber && <span className="text-xs text-muted">{l.employeeNumber}</span>}
                    </td>
                    <td className="font-mono text-xs">{l.phone}</td>
                    <td className="num">{formatAmount(l.amount, fp)}</td>
                    <td>
                      {p ? (
                        <>
                          <Badge tone={PAYOUT_TONE[p.status] ?? 'gray'}>{PAYOUT_LABEL[p.status] ?? p.status}</Badge>
                          {p.transactionId && <span className="ml-1 font-mono text-xs">{p.transactionId}</span>}
                          {p.charge && <span className="ml-1 text-xs text-muted">charge {p.charge}</span>}
                          {(p.resultDescription || p.note) && p.status !== 'COMPLETED' && <div className="text-xs text-muted">{p.resultDescription || p.note}</div>}
                        </>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-muted">Failed or unconfirmed payouts are resolved on the M-Pesa page (Banking → M-Pesa → Payouts).</p>
        </div>
      )}
      <ReasonDialog open={voiding} withDate title={`Void ${r?.number ?? ''}`} description="Only possible while no payout has gone; queued payouts are cancelled." confirmLabel="Void run" busy={voidRun.isPending} onClose={() => setVoiding(false)} onConfirm={(v) => voidRun.mutate(v)} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Bank account connections: card payments and bank feeds
// ---------------------------------------------------------------------------------------------

interface CardSettings {
  enabled: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
}
interface FeedSettings {
  enabled: boolean;
  provider: 'MONO' | 'PUSH';
  externalAccountId: string;
  hasSecretKey: boolean;
  hasPushToken: boolean;
  pushUrl: string;
  lastSyncAt: string | null;
  syncFrom: string | null;
  lastError: string;
  pushToken?: string;
}

export function ConnectionsCard({ bankId }: { bankId: string }) {
  const { can } = useSession();
  const manage = can('banking.manage');
  return (
    <div className="space-y-4">
      <CardPaymentsSettings bankId={bankId} manage={manage} />
      <FeedSettingsCard bankId={bankId} manage={manage} />
    </div>
  );
}

function CardPaymentsSettings({ bankId, manage }: { bankId: string; manage: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['card-settings', bankId], queryFn: () => api.get<CardSettings>(`/bank-accounts/${bankId}/cards`) });
  const [f, setF] = useState<{ enabled: boolean | null; secretKey: string; webhookSecret: string }>({ enabled: null, secretKey: '', webhookSecret: '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const enabled = f.enabled ?? data?.enabled ?? false;
  const save = useMutation({
    mutationFn: () => api.patch<CardSettings>(`/bank-accounts/${bankId}/cards`, { enabled, secretKey: f.secretKey || undefined, webhookSecret: f.webhookSecret || undefined }),
    onSuccess: (res) => (queryClient.setQueryData(['card-settings', bankId], res), setF({ enabled: null, secretKey: '', webhookSecret: '' }), setError(null), setSaved(true)),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Card title="Card payments (customer portal)">
      <div className="space-y-3 text-sm">
        <p className="text-muted">Customers can pay invoices by card from their portal link through Stripe&apos;s hosted checkout. Confirmed payments are receipted into this account and applied to the invoice; Stripe&apos;s fees appear when you reconcile its payouts.</p>
        <ErrorBanner error={error} />
        {saved && <Notice tone="green">Saved.</Notice>}
        <Checkbox label="Take card payments into this account" checked={enabled} disabled={!manage} onChange={(v) => (setSaved(false), setF({ ...f, enabled: v }))} />
        {enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Stripe secret key" hint={data?.hasSecretKey ? 'Saved. Leave blank to keep it.' : 'sk_live_… (or sk_test_… to try it)'}>
              <Input type="password" autoComplete="off" value={f.secretKey} disabled={!manage} onChange={(e) => setF({ ...f, secretKey: e.target.value })} />
            </Field>
            <Field label="Webhook signing secret" hint={data?.hasWebhookSecret ? 'Saved. Leave blank to keep it.' : 'whsec_… from the webhook endpoint in Stripe'}>
              <Input type="password" autoComplete="off" value={f.webhookSecret} disabled={!manage} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} />
            </Field>
            {data?.webhookUrl && (
              <Field label="Webhook URL for Stripe" hint="Add it in Stripe (Developers → Webhooks) with the checkout.session events" className="sm:col-span-2">
                <Input readOnly value={data.webhookUrl} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              </Field>
            )}
          </div>
        )}
        {manage && <Button loading={save.isPending} onClick={() => save.mutate()}>Save card settings</Button>}
      </div>
    </Card>
  );
}

function FeedSettingsCard({ bankId, manage }: { bankId: string; manage: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['feed-settings', bankId], queryFn: () => api.get<FeedSettings>(`/bank-accounts/${bankId}/feed`) });
  const [f, setF] = useState<{ enabled: boolean | null; provider: 'MONO' | 'PUSH' | null; externalAccountId: string | null; secretKey: string; syncFrom: string | null }>({ enabled: null, provider: null, externalAccountId: null, secretKey: '', syncFrom: null });
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = f.enabled ?? data?.enabled ?? false;
  const provider = f.provider ?? data?.provider ?? 'PUSH';
  const save = useMutation({
    mutationFn: (rotateToken: boolean) =>
      api.patch<FeedSettings>(`/bank-accounts/${bankId}/feed`, {
        enabled,
        provider,
        externalAccountId: f.externalAccountId ?? undefined,
        secretKey: f.secretKey || undefined,
        syncFrom: f.syncFrom ?? undefined,
        rotateToken,
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(['feed-settings', bankId], res);
      setToken(res.pushToken ?? null);
      setF({ enabled: null, provider: null, externalAccountId: null, secretKey: '', syncFrom: null });
      setError(null);
      setMessage('Saved.');
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ received: number; matched: number }>(`/bank-accounts/${bankId}/feed/sync`),
    onSuccess: (r) => (setMessage(`${r.received} new transaction${r.received === 1 ? '' : 's'}${r.matched ? `, ${r.matched} matched` : ''}.`), queryClient.invalidateQueries({ queryKey: ['feed-settings', bankId] })),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Card title="Bank feed">
      <div className="space-y-3 text-sm">
        <p className="text-muted">Transactions arrive as statement lines without importing files, each once, and are matched to the ledger automatically where they can be.</p>
        <ErrorBanner error={error} />
        {message && <Notice tone="green">{message}</Notice>}
        {data?.lastError && <Notice tone="amber">Last pull failed: {data.lastError}</Notice>}
        <Checkbox label="Receive transactions through a feed" checked={enabled} disabled={!manage} onChange={(v) => setF({ ...f, enabled: v })} />
        {enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Feed">
              <Select value={provider} disabled={!manage} onChange={(e) => setF({ ...f, provider: e.target.value as 'MONO' | 'PUSH' })}>
                <option value="MONO">Mono (open banking, pulled daily)</option>
                <option value="PUSH">Pushed by the bank or a connector</option>
              </Select>
            </Field>
            {provider === 'MONO' ? (
              <>
                <Field label="Connected account id" hint="From Mono Connect, once the account owner has linked the account">
                  <Input value={f.externalAccountId ?? data?.externalAccountId ?? ''} disabled={!manage} onChange={(e) => setF({ ...f, externalAccountId: e.target.value })} />
                </Field>
                <Field label="Mono secret key" hint={data?.hasSecretKey ? 'Saved. Leave blank to keep it.' : undefined}>
                  <Input type="password" autoComplete="off" value={f.secretKey} disabled={!manage} onChange={(e) => setF({ ...f, secretKey: e.target.value })} />
                </Field>
                <Field label="Take transactions from" hint="Earlier transactions are left to statement imports">
                  <Input type="date" value={(f.syncFrom ?? data?.syncFrom ?? '').slice(0, 10)} disabled={!manage} onChange={(e) => setF({ ...f, syncFrom: e.target.value || null })} />
                </Field>
                <div className="flex items-end gap-2">
                  {data?.enabled && data.provider === 'MONO' && <Button loading={sync.isPending} onClick={() => sync.mutate()}>Pull now</Button>}
                  {data?.lastSyncAt && <span className="text-xs text-muted">Last pulled {formatDateTime(data.lastSyncAt)}</span>}
                </div>
              </>
            ) : (
              <>
                <Field label="Endpoint" hint="POST { transactions: [{ id, date, amount, description, reference }] } with Authorization: Bearer <token>" className="sm:col-span-2">
                  <Input readOnly value={data?.pushUrl ?? ''} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                </Field>
                {token && (
                  <Notice tone="amber">
                    Token (shown once): <span className="select-all font-mono text-xs">{token}</span>
                  </Notice>
                )}
              </>
            )}
          </div>
        )}
        {manage && (
          <div className="flex gap-2">
            <Button loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save feed settings</Button>
            {enabled && provider === 'PUSH' && data?.hasPushToken && <Button variant="ghost" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>New token</Button>}
          </div>
        )}
      </div>
    </Card>
  );
}

/** M-Pesa charge bands for payouts (KES): each payout's charge is booked automatically. */
export function TariffEditor({ value, onChange, chargesAccountId, onAccount, disabled }: { value: { upTo: string; charge: string }[]; onChange: (v: { upTo: string; charge: string }[]) => void; chargesAccountId: string; onAccount: (id: string) => void; disabled?: boolean }) {
  const { data: accounts = [] } = useAccounts();
  return (
    <div className="space-y-2 sm:col-span-2">
      <p className="text-xs text-muted">M-Pesa charges per payout, by amount band (from your Safaricom tariff). Each completed payout&apos;s charge is booked and matched on the statement automatically. Leave empty to record charges by hand.</p>
      {value.map((b, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="text-muted">Up to KES</span>
          <Input className="h-8 w-32 text-right text-xs" inputMode="numeric" value={b.upTo} disabled={disabled} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, upTo: e.target.value.replace(/[^\d]/g, '') } : x)))} aria-label="Band upper amount" />
          <span className="text-muted">charge</span>
          <Input className="h-8 w-24 text-right text-xs" inputMode="decimal" value={b.charge} disabled={disabled} onChange={(e) => amountPattern.test(e.target.value) && onChange(value.map((x, j) => (j === i ? { ...x, charge: e.target.value } : x)))} aria-label="Charge" />
          {!disabled && <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove band">✕</Button>}
        </div>
      ))}
      {!disabled && <Button size="sm" variant="ghost" onClick={() => onChange([...value, { upTo: '', charge: '' }])}>+ Add band</Button>}
      {value.length > 0 && (
        <Field label="Charges account">
          <Select value={chargesAccountId} disabled={disabled} onChange={(e) => onAccount(e.target.value)}>
            <option value="">Bank Charges (6800)</option>
            <AccountOptions accounts={accounts} classes={['EXPENSE']} />
          </Select>
        </Field>
      )}
    </div>
  );
}
