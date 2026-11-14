'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Money, Notice, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtUnits, label } from '@/lib/format';

/**
 * The customer self-service portal: sign in with the account number and a code texted to the phone on
 * the account; see the balance, bills, statement and payments as they stand now; report a problem and
 * follow it; read notices. Calls the water API directly so a lapsed session simply shows the sign-in.
 */

class PortalError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/water/portal${path}`, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new PortalError(res.status, data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong');
  return data as T;
}

interface Info {
  name: string;
  branding?: Branding;
  phone?: string;
  email?: string;
  paybill?: string | null;
  notices: { title: string; message: string; type: string; endsAt?: string }[];
}

interface Me {
  customer: { accountNo: string; name: string; category: string; status: string; balance: string; location?: string; plotNo?: string; oldestUnpaidDueDate?: string };
  bills: { id: string; billNo: string; period: string; units: string; currentCharges: string; amountDue: string; dueDate: string; estimated: boolean; supplementary?: boolean }[];
  statement: { id: string; date: string; description: string; debit: string; credit: string; balance: string }[];
  payments: { id: string; receiptNo: string; paidAt: string; amount: string; channel: string; reference: string; status: string }[];
  tickets: { id: string; number: string; category: string; subject: string; status: string; createdAt: string; resolution?: string }[];
  notices: { title: string; message: string }[];
  plan: { number: string; instalments: { dueDate: string; amount: string; paid: string }[] } | null;
  asOf: string;
}

const CATEGORIES = ['NO_WATER', 'LOW_PRESSURE', 'LEAK', 'BURST', 'BILLING', 'METER', 'WATER_QUALITY', 'SEWER', 'RECONNECTION', 'OTHER'];

function SignIn({ org, onDone }: { org: string; onDone: () => void }) {
  const [f, setF] = useState({ accountNo: '', phone: '', code: '' });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Sign in to your water account">
      <div className="space-y-3">
        <ErrorBox error={error} />
        <Field label="Account number"><Input value={f.accountNo} onChange={(e) => setF({ ...f, accountNo: e.target.value })} placeholder="e.g. KML-00012" autoComplete="username" /></Field>
        {!sent ? (
          <>
            <Field label="Phone number on the account"><Input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07XX XXX XXX" /></Field>
            <Button disabled={busy || !f.accountNo || f.phone.length < 9} onClick={() => run(async () => { await call('POST', `/${org}/code`, { accountNo: f.accountNo, phone: f.phone }); setSent(true); })}>Text me a code</Button>
          </>
        ) : (
          <>
            <Notice>If the phone number is on the account, a 6-digit code is on its way. It expires in 10 minutes.</Notice>
            <Field label="Code"><Input value={f.code} inputMode="numeric" maxLength={6} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} autoComplete="one-time-code" /></Field>
            <div className="flex gap-2">
              <Button disabled={busy || f.code.length !== 6} onClick={() => run(async () => { await call('POST', `/${org}/session`, { accountNo: f.accountNo, code: f.code }); onDone(); })}>Sign in</Button>
              <Button variant="ghost" onClick={() => setSent(false)}>Use another number</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** The customer confirms a resolved report: a 1–5 rating and the 0–10 "would you recommend us" question. */
function Feedback({ org, id, onDone }: { org: string; id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ satisfaction: '5', recommend: '' });
  const send = async (confirmed: boolean) => {
    await call('POST', `/${org}/tickets/${id}/feedback`, confirmed ? { confirmed, satisfaction: Number(f.satisfaction), recommend: f.recommend === '' ? null : Number(f.recommend) } : { confirmed });
    onDone();
  };
  if (!open) {
    return (
      <div className="mt-1 flex gap-1">
        <Button variant="ghost" onClick={() => setOpen(true)}>Sorted</Button>
        <Button variant="ghost" onClick={() => send(false)}>Not sorted</Button>
      </div>
    );
  }
  return (
    <div className="mt-1 space-y-1 text-xs">
      <Select value={f.satisfaction} onChange={(e) => setF({ ...f, satisfaction: e.target.value })} aria-label="How was the service">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>Service: {n} of 5</option>)}</Select>
      <Select value={f.recommend} onChange={(e) => setF({ ...f, recommend: e.target.value })} aria-label="How likely are you to recommend us">
        <option value="">Would you recommend us? (0–10)</option>
        {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => <option key={n} value={n}>{n}</option>)}
      </Select>
      <Button onClick={() => send(true)}>Confirm</Button>
    </div>
  );
}

function Report({ org, onDone }: { org: string; onDone: () => void }) {
  const [f, setF] = useState({ category: 'NO_WATER', subject: '', description: '', location: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Card title="Report a problem">
      <div className="space-y-3">
        <ErrorBox error={error} />
        {done && <Notice tone="green">Received. Your reference is {done}; we will update you by SMS.</Notice>}
        <Field label="What is the problem?">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
        </Field>
        <Field label="Short description"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Where (landmark, plot)"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="More details"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Button
          disabled={f.subject.length < 3}
          onClick={async () => {
            setError(null);
            try {
              const t = await call<{ number: string }>('POST', `/${org}/tickets`, { ...f, description: f.description || undefined, location: f.location || undefined });
              setDone(t.number);
              setF({ ...f, subject: '', description: '' });
              onDone();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Send report
        </Button>
      </div>
    </Card>
  );
}

export default function PortalPage() {
  const { org } = useParams<{ org: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'bills' | 'statement' | 'payments' | 'tickets' | 'report'>('bills');
  const infoQuery = useQuery({ queryKey: ['portal', org, 'info'], queryFn: () => call<Info>('GET', `/${org}`), retry: false });
  // Balances stay current while the page is open.
  const meQuery = useQuery({ queryKey: ['portal', org, 'me'], queryFn: () => call<Me>('GET', `/${org}/me`), retry: false, refetchInterval: 5 * 60_000 });
  const info = infoQuery.data ?? null;
  const me = meQuery.data ?? null;
  const load = () => qc.invalidateQueries({ queryKey: ['portal', org, 'me'] });
  const missing = (infoQuery.error instanceof PortalError && infoQuery.error.status === 404) || (meQuery.error instanceof PortalError && meQuery.error.status === 404);
  const state: 'loading' | 'signin' | 'in' | 'missing' = missing ? 'missing' : me ? 'in' : meQuery.isLoading ? 'loading' : 'signin';

  if (state === 'missing') return <main className="mx-auto max-w-lg p-6 text-center text-sm text-muted">This customer portal is not available.</main>;
  const c = me?.customer;
  return (
    <PortalShell organisation={info?.name ?? ''} fallbackTitle="Customer portal" branding={info?.branding}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{info?.name ?? 'Water'} · customer portal</h1>
          {info?.phone && <p className="text-xs text-muted">Customer care {info.phone}{info.email ? ` · ${info.email}` : ''}</p>}
        </div>
        {state === 'in' && (
          <Button variant="secondary" onClick={async () => { await call('POST', `/${org}/logout`); qc.removeQueries({ queryKey: ['portal', org, 'me'] }); load(); }}>Sign out</Button>
        )}
      </header>
      {(me?.notices ?? info?.notices ?? []).map((n, i) => (
        <Notice key={i} tone="amber"><b>{n.title}.</b> {n.message}</Notice>
      ))}
      {state === 'signin' && <SignIn org={org} onDone={load} />}
      {state === 'in' && c && me && (
        <>
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-sm text-muted">{c.accountNo} · {c.name}</div>
                <div className="text-3xl font-semibold tabular-nums">{Number(c.balance) > 0 ? <>KES <Money value={c.balance} /></> : 'Paid up'}</div>
                <div className="text-xs text-muted">{Number(c.balance) > 0 ? 'to pay' : Number(c.balance) < 0 ? `credit KES ${Math.abs(Number(c.balance)).toFixed(2)}` : ''} · as at {fmtDateTime(me.asOf)}</div>
              </div>
              {info?.paybill && (
                <div className="rounded-md border border-line px-3 py-2 text-sm">
                  Pay by M-Pesa: Paybill <b>{info.paybill}</b>, account <b>{c.accountNo}</b>
                </div>
              )}
            </div>
            {me.plan && <p className="mt-3 text-sm">Payment plan {me.plan.number}: next instalment {(() => { const n = me.plan.instalments.find((i) => Number(i.paid) < Number(i.amount)); return n ? `KES ${Number(n.amount).toFixed(2)} by ${fmtDate(n.dueDate)}` : 'none'; })()}.</p>}
          </Card>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'bills', label: 'Bills' }, { id: 'statement', label: 'Statement' }, { id: 'payments', label: 'Payments' }, { id: 'tickets', label: 'My reports' }, { id: 'report', label: 'Report a problem' }]} />
          {tab === 'bills' && (
            <Card padded={false}>
              <table className="table-base">
                <thead><tr><th>Period</th><th>Bill</th><th className="num">m³</th><th className="num">This bill</th><th className="num">Amount due</th><th>Due</th></tr></thead>
                <tbody>
                  {me.bills.map((b) => (
                    <tr key={b.id}><td>{b.period}{b.estimated && <div className="text-xs text-amber-700">estimated</div>}{b.supplementary && <div className="text-xs text-muted">supplementary</div>}</td><td>{b.billNo}</td><td className="num">{fmtUnits(b.units)}</td><td className="num"><Money value={b.currentCharges} /></td><td className="num"><Money value={b.amountDue} /></td><td>{fmtDate(b.dueDate)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {tab === 'statement' && (
            <Card padded={false}>
              <table className="table-base">
                <thead><tr><th>Date</th><th>Details</th><th className="num">Charged</th><th className="num">Paid</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {me.statement.map((l) => (
                    <tr key={l.id}><td>{fmtDate(l.date)}</td><td>{l.description}</td><td className="num">{Number(l.debit) ? <Money value={l.debit} /> : ''}</td><td className="num">{Number(l.credit) ? <Money value={l.credit} /> : ''}</td><td className="num"><Money value={l.balance} /></td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {tab === 'payments' && (
            <Card padded={false}>
              <table className="table-base">
                <thead><tr><th>Date</th><th>Receipt</th><th>Paid by</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {me.payments.map((p) => (
                    <tr key={p.id}><td>{fmtDateTime(p.paidAt)}</td><td>{p.receiptNo}</td><td>{p.channel === 'MPESA' ? 'M-Pesa' : label(p.channel)} {p.reference}</td><td className="num"><Money value={p.amount} /></td><td><Badge value={p.status} /></td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {tab === 'tickets' && (
            <Card padded={false}>
              <table className="table-base">
                <thead><tr><th>Reference</th><th>Reported</th><th>Problem</th><th>Status</th></tr></thead>
                <tbody>
                  {me.tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="font-medium">{t.number}</td>
                      <td>{fmtDate(t.createdAt)}</td>
                      <td>{t.subject}{t.resolution && <div className="text-xs text-muted">{t.resolution}</div>}</td>
                      <td>
                        <Badge value={t.status} />
                        {t.status === 'RESOLVED' && <Feedback org={org} id={t.id} onDone={load} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {tab === 'report' && <Report org={org} onDone={load} />}
        </>
      )}
    </PortalShell>
  );
}
