'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Money, Notice, PageHeader, Select, Stat } from '@/components/ui';
import { fmtDate, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/estates/ui/api';

interface Lease {
  id: string;
  number: string;
  status: string;
  startDate: string;
  endDate: string;
  rent: string;
  serviceCharge: string;
  escalationPct: number;
  dueDay: number;
  deposit: string;
  depositPaid: string;
  currentRent: string;
  balance: string;
  depositHeld: string;
  tenant: { name: string; phone?: string; email?: string } | null;
  property: { code: string; name: string } | null;
  unit: string;
  statement: { id: string; date: string; kind: string; period?: string; description?: string; reference?: string; amount: string; balance: string | null }[];
}

export default function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const { data: l, error, isLoading } = useQuery({ queryKey: ['estates-lease', id], queryFn: () => api.get<Lease>(`/leases/${id}`) });
  const [pay, setPay] = useState({ date: today(), amount: '', reference: '', kind: 'RENT' });
  const [adj, setAdj] = useState({ amount: '', description: '', kind: 'ADJUSTMENT' });
  const [end, setEnd] = useState({ date: today(), reason: '', deductions: '', refundReference: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['estates-lease', id] }); qc.invalidateQueries({ queryKey: ['estates-roll'] }); };
  const receive = useMutation({ mutationFn: () => api.post(`/leases/${id}/receive`, { ...pay, reference: pay.reference || undefined }), onSuccess: () => { setPay({ ...pay, amount: '', reference: '' }); refresh(); } });
  const adjust = useMutation({ mutationFn: () => api.post(`/leases/${id}/adjust`, adj), onSuccess: () => { setAdj({ amount: '', description: '', kind: 'ADJUSTMENT' }); refresh(); } });
  const finish = useMutation({ mutationFn: () => api.post(`/leases/${id}/end`, { date: end.date, reason: end.reason || undefined, deductions: end.deductions || undefined, refundReference: end.refundReference || undefined }), onSuccess: refresh });
  if (isLoading) return <Loading />;
  if (!l) return <ErrorBox error={error} />;
  const manage = can('estates.manage') && l.status === 'ACTIVE';
  return (
    <>
      <PageHeader title={`${l.number} · ${l.tenant?.name ?? ''}`} subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={l.status} /> {l.property?.code} {l.unit} · {fmtDate(l.startDate)} – {fmtDate(l.endDate)} · due on day {l.dueDay}{l.escalationPct > 0 && ` · +${l.escalationPct}% a year`}</span>} actions={<a href="/estates" className="text-sm text-brand-700 hover:underline">Rent roll</a>} />
      <ErrorBox error={receive.error || adjust.error || finish.error} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Rent now" value={<Money value={l.currentRent} />} hint={Number(l.serviceCharge) ? `+ service ${Number(l.serviceCharge).toLocaleString('en-KE')}` : undefined} />
        <Stat label="Owed" value={<Money value={l.balance} />} tone={Number(l.balance) > 0 ? 'warn' : 'good'} />
        <Stat label="Deposit agreed" value={<Money value={l.deposit} />} />
        <Stat label="Deposit held" value={<Money value={l.depositHeld} />} />
        <Stat label="Tenant" value={l.tenant?.name ?? ''} hint={[l.tenant?.phone, l.tenant?.email].filter(Boolean).join(' · ')} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card padded={false} title="Statement" className="lg:col-span-2">
          <table className="table-base">
            <thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
            <tbody>{l.statement.map((e) => <tr key={e.id} className={e.balance === null ? 'text-muted' : ''}><td>{fmtDate(e.date)}</td><td>{e.description ?? label(e.kind)}</td><td>{e.reference}</td><td className="num"><Money value={e.amount} /></td><td className="num">{e.balance === null ? 'deposit' : <Money value={e.balance} />}</td></tr>)}</tbody>
          </table>
        </Card>
        <div className="space-y-5">
          {manage && (
            <Card title="Receive a payment">
              <div className="grid gap-2">
                <Select value={pay.kind} onChange={(e) => setPay({ ...pay, kind: e.target.value })}><option value="RENT">Rent and charges</option><option value="DEPOSIT">Deposit</option></Select>
                <Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
                <Input placeholder="Amount" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                <Input placeholder="M-Pesa or bank reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                <Button onClick={() => receive.mutate()} disabled={!Number(pay.amount) || receive.isPending}>Record</Button>
              </div>
            </Card>
          )}
          {manage && (
            <Card title="Charge or credit">
              <div className="grid gap-2">
                <Select value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}><option value="ADJUSTMENT">Adjustment (negative to credit)</option><option value="PENALTY">Late payment penalty</option></Select>
                <Input placeholder="Amount" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
                <Input placeholder="Why" value={adj.description} onChange={(e) => setAdj({ ...adj, description: e.target.value })} />
                <Button variant="secondary" onClick={() => adjust.mutate()} disabled={!Number(adj.amount) || adj.description.length < 3 || adjust.isPending}>Post</Button>
              </div>
            </Card>
          )}
          {manage && (
            <Card title="End the lease">
              <div className="grid gap-2">
                <Field label="Last day"><Input type="date" value={end.date} onChange={(e) => setEnd({ ...end, date: e.target.value })} /></Field>
                <Input placeholder="Damages or other charges" value={end.deductions} onChange={(e) => setEnd({ ...end, deductions: e.target.value })} />
                <Input placeholder="Reason" value={end.reason} onChange={(e) => setEnd({ ...end, reason: e.target.value })} />
                <Input placeholder="Refund cheque or transfer reference" value={end.refundReference} onChange={(e) => setEnd({ ...end, refundReference: e.target.value })} />
                <Notice>The deposit first clears what is owed (and the charges); whatever is left is refunded.</Notice>
                <Button variant="secondary" onClick={() => finish.mutate()} disabled={finish.isPending}>End lease and settle the deposit</Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
