'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, ErrorBox, Input, Loading, Money, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { api } from '@/modules/hr/ui/api';
import { lastMonth } from '@/modules/hr/ui/hooks';
import { GratuityReport, PayrollAuditTrail } from '@/modules/hr/ui/payroll-extras';
import { useCan } from '@/lib/session';

interface Returns {
  period: string;
  due: string;
  employees: number;
  paye: string;
  nssf: { employee: string; employer: string; tier1: string; tier2: string };
  shif: string;
  ahl: { employee: string; employer: string };
  nita: string;
  netPay: string;
  gross: string;
}

const RETURNS = [
  { type: 'PAYE', title: 'PAYE', to: 'KRA iTax (P10)', amount: (r: Returns) => r.paye, detail: () => 'Taxable pay, tax charged and relief per employee' },
  { type: 'NSSF', title: 'NSSF', to: 'NSSF', amount: (r: Returns) => Number(r.nssf.employee) + Number(r.nssf.employer), detail: (r: Returns) => `Employees ${r.nssf.employee} (Tier I ${r.nssf.tier1}, Tier II ${r.nssf.tier2}) + employer ${r.nssf.employer}` },
  { type: 'SHIF', title: 'SHIF', to: 'Social Health Authority', amount: (r: Returns) => r.shif, detail: () => '2.75% of gross pay, at least KES 300' },
  { type: 'AHL', title: 'Housing levy', to: 'KRA iTax', amount: (r: Returns) => Number(r.ahl.employee) + Number(r.ahl.employer), detail: (r: Returns) => `Employees ${r.ahl.employee} + employer ${r.ahl.employer}` },
  { type: 'NET_PAY', title: 'Net pay', to: 'Bank / M-Pesa bulk payment', amount: (r: Returns) => r.netPay, detail: () => 'Account or phone and amount per employee' },
] as const;

export default function ReturnsPage() {
  const can = useCan();
  const [period, setPeriod] = useState(lastMonth());
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-returns', period], queryFn: () => api.get<Returns>('/returns', { period }), enabled: Boolean(period), retry: false });
  return (
    <>
      <PageHeader title="Statutory returns" subtitle="What to remit for a payroll month, and the schedules each authority asks for" actions={<Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="max-w-40" />} />
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : (
        data && (
          <>
            <p className="mb-4 text-sm text-muted">
              {data.employees} employees, gross pay KES <Money value={data.gross} />. PAYE, NSSF, SHIF and the housing levy are due by <b>{fmtDate(data.due)}</b>. NITA levy: KES <Money value={data.nita} />.
            </p>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {RETURNS.map((r) => (
                <Card key={r.type} title={`${r.title} → ${r.to}`}>
                  <div className="text-2xl font-semibold tabular-nums">KES <Money value={r.amount(data)} /></div>
                  <p className="mt-1 text-xs text-muted">{r.detail(data)}</p>
                  <a href={`/api/v1/hr/returns/csv?period=${period}&type=${r.type}`} className="mt-3 inline-block text-sm text-brand-700 hover:underline">Download schedule (CSV)</a>
                </Card>
              ))}
            </div>
          </>
        )
      )}
      {can('hr.salary.view') && (
        <div className="mt-6 grid gap-6">
          <GratuityReport />
          {can('hr.reports.view') && <PayrollAuditTrail />}
        </div>
      )}
    </>
  );
}
