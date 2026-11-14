'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Stat, Tabs } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';

interface View {
  organisation: string;
  branding?: Branding;
  supplier: { name: string; code: string };
  expiresAt: string;
  summary: { owed: string; overdue: string; openOrders: number };
  orders: { id: string; number: string; date: string; expectedDate?: string; status: string; currency: string; total: string; reference?: string; lines: { description: string; quantity: string; received: string; unitPrice: string }[] }[];
  invoices: { id: string; kind: string; number: string; supplierInvoiceNumber?: string; date: string; dueDate?: string; currency: string; total: string; amountDue: string; paymentStatus: string; overdue: boolean }[];
  payments: { id: string; number: string; date: string; method: string; reference?: string; currency: string; amount: string; withholding?: string; settled: { document: string; amount: string }[] }[];
  submissions: { id: string; invoiceNumber: string; invoiceDate: string; amount: string; currency: string; status: string; reason: string; submittedAt: string }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/finance/vendor-portal${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong');
  return data as T;
}

/** The supplier's own view, opened by the private link the organisation sent them. */
export default function VendorPortalPage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'send'>('orders');
  const { data, error, isLoading } = useQuery({ queryKey: ['vendor-portal', token], queryFn: () => call<View>('GET', `/${encodeURIComponent(token)}`), retry: false });
  const [f, setF] = useState({ invoiceNumber: '', invoiceDate: '', amount: '', purchaseOrderId: '', etimsNumber: '', note: '' });
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const send = async () => {
    setSendError(null);
    try {
      await call('POST', `/${encodeURIComponent(token)}/invoices`, { ...f, purchaseOrderId: f.purchaseOrderId || null, etimsNumber: f.etimsNumber || undefined, note: f.note || undefined });
      setSent(true);
      setF({ invoiceNumber: '', invoiceDate: '', amount: '', purchaseOrderId: '', etimsNumber: '', note: '' });
      qc.invalidateQueries({ queryKey: ['vendor-portal', token] });
    } catch (e) {
      setSendError(e);
    }
  };
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="Vendor portal" branding={data?.branding}>
      <ErrorBox error={error} />
      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <header>
            <h1 className="text-2xl font-semibold">{data.organisation}: vendor portal</h1>
            <p className="text-sm text-muted">{data.supplier.name}{data.supplier.code && ` (${data.supplier.code})`} · this link works until {fmtDate(data.expiresAt)}</p>
          </header>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Owed to you" value={`KES ${fmtMoney(Number(data.summary.owed))}`} />
            <Stat label="Of which overdue" value={`KES ${fmtMoney(Number(data.summary.overdue))}`} tone={Number(data.summary.overdue) > 0 ? 'warn' : undefined} />
            <Stat label="Open orders" value={data.summary.openOrders} />
          </div>
          <Tabs tabs={[{ id: 'orders', label: 'Orders' }, { id: 'invoices', label: 'Invoices' }, { id: 'payments', label: 'Payments' }, { id: 'send', label: 'Send an invoice' }]} value={tab} onChange={setTab} />
          {tab === 'orders' && (
            <Card padded={false}>
              {!data.orders.length ? <p className="p-4 text-sm text-muted">No orders.</p> : (
                <table className="table-base">
                  <thead><tr><th>Order</th><th>Date</th><th>Expected</th><th>Items</th><th className="num">Total</th><th>Status</th></tr></thead>
                  <tbody>{data.orders.map((o) => <tr key={o.id}><td className="font-medium">{o.number}</td><td>{fmtDate(o.date)}</td><td>{o.expectedDate ? fmtDate(o.expectedDate) : '—'}</td><td className="text-xs">{o.lines.map((l, i) => <div key={i}>{l.description}: {Number(l.received)} of {Number(l.quantity)} received</div>)}</td><td className="num">{o.currency} {fmtMoney(Number(o.total))}</td><td><Badge value={o.status} /></td></tr>)}</tbody>
                </table>
              )}
            </Card>
          )}
          {tab === 'invoices' && (
            <Card padded={false}>
              {!data.invoices.length ? <p className="p-4 text-sm text-muted">No invoices entered yet.</p> : (
                <table className="table-base">
                  <thead><tr><th>Our ref</th><th>Your invoice</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Still owed</th><th>Status</th></tr></thead>
                  <tbody>{data.invoices.map((b) => <tr key={b.id}><td>{b.number}{b.kind === 'PURCHASE_CREDIT' && <Badge tone="gray">credit note</Badge>}</td><td>{b.supplierInvoiceNumber}</td><td>{fmtDate(b.date)}</td><td>{b.dueDate ? fmtDate(b.dueDate) : '—'}</td><td className="num">{fmtMoney(Number(b.total))}</td><td className="num">{fmtMoney(Number(b.amountDue))}</td><td>{b.overdue ? <Badge tone="red">overdue</Badge> : <Badge value={b.paymentStatus} />}</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          )}
          {tab === 'payments' && (
            <Card padded={false}>
              {!data.payments.length ? <p className="p-4 text-sm text-muted">No payments yet.</p> : (
                <table className="table-base">
                  <thead><tr><th>Payment</th><th>Date</th><th>How</th><th>Reference</th><th className="num">Paid</th><th className="num">Tax withheld</th><th>Settled</th></tr></thead>
                  <tbody>{data.payments.map((p) => <tr key={p.id}><td>{p.number}</td><td>{fmtDate(p.date)}</td><td>{label(p.method)}</td><td>{p.reference}</td><td className="num">{p.currency} {fmtMoney(Number(p.amount))}</td><td className="num">{p.withholding ? fmtMoney(Number(p.withholding)) : '—'}</td><td className="text-xs">{p.settled.map((s, i) => <div key={i}>{s.document}: {fmtMoney(Number(s.amount))}</div>)}</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          )}
          {tab === 'send' && (
            <Card title="Send an invoice">
              <div className="space-y-3">
                <ErrorBox error={sendError} />
                {sent && <Notice tone="green">Received. Accounts payable will enter it and you can follow it below.</Notice>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Your invoice number"><Input value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} /></Field>
                  <Field label="Invoice date"><Input type="date" value={f.invoiceDate} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} /></Field>
                  <Field label="Amount (with tax)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
                  <Field label="Against order"><Select value={f.purchaseOrderId} onChange={(e) => setF({ ...f, purchaseOrderId: e.target.value })}><option value="">No order</option>{data.orders.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}</Select></Field>
                  <Field label="eTIMS invoice number"><Input value={f.etimsNumber} onChange={(e) => setF({ ...f, etimsNumber: e.target.value })} /></Field>
                  <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
                </div>
                <Button onClick={send} disabled={!f.invoiceNumber || !f.invoiceDate || !Number(f.amount)}>Send</Button>
                {data.submissions.length > 0 && (
                  <table className="table-base">
                    <thead><tr><th>Invoice</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
                    <tbody>{data.submissions.map((x) => <tr key={x.id}><td>{x.invoiceNumber}</td><td>{fmtDate(x.invoiceDate)}</td><td className="num">{x.currency} {fmtMoney(Number(x.amount))}</td><td><Badge value={x.status === 'SUBMITTED' ? 'PENDING' : x.status === 'ENTERED' ? 'APPROVED' : 'REJECTED'}>{x.status === 'SUBMITTED' ? 'waiting' : x.status === 'ENTERED' ? 'entered' : 'turned back'}</Badge>{x.reason && <div className="text-xs text-muted">{x.reason}</div>}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </PortalShell>
  );
}
