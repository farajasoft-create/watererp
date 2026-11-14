'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PaymentForm } from '@/modules/water/ui/account-actions';
import { CustomerPicker } from '@/modules/water/ui/customer-picker';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Pager, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDateTime, fmtMoney, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Customer, Page, Payment } from '@/modules/water/ui/types';

function Allocate({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const qc = useQueryClient();
  const allocate = useMutation({
    mutationFn: (customerId: string) => api.post(`/payments/${payment.id}/allocate`, { customerId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`Allocate ${payment.reference} · KES ${fmtMoney(payment.amount)}`}>
      <ErrorBox error={allocate.error} />
      <p className="text-sm text-muted">
        {payment.payerName} ({payment.payerPhone}) typed account <b>“{payment.accountRef || '—'}”</b>. Find the account it belongs to:
      </p>
      <CustomerPicker onPick={(c) => allocate.mutate(c.id)} />
    </Modal>
  );
}

interface Part {
  customer: Customer;
  amount: string;
}

/** One receipt shared between accounts: either a new receipt, or an unmatched payment being split. */
function Split({ payment, onClose }: { payment?: Payment; onClose: () => void }) {
  const qc = useQueryClient();
  const [parts, setParts] = useState<Part[]>([]);
  const [f, setF] = useState({ channel: 'BANK', reference: '', paidAt: today(), payerName: '', chequeNo: '', drawerBank: '' });
  const total = parts.reduce((s, p) => s + Number(p.amount || 0), 0);
  const target = payment ? Number(payment.amount) : null;
  const save = useMutation({
    mutationFn: () => {
      const body = { parts: parts.map((p) => ({ customerId: p.customer.id, amount: p.amount })) };
      return payment
        ? api.post(`/payments/${payment.id}/split`, body)
        : api.post('/payments/split', { ...body, ...f, payerName: f.payerName || undefined, chequeNo: f.chequeNo || undefined, drawerBank: f.drawerBank || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
  });
  const ready = parts.length >= 2 && parts.every((p) => Number(p.amount) > 0) && (target === null ? Boolean(f.reference) : Math.abs(total - target) < 0.005);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={payment ? `Split ${payment.reference} · KES ${fmtMoney(payment.amount)}` : 'Receive one payment for several accounts'}
      footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !ready}>Post {parts.length} receipts</Button>}
    >
      <ErrorBox error={save.error} />
      {!payment && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Channel">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="BANK">Bank deposit</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CASH">Cash office</option>
              <option value="MPESA">M-Pesa (manual entry)</option>
            </Select>
          </Field>
          <Field label="Reference">
            <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
          <Field label="Date paid">
            <Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} />
          </Field>
          {f.channel === 'CHEQUE' && (
            <>
              <Field label="Cheque no.">
                <Input value={f.chequeNo} onChange={(e) => setF({ ...f, chequeNo: e.target.value })} />
              </Field>
              <Field label="Drawer's bank">
                <Input value={f.drawerBank} onChange={(e) => setF({ ...f, drawerBank: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Paid by">
            <Input value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} />
          </Field>
        </div>
      )}
      <table className="table-base">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Amount (KES)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {parts.map((p, i) => (
            <tr key={p.customer.id}>
              <td>
                <b>{p.customer.accountNo}</b> · {p.customer.name} <span className="text-xs text-muted">owes <Money value={p.customer.balance} /></span>
              </td>
              <td className="num">
                <Input inputMode="decimal" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="w-32 text-right" />
              </td>
              <td>
                <Button variant="ghost" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Remove</Button>
              </td>
            </tr>
          ))}
          <tr>
            <td className="font-medium">Total</td>
            <td className="num font-medium">
              {fmtMoney(total)}
              {target !== null && <div className={Math.abs(total - target) < 0.005 ? 'text-xs text-emerald-700' : 'text-xs text-amber-700'}>of {fmtMoney(target)}</div>}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="text-sm text-muted">Add an account:</p>
      <CustomerPicker onPick={(c) => !parts.some((p) => p.customer.id === c.id) && setParts([...parts, { customer: c, amount: Number(c.balance) > 0 ? c.balance : '' }])} />
    </Modal>
  );
}

function Reverse({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const reverse = useMutation({
    mutationFn: () => api.post(`/payments/${payment.id}/reverse`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reverse ${payment.receiptNo}`}
      footer={
        <Button variant="danger" onClick={() => reverse.mutate()} disabled={reverse.isPending || reason.length < 5}>Reverse payment</Button>
      }
    >
      <ErrorBox error={reverse.error} />
      <p className="text-sm">KES {fmtMoney(payment.amount)} will be charged back to {payment.accountNo}. If it already reached the ledger, a reversing journal is sent to accounting.</p>
      <Field label="Reason">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function PaymentsInner() {
  const params = useSearchParams();
  const can = useCan();
  const [q, setQ] = useState({ status: params.get('status') ?? '', channel: '', search: '', from: '', to: '', page: 1 });
  const [picking, setPicking] = useState(false);
  const [receiving, setReceiving] = useState<Customer | null>(null);
  const [allocating, setAllocating] = useState<Payment | null>(null);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [splitting, setSplitting] = useState<Payment | 'new' | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['payments', q], queryFn: () => api.get<Page<Payment> & { amount: string }>('/payments', { ...q, pageSize: 50 }) });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));

  return (
    <>
      <PageHeader title="Payments" subtitle="M-Pesa paybill, bank and cash office receipts" actions={
          can('water.payment.record') && (
            <>
              <Button variant="secondary" onClick={() => setSplitting('new')}>One payment, several accounts</Button>
              <Button onClick={() => setPicking(true)}>Receive payment</Button>
            </>
          )
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input placeholder="Receipt, M-Pesa code, account, payer" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
          <Select value={q.status} onChange={(e) => set({ status: e.target.value })} className="max-w-[10rem]">
            <option value="">Any status</option>
            <option value="POSTED">Posted</option>
            <option value="UNMATCHED">Unmatched</option>
            <option value="REVERSED">Reversed</option>
            <option value="SPLIT">Split</option>
          </Select>
          <Select value={q.channel} onChange={(e) => set({ channel: e.target.value })} className="max-w-[10rem]">
            <option value="">Any channel</option>
            <option value="MPESA">M-Pesa</option>
            <option value="BANK">Bank</option>
            <option value="CASH">Cash</option>
            <option value="CHEQUE">Cheque</option>
          </Select>
          <Input type="date" value={q.from} onChange={(e) => set({ from: e.target.value })} className="w-40" />
          <Input type="date" value={q.to} onChange={(e) => set({ to: e.target.value })} className="w-40" />
          {data && <span className="ml-auto self-center text-sm">Total <b>KES {fmtMoney(data.amount)}</b></span>}
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No payments match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Paid</th>
                  <th>Channel</th>
                  <th>Reference</th>
                  <th>Account</th>
                  <th>Payer</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Ledger</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">{p.receiptNo}</td>
                    <td>{fmtDateTime(p.paidAt)}</td>
                    <td>{p.channel === 'MPESA' ? 'M-Pesa' : label(p.channel)}</td>
                    <td>{p.reference}{p.chequeNo && <div className="text-xs text-muted">Cheque {p.chequeNo}{p.drawerBank ? ` · ${p.drawerBank}` : ''}</div>}</td>
                    <td>
                      {p.customerId ? <Link href={`/water/customers/${p.customerId}`} className="text-brand-700 hover:underline">{p.accountNo}</Link> : <span className="text-amber-700">“{p.accountRef}”</span>}
                    </td>
                    <td className="text-xs">{p.payerName}<div className="text-muted">{p.payerPhone}</div></td>
                    <td className="num"><Money value={p.amount} /></td>
                    <td><Badge value={p.status} /></td>
                    <td>{p.status === 'SPLIT' ? '—' : <Badge value={p.accounting?.status ?? 'NOT_SENT'} />}</td>
                    <td className="text-right">
                      {p.status === 'UNMATCHED' && can('water.payment.allocate') && (
                        <>
                          <Button variant="ghost" onClick={() => setAllocating(p)}>Allocate</Button>
                          <Button variant="ghost" onClick={() => setSplitting(p)}>Split</Button>
                        </>
                      )}
                      {p.status === 'POSTED' && can('water.payment.allocate') && <Button variant="ghost" onClick={() => setReversing(p)}>Reverse</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {picking && (
        <Modal open onClose={() => setPicking(false)} title="Receive payment: find the account">
          <CustomerPicker
            onPick={(c) => {
              setPicking(false);
              setReceiving(c);
            }}
          />
        </Modal>
      )}
      {receiving && <PaymentForm customer={receiving} onClose={() => setReceiving(null)} />}
      {allocating && <Allocate payment={allocating} onClose={() => setAllocating(null)} />}
      {reversing && <Reverse payment={reversing} onClose={() => setReversing(null)} />}
      {splitting && <Split payment={splitting === 'new' ? undefined : splitting} onClose={() => setSplitting(null)} />}
    </>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentsInner />
    </Suspense>
  );
}
