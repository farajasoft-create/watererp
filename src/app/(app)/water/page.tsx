'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, ErrorBox, Input, Loading, Money, PageHeader, Stat } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { currentPeriod, fmtMoney, fmtUnits } from '@/lib/format';
import { BillRun } from '@/modules/water/ui/types';

interface Dashboard {
  period: string;
  customers: { active: number; byStatus: Record<string, number> };
  billing: { billed: string; units: string; bills: number };
  collections: { collected: string; payments: number };
  arrears: string;
  readings: { read: number; expected: number; pendingReview: number };
  work: { unmatchedPayments: number; disconnectionList: number };
  indicators: { collectionEfficiency: string | null; meteringRatio: string | null; readingCoverage: string | null; nrwPercent: string | null; nrwRating: string | null };
  recentRuns: BillRun[];
}

const pct = (v: string | null) => (v === null ? '—' : `${Number(v).toFixed(1)}%`);
const tone = (v: string | null, good: number, warn: number) => (v === null ? undefined : Number(v) >= good ? 'good' : Number(v) >= warn ? 'warn' : 'bad');

export default function DashboardPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const { data, error, isLoading } = useQuery({ queryKey: ['dashboard', period], queryFn: () => api.get<Dashboard>('/reports/dashboard', { period }) });

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Revenue, collections and network performance for the period" actions={<Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-40" />} />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Active connections" value={data.customers.active.toLocaleString()} hint={`${data.customers.byStatus.DISCONNECTED ?? 0} disconnected · ${(data.customers.byStatus.APPLIED ?? 0) + (data.customers.byStatus.APPROVED ?? 0)} pending connection`} />
            <Stat label="Billed this period" value={`KES ${fmtMoney(data.billing.billed)}`} hint={`${data.billing.bills.toLocaleString()} bills · ${fmtUnits(data.billing.units)} m³`} />
            <Stat label="Collected this period" value={`KES ${fmtMoney(data.collections.collected)}`} hint={`${data.collections.payments.toLocaleString()} payments`} />
            <Stat label="Total arrears" value={`KES ${fmtMoney(data.arrears)}`} hint={<Link href="/water/reports" className="text-brand-700 hover:underline">Debt ageing →</Link>} />
          </div>

          <Card title="WASREB key performance indicators">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Collection efficiency" value={pct(data.indicators.collectionEfficiency)} tone={tone(data.indicators.collectionEfficiency, 95, 85)} hint="Collected ÷ billed (benchmark ≥ 95%)" />
              <Stat
                label="Non-revenue water"
                value={pct(data.indicators.nrwPercent)}
                tone={data.indicators.nrwRating === 'GOOD' ? 'good' : data.indicators.nrwRating === 'ACCEPTABLE' ? 'warn' : data.indicators.nrwRating ? 'bad' : undefined}
                hint={<Link href="/water/nrw" className="text-brand-700 hover:underline">Water balance (benchmark &lt; 20%) →</Link>}
              />
              <Stat label="Metering ratio" value={pct(data.indicators.meteringRatio)} tone={tone(data.indicators.meteringRatio, 100, 95)} hint="Active connections with a meter" />
              <Stat label="Reading coverage" value={pct(data.indicators.readingCoverage)} tone={tone(data.indicators.readingCoverage, 95, 80)} hint={`${data.readings.read.toLocaleString()} of ${data.readings.expected.toLocaleString()} meters read`} />
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Needs attention">
              <ul className="divide-y divide-line text-sm">
                <li className="flex justify-between py-2">
                  <Link href="/water/readings?status=PENDING" className="text-brand-700 hover:underline">Readings awaiting review</Link>
                  <span className="font-medium tabular-nums">{data.readings.pendingReview}</span>
                </li>
                <li className="flex justify-between py-2">
                  <Link href="/water/payments?status=UNMATCHED" className="text-brand-700 hover:underline">Unmatched M-Pesa payments</Link>
                  <span className="font-medium tabular-nums">{data.work.unmatchedPayments}</span>
                </li>
                <li className="flex justify-between py-2">
                  <Link href="/water/disconnections" className="text-brand-700 hover:underline">Accounts on the disconnection list</Link>
                  <span className="font-medium tabular-nums">{data.work.disconnectionList}</span>
                </li>
              </ul>
            </Card>
            <Card title="Recent billing runs" padded={false}>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Status</th>
                    <th className="num">Bills</th>
                    <th className="num">Amount</th>
                    <th>Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentRuns.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/water/billing/${r.id}`} className="text-brand-700 hover:underline">{r.period}</Link>
                      </td>
                      <td><Badge value={r.status} /></td>
                      <td className="num">{r.billCount}</td>
                      <td className="num"><Money value={r.totalAmount} /></td>
                      <td><Badge value={r.accounting?.status ?? 'NOT_SENT'} /></td>
                    </tr>
                  ))}
                  {!data.recentRuns.length && (
                    <tr>
                      <td colSpan={5} className="text-center text-muted">No billing runs yet</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
