'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { TariffEditor } from './money';
import { formatAmount, formatDate, formatDateTime } from '@/modules/finance/ui/lib/format';
import { useParties } from '@/modules/finance/ui/lib/commercial-hooks';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap, Tabs, Textarea } from './ui';

/** Opens the printable invoice in a new tab (the PDF button gives the server-made PDF). */
export function openDocument(id: string, print = true) {
  window.open(`/api/v1/finance/invoices/${id}/document${print ? '?print=1' : ''}`, '_blank', 'noopener');
}

// ----- Invoice actions: email and M-Pesa prompt ----------------------------------------------------

interface SalesDoc {
  id: string;
  number: string;
  kind: string;
  status: string;
  currency: string;
  amountDue: string;
  paymentStatus: string;
  emailedAt?: string | null;
  party?: { email?: string; phone?: string } | null;
}

export function SalesDocumentActions({ d, onChanged }: { d: SalesDoc; onChanged: () => void }) {
  const { can } = useSession();
  const [dialog, setDialog] = useState<null | 'email' | 'mpesa' | 'sms'>(null);
  const posted = d.status === 'POSTED';
  const payable = posted && d.kind === 'SALES_INVOICE' && d.currency === 'KES' && d.paymentStatus !== 'PAID';
  return (
    <>
      <Button onClick={() => openDocument(d.id)}>Print</Button>
      {d.status !== 'DRAFT' && <Button onClick={() => window.open(`/api/v1/finance/invoices/${d.id}/pdf`, '_blank', 'noopener')}>PDF</Button>}
      {posted && can('ar.manage') && <Button onClick={() => setDialog('email')}>{d.emailedAt ? 'Email again' : 'Email to customer'}</Button>}
      {posted && can('ar.manage') && <Button onClick={() => setDialog('sms')}>Text to customer</Button>}
      {payable && can('ar.manage') && <Button onClick={() => setDialog('mpesa')}>Request M-Pesa payment</Button>}
      {dialog === 'sms' && <SmsDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'email' && <EmailDialog d={d} onClose={() => setDialog(null)} onSent={onChanged} />}
      {dialog === 'mpesa' && <MpesaDialog d={d} onClose={() => setDialog(null)} onPaid={onChanged} />}
    </>
  );
}

