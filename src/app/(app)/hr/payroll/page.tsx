'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select } from '@/components/ui';
import { currentPeriod, fmtDate } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { PayRun } from '@/modules/hr/ui/types';

function NewRun({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: 'REGULAR', title: '', period: currentPeriod(), payDate: '', payGroup: 'BOARD' });
  const offCycle = f.kind === 'OFF_CYCLE';
  const group = f.kind === 'GROUP';
  const create = useMutation({
    mutationFn: () => api.post<PayRun>('/payroll', { kind: f.kind, title: offCycle ? f.title : undefined, payGroup: group ? f.payGroup : undefined, period: f.period, payDate: f.payDate || null }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ['hr-payrolls'] });
      router.push(`/hr/payroll/${run.id}`);
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="New payroll"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !f.period || (offCycle && !f.title.trim())}>{offCycle ? 'Create' : create.isPending ? 'Calculating pay…' : 'Calculate pay'}</Button>
        </>
      }
    >
      <ErrorBox error={create.error} />
      <div className="grid gap-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="radio" name="kind" checked={f.kind === 'REGULAR'} onChange={() => setF({ ...f, kind: 'REGULAR' })} className="mt-1" />
          <span>
            <b>The month&apos;s payroll.</b> Everyone on the payroll that month: basic salary (pro-rated for joiners and leavers), unpaid leave taken off, their allowances and deductions, then PAYE, NSSF,
            SHIF and the housing levy.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="kind" checked={offCycle} onChange={() => setF({ ...f, kind: 'OFF_CYCLE' })} className="mt-1" />
          <span>
            <b>An off-cycle payroll.</b> A bonus, arrears or someone&apos;s final dues, paid on its own. Tax is worked together with the rest of the month&apos;s pay, so nobody is taxed twice or gets relief twice.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="kind" checked={group} onChange={() => setF({ ...f, kind: 'GROUP' })} className="mt-1" />
          <span>
            <b>Board or seconded staff.</b> People whose pay group (on their pay details) is board or seconded are left off the month&apos;s payroll and paid here: board fees and allowances, or seconded staff&apos;s pay.
          </span>
        </label>
      </div>
      {group && (
        <Field label="Pay group">
          <Select value={f.payGroup} onChange={(e) => setF({ ...f, payGroup: e.target.value })}>
            <option value="BOARD">Board members</option>
            <option value="SECONDED">Seconded staff</option>
          </Select>
        </Field>
      )}
      <p className="text-sm text-muted">Nothing is final until someone else approves it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {offCycle && <Field label="What it is for" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="December bonus" maxLength={80} /></Field>}
        <Field label="Month"><Input type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></Field>
        <Field label="Pay date" hint="Defaults to the last day of the month"><Input type="date" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export default function PayrollPage() {
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-payrolls'], queryFn: () => api.get<PayRun[]>('/payroll') });
  return (
    <>
      <PageHeader title="Payroll" subtitle="Monthly and off-cycle payrolls: calculate, review, approve and pay" actions={can('hr.payroll.run') && <Button onClick={() => setCreating(true)}>New payroll</Button>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No payrolls yet. Check the statutory rates under HR settings, then calculate the first month.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Status</th>
                  <th>Pay date</th>
                  <th className="num">Employees</th>
                  <th className="num">Gross</th>
                  <th className="num">PAYE</th>
                  <th className="num">Net pay</th>
                  <th className="num">Employer cost</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/hr/payroll/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.period}</Link>
                      {r.kind !== 'REGULAR' && r.title && <div className="text-xs text-muted">{r.title}</div>}
                    </td>
                    <td><Badge value={r.status} /></td>
                    <td>{fmtDate(r.payDate)}</td>
                    <td className="num">{r.employeeCount}</td>
                    <td className="num"><Money value={r.totals?.gross} /></td>
                    <td className="num"><Money value={r.totals?.paye} /></td>
                    <td className="num font-medium"><Money value={r.totals?.netPay} /></td>
                    <td className="num"><Money value={r.totals?.employerCost} /></td>
                    <td>{r.imported ? <Badge tone="gray">imported history</Badge> : r.status === 'APPROVED' || r.status === 'PAID' ? <Badge value={r.accounting?.status ?? 'NOT_SENT'} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewRun onClose={() => setCreating(false)} />}
    </>
  );
}
