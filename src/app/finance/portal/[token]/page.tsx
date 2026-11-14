'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Badge, Button, ErrorBanner, Field, Input, Loading, Modal, Notice } from '@/modules/finance/ui/components/ui';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';

interface PortalInvoice {
  id: string;
  number: string;
  reference: string;
  date: string;
  dueDate: string;
  overdue: boolean;
  currency: string;
  total: string;
  amountDue: string;
  payable: boolean;
  cardPayable?: boolean;
}

interface PortalView {
  organisation: string;
  seller: { name: string; email: string; phone: string; paymentInstructions: string };
  customer: { name: string; code: string };
  expiresAt: string;
  mpesa: { available: boolean; shortCode?: string; type?: 'PAYBILL' | 'TILL' };
  balances: { currency: string; amount: string }[];
  open: PortalInvoice[];
  history: { id: string; number: string; kind: string; date: string; currency: string; total: string }[];
}

/** Public calls: the token in the address is the only credential, so no app session is involved. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/finance/portal/${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers }, cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? 'Something went wrong; try again');
  return data as T;
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Portal />
    </Suspense>
  );
}

function Portal() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const [view, setView] = useState<PortalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<PortalInvoice | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const payByCard = async (i: PortalInvoice) => {
    setCard(i.id);
    setError(null);
    try {
      const { url } = await call<{ url: string }>(`${encodeURIComponent(token)}/invoices/${i.id}/card`, { method: 'POST', body: JSON.stringify({}) });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Card payment is not available right now');
      setCard(null);
    }
  };

  const load = useCallback(async () => {
    try {
      const v = await call<PortalView>(encodeURIComponent(token));
      setView(v);
      return v;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This link is not valid');
      return null;
    }
  }, [token]);

  useEffect(() => {
    let active = true;
    call<PortalView>(encodeURIComponent(token)).then(
      (v) => {
        if (!active) return;
        setView(v);
        const inv = v.open.find((i) => i.id === search.get('pay'));
        if (inv?.payable) setPaying(inv);
      },
      (err) => active && setError(err instanceof Error ? err.message : 'This link is not valid'),
    );
    return () => {
      active = false;
    };
  }, [token, search]);

  if (error && !view) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <Notice tone="amber">{error}</Notice>
      </main>
    );
  }
  if (!view) return <Loading />;
  const amount = (v: string, currency: string) => `${currency} ${formatAmount(v, 2)}`;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{view.seller.name}</p>
          <h1 className="text-2xl font-semibold">{view.customer.name}</h1>
          <p className="text-sm text-muted">Account {view.customer.code}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">Balance due</p>
          {view.balances.length ? (
            view.balances.map((b) => (
              <p key={b.currency} className="text-2xl font-semibold tabular-nums">{amount(b.amount, b.currency)}</p>
            ))
          ) : (
            <p className="text-2xl font-semibold">Nothing due</p>
          )}
        </div>
      </header>

      {search.get('card') === 'done' && (
        <div className="mt-6">
          <Notice tone="green">Thank you. Your card payment is being confirmed and will show here within a few minutes.</Notice>
        </div>
      )}
      {search.get('card') === 'cancelled' && (
        <div className="mt-6">
          <Notice tone="amber">The card payment was cancelled; nothing was charged.</Notice>
        </div>
      )}
      {error && (
        <div className="mt-6">
          <ErrorBanner error={error} />
        </div>
      )}

      <section className="mt-8 rounded-lg border border-line bg-white">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Open invoices</h2>
        {view.open.length ? (
          <ul className="divide-y divide-line">
            {view.open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {i.number} {i.overdue && <Badge tone="red">Overdue</Badge>}
                  </p>
                  <p className="text-xs text-muted">
                    Issued {formatDate(i.date)} · due {formatDate(i.dueDate)}
                    {i.reference && ` · ${i.reference}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{amount(i.amountDue, i.currency)}</p>
                    {i.amountDue !== i.total && <p className="text-xs text-muted">of {amount(i.total, i.currency)}</p>}
                  </div>
                  <Button onClick={() => window.open(`/api/v1/finance/portal/${encodeURIComponent(token)}/invoices/${i.id}/document`, '_blank', 'noopener')}>View</Button>
                  <Button variant="ghost" onClick={() => window.open(`/api/v1/finance/portal/${encodeURIComponent(token)}/invoices/${i.id}/pdf`, '_blank', 'noopener')}>PDF</Button>
                  {i.payable && (
                    <Button variant="primary" onClick={() => setPaying(i)}>Pay with M-Pesa</Button>
                  )}
                  {i.cardPayable && (
                    <Button variant={i.payable ? 'secondary' : 'primary'} loading={card === i.id} onClick={() => payByCard(i)}>Pay by card</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted">You have no open invoices. Thank you.</p>
        )}
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-white p-4 text-sm">
          <h2 className="font-semibold">Other ways to pay</h2>
          {view.mpesa.available && (
            <p className="mt-2">
              M-Pesa {view.mpesa.type === 'TILL' ? `Buy Goods till ${view.mpesa.shortCode}` : `paybill ${view.mpesa.shortCode}, using the invoice number as the account number`}.
            </p>
          )}
          {view.seller.paymentInstructions && <p className="mt-2 whitespace-pre-wrap text-muted">{view.seller.paymentInstructions}</p>}
          {!view.mpesa.available && !view.seller.paymentInstructions && <p className="mt-2 text-muted">Contact us for payment details.</p>}
        </div>
        <div className="rounded-lg border border-line bg-white p-4 text-sm">
          <h2 className="font-semibold">Questions?</h2>
          <p className="mt-2 text-muted">
            Contact {view.seller.name}
            {view.seller.email && (
              <>
                {' '}at <a className="text-brand-700 hover:underline" href={`mailto:${view.seller.email}`}>{view.seller.email}</a>
              </>
            )}
            {view.seller.phone && <> or {view.seller.phone}</>}.
          </p>
        </div>
      </section>

      {!!view.history.length && (
        <section className="mt-6 rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Paid invoices and credit notes</h2>
          <ul className="divide-y divide-line text-sm">
            {view.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span>
                  {h.kind === 'SALES_CREDIT' ? 'Credit note' : 'Invoice'} {h.number} <span className="text-muted">· {formatDate(h.date)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{amount(h.total, h.currency)}</span>
                  <button className="text-brand-700 hover:underline" onClick={() => window.open(`/api/v1/finance/portal/${encodeURIComponent(token)}/invoices/${h.id}/document`, '_blank', 'noopener')}>View</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-8 text-center text-xs text-muted">This page is private to your account; do not share the link. It works until {formatDate(view.expiresAt)}.</p>

      {paying && <PayDialog token={token} invoice={paying} onClose={() => setPaying(null)} onPaid={load} />}
    </main>
  );
}

function PayDialog({ token, invoice, onClose, onPaid }: { token: string; invoice: PortalInvoice; onClose: () => void; onPaid: () => void }) {
  const due = Math.ceil(Number(invoice.amountDue));
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(String(due));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status: 'PENDING' | 'PAID' | 'FAILED'; message: string } | null>(null);

  useEffect(() => {
    if (!paymentId || (status && status.status !== 'PENDING')) return;
    const timer = setInterval(async () => {
      try {
        const s = await call<{ status: 'PENDING' | 'PAID' | 'FAILED'; message: string }>(`${encodeURIComponent(token)}/payments/${paymentId}`);
        setStatus(s);
        if (s.status === 'PAID') onPaid();
      } catch {
        // Keep polling; a transient error should not end the wait.
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [paymentId, status, token, onPaid]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ id: string; message: string }>(`${encodeURIComponent(token)}/invoices/${invoice.id}/pay`, { method: 'POST', body: JSON.stringify({ phone, amount }) });
      setPaymentId(res.id);
      setStatus({ status: 'PENDING', message: 'Check your phone and enter your M-Pesa PIN.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the payment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Pay ${invoice.number}`}
      footer={
        paymentId ? (
          <Button variant="primary" onClick={onClose}>{status?.status === 'PENDING' ? 'Close' : 'Done'}</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!phone.trim() || !amount} onClick={pay}>Send payment prompt</Button>
          </>
        )
      }
    >
      {!paymentId ? (
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <p className="text-sm text-muted">We will send a prompt to your phone. Enter your M-Pesa PIN there to pay.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Safaricom number">
              <Input inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" />
            </Field>
            <Field label="Amount (KES)" hint={`Up to ${due.toLocaleString()}`}>
              <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            </Field>
          </div>
        </div>
      ) : status?.status === 'PAID' ? (
        <Notice tone="green">{status.message}. Thank you!</Notice>
      ) : status?.status === 'FAILED' ? (
        <Notice tone="amber">{status.message}. You can close this and try again.</Notice>
      ) : (
        <Notice>{status?.message ?? 'Waiting…'}</Notice>
      )}
    </Modal>
  );
}
