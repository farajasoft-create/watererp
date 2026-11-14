'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, Input, Loading, Money, Notice, PageHeader, Select, Stat, Tabs } from '@/components/ui';
import { label, today } from '@/lib/format';
import { api } from '@/modules/bi/ui/api';

interface Turnaround {
  processes: { key: string; label: string; module: string; completed: number; avgHours: number | null; medianHours: number | null; p90Hours: number | null; onTimePct: number | null; open: number; overdue: number; oldestOpenDays: number | null }[];
  bottlenecks: { key: string; label: string; reason: string }[];
}
interface Scored { id: string; accountNo: string; name: string; category: string; status: string; balance: number; arrearsDays: number; daysSinceLastPayment: number | null; paidOfBilledPct: number | null; defaultRisk: number; churnRisk: number; band: string; expectedLoss: number }
interface Risk {
  scored: number;
  portfolio: { balance: number; expectedLoss: number; atRiskPct: number | null; bands: { band: string; accounts: number; balance: number; expectedLoss: number }[] };
  churn: { likely: number; ofActive: number };
  riskiest: Scored[];
  likelyToLeave: Scored[];
  weights: Record<string, string>;
  model?: { method: 'TRAINED' | 'RULES'; reason?: string; trainedOn: number; defaulters: number; testAuc: number | null; coefficients?: Record<string, number> };
}

