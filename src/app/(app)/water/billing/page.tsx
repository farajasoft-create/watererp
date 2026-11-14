'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { currentPeriod, fmtDate, fmtUnits, today } from '@/lib/format';
import { useCycles, useZones, zoneName } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';
import { CustomerPicker } from '@/modules/water/ui/customer-picker';
import { BillRun, Customer } from '@/modules/water/ui/types';

function NewRun({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: cycles } = useCycles();
  const { data: zones } = useZones();
  const [f, setF] = useState({ period: cycles?.find((c) => c.status !== 'BILLED')?.period ?? '', zoneId: '', billDate: today(), dueDate: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ run: BillRun; unread: string[] }>('/bill-runs', { period: f.period, zoneId: f.zoneId || null, billDate: f.billDate, dueDate: f.dueDate || null }),
    onSuccess: ({ run, unread }) => {
      qc.invalidateQueries({ queryKey: ['bill-runs'] });
      router.push(`/water/billing/${run.id}${unread.length ? `?unread=${unread.length}` : ''}`);
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="New billing run"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !f.period}>{create.isPending ? 'Calculating bills…' : 'Calculate bills'}</Button>
        </>
      }
    >
      <ErrorBox error={create.error} />
      <p className="text-sm text-muted">Every active connection with an approved reading (actual or estimated) for the period is priced into a draft bill. Nothing reaches customers until the run is approved.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Period">
          <Select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
            <option value="">Select…</option>
            {cycles?.map((c) => (
              <option key={c.id} value={c.period}>{c.period}</option>
            ))}
          </Select>
        </Field>
        <Field label="Zone">
          <Select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
            <option value="">All zones</option>
            {zones?.map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Bill date">
          <Input type="date" value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} />
        </Field>
        <Field label="Due date" hint="Defaults to the bill date plus the due days in Settings">
          <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

/** A one-off bill for one account: back-billed units on its tariff and/or other charges. */
function Supplementary({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ period: currentPeriod(), reason: '', billDate: today(), dueDate: '', units: '' });
  const [charges, setCharges] = useState<{ description: string; amount: string }[]>([]);
  const save = useMutation({
    mutationFn: () =>
      api.post('/bill-runs/supplementary', {
        customerId: customer!.id,
        period: f.period,
        reason: f.reason,
        billDate: f.billDate,
        dueDate: f.dueDate || null,
        units: f.units || null,
        charges: charges.filter((c) => c.description && c.amount),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bill-runs'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Supplementary bill"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !customer || f.reason.length < 5 || (!f.units && !charges.some((c) => c.description && c.amount))}>Prepare bill</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">For consumption missed on earlier bills, bowser deliveries or other one-off charges. Someone else approves it before it reaches the account; the regular bill for the period is not affected.</p>
      {customer ? (
        <div className="flex items-center justify-between rounded border border-line px-3 py-2 text-sm">
          <span>
            <b>{customer.accountNo}</b> · {customer.name}
          </span>
          <Button variant="ghost" onClick={() => setCustomer(null)}>Change</Button>
        </div>
      ) : (
        <CustomerPicker onPick={setCustomer} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Period">
          <Input type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} />
        </Field>
        <Field label="Reason">
          <Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Under-read meter Jul–Sep" />
        </Field>
        <Field label="Bill date">
          <Input type="date" value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} />
        </Field>
        <Field label="Due date" hint="Defaults to the bill date plus the due days in Settings">
          <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </Field>
        <Field label="Units to back-bill (m³)" hint="Priced on the account's tariff; fixed charges are not repeated">
          <Input inputMode="decimal" value={f.units} onChange={(e) => setF({ ...f, units: e.target.value })} />
        </Field>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">Other charges</div>
        {charges.map((c, i) => (
          <div key={i} className="flex gap-2">
            <Input value={c.description} placeholder="Description" onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input inputMode="decimal" value={c.amount} placeholder="KES" className="w-36" onChange={(e) => setCharges(charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <Button variant="ghost" onClick={() => setCharges(charges.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setCharges([...charges, { description: '', amount: '' }])}>Add a charge</Button>
      </div>
    </Modal>
  );
}

export default function BillingPage() {
  const can = useCan();
  const { data: zones } = useZones();
  const [creating, setCreating] = useState(false);
  const [supplementary, setSupplementary] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['bill-runs'], queryFn: () => api.get<BillRun[]>('/bill-runs') });
  return (
    <>
      <PageHeader title="Billing" subtitle="Billing runs: calculate, review, approve and issue" actions={
          can('water.billing.run') && (
            <>
              <Button variant="secondary" onClick={() => setSupplementary(true)}>Supplementary bill</Button>
              <Button onClick={() => setCreating(true)}>New billing run</Button>
            </>
          )
        }
      />
      <ErrorBox error={error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No billing runs yet. Open a reading cycle, capture readings, then calculate the bills.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Zone</th>
                  <th>Status</th>
                  <th>Bill date</th>
                  <th className="num">Bills</th>
                  <th className="num">m³</th>
                  <th className="num">Amount (KES)</th>
                  <th>Accounting</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/water/billing/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.period}</Link>
                    </td>
                    <td>
                      {r.kind === 'SUPPLEMENTARY' ? (
                        <span>
                          <Badge tone="blue">Supplementary</Badge> <span className="text-xs text-muted">{r.reason}</span>
                        </span>
                      ) : (
                        zoneName(zones, r.zoneId)
                      )}
                    </td>
                    <td><Badge value={r.status} /></td>
                    <td>{fmtDate(r.billDate)}</td>
                    <td className="num">{r.billCount.toLocaleString()}</td>
                    <td className="num">{fmtUnits(r.totalUnits)}</td>
                    <td className="num"><Money value={r.totalAmount} /></td>
                    <td>{r.status === 'APPROVED' ? <Badge value={r.accounting?.status ?? 'NOT_SENT'} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewRun onClose={() => setCreating(false)} />}
      {supplementary && <Supplementary onClose={() => setSupplementary(false)} />}
    </>
  );
}
