'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, use } from 'react';
import { Button, ErrorBox, Loading } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { api } from '@/modules/hr/ui/api';
import { P9 } from '@/modules/hr/ui/types';

const COLUMNS = [
  ['basic', 'Basic salary'],
  ['otherPay', 'Other pay'],
  ['gross', 'Gross pay'],
  ['retirement', 'NSSF & pension'],
  ['shif', 'SHIF'],
  ['ahl', 'Housing levy'],
  ['taxablePay', 'Chargeable pay'],
  ['taxCharged', 'Tax charged'],
  ['relief', 'Personal relief'],
  ['paye', 'PAYE'],
] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function P9Inner({ id }: { id: string }) {
  const year = Number(useSearchParams().get('year')) || new Date().getFullYear() - 1;
  const { data: p, error, isLoading } = useQuery({ queryKey: ['hr-p9', id, year], queryFn: () => api.get<P9>(id === 'me' ? '/me/p9' : `/employees/${id}/p9`, { year }) });
  if (isLoading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  return (
    <main className="mx-auto max-w-5xl bg-white p-8 print:p-0">
      <div className="no-print mb-4 flex justify-end">
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <header className="text-center">
        <div className="text-sm font-semibold uppercase">Tax deduction card (P9A) · {p.year}</div>
        <div className="text-xs text-muted">From the employer&apos;s payroll records</div>
      </header>
      <section className="mt-4 grid grid-cols-2 gap-x-6 text-sm">
        <div><span className="text-muted">Employer </span><b>{p.employer.name}</b></div>
        <div><span className="text-muted">Employer PIN </span>{p.employer.kraPin ?? '—'}</div>
        <div><span className="text-muted">Employee </span><b>{p.employee.name}</b> ({p.employee.employeeNo})</div>
        <div><span className="text-muted">Employee PIN </span>{p.employee.kraPin ?? '—'}</div>
      </section>
      <table className="mt-4 w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="border border-line p-1 text-left">Month</th>
            {COLUMNS.map(([k, t]) => <th key={k} className="border border-line p-1 text-right">{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {p.months.map((m, i) => (
            <tr key={m.period}>
              <td className="border border-line p-1">{MONTHS[i]}</td>
              {COLUMNS.map(([k]) => <td key={k} className="border border-line p-1 text-right tabular-nums">{Number(m[k]) ? fmtMoney(m[k]) : '—'}</td>)}
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="border border-line p-1">Total</td>
            {COLUMNS.map(([k]) => <td key={k} className="border border-line p-1 text-right tabular-nums">{fmtMoney(p.totals[k])}</td>)}
          </tr>
        </tbody>
      </table>
      <p className="mt-4 text-xs text-muted">Total PAYE deducted for {p.year}: KES {fmtMoney(p.totals.paye)}. Use with the KRA iTax return; KRA&apos;s own P9 format applies where it differs.</p>
    </main>
  );
}

/** The year's P9 for an employee (HR) or, with id "me", the signed-in employee's own. */
export default function P9Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <P9Inner id={id} />
    </Suspense>
  );
}
