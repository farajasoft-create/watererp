'use client';

import { Attachments } from '@/components/attachments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { AdjustmentForm, InstallMeterForm, PaymentForm } from '@/modules/water/ui/account-actions';
import { CustomerForm } from '@/modules/water/ui/customer-form';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Money, PageHeader, Tabs } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, fmtDateTime, fmtUnits, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { Bill, Customer, Meter, Payment, Reading, Tariff, Zone } from '@/modules/water/ui/types';

type Detail = Customer & { meter: Meter | null; zone: Zone | null; tariff: Tariff | null; bills: Bill[]; payments: Payment[]; readings: Reading[] };
interface Entry {
  id: string;
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}

const NEXT_STATUS: Record<string, { to: string; label: string; variant?: 'danger' | 'secondary' }[]> = {
  APPLIED: [
    { to: 'APPROVED', label: 'Approve application' },
    { to: 'REJECTED', label: 'Reject', variant: 'danger' },
  ],
  APPROVED: [{ to: 'ACTIVE', label: 'Mark connected' }],
  ACTIVE: [{ to: 'CLOSED', label: 'Close account', variant: 'secondary' }],
  DISCONNECTED: [{ to: 'CLOSED', label: 'Close account', variant: 'secondary' }],
};

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'statement' | 'bills' | 'readings' | 'payments'>('statement');
  const [dialog, setDialog] = useState<null | 'edit' | 'pay' | 'adjust' | 'meter'>(null);
  const { data: c, error, isLoading } = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<Detail>(`/customers/${id}`) });
  const statement = useQuery({ queryKey: ['statement', id], queryFn: () => api.get<Entry[]>(`/customers/${id}/statement`), enabled: tab === 'statement' });
  const status = useMutation({
    mutationFn: (to: string) => api.post(`/customers/${id}/status`, { status: to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer', id] }),
  });

  if (isLoading) return <Loading />;
  if (!c) return <ErrorBox error={error} />;

  return (
    <>
      <PageHeader
        title={`${c.accountNo} · ${c.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={c.status} /> {label(c.category)} · {c.zone ? `${c.zone.code} ${c.zone.name}` : ''} · tariff {c.tariff?.code}
            {c.sewered && <Badge tone="blue">Sewered</Badge>}
          </span>
        }
        actions={
          <>
            {can('water.payment.record') && <Button onClick={() => setDialog('pay')}>Receive payment</Button>}
            {can('water.meter.manage') && !['CLOSED', 'REJECTED'].includes(c.status) && (
              <Button variant="secondary" onClick={() => setDialog('meter')}>{c.meterId ? 'Replace meter' : 'Install meter'}</Button>
            )}
            {can('water.adjustment.create') && <Button variant="secondary" onClick={() => setDialog('adjust')}>Adjustment</Button>}
            {can('water.customer.manage') && <Button variant="secondary" onClick={() => setDialog('edit')}>Edit</Button>}
          </>
        }
      />
      <ErrorBox error={status.error} />
      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <Card title="Account">
          <div className="text-xs text-muted">Balance</div>
          <div className="text-2xl font-semibold"><Money value={c.balance} /></div>
          <div className="mt-1 text-xs text-muted">{Number(c.balance) < 0 ? 'In credit' : c.oldestUnpaidDueDate ? `Oldest unpaid bill due ${fmtDate(c.oldestUnpaidDueDate)}` : 'Nothing overdue'}</div>
          {can('water.customer.manage') && NEXT_STATUS[c.status] && (
            <div className="mt-3 flex flex-wrap gap-2">
              {NEXT_STATUS[c.status].map((n) => (
                <Button key={n.to} variant={n.variant ?? 'primary'} disabled={status.isPending} onClick={() => status.mutate(n.to)}>{n.label}</Button>
              ))}
            </div>
          )}
        </Card>
        <Card title="Contact & location">
          <dl className="grid grid-cols-3 gap-y-1 text-sm">
            <dt className="text-muted">Phone</dt>
            <dd className="col-span-2">{c.phone ? `0${c.phone.slice(3)}` : '—'}</dd>
            <dt className="text-muted">ID</dt>
            <dd className="col-span-2">{c.idNumber ?? '—'}</dd>
            <dt className="text-muted">KRA PIN</dt>
            <dd className="col-span-2">{c.kraPin ?? '—'}</dd>
            <dt className="text-muted">Plot</dt>
            <dd className="col-span-2">{c.plotNo ?? '—'}</dd>
            <dt className="text-muted">Location</dt>
            <dd className="col-span-2">{c.location ?? '—'}</dd>
          </dl>
        </Card>
        <Card title="Meter">
          {c.meter ? (
            <dl className="grid grid-cols-3 gap-y-1 text-sm">
              <dt className="text-muted">Serial</dt>
              <dd className="col-span-2 font-medium">{c.meter.serialNo}</dd>
              <dt className="text-muted">Status</dt>
              <dd className="col-span-2"><Badge value={c.meter.status} /></dd>
              <dt className="text-muted">Last read</dt>
              <dd className="col-span-2">{fmtUnits(c.meter.lastReading)} on {fmtDate(c.meter.lastReadingDate)}</dd>
              <dt className="text-muted">Installed</dt>
              <dd className="col-span-2">{fmtDate(c.meter.installedAt)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">No meter fitted.</p>
          )}
        </Card>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'statement', label: 'Statement' },
          { id: 'bills', label: 'Bills' },
          { id: 'readings', label: 'Readings' },
          { id: 'payments', label: 'Payments' },
        ]}
      />
      <Card padded={false}>
        {tab === 'statement' &&
          (statement.isLoading ? (
            <Loading />
          ) : !statement.data?.length ? (
            <Empty>No transactions yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference</th>
                    <th>Description</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.data.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtDate(e.date)}</td>
                      <td>{e.reference}</td>
                      <td>{e.description}</td>
                      <td className="num">{Number(e.debit) ? <Money value={e.debit} /> : ''}</td>
                      <td className="num">{Number(e.credit) ? <Money value={e.credit} /> : ''}</td>
                      <td className="num font-medium"><Money value={e.balance} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'bills' && (
          <table className="table-base">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Period</th>
                <th className="num">Units</th>
                <th className="num">Charges</th>
                <th className="num">Amount due</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {c.bills.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/water/bills/${b.id}`} className="text-brand-700 hover:underline">{b.billNo}</Link> {b.estimated && <Badge value="ESTIMATED" />}
                  </td>
                  <td>{b.period}</td>
                  <td className="num">{fmtUnits(b.units)}</td>
                  <td className="num"><Money value={b.currentCharges} /></td>
                  <td className="num"><Money value={b.amountDue} /></td>
                  <td>{fmtDate(b.dueDate)}</td>
                </tr>
              ))}
              {!c.bills.length && (
                <tr><td colSpan={6} className="text-center text-muted">No bills yet</td></tr>
              )}
            </tbody>
          </table>
        )}
        {tab === 'readings' && (
          <table className="table-base">
            <thead>
              <tr>
                <th>Read</th>
                <th>Period</th>
                <th className="num">Previous</th>
                <th className="num">Reading</th>
                <th className="num">Units billed</th>
                <th>Type</th>
                <th>Exception</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.readings.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.readAt)}</td>
                  <td>{r.period}</td>
                  <td className="num">{r.type === 'ESTIMATED' ? '—' : fmtUnits(r.previousValue)}</td>
                  <td className="num">{fmtUnits(r.value)}</td>
                  <td className="num">{fmtUnits(r.units)}</td>
                  <td><Badge value={r.type} /></td>
                  <td>{r.exception !== 'NONE' && <Badge value={r.exception} />}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {!c.readings.length && (
                <tr><td colSpan={8} className="text-center text-muted">No readings yet</td></tr>
              )}
            </tbody>
          </table>
        )}
        {tab === 'payments' && (
          <table className="table-base">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Date</th>
                <th>Channel</th>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.receiptNo}</td>
                  <td>{fmtDate(p.paidAt)}</td>
                  <td>{p.channel === 'MPESA' ? 'M-Pesa' : label(p.channel)}</td>
                  <td>{p.reference}</td>
                  <td className="num"><Money value={p.amount} /></td>
                  <td><Badge value={p.status} /></td>
                </tr>
              ))}
              {!c.payments.length && (
                <tr><td colSpan={6} className="text-center text-muted">No payments yet</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-5">
        <Attachments module="water" entity="customer" entityId={c.id} categories={['KYC', 'APPLICATION', 'AGREEMENT', 'CORRESPONDENCE', 'GENERAL']} title="Customer file" />
      </div>

      {dialog === 'edit' && <CustomerForm open customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <PaymentForm customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && <AdjustmentForm customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'meter' && <InstallMeterForm customer={c} onClose={() => setDialog(null)} />}
    </>
  );
}