const hrs = (h: number | null) => (h === null ? '—' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`);
const TONE: Record<string, 'red' | 'amber' | 'green'> = { HIGH: 'red', MEDIUM: 'amber', LOW: 'green' };

function TurnaroundTab() {
  const [range, setRange] = useState({ from: `${today().slice(0, 4)}-01-01`, to: today() });
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-turnaround', range], queryFn: () => api.get<Turnaround>('/analytics/turnaround', range) });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Finished from"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : data && (
        <div className="space-y-4">
          {data.bottlenecks.length > 0 && <Notice tone="amber"><b>Bottlenecks:</b> {data.bottlenecks.map((b) => `${b.label}: ${b.reason}`).join('; ')}.</Notice>}
          <Card padded={false} title="End-to-end turnaround, every process">
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Process</th><th className="num">Finished</th><th className="num">Average</th><th className="num">Median</th><th className="num">90% within</th><th className="num">On time</th><th className="num">Open now</th><th className="num">Overdue</th><th className="num">Oldest open</th></tr></thead>
                <tbody>
                  {data.processes.map((p) => (
                    <tr key={p.key} className={data.bottlenecks.some((b) => b.key === p.key) ? 'bg-amber-50' : ''}>
                      <td>{p.label}</td>
                      <td className="num">{p.completed}</td>
                      <td className="num">{hrs(p.avgHours)}</td>
                      <td className="num">{hrs(p.medianHours)}</td>
                      <td className="num">{hrs(p.p90Hours)}</td>
                      <td className="num">{p.onTimePct === null ? '—' : `${p.onTimePct}%`}</td>
                      <td className="num">{p.open}</td>
                      <td className={`num ${p.overdue ? 'text-red-700' : ''}`}>{p.overdue}</td>
                      <td className="num">{p.oldestOpenDays === null ? '—' : `${p.oldestOpenDays} days`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="text-xs text-muted">On time is against each record&apos;s own deadline where it has one; otherwise 14 days for connections, 48 hours for leave decisions and 72 hours for approvals.</p>
        </div>
      )}
    </>
  );
}

function RiskTable({ rows, churn }: { rows: Scored[]; churn?: boolean }) {
  if (!rows.length) return <Empty>None.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead><tr><th>Account</th><th>Customer</th><th>Status</th><th className="num">Balance</th><th className="num">Arrears days</th><th className="num">Last paid</th><th className="num">Paid of billed</th><th className="num">{churn ? 'Leaving risk' : 'Default risk'}</th><th className="num">Expected loss</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.accountNo}</td>
              <td>{r.name}<div className="text-xs text-muted">{label(r.category)}</div></td>
              <td><Badge value={r.status} /></td>
              <td className="num"><Money value={r.balance} /></td>
              <td className="num">{r.arrearsDays}</td>
              <td className="num">{r.daysSinceLastPayment === null ? 'not in 6 months' : `${r.daysSinceLastPayment} days ago`}</td>
              <td className="num">{r.paidOfBilledPct === null ? '—' : `${r.paidOfBilledPct}%`}</td>
              <td className="num">{churn ? `${r.churnRisk}%` : <><Badge tone={TONE[r.band]}>{r.defaultRisk}%</Badge></>}</td>
              <td className="num"><Money value={r.expectedLoss} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskTab() {
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-risk'], queryFn: () => api.get<Risk>('/analytics/customer-risk') });
  return (
    <>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Accounts scored" value={data.scored} />
            <Stat label="Owed" value={<Money value={data.portfolio.balance} />} />
            <Stat label="Expected loss" value={<Money value={data.portfolio.expectedLoss} />} tone="warn" />
            <Stat label="Owed by high-risk accounts" value={data.portfolio.atRiskPct === null ? '—' : `${data.portfolio.atRiskPct}%`} tone="bad" />
            <Stat label="Likely to leave" value={`${data.churn.likely}`} hint={`of ${data.churn.ofActive} active`} />
          </div>
          <Card padded={false} title="Portfolio by risk">
            <table className="table-base">
              <thead><tr><th>Risk</th><th className="num">Accounts</th><th className="num">Owed</th><th className="num">Expected loss</th></tr></thead>
              <tbody>{data.portfolio.bands.map((b) => <tr key={b.band}><td><Badge tone={TONE[b.band]}>{b.band.toLowerCase()}</Badge></td><td className="num">{b.accounts}</td><td className="num"><Money value={b.balance} /></td><td className="num"><Money value={b.expectedLoss} /></td></tr>)}</tbody>
            </table>
          </Card>
          <Card padded={false} title="Most likely to default (by expected loss)"><RiskTable rows={data.riskiest} /></Card>
          <Card padded={false} title="Most likely to leave"><RiskTable rows={data.likelyToLeave} churn /></Card>
          <Card title="How the score is worked out">
            {data.model?.method === 'TRAINED' ? (
              <>
                <p className="mb-2 text-sm">Likelihood of default comes from a logistic regression trained on this organisation&apos;s own accounts: their payment behaviour six months ago and whether they then defaulted ({data.model.trainedOn} accounts, {data.model.defaulters} defaults). On accounts held back from training it ranks a defaulter above a good payer {Math.round((data.model.testAuc ?? 0) * 100)}% of the time (AUC {data.model.testAuc}). It is retrained on every run.</p>
                <p className="mb-1 text-xs text-muted">Weights on standardised inputs (positive raises the risk):</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{Object.entries(data.model.coefficients ?? {}).map(([k, v]) => <li key={k}><b>{label(k)}</b>: {v}</li>)}</ul>
              </>
            ) : (
              <>
                <p className="mb-2 text-sm text-muted">{data.model?.reason ? `${data.model.reason}. Until then ` : ''}a transparent rule-based score is used, so every number can be explained to a customer or an auditor:</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{Object.entries(data.weights).map(([k, v]) => <li key={k}><b>{label(k)}</b>: {v}</li>)}</ul>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

interface Segments { customers: number; note?: string; features?: string[]; segments: { segment: number; name: string; customers: number; share: number; balanceOwed: number; centre: { monthlyUnits: number; monthlyBill: number; paidShare: number; daysSincePayment: number; balance: number }; examples: { accountNo: string; name: string }[] }[] }

/** Data mining: customers grouped by how they use water and pay (k-means). */
function SegmentsTab() {
  const [k, setK] = useState(4);
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-segments', k], queryFn: () => api.get<Segments>('/analytics/customer-segments', { k }) });
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="flex items-center gap-2 text-sm">Groups <Select value={String(k)} onChange={(e) => setK(Number(e.target.value))} className="w-20">{[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</Select><span className="text-muted">k-means on {data?.features?.join(', ') ?? 'behaviour'} over the last six months</span></div>
      {isLoading || !data ? <Loading /> : data.note ? <Card><p className="text-sm text-muted">{data.note}</p></Card> : (
        <Card padded={false} title={`${data.customers} active customers in ${data.segments.length} groups`}>
          <table className="table-base">
            <thead><tr><th>Group</th><th className="num">Customers</th><th className="num">m³ a month</th><th className="num">Bill a month</th><th className="num">Bills paid</th><th className="num">Days since paying</th><th className="num">Owed</th><th>For example</th></tr></thead>
            <tbody>{data.segments.map((s) => <tr key={s.segment}><td className="font-medium">{s.name}</td><td className="num">{s.customers} <span className="text-xs text-muted">({s.share}%)</span></td><td className="num">{s.centre.monthlyUnits}</td><td className="num">{s.centre.monthlyBill.toLocaleString()}</td><td className="num">{s.centre.paidShare}%</td><td className="num">{s.centre.daysSincePayment}</td><td className="num">{s.balanceOwed.toLocaleString()}</td><td className="text-xs">{s.examples.map((e) => e.accountNo).join(', ')}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState<'turnaround' | 'risk' | 'segments'>('turnaround');
  return (
    <>
      <PageHeader title="Turnaround and risk" subtitle="How long work takes across the organisation, where it gets stuck, and which accounts are at risk" />
      <Tabs tabs={[{ id: 'turnaround', label: 'Turnaround and bottlenecks' }, { id: 'risk', label: 'Customer risk' }, { id: 'segments', label: 'Customer groups' }]} value={tab} onChange={setTab} />
      {tab === 'turnaround' ? <TurnaroundTab /> : tab === 'risk' ? <RiskTab /> : <SegmentsTab />}
    </>
  );
}
