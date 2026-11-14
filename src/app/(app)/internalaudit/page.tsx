'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, ErrorBox, Input, Loading, Money, PageHeader, Stat } from '@/components/ui';
import { label } from '@/lib/format';
import { api } from '@/modules/internalaudit/ui/api';
import { RatingBadge, RATINGS } from '@/modules/internalaudit/ui/shared';

interface Dashboard {
  plan: { id: string; title: string; audits: number; started: number; completed: number; plannedHours: number; completionPct: number | null } | null;
  engagements: { total: number; byStatus: Record<string, number> };
  findings: { total: number; byRating: Record<string, number> };
  recommendations: { tracked: number; open: number; verified: number; implementationPct: number | null; overdue: number; ageing: { band: string; count: number }[] };
  productivity: { id: string; name: string; hours: number; engagements: number; led: number; papersPrepared: number; papersReviewed: number; findings: number }[];
  hoursByActivity: { activity: string; hours: number }[];
  budget: { id: string; number: string; title: string; status: string; budgetHours: number; hours: number; variancePct: number | null; cost: string }[];
  totals: { hours: number; cost: string };
}

/** A horizontal bar for a share of the largest value. */
function Bar({ value, max, tone = 'bg-brand-500' }: { value: number; max: number; tone?: string }) {
  return (
    <div className="h-2 w-full rounded bg-slate-100">
      <div className={`h-2 rounded ${tone}`} style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

export default function InternalAuditDashboard() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { data: d, error, isLoading } = useQuery({ queryKey: ['ia-dashboard', year], queryFn: () => api.get<Dashboard>('/dashboard', { year }) });
  const maxAge = Math.max(0, ...(d?.recommendations.ageing.map((a) => a.count) ?? []));
  const maxRating = Math.max(0, ...RATINGS.map((r) => d?.findings.byRating[r] ?? 0));
  const maxHours = Math.max(0, ...(d?.hoursByActivity.map((h) => h.hours) ?? []));
  return (
    <>
      <PageHeader title="Internal audit" subtitle="Plan delivery, findings, recommendations and the team's time" actions={<Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="max-w-28" aria-label="Year" />} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : d && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Plan delivered" value={d.plan ? `${d.plan.completed} of ${d.plan.audits}` : 'No approved plan'} hint={d.plan?.completionPct != null ? `${d.plan.completionPct}%` : undefined} />
            <Stat label="Engagements" value={d.engagements.total} hint={`${d.engagements.byStatus.FIELDWORK ?? 0} in fieldwork`} />
            <Stat label="Findings reported" value={d.findings.total} />
            <Stat label="Recommendations implemented" value={d.recommendations.implementationPct != null ? `${d.recommendations.implementationPct}%` : '—'} hint={`${d.recommendations.verified} of ${d.recommendations.tracked} verified`} tone="good" />
            <Stat label="Overdue actions" value={d.recommendations.overdue} tone={d.recommendations.overdue ? 'bad' : undefined} />
            <Stat label="Hours / cost" value={`${d.totals.hours} h`} hint={<>KES <Money value={d.totals.cost} /></>} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Engagements by stage">
              <ul className="space-y-1.5 text-sm">
                {Object.entries(d.engagements.byStatus).map(([k, n]) => <li key={k} className="flex justify-between"><Badge value={k} /><span className="tabular-nums">{n}</span></li>)}
              </ul>
            </Card>
            <Card title="Findings by risk rating">
              <ul className="space-y-2 text-sm">
                {RATINGS.slice().reverse().map((r) => (
                  <li key={r} className="grid grid-cols-[80px_1fr_32px] items-center gap-2"><RatingBadge r={r} /><Bar value={d.findings.byRating[r] ?? 0} max={maxRating} tone={r === 'CRITICAL' ? 'bg-red-500' : r === 'HIGH' ? 'bg-amber-500' : 'bg-brand-500'} /><span className="text-right tabular-nums">{d.findings.byRating[r] ?? 0}</span></li>
                ))}
              </ul>
            </Card>
            <Card title="Open recommendations by age" actions={<Link href="/internalaudit/recommendations?overdue=true" className="text-sm text-brand-700 hover:underline">Overdue</Link>}>
              <ul className="space-y-2 text-sm">
                {d.recommendations.ageing.map((a) => (
                  <li key={a.band} className="grid grid-cols-[110px_1fr_32px] items-center gap-2"><span>{a.band}</span><Bar value={a.count} max={maxAge} tone={a.band === 'Not yet due' ? 'bg-emerald-500' : 'bg-red-500'} /><span className="text-right tabular-nums">{a.count}</span></li>
                ))}
              </ul>
            </Card>
          </div>
          <Card padded={false} title="Auditor productivity">
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Auditor</th><th className="num">Hours</th><th className="num">Engagements</th><th className="num">Led</th><th className="num">Papers prepared</th><th className="num">Papers reviewed</th><th className="num">Findings</th></tr></thead>
                <tbody>
                  {d.productivity.map((p) => <tr key={p.id}><td>{p.name}</td><td className="num">{p.hours}</td><td className="num">{p.engagements}</td><td className="num">{p.led}</td><td className="num">{p.papersPrepared}</td><td className="num">{p.papersReviewed}</td><td className="num">{p.findings}</td></tr>)}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Hours by activity">
              <ul className="space-y-2 text-sm">
                {d.hoursByActivity.map((h) => <li key={h.activity} className="grid grid-cols-[90px_1fr_40px] items-center gap-2"><span>{label(h.activity)}</span><Bar value={h.hours} max={maxHours} /><span className="text-right tabular-nums">{h.hours}</span></li>)}
              </ul>
            </Card>
            <Card padded={false} title="Engagement hours and cost against budget" className="lg:col-span-2">
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th>Engagement</th><th>Stage</th><th className="num">Budget h</th><th className="num">Actual h</th><th className="num">Variance</th><th className="num">Cost (KES)</th></tr></thead>
                  <tbody>
                    {d.budget.map((b) => (
                      <tr key={b.id}>
                        <td><Link href={`/internalaudit/engagements/${b.id}`} className="text-brand-700 hover:underline">{b.number}</Link> {b.title}</td>
                        <td><Badge value={b.status} /></td>
                        <td className="num">{b.budgetHours}</td>
                        <td className="num">{b.hours}</td>
                        <td className={`num ${b.variancePct != null && b.variancePct > 10 ? 'text-red-700' : ''}`}>{b.variancePct != null ? `${b.variancePct > 0 ? '+' : ''}${b.variancePct}%` : '—'}</td>
                        <td className="num"><Money value={b.cost} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
