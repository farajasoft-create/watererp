'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Money, Notice, PageHeader, Select, Stat } from '@/components/ui';
import { fmtDate, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/projects/ui/api';
import { MonthlyBars, Progress } from '@/modules/projects/ui/shared';

interface Project {
  id: string;
  code: string;
  name: string;
  description?: string;
  kind: string;
  status: string;
  financeCode: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  manager: string | null;
  grants: { id: string; code: string; title: string }[];
  milestones: { id: string; name: string; due?: string | null; weight: number; percentComplete: number; completedAt?: string | null; note?: string }[];
  kpis: { id: string; name: string; unit?: string; baseline: number; target: number; actual: number | null; direction: string; updates: { at: string; value: number; note?: string }[] }[];
  capitalisations: { id: string; date: string; amount: string; assetRef?: string; note?: string }[];
  position: { financeLinked: boolean; budget: string; spent: string; capex: string; opex: string; capitalised: string; wip: string; remaining: string; spentPct: number | null; physicalPct: number | null; timeElapsedPct: number | null; kpiAttainmentPct: number | null; costPerformance: number | null; byAccount: { code: string; name: string; accountClass: string; amount: string }[]; monthly: { month: string; amount: number }[] };
}

function Milestones({ p, refresh }: { p: Project; refresh: () => void }) {
  const can = useCan();
  const [rows, setRows] = useState(p.milestones.map((m) => ({ id: m.id, name: m.name, due: m.due?.slice(0, 10) ?? '', weight: String(m.weight), percentComplete: String(m.percentComplete) })));
  const save = useMutation({ mutationFn: () => api.put(`/projects/${p.id}/milestones`, { milestones: rows.filter((r) => r.name.length >= 2).map((r) => ({ id: r.id, name: r.name, due: r.due || null, weight: Number(r.weight) || 1, percentComplete: Number(r.percentComplete) || 0 })) }), onSuccess: refresh });
  const set = (i: number, k: string, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const manage = can('projects.manage');
  return (
    <Card title={`Milestones (physical progress ${p.position.physicalPct ?? '—'}%)`} actions={manage && <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {!rows.length && !manage ? <Empty>No milestones.</Empty> : (
        <div className="space-y-2">
          <div className="grid grid-cols-[2fr_1fr_80px_100px] gap-2 text-xs text-muted"><span>Milestone</span><span>Due</span><span>Weight</span><span>% complete</span></div>
          {rows.map((r, i) => (
            <div key={r.id ?? `n${i}`} className="grid grid-cols-[2fr_1fr_80px_100px] gap-2">
              <Input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} disabled={!manage} />
              <Input type="date" value={r.due} onChange={(e) => set(i, 'due', e.target.value)} disabled={!manage} />
              <Input inputMode="numeric" value={r.weight} onChange={(e) => set(i, 'weight', e.target.value)} disabled={!manage} />
              <Input inputMode="numeric" value={r.percentComplete} onChange={(e) => set(i, 'percentComplete', e.target.value)} disabled={!manage} />
            </div>
          ))}
          {manage && <Button variant="secondary" onClick={() => setRows([...rows, { id: undefined as unknown as string, name: '', due: '', weight: '1', percentComplete: '0' }])}>Add milestone</Button>}
        </div>
      )}
    </Card>
  );
}

function Kpis({ p, refresh }: { p: Project; refresh: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ name: '', unit: '', baseline: '0', target: '', direction: 'UP' });
  const [rec, setRec] = useState<Record<string, string>>({});
  const add = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/kpis`, { name: f.name, unit: f.unit || undefined, baseline: Number(f.baseline) || 0, target: Number(f.target), direction: f.direction }), onSuccess: () => { setF({ name: '', unit: '', baseline: '0', target: '', direction: 'UP' }); refresh(); } });
  const record = useMutation({ mutationFn: (k: string) => api.post(`/projects/${p.id}/kpis/${k}/record`, { value: Number(rec[k]) }), onSuccess: refresh });
  const manage = can('projects.manage');
  return (
    <Card padded={false} title={`Key performance indicators (${p.position.kpiAttainmentPct ?? '—'}% attained)`}>
      <ErrorBox error={add.error || record.error} />
      {!p.kpis.length ? <Empty>No indicators.</Empty> : (
        <table className="table-base">
          <thead><tr><th>Indicator</th><th className="num">Baseline</th><th className="num">Target</th><th className="num">Actual</th><th>Last update</th>{manage && <th />}</tr></thead>
          <tbody>
            {p.kpis.map((k) => (
              <tr key={k.id}>
                <td>{k.name}{k.unit && <span className="text-muted"> ({k.unit})</span>}{k.direction === 'DOWN' && <span className="text-xs text-muted"> lower is better</span>}</td>
                <td className="num">{k.baseline}</td>
                <td className="num">{k.target}</td>
                <td className="num font-medium">{k.actual ?? '—'}</td>
                <td>{k.updates.length ? fmtDate(k.updates[k.updates.length - 1].at) : '—'}</td>
                {manage && <td><div className="flex gap-1"><Input className="w-24" inputMode="decimal" value={rec[k.id] ?? ''} onChange={(e) => setRec({ ...rec, [k.id]: e.target.value })} /><Button variant="secondary" onClick={() => record.mutate(k.id)} disabled={!rec[k.id]}>Record</Button></div></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manage && (
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-6">
          <Input placeholder="Indicator" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="sm:col-span-2" />
          <Input placeholder="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
          <Input placeholder="Baseline" value={f.baseline} onChange={(e) => setF({ ...f, baseline: e.target.value })} />
          <Input placeholder="Target" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
          <div className="flex gap-1"><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="UP">Higher better</option><option value="DOWN">Lower better</option></Select><Button onClick={() => add.mutate()} disabled={f.name.length < 2 || f.target === ''}>Add</Button></div>
        </div>
      )}
    </Card>
  );
}

function Capitalise({ p, refresh }: { p: Project; refresh: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ date: today(), amount: '', assetRef: '' });
  const save = useMutation({ mutationFn: () => api.post(`/projects/${p.id}/capitalise`, { ...f, assetRef: f.assetRef || undefined }), onSuccess: () => { setF({ date: today(), amount: '', assetRef: '' }); refresh(); } });
  return (
    <Card padded={false} title="Work in progress and capitalisation">
      <div className="grid grid-cols-3 gap-3 p-3 text-sm">
        <div><div className="text-muted">Capital spending</div><Money value={p.position.capex} /></div>
        <div><div className="text-muted">Capitalised</div><Money value={p.position.capitalised} /></div>
        <div><div className="text-muted">Still in progress</div><b><Money value={p.position.wip} /></b></div>
      </div>
      {p.capitalisations.length > 0 && (
        <table className="table-base"><thead><tr><th>Date</th><th>Asset</th><th className="num">Amount</th></tr></thead><tbody>{p.capitalisations.map((c) => <tr key={c.id}><td>{fmtDate(c.date)}</td><td>{c.assetRef}</td><td className="num"><Money value={c.amount} /></td></tr>)}</tbody></table>
      )}
      {can('projects.manage') && Number(p.position.wip) > 0 && (
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-4">
          <ErrorBox error={save.error} />
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <Input placeholder="Amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <Input placeholder="Fixed asset tag" value={f.assetRef} onChange={(e) => setF({ ...f, assetRef: e.target.value })} />
          <Button onClick={() => save.mutate()} disabled={!Number(f.amount) || save.isPending}>Capitalise</Button>
        </div>
      )}
      <p className="px-3 pb-3 text-xs text-muted">Record the matching journal (work in progress to fixed assets) in Finance; this keeps the project&apos;s record of what moved.</p>
    </Card>
  );
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['projects-project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['projects-project', id] }); qc.invalidateQueries({ queryKey: ['projects-list'] }); };
  if (isLoading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  const s = p.position;
  return (
    <>
      <PageHeader title={`${p.code} · ${p.name}`} subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={p.status} /> {label(p.kind)}{p.location && ` · ${p.location}`}{p.manager && ` · managed by ${p.manager}`}{p.startDate && ` · ${fmtDate(p.startDate)} – ${fmtDate(p.endDate ?? null)}`}</span>} />
      {!s.financeLinked && <div className="mb-4"><Notice tone="amber">No PROJECT dimension {p.financeCode} in Finance yet. Create it there and tag postings with it; spending then appears here.</Notice></div>}
      {p.grants.length > 0 && <p className="mb-4 text-sm">Funded by {p.grants.map((g, i) => <span key={g.id}>{i > 0 && ', '}<Link href={`/projects/grants/${g.id}`} className="text-brand-700 hover:underline">{g.code}</Link> {g.title}</span>)}</p>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="Budget" value={<Money value={s.budget} />} />
        <Stat label="Spent" value={<Money value={s.spent} />} hint={`capital ${Number(s.capex).toLocaleString('en-KE')} · running ${Number(s.opex).toLocaleString('en-KE')}`} />
        <Stat label="Remaining" value={<Money value={s.remaining} />} tone={Number(s.remaining) < 0 ? 'bad' : undefined} />
        <Stat label="Spent of budget" value={s.spentPct === null ? '—' : `${s.spentPct}%`} />
        <Stat label="Physical progress" value={s.physicalPct === null ? '—' : `${s.physicalPct}%`} hint={s.timeElapsedPct !== null ? `${s.timeElapsedPct}% of the time used` : undefined} tone={s.physicalPct !== null && s.timeElapsedPct !== null && s.physicalPct + 15 < s.timeElapsedPct ? 'warn' : undefined} />
        <Stat label="Cost performance" value={s.costPerformance ?? '—'} hint="value of work done ÷ spent (1 = on budget)" tone={s.costPerformance !== null && s.costPerformance < 0.9 ? 'warn' : undefined} />
        <Stat label="Work in progress" value={<Money value={s.wip} />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Milestones p={p} refresh={refresh} />
        <Card title="Spending by month"><MonthlyBars rows={s.monthly} /><div className="mt-3"><Progress value={s.spentPct} against={s.timeElapsedPct} /></div></Card>
        <Kpis p={p} refresh={refresh} />
        <Card padded={false} title="Spending by account">
          {!s.byAccount.length ? <Empty>Nothing posted.</Empty> : (
            <table className="table-base"><thead><tr><th>Account</th><th>Class</th><th className="num">Amount</th></tr></thead><tbody>{s.byAccount.map((a) => <tr key={a.code}><td>{a.code} {a.name}</td><td>{label(a.accountClass)}</td><td className="num"><Money value={a.amount} /></td></tr>)}</tbody></table>
          )}
        </Card>
        <Capitalise p={p} refresh={refresh} />
      </div>
    </>
  );
}
