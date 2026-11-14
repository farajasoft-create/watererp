'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, use } from 'react';
import { Button, ErrorBox, Loading } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { api } from '@/modules/hr/ui/api';
import { PayLine, Payslip } from '@/modules/hr/ui/types';

type Printable = Payslip & { lines: PayLine[]; organisation: { name: string; address?: string; phone?: string; email?: string; kraPin?: string } | null };

function Section({ title, lines, total, totalLabel }: { title: string; lines: PayLine[]; total?: string; totalLabel?: string }) {
  if (!lines.length) return null;
  return (
    <div>
      <div className="border-b border-ink pb-0.5 text-xs font-semibold uppercase">{title}</div>
      {lines.map((l, i) => (
        <div key={`${l.code}-${i}`} className="flex justify-between py-0.5 text-sm">
          <span>{l.name}</span>
          <span className="tabular-nums">{fmtMoney(l.amount)}</span>
        </div>
      ))}
      {total && (
        <div className="flex justify-between border-t border-line py-0.5 text-sm font-semibold">
          <span>{totalLabel}</span>
          <span className="tabular-nums">{fmtMoney(total)}</span>
        </div>
      )}
    </div>
  );
}

function PayslipInner({ id }: { id: string }) {
  const mine = useSearchParams().get('mine') === '1';
  const { data: p, error, isLoading } = useQuery({ queryKey: ['hr-payslip', id, mine], queryFn: () => api.get<Printable>(mine ? `/me/payslips/${id}` : `/payslips/${id}`) });
  if (isLoading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  const org = p.organisation;
  const e = p.employee;
  const of = (...types: PayLine['type'][]) => p.lines.filter((l) => types.includes(l.type));
  return (
    <main className="mx-auto max-w-2xl bg-white p-8 print:p-0">
      <div className="no-print mb-4 flex justify-end">
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <header className="flex items-start justify-between border-b-2 border-brand-700 pb-3">
        <div>
          <div className="text-lg font-bold text-brand-800">{org?.name}</div>
          <div className="text-xs text-muted">{[org?.address, org?.phone, org?.email].filter(Boolean).join(' · ')}</div>
          {org?.kraPin && <div className="text-xs text-muted">PIN {org.kraPin}</div>}
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold uppercase tracking-wide">Payslip</div>
          <div className="text-xs">{p.payslipNo ?? 'DRAFT – not approved'}</div>
          <div className="text-xs">Month {p.period}</div>
          {p.title && <div className="text-xs font-semibold">{p.title}</div>}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-0.5 text-sm">
        <div><span className="text-muted">Name </span><b>{e.name}</b></div>
        <div><span className="text-muted">Employee no. </span>{e.employeeNo}</div>
        <div><span className="text-muted">Department </span>{e.department ?? '—'}</div>
        <div><span className="text-muted">Job title </span>{e.jobTitle ?? '—'}</div>
        <div><span className="text-muted">KRA PIN </span>{e.kraPin ?? '—'}</div>
        <div><span className="text-muted">NSSF </span>{e.nssfNo ?? '—'} <span className="text-muted">SHA </span>{e.shaNo ?? '—'}</div>
        <div className="col-span-2"><span className="text-muted">Paid to </span>{e.payMethod === 'BANK' ? [e.bankName, e.bankBranch, e.accountNo].filter(Boolean).join(', ') : e.payMethod === 'MPESA' ? `M-Pesa ${e.mpesaPhone ?? ''}` : 'Cash'}</div>
        {p.daysInPeriod && p.daysPaid !== p.daysInPeriod && <div className="col-span-2 text-amber-800">Paid for {p.daysPaid} of {p.daysInPeriod} days</div>}
      </section>

      <section className="mt-5 grid grid-cols-2 gap-6">
        <Section title="Pay" lines={of('BASIC', 'EARNING', 'REIMBURSEMENT')} total={p.gross} totalLabel="Gross pay" />
        <Section title="Deductions" lines={of('STATUTORY', 'DEDUCTION')} total={p.totalDeductions} totalLabel="Total deductions" />
      </section>

      <section className="mt-5 flex items-center justify-between rounded border-2 border-brand-700 px-4 py-2">
        <span className="text-sm font-semibold uppercase">Net pay</span>
        <span className="text-xl font-bold tabular-nums">KES {fmtMoney(p.netPay)}</span>
      </section>

      <section className="mt-5 grid grid-cols-2 gap-6 text-xs">
        <div>
          <div className="mb-0.5 font-semibold uppercase">Tax</div>
          <div className="flex justify-between"><span>Taxable pay</span><span className="tabular-nums">{fmtMoney(p.taxablePay)}</span></div>
          <div className="flex justify-between"><span>Tax charged</span><span className="tabular-nums">{fmtMoney(p.taxCharged)}</span></div>
          <div className="flex justify-between"><span>Personal relief</span><span className="tabular-nums">{fmtMoney(p.personalRelief)}</span></div>
          {Number(p.pensionRelief) > 0 && <div className="flex justify-between"><span>Pension relief</span><span className="tabular-nums">{fmtMoney(p.pensionRelief)}</span></div>}
        </div>
        <Section title="Paid by the employer on top" lines={of('EMPLOYER')} />
      </section>
      {Number(p.priorGrossPay) > 0 && (
        <p className="mt-4 text-xs text-muted">
          Tax and statutory deductions here are worked on the month&apos;s total pay, with KES {fmtMoney(p.priorGrossPay)} already paid on an earlier payroll for {p.period}: only what that one did not take is deducted.
        </p>
      )}
      <footer className="mt-8 text-center text-[10px] text-muted">NSSF, SHIF and the housing levy are deducted before PAYE, as the Tax Laws (Amendment) Act 2024 allows.</footer>
    </main>
  );
}

/** A printable payslip, for HR or (with ?mine=1) the employee themselves. */
export default function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <PayslipInner id={id} />
    </Suspense>
  );
}
