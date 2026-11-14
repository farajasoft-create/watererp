'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, ErrorBox, Input, Loading, PageHeader, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { currentPeriod, fmtDate, fmtMoney, label } from '@/lib/format';

const BUCKETS = [
  ['current', 'Not yet due'],
  ['d30', '1–30 days'],
  ['d60', '31–60 days'],
  ['d90', '61–90 days'],
  ['over90', 'Over 90 days'],
] as const;

interface Ageing {
  asAt: string;
  debtors: number;
  byCategory: Record<string, Record<string, string>>;
  total: Record<string, string>;
}

interface Wasreb {
  rows: { key: string; name: string; value: number | null; unit: string; rating: string; basis: string; benchmark: { good: number; acceptable: number } }[];
}

const RATING_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { GOOD: 'green', ACCEPTABLE: 'amber', NOT_ACCEPTABLE: 'red', NO_DATA: 'gray' };

/** The WASPA annual benchmarking return for a financial year (July to June). */
function WaspaCard() {
  const thisYear = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  const [fyEnd, setFyEnd] = useState(thisYear - 1);
  const { data, error, isLoading } = useQuery({ queryKey: ['waspa', fyEnd], queryFn: () => api.get<{ financialYear: string; lines: { section: string; item: string; value: string | number | null; unit: string; source: string }[] }>('/reports/waspa', { fyEnd }) });
  return (
    <Card padded={false} title={<span>WASPA annual return {data ? data.financialYear : ''}</span>} actions={<div className="flex items-center gap-2"><Select value={String(fyEnd)} onChange={(e) => setFyEnd(Number(e.target.value))} className="w-32">{[0, 1, 2, 3].map((i) => <option key={i} value={thisYear - i}>{thisYear - i - 1}/{String(thisYear - i).slice(2)}</option>)}</Select><a className="text-sm font-medium text-brand-700 hover:underline" href={`/api/v1/water/reports/waspa?fyEnd=${fyEnd}&csv=true`}>CSV</a></div>}>
      <ErrorBox error={error} />
      {isLoading || !data ? <Loading /> : (
        <table className="table-base">
          <thead><tr><th>Section</th><th>Item</th><th className="num">Value</th><th>Unit</th><th>Source</th></tr></thead>
          <tbody>{data.lines.map((l, i) => <tr key={i}><td className="text-xs text-muted">{l.section}</td><td>{l.item}</td><td className="num">{l.value === null ? <span className="text-muted">to fill in</span> : String(l.value)}</td><td className="text-xs">{l.unit}</td><td className="text-xs text-muted">{l.source}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function WasrebCard() {
  const [period, setPeriod] = useState(currentPeriod());
  const [months, setMonths] = useState('1');
  const { data, error, isLoading } = useQuery({ queryKey: ['wasreb', period, months], queryFn: () => api.get<Wasreb>('/reports/wasreb', { period, months }) });
  return (
    <Card
      padded={false}
      title="WASREB key performance indicators"
      actions={
        <>
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          <Select value={months} onChange={(e) => setMonths(e.target.value)} className="w-36">
            <option value="1">The month</option>
            <option value="3">Quarter to it</option>
            <option value="12">Year to it</option>
          </Select>
          <a className="text-sm font-medium text-brand-700 hover:underline" href={`/api/v1/water/reports/wasreb?period=${period}&months=${months}&csv=true`}>CSV</a>
        </>
      }
    >
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <table className="table-base">
          <thead><tr><th>Indicator</th><th className="num">Value</th><th>Rating</th><th className="num">Good / acceptable</th><th>Worked from</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td>{r.name}</td>
                <td className="num font-medium">{r.value === null ? '—' : `${r.value}${r.unit === '%' ? '%' : r.unit ? ` ${r.unit}` : ''}`}</td>
                <td><Badge tone={RATING_TONE[r.rating]}>{label(r.rating)}</Badge></td>
                <td className="num text-xs text-muted">{r.benchmark.good} / {r.benchmark.acceptable}</td>
                <td className="text-xs text-muted">{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function ReportsPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const { data, error, isLoading } = useQuery({ queryKey: ['ageing'], queryFn: () => api.get<Ageing>('/reports/ageing') });
  const rowTotal = (r: Record<string, string>) => BUCKETS.reduce((s, [k]) => s + Number(r[k] ?? 0), 0);
  return (
    <>
      <PageHeader title="Reports" />
      <div className="space-y-5">
        <WasrebCard />
        <WaspaCard />
        <Card title="Billing register" actions={<Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />}>
          <p className="mb-2 text-sm text-muted">Every bill issued for the period: readings, units, each charge, balance brought forward and amount due. Opens in Excel.</p>
          <a href={`/api/v1/water/reports/billing-register?period=${period}`} className="text-sm font-medium text-brand-700 hover:underline">Download billing register {period} (CSV)</a>
        </Card>
        <Card padded={false} title={data ? `Debt ageing as at ${fmtDate(data.asAt)} · ${data.debtors.toLocaleString()} accounts in arrears` : 'Debt ageing'}>
          <ErrorBox error={error} />
          {isLoading || !data ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Category</th>
                    {BUCKETS.map(([k, l]) => (
                      <th key={k} className="num">{l}</th>
                    ))}
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.byCategory).map(([cat, row]) => (
                    <tr key={cat}>
                      <td>{label(cat)}</td>
                      {BUCKETS.map(([k]) => (
                        <td key={k} className="num">{fmtMoney(row[k])}</td>
                      ))}
                      <td className="num font-medium">{fmtMoney(rowTotal(row))}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-semibold">Total</td>
                    {BUCKETS.map(([k]) => (
                      <td key={k} className="num font-semibold">{fmtMoney(data.total[k])}</td>
                    ))}
                    <td className="num font-semibold">{fmtMoney(rowTotal(data.total))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
