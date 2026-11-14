'use client';

import { useQuery } from '@tanstack/react-query';
import { use } from 'react';
import { Button, ErrorBox, Loading } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, fmtMoney, fmtUnits, label } from '@/lib/format';
import { Bill } from '@/modules/water/ui/types';

type PrintableBill = Bill & {
  organisation: { name: string; address?: string; phone?: string; email?: string; kraPin?: string; paybill?: string; footer?: string } | null;
  customer: { name: string; accountNo: string; plotNo?: string; location?: string; phone?: string; category: string } | null;
};

/** A printable (A5/A4) water bill. */
export default function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: b, error, isLoading } = useQuery({ queryKey: ['bill', id], queryFn: () => api.get<PrintableBill>(`/bills/${id}`) });
  if (isLoading) return <Loading />;
  if (!b) return <ErrorBox error={error} />;
  const org = b.organisation;
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
          <div className="text-sm font-semibold uppercase tracking-wide">Water bill</div>
          <div className="text-xs">No. {b.billNo ?? 'DRAFT'}</div>
          <div className="text-xs">Period {b.period}</div>
        </div>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase text-muted">Account</div>
          <div className="text-base font-semibold">{b.accountNo}</div>
          <div>{b.customer?.name}</div>
          <div className="text-xs text-muted">{[b.customer?.plotNo, b.customer?.location].filter(Boolean).join(', ')}</div>
          <div className="text-xs text-muted">{label(b.customer?.category)} · tariff {b.tariffCode}</div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-muted">Bill date</div>
          <div>{fmtDate(b.billDate)}</div>
          <div className="mt-1 text-xs uppercase text-muted">Pay by</div>
          <div className="font-semibold">{fmtDate(b.dueDate)}</div>
        </div>
      </section>

      <section className="mt-4 rounded border border-line">
        <table className="table-base">
          <thead>
            <tr>
              <th>Meter</th>
              <th className="num">Previous</th>
              <th className="num">Current</th>
              <th className="num">Consumption (m³)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{b.meterSerial ?? '—'}</td>
              <td className="num">{fmtUnits(b.previousReading)}</td>
              <td className="num">{b.estimated ? 'Estimated' : fmtUnits(b.currentReading)}</td>
              <td className="num font-semibold">{fmtUnits(b.units)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-4">
        <table className="table-base">
          <tbody>
            {b.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td className="num">{fmtMoney(l.amount)}</td>
              </tr>
            ))}
            <tr>
              <td className="font-medium">Current charges</td>
              <td className="num font-medium">{fmtMoney(b.currentCharges)}</td>
            </tr>
            <tr>
              <td>Balance brought forward</td>
              <td className="num">{fmtMoney(b.balanceBroughtForward)}</td>
            </tr>
            <tr>
              <td className="text-base font-bold">Amount due (KES)</td>
              <td className="num text-base font-bold">{fmtMoney(b.amountDue)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {org?.paybill && (
        <section className="mt-5 rounded-md bg-brand-50 p-3 text-sm">
          <div className="font-semibold">Pay with M-Pesa</div>
          <div>
            Lipa na M-Pesa → Pay Bill → Business no. <b>{org.paybill}</b> → Account no. <b>{b.accountNo}</b>
          </div>
        </section>
      )}
      <footer className="mt-5 border-t border-line pt-2 text-xs text-muted">{org?.footer ?? 'Supply may be disconnected if the bill is not paid by the due date. A reconnection fee applies.'}</footer>
    </main>
  );
}