function EmailDialog({ d, onClose, onSent }: { d: SalesDoc; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(d.party?.email ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string[] | null>(null);
  const send = useMutation({
    mutationFn: () =>
      api.post<{ to: string[] }>(`/invoices/${d.id}/email`, {
        to: to
          .split(/[;,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        message: message || undefined,
      }),
    onSuccess: (res) => {
      setSent(res.to);
      onSent();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Email ${d.number}`}
      footer={
        sent ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} disabled={!to.trim()} onClick={() => send.mutate()}>Send</Button>
          </>
        )
      }
    >
      {sent ? (
        <Notice tone="green">Sent to {sent.join(', ')}. The email links to a private page where the customer can view, download and pay the document.</Notice>
      ) : (
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <Field label="To" hint="Separate several addresses with commas.">
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="accounts@customer.co.ke" />
          </Field>
          <Field label="Message (optional)">
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Thank you for your business." />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function SmsDialog({ d, onClose }: { d: SalesDoc; onClose: () => void }) {
  const [to, setTo] = useState(d.party?.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api.post<{ to: string }>(`/invoices/${d.id}/sms`, { to: to || undefined }),
    onSuccess: (res) => setSent(res.to),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Text ${d.number}`}
      footer={
        sent ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} disabled={!to.trim()} onClick={() => send.mutate()}>Send</Button>
          </>
        )
      }
    >
      {sent ? (
        <Notice tone="green">Texted to {sent}, with a private link to view and pay.</Notice>
      ) : (
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <Field label="Mobile number" hint="The message carries the amount, due date and a private link to view and pay.">
            <Input inputMode="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0712 345 678" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

interface PromptStatus {
  status: 'PENDING' | 'FAILED' | 'UNMATCHED' | 'RECEIPTED' | 'IGNORED';
  resultDescription?: string;
  transactionId?: string | null;
}

/** Sends a payment prompt and follows it until the customer enters their PIN or cancels. */
function MpesaDialog({ d, onClose, onPaid }: { d: SalesDoc; onClose: () => void; onPaid: () => void }) {
  const due = Math.ceil(Number(d.amountDue));
  const [phone, setPhone] = useState(d.party?.phone ?? '');
  const [amount, setAmount] = useState(String(due));
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/invoices/${d.id}/mpesa-request`, { phone, amount }),
    onSuccess: (res) => setRequestId(res.id),
    onError: (err) => setError(errorMessage(err)),
  });
  const status = useQuery({
    queryKey: ['mpesa-status', requestId],
    queryFn: () => api.get<PromptStatus>(`/mpesa/transactions/${requestId}/status`),
    enabled: !!requestId,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'PENDING' ? false : 3000),
  });
  const done = status.data && status.data.status !== 'PENDING';
  useEffect(() => {
    if (done && status.data?.status !== 'FAILED') onPaid();
  }, [done, status.data?.status, onPaid]);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Request M-Pesa payment for ${d.number}`}
      footer={
        requestId ? (
          <Button variant="primary" onClick={onClose}>{done ? 'Done' : 'Close'}</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={request.isPending} disabled={!phone.trim() || !amount} onClick={() => request.mutate()}>Send prompt</Button>
          </>
        )
      }
    >
      {!requestId ? (
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <p className="text-sm text-muted">The customer gets a prompt on their phone to enter their M-Pesa PIN. When they pay, the receipt is recorded and matched automatically.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Safaricom number">
              <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" />
            </Field>
            <Field label="Amount (KES)" hint={`Up to ${due.toLocaleString()}`}>
              <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            </Field>
          </div>
        </div>
      ) : !status.data || status.data.status === 'PENDING' ? (
        <Notice>Prompt sent. Waiting for the customer to enter their PIN…</Notice>
      ) : status.data.status === 'FAILED' ? (
        <Notice tone="amber">Not paid: {status.data.resultDescription || 'the prompt was cancelled or timed out'}.</Notice>
      ) : status.data.status === 'RECEIPTED' ? (
        <Notice tone="green">Paid. M-Pesa reference {status.data.transactionId}; the receipt has been recorded against {d.number}.</Notice>
      ) : (
        <Notice tone="amber">Paid (reference {status.data.transactionId}), but the receipt could not be recorded automatically. It is waiting in M-Pesa payments.</Notice>
      )}
    </Modal>
  );
}

// ----- M-Pesa settings on a mobile-money account ---------------------------------------------------

interface MpesaSettings {
  enabled: boolean;
  environment: 'sandbox' | 'production';
  shortCode: string;
  shortCodeType: 'PAYBILL' | 'TILL';
  partyB: string;
  hasConsumerKey: boolean;
  hasConsumerSecret: boolean;
  hasPasskey: boolean;
  postAsUserId: string | null;
  registeredAt: string | null;
  payouts: {
    enabled: boolean;
    shortCode: string;
    initiatorName: string;
    hasSecurityCredential: boolean;
    dailyLimit: string | null;
    lowBalanceAlert: string | null;
    tariff: { upTo: string; charge: string }[];
    chargesAccountId: string | null;
    balance: { available: string | null; accounts: { name: string; currency: string; available: string }[]; checkedAt: string } | null;
  };
  callbackUrls: { stk: string; confirmation: string; validation: string } | null;
}

export function MpesaSettingsCard({ bankId }: { bankId: string }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['mpesa-settings', bankId], queryFn: () => api.get<MpesaSettings>(`/bank-accounts/${bankId}/mpesa`) });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: string; name: string; isActive: boolean }[]>('/users'), enabled: can('users.manage') });
  const [form, setForm] = useState<Partial<MpesaSettings> & { consumerKey?: string; consumerSecret?: string; passkey?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = can('banking.manage') && can('org.manage');
  const v = { ...data, ...form } as MpesaSettings & { consumerKey?: string; consumerSecret?: string; passkey?: string };
  const save = useMutation({
    mutationFn: () =>
      api.patch<MpesaSettings>(`/bank-accounts/${bankId}/mpesa`, {
        enabled: v.enabled,
        environment: v.environment,
        shortCode: v.shortCode,
        shortCodeType: v.shortCodeType,
        partyB: v.partyB || undefined,
        consumerKey: form.consumerKey || undefined,
        consumerSecret: form.consumerSecret || undefined,
        passkey: form.passkey || undefined,
        postAsUserId: v.postAsUserId || undefined,
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(['mpesa-settings', bankId], res);
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      setForm({});
      setError(null);
      setNotice(res.enabled ? (res.registeredAt ? 'Saved.' : 'Saved. Now register the payment notification URLs so paybill payments arrive automatically.') : 'M-Pesa is disconnected.');
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const register = useMutation({
    mutationFn: () => api.post<MpesaSettings>(`/bank-accounts/${bankId}/mpesa/register`),
    onSuccess: (res) => {
      queryClient.setQueryData(['mpesa-settings', bankId], res);
      setNotice('Safaricom will now send paybill and till payments here.');
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  if (isLoading || !data) return <Loading />;
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card
      title="M-Pesa (Safaricom Daraja)"
      actions={data.enabled ? <Badge tone={data.environment === 'production' ? 'green' : 'amber'}>{data.environment === 'production' ? 'Live' : 'Sandbox'}</Badge> : <Badge>Not connected</Badge>}
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        {notice && <Notice tone="green">{notice}</Notice>}
        <p className="text-sm text-muted">
          Customers pay by paybill or till, or approve a prompt on their phone. Each payment becomes a receipt against the invoice they name and a statement line already matched here, so this account reconciles itself. Payments that cannot be matched wait in{' '}
          <Link className="text-brand-700 hover:underline" href="/finance/banking/mpesa">M-Pesa payments</Link>.
        </p>
        <Checkbox label="Take payments through M-Pesa on this account" checked={!!v.enabled} disabled={!manage} onChange={(enabled) => set({ enabled })} />
        {v.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select value={v.shortCodeType} disabled={!manage} onChange={(e) => set({ shortCodeType: e.target.value as 'PAYBILL' | 'TILL' })}>
                <option value="PAYBILL">Paybill</option>
                <option value="TILL">Buy Goods till</option>
              </Select>
            </Field>
            <Field label="Environment">
              <Select value={v.environment} disabled={!manage} onChange={(e) => set({ environment: e.target.value as 'sandbox' | 'production' })}>
                <option value="sandbox">Sandbox (testing)</option>
                <option value="production">Production (live money)</option>
              </Select>
            </Field>
            <Field label={v.shortCodeType === 'TILL' ? 'Store number (head office)' : 'Paybill number'}>
              <Input value={v.shortCode ?? ''} disabled={!manage} onChange={(e) => set({ shortCode: e.target.value.trim() })} placeholder="174379" />
            </Field>
            {v.shortCodeType === 'TILL' && (
              <Field label="Till number" hint="Where prompts pay into, if different from the store number.">
                <Input value={v.partyB ?? ''} disabled={!manage} onChange={(e) => set({ partyB: e.target.value.trim() })} />
              </Field>
            )}
            <Field label="Consumer key" hint={data.hasConsumerKey ? 'Saved. Leave blank to keep it.' : 'From your app on developer.safaricom.co.ke'}>
              <Input type="password" autoComplete="off" value={form.consumerKey ?? ''} disabled={!manage} onChange={(e) => set({ consumerKey: e.target.value })} />
            </Field>
            <Field label="Consumer secret" hint={data.hasConsumerSecret ? 'Saved. Leave blank to keep it.' : undefined}>
              <Input type="password" autoComplete="off" value={form.consumerSecret ?? ''} disabled={!manage} onChange={(e) => set({ consumerSecret: e.target.value })} />
            </Field>
            <Field label="Lipa na M-Pesa Online passkey" hint={data.hasPasskey ? 'Saved. Leave blank to keep it.' : undefined}>
              <Input type="password" autoComplete="off" value={form.passkey ?? ''} disabled={!manage} onChange={(e) => set({ passkey: e.target.value })} />
            </Field>
            {users.data && (
              <Field label="Record receipts as" hint="Receipts are posted in this user's name; they need permission to manage receivables.">
                <Select value={v.postAsUserId ?? ''} disabled={!manage} onChange={(e) => set({ postAsUserId: e.target.value || null })}>
                  <option value="">Me</option>
                  {users.data
                    .filter((u) => u.isActive)
                    .map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                </Select>
              </Field>
            )}
          </div>
        )}
        {data.enabled && data.callbackUrls && (
          <div className="rounded-md border border-line bg-gray-50 p-3 text-xs">
            <p className="font-medium text-ink">Payment notifications {data.registeredAt ? `registered ${formatDateTime(data.registeredAt)}` : 'not registered yet'}</p>
            <p className="mt-1 break-all text-muted">Confirmation URL: {data.callbackUrls.confirmation}</p>
            <p className="mt-1 text-muted">These addresses contain a secret; do not share them.</p>
          </div>
        )}
        {manage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
            {data.enabled && <Button type="button" loading={register.isPending} onClick={() => register.mutate()}>{data.registeredAt ? 'Register URLs again' : 'Register payment URLs'}</Button>}
          </div>
        ) : (
          <p className="text-xs text-muted">Only organisation administrators can change payment connections.</p>
        )}
      </form>
      {data.enabled && <PayoutSettings bankId={bankId} settings={data} manage={manage} />}
    </Card>
  );
}

/** Paying suppliers and reimbursing claims from this account (B2C and B2B). */
function PayoutSettings({ bankId, settings, manage }: { bankId: string; settings: MpesaSettings; manage: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    enabled: settings.payouts.enabled,
    shortCode: settings.payouts.shortCode,
    initiatorName: settings.payouts.initiatorName,
    securityCredential: '',
    dailyLimit: settings.payouts.dailyLimit ?? '',
    lowBalanceAlert: settings.payouts.lowBalanceAlert ?? '',
    tariff: settings.payouts.tariff ?? [],
    chargesAccountId: settings.payouts.chargesAccountId ?? '',
  });
  const [balanceNote, setBalanceNote] = useState<string | null>(null);
  const checkBalance = useMutation({
    mutationFn: () => api.post(`/bank-accounts/${bankId}/mpesa/balance`),
    onSuccess: () => {
      setBalanceNote('Asked M-Pesa; the balance usually arrives within a minute.');
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['mpesa-settings', bankId] }), 15_000);
    },
    onError: (err) => setBalanceNote(errorMessage(err)),
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch<MpesaSettings>(`/bank-accounts/${bankId}/mpesa/payouts`, {
        ...form,
        securityCredential: form.securityCredential || undefined,
        dailyLimit: form.dailyLimit || null,
        lowBalanceAlert: form.lowBalanceAlert || null,
        tariff: form.tariff.filter((b) => b.upTo && b.charge !== ''),
        chargesAccountId: form.chargesAccountId || null,
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(['mpesa-settings', bankId], res);
      setForm((f) => ({ ...f, securityCredential: '' }));
      setError(null);
      setSaved(true);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const set = (patch: Partial<typeof form>) => (setSaved(false), setForm((f) => ({ ...f, ...patch })));
  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Paying out</h3>
      <p className="text-sm text-muted">
        Supplier payments made by mobile money from this account, customer refunds, salaries and expense claims reimbursed from it are sent through M-Pesa when they are released: to phones (B2C) or to paybills and tills (B2B). Each payout is matched on the statement once Safaricom confirms it.
      </p>
      <ErrorBanner error={error} />
      {saved && <Notice tone="green">Saved.</Notice>}
      {settings.payouts.enabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-gray-50 p-3 text-sm">
          <div>
            <p className="text-xs text-muted">Float available</p>
            <p className="text-lg font-semibold tabular-nums">{settings.payouts.balance?.available ? `KES ${Number(settings.payouts.balance.available).toLocaleString('en-KE', { minimumFractionDigits: 2 })}` : 'Not checked yet'}</p>
            {settings.payouts.balance && <p className="text-xs text-muted">as at {formatDateTime(settings.payouts.balance.checkedAt)} · checked daily</p>}
          </div>
          <Button size="sm" loading={checkBalance.isPending} onClick={() => checkBalance.mutate()}>Check balance now</Button>
          {balanceNote && <span className="text-xs text-muted">{balanceNote}</span>}
        </div>
      )}
      <Checkbox label="Pay out through M-Pesa from this account" checked={form.enabled} disabled={!manage} onChange={(enabled) => set({ enabled })} />
      {form.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Disbursement short code" hint="The B2C/B2B short code holding the float">
            <Input value={form.shortCode} disabled={!manage} onChange={(e) => set({ shortCode: e.target.value.trim() })} />
          </Field>
          <Field label="API initiator name">
            <Input value={form.initiatorName} disabled={!manage} onChange={(e) => set({ initiatorName: e.target.value })} />
          </Field>
          <Field label="Security credential" hint={settings.payouts.hasSecurityCredential ? 'Saved. Leave blank to keep it.' : "The initiator password encrypted with Safaricom's certificate (generate it on the Daraja portal)"} className="sm:col-span-2">
            <Textarea rows={2} autoComplete="off" value={form.securityCredential} disabled={!manage} onChange={(e) => set({ securityCredential: e.target.value })} />
          </Field>
          <Field label="Daily limit (KES)" hint="Blank for no limit; releases that would go over it are refused">
            <Input inputMode="numeric" value={form.dailyLimit} disabled={!manage} onChange={(e) => set({ dailyLimit: e.target.value.replace(/[^\d]/g, '') })} />
          </Field>
          <Field label="Low float alert (KES)" hint="Approvers are notified when the float falls below this">
            <Input inputMode="numeric" value={form.lowBalanceAlert} disabled={!manage} onChange={(e) => set({ lowBalanceAlert: e.target.value.replace(/[^\d]/g, '') })} />
          </Field>
          <TariffEditor value={form.tariff} onChange={(tariff) => set({ tariff })} chargesAccountId={form.chargesAccountId} onAccount={(chargesAccountId) => set({ chargesAccountId })} disabled={!manage} />
        </div>
      )}
      {manage && <Button loading={save.isPending} onClick={() => save.mutate()}>Save payout settings</Button>}
    </div>
  );
}

interface Payout {
  id: string;
  sourceType: 'Payment' | 'ExpenseClaim';
  sourceId: string;
  sourceNumber: string;
  payeeName: string;
  payeeType: 'PHONE' | 'PAYBILL' | 'TILL';
  payeeNumber: string;
  accountReference: string;
  amount: string;
  status: 'QUEUED' | 'SENT' | 'COMPLETED' | 'FAILED' | 'CHECK' | 'CANCELLED';
  transactionId: string | null;
  resultDescription: string;
  note: string;
  createdAt: string;
  completedAt: string | null;
}

const PAYOUT_TONE: Record<Payout['status'], 'green' | 'amber' | 'red' | 'gray' | 'blue'> = { COMPLETED: 'green', SENT: 'blue', QUEUED: 'blue', FAILED: 'red', CHECK: 'amber', CANCELLED: 'gray' };
const PAYOUT_LABEL: Record<Payout['status'], string> = { COMPLETED: 'Paid', SENT: 'Sent, awaiting M-Pesa', QUEUED: 'Queued', FAILED: 'Failed', CHECK: 'Unconfirmed', CANCELLED: 'Cancelled' };

/** Retry or cancel a payout; unconfirmed ones need the user to confirm the money did not go. */
function PayoutActions({ payout, onDone }: { payout: Payout; onDone: () => void }) {
  const { can } = useSession();
  const [confirming, setConfirming] = useState<null | 'retry' | 'cancel'>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (kind: 'retry' | 'cancel') => api.post(`/mpesa/payouts/${payout.id}/${kind}`, kind === 'retry' ? { confirmNotPaid: payout.status === 'CHECK' } : { confirmNotPaid: payout.status === 'CHECK', reason }),
    onSuccess: () => (setConfirming(null), setError(null), onDone()),
    onError: (err) => setError(errorMessage(err)),
  });
  const ask = useMutation({
    mutationFn: () => api.post(`/mpesa/payouts/${payout.id}/check`),
    onSuccess: () => (setError(null), setTimeout(onDone, 15_000)),
    onError: (err) => setError(errorMessage(err)),
  });
  const permitted = can(payout.sourceType === 'Payment' ? 'payments.approve' : 'expenses.pay');
  if (!permitted || !['FAILED', 'CHECK', 'QUEUED', 'SENT'].includes(payout.status)) return null;
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-1">
        {(payout.status === 'CHECK' || payout.status === 'SENT') && (
          <Button size="sm" variant="ghost" loading={ask.isPending} disabled={ask.isSuccess} onClick={() => ask.mutate()}>
            {ask.isSuccess ? 'Asked M-Pesa' : 'Ask M-Pesa'}
          </Button>
        )}
        {!confirming && error && <span className="text-xs text-red-700">{error}</span>}
        {(payout.status === 'FAILED' || payout.status === 'CHECK') && <Button size="sm" onClick={() => setConfirming('retry')}>Send again</Button>}
        {payout.sourceType === 'Payment' && payout.status !== 'SENT' && <Button size="sm" variant="ghost" onClick={() => setConfirming('cancel')}>Cancel</Button>}
      </span>
      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirming === 'retry' ? `Send ${payout.sourceNumber} again` : `Cancel the payout for ${payout.sourceNumber}`}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Back</Button>
              <Button variant="primary" loading={act.isPending} disabled={confirming === 'cancel' && reason.trim().length < 3} onClick={() => act.mutate(confirming)}>
                {confirming === 'retry' ? 'Send again' : 'Cancel payout'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <ErrorBanner error={error} />
            {payout.status === 'CHECK' && (
              <Notice tone="amber">M-Pesa never confirmed this payout, so the money may already have gone. Check the M-Pesa statement for KES {payout.amount} to {payout.payeeName} first; continue only if it was not paid.</Notice>
            )}
            {confirming === 'retry' ? (
              <p>
                KES {payout.amount} will be sent to {payout.payeeName} ({payout.payeeNumber}) again.
              </p>
            ) : (
              <>
                <p>No money will be sent. Void the payment afterwards, or pay the supplier another way.</p>
                <Field label="Reason">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** On a supplier payment: where its M-Pesa payout stands. */
export function PayoutCard({ sourceId }: { sourceId: string }) {
  const queryClient = useQueryClient();
  const { data: payout } = useQuery({
    queryKey: ['payout', sourceId],
    queryFn: () => api.get<Payout | null>(`/mpesa/payouts/by-source/${sourceId}`),
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'SENT'].includes(q.state.data.status) ? 5000 : false),
  });
  if (!payout) return null;
  return (
    <Card title="M-Pesa payout" actions={<PayoutActions payout={payout} onDone={() => queryClient.invalidateQueries({ queryKey: ['payout', sourceId] })} />}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={PAYOUT_TONE[payout.status]}>{PAYOUT_LABEL[payout.status]}</Badge>
        <span>
          KES {payout.amount} to {payout.payeeName} ·{' '}
          {payout.payeeType === 'PHONE' ? payout.payeeNumber : `${payout.payeeType === 'TILL' ? 'till' : 'paybill'} ${payout.payeeNumber}${payout.accountReference ? `, account ${payout.accountReference}` : ''}`}
        </span>
        {payout.transactionId && <span className="text-muted">M-Pesa ref {payout.transactionId}</span>}
      </div>
      {(payout.resultDescription || payout.note) && payout.status !== 'COMPLETED' && <p className="mt-2 text-xs text-muted">{payout.note || payout.resultDescription}</p>}
    </Card>
  );
}

function PayoutsTable() {
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const { data = [], isLoading } = useQuery({ queryKey: ['payouts', status], queryFn: () => api.get<Payout[]>('/mpesa/payouts', { status: status || undefined, limit: 200 }) });
  return (
    <>
      <Select className="mb-3 w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="">All payouts</option>
        <option value="CHECK">Unconfirmed</option>
        <option value="FAILED">Failed</option>
        <option value="SENT">Awaiting M-Pesa</option>
        <option value="COMPLETED">Paid</option>
        <option value="CANCELLED">Cancelled</option>
      </Select>
      {isLoading ? (
        <Loading />
      ) : !data.length ? (
        <Empty title="No payouts">Supplier payments by mobile money and M-Pesa reimbursements appear here.</Empty>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Date</th>
                <th>For</th>
                <th>To</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="whitespace-nowrap">{formatDateTime(p.completedAt ?? p.createdAt)}</td>
                  <td>
                    <Link className="text-brand-700 hover:underline" href={p.sourceType === 'Payment' ? `/purchases/payments/${p.sourceId}` : '/expenses'}>{p.sourceNumber}</Link>
                    <div className="text-xs text-muted">{p.sourceType === 'Payment' ? 'Supplier payment' : 'Expense claim'}</div>
                  </td>
                  <td>
                    {p.payeeName}
                    <div className="text-xs text-muted">{p.payeeType === 'PHONE' ? p.payeeNumber : `${p.payeeType === 'TILL' ? 'Till' : 'Paybill'} ${p.payeeNumber}${p.accountReference ? ` · ${p.accountReference}` : ''}`}</div>
                  </td>
                  <td>
                    <Badge tone={PAYOUT_TONE[p.status]}>{PAYOUT_LABEL[p.status]}</Badge>
                    {p.transactionId && <div className="text-xs text-muted">{p.transactionId}</div>}
                    {(p.note || p.resultDescription) && p.status !== 'COMPLETED' && <div className="mt-1 max-w-64 text-xs text-muted">{p.note || p.resultDescription}</div>}
                  </td>
                  <td className="num">{formatAmount(p.amount, precision('KES'))}</td>
                  <td className="text-right">
                    <PayoutActions payout={p} onDone={() => queryClient.invalidateQueries({ queryKey: ['payouts'] })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}

// ----- M-Pesa payments queue -------------------------------------------------------------------------

interface MpesaTx {
  id: string;
  kind: 'C2B' | 'STK';
  transactionId: string | null;
  amount: string | null;
  phone: string;
  payerName: string;
  accountReference: string;
  transactionDate: string | null;
  status: PromptStatus['status'];
  resultDescription: string;
  note: string;
  customer: { id: string; name: string; code: string } | null;
  invoiceNumber: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  requestedVia: 'app' | 'portal' | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = { RECEIPTED: 'green', UNMATCHED: 'amber', PENDING: 'blue', FAILED: 'gray', IGNORED: 'gray' };
const STATUS_LABEL: Record<string, string> = { RECEIPTED: 'Receipted', UNMATCHED: 'To assign', PENDING: 'Waiting for PIN', FAILED: 'Not paid', IGNORED: 'Set aside' };

export function MpesaPaymentsPage() {
  const [tab, setTab] = useState<'in' | 'out'>('in');
  return (
    <>
      <PageHeader title="M-Pesa" description="Money received through paybills, tills and payment prompts, and money paid out to suppliers and staff." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'in', label: 'Received' }, { id: 'out', label: 'Paid out' }]} />
      {tab === 'in' ? <ReceivedPayments /> : <PayoutsTable />}
    </>
  );
}

function ReceivedPayments() {
  const { entity } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('UNMATCHED');
  const [assigning, setAssigning] = useState<MpesaTx | null>(null);
  const [ignoring, setIgnoring] = useState<MpesaTx | null>(null);
  const { data = [], isLoading, error } = useQuery({ queryKey: ['mpesa-transactions', status], queryFn: () => api.get<MpesaTx[]>('/mpesa/transactions', { status: status || undefined, limit: 200 }) });
  const refresh = () => {
    for (const key of [['mpesa-transactions'], ['bank-accounts'], ['documents']]) queryClient.invalidateQueries({ queryKey: key });
  };
  return (
    <>
      <p className="mb-3 text-sm text-muted">Receipts are recorded automatically when the payer names an invoice or customer code; the rest wait here to be assigned.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[
          ['UNMATCHED', 'To assign'],
          ['RECEIPTED', 'Receipted'],
          ['PENDING', 'Waiting for PIN'],
          ['FAILED', 'Not paid'],
          ['IGNORED', 'Set aside'],
          ['', 'All'],
        ].map(([id, label]) => (
          <Button key={id} variant={status === id ? 'primary' : 'secondary'} onClick={() => setStatus(id)}>{label}</Button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Loading />
      ) : !data.length ? (
        <Empty title={status === 'UNMATCHED' ? 'Nothing to assign' : 'No payments'}>{status === 'UNMATCHED' ? 'Every M-Pesa payment has been matched to a customer.' : 'Payments appear here as Safaricom confirms them.'}</Empty>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>From</th>
                <th>Account typed</th>
                <th>Customer / invoice</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap">{formatDateTime(t.transactionDate ?? t.createdAt)}</td>
                  <td className="font-mono text-xs">
                    {t.transactionId ?? '—'}
                    <div className="font-sans text-muted">{t.kind === 'STK' ? `Prompt${t.requestedVia === 'portal' ? ' from portal' : ''}` : 'Paybill / till'}</div>
                  </td>
                  <td>
                    {t.payerName || '—'}
                    <div className="text-xs text-muted">{t.phone}</div>
                  </td>
                  <td className="text-xs">{t.accountReference || '—'}</td>
                  <td>
                    {t.customer ? <Link className="text-brand-700 hover:underline" href={`/finance/sales/customers/${t.customer.id}`}>{t.customer.name}</Link> : '—'}
                    {t.invoiceNumber && t.invoiceId && (
                      <div className="text-xs">
                        <Link className="text-brand-700 hover:underline" href={`/finance/sales/invoices/${t.invoiceId}`}>{t.invoiceNumber}</Link>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                    {(t.note || (t.status === 'FAILED' && t.resultDescription)) && <div className="mt-1 max-w-56 text-xs text-muted">{t.note || t.resultDescription}</div>}
                  </td>
                  <td className="num">{t.amount ? formatAmount(t.amount, precision('KES')) : '—'}</td>
                  <td className="whitespace-nowrap text-right">
                    {t.status === 'RECEIPTED' && t.paymentId && <Link className="text-sm text-brand-700 hover:underline" href={`/finance/sales/receipts/${t.paymentId}`}>Receipt</Link>}
                    {t.status === 'UNMATCHED' && (
                      <span className="inline-flex gap-1">
                        <Button onClick={() => setAssigning(t)}>Assign</Button>
                        <Button variant="ghost" onClick={() => setIgnoring(t)}>Set aside</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {assigning && entity && <AssignDialog tx={assigning} entityId={entity.id} onClose={() => setAssigning(null)} onDone={refresh} />}
      {ignoring && <IgnoreDialog tx={ignoring} onClose={() => setIgnoring(null)} onDone={refresh} />}
    </>
  );
}

function AssignDialog({ tx, entityId, onClose, onDone }: { tx: MpesaTx; entityId: string; onClose: () => void; onDone: () => void }) {
  const { data: customers = [] } = useParties('CUSTOMER', entityId);
  const [customerId, setCustomerId] = useState(tx.customer?.id ?? '');
  const [invoiceId, setInvoiceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const invoices = useQuery({
    queryKey: ['open-invoices', customerId],
    queryFn: () => api.get<{ items: { id: string; number: string; amountDue: string; dueDate: string }[] }>('/invoices', { kind: 'SALES_INVOICE', partyId: customerId, status: 'POSTED', open: true, pageSize: 100 }),
    enabled: !!customerId,
  });
  const assign = useMutation({
    mutationFn: () => api.post<MpesaTx>(`/mpesa/transactions/${tx.id}/assign`, { customerId, invoiceId: invoiceId || null }),
    onSuccess: (res) => {
      onDone();
      if (res.status === 'RECEIPTED') onClose();
      else setError(res.note || 'The receipt could not be recorded');
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign M-Pesa ${tx.transactionId}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={assign.isPending} disabled={!customerId} onClick={() => assign.mutate()}>Record receipt</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <p className="text-sm text-muted">
          KES {tx.amount} from {tx.payerName || tx.phone}
          {tx.accountReference && <>, account typed “{tx.accountReference}”</>}.
        </p>
        <Field label="Customer">
          <Select value={customerId} onChange={(e) => (setCustomerId(e.target.value), setInvoiceId(''))}>
            <option value="">Choose…</option>
            {customers
              .filter((c) => c.currency === 'KES' && c.isActive)
              .map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
          </Select>
        </Field>
        {customerId && (
          <Field label="Invoice" hint="Leave on account to allocate later.">
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">On account</option>
              {(invoices.data?.items ?? []).map((i) => (
                <option key={i.id} value={i.id}>{i.number} · due {formatDate(i.dueDate)} · {formatAmount(i.amountDue, 2)} open</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function IgnoreDialog({ tx, onClose, onDone }: { tx: MpesaTx; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ignore = useMutation({
    mutationFn: () => api.post(`/mpesa/transactions/${tx.id}/ignore`, { note }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Set aside M-Pesa ${tx.transactionId}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={ignore.isPending} disabled={note.trim().length < 3} onClick={() => ignore.mutate()}>Set aside</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <p className="text-sm text-muted">No receipt is recorded. The statement line stays on the M-Pesa account for you to explain when reconciling (a refund, a non-customer deposit).</p>
        <Field label="Reason">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Refunded to sender" />
        </Field>
      </div>
    </Modal>
  );
}

// ----- Customer portal links -------------------------------------------------------------------------

interface PortalLinkRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  views: number;
  createdByName: string | null;
  active: boolean;
}

/** Private portal links for a customer (invoices, M-Pesa) or a supplier (the vendor portal). */
export function PortalLinksCard({ customerId, supplierId }: { customerId?: string; supplierId?: string }) {
  const vendor = Boolean(supplierId);
  const partyId = (supplierId ?? customerId)!;
  const base = vendor ? `/suppliers/${partyId}/portal-links` : `/customers/${partyId}/portal-links`;
  const manage = vendor ? 'ap.manage' : 'ar.manage';
  const { entity, can } = useSession();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data = [] } = useQuery({ queryKey: ['portal-links', partyId], queryFn: () => api.get<PortalLinkRow[]>(base) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['portal-links', partyId] });
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>(base, vendor ? { days: 180 } : { entityId: entity!.id, days: 90 }),
    onSuccess: (res) => {
      setCreated(res.url);
      setCopied(false);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(vendor ? `/supplier-portal-links/${id}/revoke` : `/portal-links/${id}/revoke`), onSuccess: refresh, onError: (err) => setError(errorMessage(err)) });
  const active = data.filter((l) => l.active);
  return (
    <Card
      title={vendor ? 'Vendor portal' : 'Customer portal'}
      actions={can(manage) && <Button loading={create.isPending} onClick={() => create.mutate()}>New link</Button>}
    >
      <ErrorBanner error={error} />
      <p className="text-sm text-muted">{vendor ? 'A private link where the supplier follows their orders, the invoices entered for them, what is owed and the payments made, and sends in new invoices, without an account.' : 'A private link where the customer sees their open invoices, downloads them and pays by M-Pesa, without an account. Emailing an invoice creates one automatically.'}</p>
      {created && (
        <div className="mt-3 rounded-md border border-brand-200 bg-brand-50 p-3 text-sm">
          <p className="font-medium">Copy this link now; it is not shown again.</p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={created} onFocus={(e) => e.target.select()} />
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
      {!!data.length && (
        <table className="table-base mt-3">
          <thead>
            <tr>
              <th>Created</th>
              <th>Expires</th>
              <th>Last viewed</th>
              <th className="num">Views</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.slice(0, 10).map((l) => (
              <tr key={l.id} className={l.active ? '' : 'text-muted'}>
                <td>
                  {formatDate(l.createdAt)}
                  {l.createdByName && <span className="text-xs text-muted"> · {l.createdByName}</span>}
                </td>
                <td>{l.revokedAt ? 'Revoked' : formatDate(l.expiresAt)}</td>
                <td>{l.lastViewedAt ? formatDateTime(l.lastViewedAt) : '—'}</td>
                <td className="num">{l.views}</td>
                <td className="text-right">{l.active && can(manage) && <Button variant="ghost" loading={revoke.isPending && revoke.variables === l.id} onClick={() => revoke.mutate(l.id)}>Revoke</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!!active.length && active.length < data.length && <p className="mt-2 text-xs text-muted">{active.length} active.</p>}
    </Card>
  );
}
