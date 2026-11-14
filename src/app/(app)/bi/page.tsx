'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDateTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/bi/ui/api';
import { DrillModal, Spec } from '@/modules/bi/ui/builder';
import { CHART_TYPES, ChartType, Result, ResultView } from '@/modules/bi/ui/charts';

interface Tile { id: string; reportId: string; title?: string; chart?: ChartType | null; width: number }
interface Dashboard { id: string; name: string; description?: string; featured: boolean; refreshSeconds: number; tiles: Tile[]; everyone: boolean; sharedWith: string[]; ownerName: string; mine: boolean }
interface Run { dashboard: Dashboard; tiles: { id: string; reportId?: string; title: string; chart?: ChartType; width: number; spec?: Spec; result?: Result; error?: string }[]; ranAt: string }
interface ReportRow { id: string; name: string; chart: ChartType }

function EditDashboard({ d, onClose, onSaved }: { d?: Dashboard; onClose: () => void; onSaved: (id: string) => void }) {
  const can = useCan();
  const reports = useQuery({ queryKey: ['bi-reports'], queryFn: () => api.get<ReportRow[]>('/reports') });
  const [f, setF] = useState({ name: d?.name ?? '', description: d?.description ?? '', featured: d?.featured ?? false, refreshSeconds: String(d?.refreshSeconds ?? 300) });
  const [tiles, setTiles] = useState<{ reportId: string; title: string; chart: string; width: number }[]>(d?.tiles.map((t) => ({ reportId: t.reportId, title: t.title ?? '', chart: t.chart ?? '', width: t.width })) ?? []);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, description: f.description || undefined, featured: f.featured, refreshSeconds: Number(f.refreshSeconds) || 300, tiles: tiles.filter((t) => t.reportId).map((t) => ({ reportId: t.reportId, title: t.title || undefined, chart: t.chart || null, width: t.width })) };
      return d ? api.put<{ id: string }>(`/dashboards/${d.id}`, body) : api.post<{ id: string }>('/dashboards', body);
    },
    onSuccess: (x) => onSaved(x.id),
  });
  const set = (i: number, k: string, v: string | number) => setTiles(tiles.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  return (
    <Modal open wide onClose={onClose} title={d ? `Edit ${d.name}` : 'New dashboard'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Managing director's dashboard" /></Field>
        <Field label="Refresh every (seconds)"><Input inputMode="numeric" value={f.refreshSeconds} onChange={(e) => setF({ ...f, refreshSeconds: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-3"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      {can('bi.admin') && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.featured} onChange={(e) => setF({ ...f, featured: e.target.checked })} /> Featured (an executive or departmental dashboard, shown first)</label>}
      <div className="space-y-2">
        <div className="text-sm font-medium">Tiles</div>
        {tiles.map((t, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]">
            <Select value={t.reportId} onChange={(e) => set(i, 'reportId', e.target.value)}><option value="">Choose a report</option>{reports.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
            <Input placeholder="Title (optional)" value={t.title} onChange={(e) => set(i, 'title', e.target.value)} />
            <Select value={t.chart} onChange={(e) => set(i, 'chart', e.target.value)}><option value="">As saved</option>{CHART_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
            <Select value={t.width} onChange={(e) => set(i, 'width', Number(e.target.value))}><option value={1}>Narrow</option><option value={2}>Wide</option><option value={3}>Full width</option></Select>
            <Button variant="secondary" onClick={() => setTiles(tiles.filter((_, j) => j !== i))} aria-label="Remove tile">✕</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setTiles([...tiles, { reportId: '', title: '', chart: '', width: 1 }])}>Add tile</Button>
      </div>
    </Modal>
  );
}

function ShareDashboard({ d, onClose }: { d: Dashboard; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const people = useDirectory('bi');
  const [f, setF] = useState({ everyone: d.everyone, sharedWith: d.sharedWith ?? [] });
  const save = useMutation({ mutationFn: () => api.put(`/dashboards/${d.id}/share`, f), onSuccess: () => { qc.invalidateQueries({ queryKey: ['bi-dashboards'] }); onClose(); } });
  return (
    <Modal open onClose={onClose} title={`Share ${d.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <ErrorBox error={save.error} />
      {can('bi.admin') && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.everyone} onChange={(e) => setF({ ...f, everyone: e.target.checked })} /> Everyone who uses reports</label>}
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
        {people.data?.map((p) => <label key={p.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.sharedWith.includes(p.id)} onChange={(e) => setF({ ...f, sharedWith: e.target.checked ? [...f.sharedWith, p.id] : f.sharedWith.filter((x) => x !== p.id) })} /> {p.name}</label>)}
      </div>
      <p className="text-xs text-muted">The reports on its tiles are shared with them too. They still only see data their own roles allow.</p>
    </Modal>
  );
}

function View({ id, onEdit, onShare }: { id: string; onEdit: (d: Dashboard) => void; onShare: (d: Dashboard) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const [drill, setDrill] = useState<{ spec: Spec; values: Record<string, unknown> } | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-dashboard', id], queryFn: () => api.get<Run>(`/dashboards/${id}/run`), refetchInterval: (q) => ((q.state.data?.dashboard.refreshSeconds ?? 300) * 1000) });
  const del = useMutation({ mutationFn: () => api.delete(`/dashboards/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['bi-dashboards'] }) });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const d = data.dashboard;
  const owner = d.mine || can('bi.admin');
  const span = (w: number) => (w >= 3 ? 'lg:col-span-3' : w === 2 ? 'lg:col-span-2' : '');
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{d.name} {d.featured && <Badge tone="blue">featured</Badge>}</h2>
          <p className="text-xs text-muted">{d.description} Refreshed {fmtDateTime(data.ranAt)}; every {d.refreshSeconds} seconds.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/v1/bi/dashboards/${id}/export/xls`} className="text-sm text-brand-700 hover:underline">Excel</a>
          <a href={`/api/v1/bi/dashboards/${id}/export/doc`} className="text-sm text-brand-700 hover:underline">Word</a>
          {owner && can('bi.build') && <><Button variant="secondary" onClick={() => onEdit(d)}>Edit</Button><Button variant="secondary" onClick={() => onShare(d)}>Share</Button><Button variant="secondary" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}
        </div>
      </div>
      {!data.tiles.length ? <Card><Empty>No tiles yet. Edit the dashboard and add saved reports.</Empty></Card> : (
        <div className="grid gap-4 lg:grid-cols-3">
          {data.tiles.map((t) => (
            <Card key={t.id} title={t.reportId ? <Link href={`/bi/reports/${t.reportId}`} className="hover:underline">{t.title}</Link> : t.title} className={span(t.width)}>
              {t.error ? <p className="text-sm text-amber-800">{t.error}</p> : t.result && <ResultView r={t.result} chart={t.chart ?? 'table'} onPick={t.spec?.groupBy?.length ? (values) => setDrill({ spec: t.spec!, values }) : undefined} />}
            </Card>
          ))}
        </div>
      )}
      {drill && <DrillModal spec={drill.spec} values={drill.values} onClose={() => setDrill(null)} />}
    </>
  );
}

export default function DashboardsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-dashboards'], queryFn: () => api.get<Dashboard[]>('/dashboards') });
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Dashboard | 'new' | null>(null);
  const [sharing, setSharing] = useState<Dashboard | null>(null);
  const current = chosen ?? data?.[0]?.id ?? null;
  return (
    <>
      <PageHeader title="Dashboards" subtitle="Live figures from every module, refreshed automatically" actions={can('bi.build') && <Button onClick={() => setEditing('new')}>New dashboard</Button>} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? (
        <Card><Empty>No dashboards yet. Save some reports in the report builder, then put them on a dashboard.</Empty></Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {data.map((d) => <Button key={d.id} variant={d.id === current ? 'primary' : 'secondary'} onClick={() => setChosen(d.id)}>{d.name}</Button>)}
          </div>
          {current && <View key={current} id={current} onEdit={setEditing} onShare={setSharing} />}
        </>
      )}
      {editing && <EditDashboard d={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setChosen(id); qc.invalidateQueries({ queryKey: ['bi-dashboards'] }); qc.invalidateQueries({ queryKey: ['bi-dashboard', id] }); }} />}
      {sharing && <ShareDashboard d={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}
