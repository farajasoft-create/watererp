'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDateTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/bi/ui/api';
import { Runner, Spec } from '@/modules/bi/ui/builder';
import { ChartType } from '@/modules/bi/ui/charts';

interface Report {
  id: string;
  name: string;
  description?: string;
  folder: string;
  spec: Spec;
  chart: ChartType;
  ownerName: string;
  mine: boolean;
  everyone: boolean;
  sharedWith: string[];
  version: number;
  versions: { version: number; name: string; chart: string; savedByName: string; at: string; note?: string }[];
  schedule?: { frequency: string | null; hour: number; recipients: string[]; emails: string[]; nextRunAt: string | null; lastRunAt?: string; lastStatus?: string };
  updatedAt: string;
}

function Share({ r, onClose }: { r: Report; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const people = useDirectory('bi');
  const [f, setF] = useState({ everyone: r.everyone, sharedWith: r.sharedWith ?? [] });
  const save = useMutation({ mutationFn: () => api.put(`/reports/${r.id}/share`, f), onSuccess: () => { qc.invalidateQueries({ queryKey: ['bi-report', r.id] }); onClose(); } });
  return (
    <Modal open onClose={onClose} title={`Share ${r.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <ErrorBox error={save.error} />
      {can('bi.admin') && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.everyone} onChange={(e) => setF({ ...f, everyone: e.target.checked })} /> Everyone who uses reports</label>}
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
        {people.data?.map((p) => <label key={p.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.sharedWith.includes(p.id)} onChange={(e) => setF({ ...f, sharedWith: e.target.checked ? [...f.sharedWith, p.id] : f.sharedWith.filter((x) => x !== p.id) })} /> {p.name}</label>)}
      </div>
      <p className="text-xs text-muted">People only see the data their own roles allow, even in a shared report.</p>
    </Modal>
  );
}

function Schedule({ r, onClose }: { r: Report; onClose: () => void }) {
  const qc = useQueryClient();
  const people = useDirectory('bi');
  const [f, setF] = useState({ frequency: r.schedule?.frequency ?? '', hour: String(r.schedule?.hour ?? 7), recipients: r.schedule?.recipients ?? [], emails: (r.schedule?.emails ?? []).join(', ') });
  const save = useMutation({
    mutationFn: () => api.put(`/reports/${r.id}/schedule`, { frequency: f.frequency || null, hour: Number(f.hour), recipients: f.recipients, emails: f.emails.split(/[\s,;]+/).filter(Boolean) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bi-report', r.id] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Email this report on a schedule" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How often"><Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="">Not scheduled</option><option value="DAILY">Every day</option><option value="WEEKLY">Every Monday</option><option value="MONTHLY">On the 1st of each month</option></Select></Field>
        <Field label="At (hour, East Africa time)"><Input inputMode="numeric" value={f.hour} onChange={(e) => setF({ ...f, hour: e.target.value })} /></Field>
        <Field label="Other email addresses" className="sm:col-span-2"><Input value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} placeholder="md@tachwasco.go.ke, board@…" /></Field>
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
        {people.data?.map((p) => <label key={p.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.recipients.includes(p.id)} onChange={(e) => setF({ ...f, recipients: e.target.checked ? [...f.recipients, p.id] : f.recipients.filter((x) => x !== p.id) })} /> {p.name}</label>)}
      </div>
      <p className="text-xs text-muted">It runs with your access, so recipients get what you can see. Delivery needs POST /api/v1/bi/schedules/run scheduled every few minutes.</p>
    </Modal>
  );
}

function Versions({ r }: { r: Report }) {
  const qc = useQueryClient();
  const back = useMutation({ mutationFn: (version: number) => api.post(`/reports/${r.id}/rollback`, { version }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['bi-report', r.id] }); qc.invalidateQueries({ queryKey: ['bi-run'] }); } });
  return (
    <Card padded={false} title={`Versions (now ${r.version})`}>
      <ErrorBox error={back.error} />
      {!r.versions.length ? <p className="p-4 text-sm text-muted">Never changed.</p> : (
        <table className="table-base">
          <thead><tr><th>Version</th><th>Name then</th><th>Chart</th><th>Replaced by</th><th>When</th><th>Note</th><th /></tr></thead>
          <tbody>
            {[...r.versions].reverse().map((v) => (
              <tr key={v.version}><td>{v.version}</td><td>{v.name}</td><td>{v.chart}</td><td>{v.savedByName}</td><td>{fmtDateTime(v.at)}</td><td className="text-sm">{v.note}</td><td>{r.mine && <Button variant="secondary" onClick={() => back.mutate(v.version)} disabled={back.isPending}>Roll back</Button>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AccessLog({ id }: { id: string }) {
  const { data, error } = useQuery({ queryKey: ['bi-access', id], queryFn: () => api.get<{ at: string; who: string; action: string; ip: string }[]>(`/reports/${id}/access-log`) });
  return (
    <Card padded={false} title="Who opened, ran, exported or changed it">
      <ErrorBox error={error} />
      <table className="table-base">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>IP</th></tr></thead>
        <tbody>{data?.map((l, i) => <tr key={i}><td>{fmtDateTime(l.at)}</td><td>{l.who}</td><td>{l.action}</td><td className="text-xs text-muted">{l.ip}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const [tab, setTab] = useState<'result' | 'versions' | 'log'>('result');
  const [sharing, setSharing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [period, setPeriod] = useState({ from: '', to: '' });
  const { data: r, error, isLoading } = useQuery({ queryKey: ['bi-report', id], queryFn: () => api.get<Report>(`/reports/${id}`) });
  const [chart, setChart] = useState<ChartType | null>(null);
  if (isLoading) return <Loading />;
  if (!r) return <ErrorBox error={error} />;
  const ds = r.spec.dataset;
  // A period chosen here narrows the report on its date (the first date filter, or the data's main date).
  const dateField = r.spec.filters.find((f) => f.op === 'between')?.field ?? r.spec.groupBy?.find((g) => g.bucket)?.field;
  const extra: Spec['filters'] = period.from && period.to && dateField ? [{ field: dateField, op: 'between', value: period.from, to: period.to }] : [];
  const owner = r.mine || can('bi.admin');
  return (
    <>
      <PageHeader
        title={r.name}
        subtitle={<span className="flex flex-wrap items-center gap-2">{ds} · {r.mine ? 'yours' : `by ${r.ownerName}`} · version {r.version}{r.schedule?.frequency && <Badge tone="blue">{r.schedule.frequency.toLowerCase()}</Badge>}</span>}
        actions={
          <>
            <Link href={`/bi/explore?report=${r.id}`}><Button variant="secondary">{r.mine ? 'Edit' : 'Open in builder'}</Button></Link>
            {owner && can('bi.build') && <Button variant="secondary" onClick={() => setSharing(true)}>Share</Button>}
            {owner && can('bi.build') && <Button variant="secondary" onClick={() => setScheduling(true)}>Schedule</Button>}
          </>
        }
      />
      {r.description && <p className="mb-3 text-sm text-muted">{r.description}</p>}
      {r.schedule?.frequency && <p className="mb-3 text-xs text-muted">Emailed {r.schedule.frequency.toLowerCase()}; next {r.schedule.nextRunAt ? fmtDateTime(r.schedule.nextRunAt) : '—'}{r.schedule.lastStatus && `; last: ${r.schedule.lastStatus}`}.</p>}
      <Tabs tabs={[{ id: 'result', label: 'Report' }, { id: 'versions', label: 'Versions' }, ...(owner ? [{ id: 'log' as const, label: 'Access log' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'result' && (
        <div className="space-y-3">
          {dateField && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="From"><Input type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} /></Field>
              <Field label="To"><Input type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} /></Field>
              <span className="pb-2 text-xs text-muted">Leave blank for the saved period.</span>
            </div>
          )}
          <Runner spec={r.spec} reportId={r.id} extra={extra} chart={chart ?? r.chart} setChart={setChart} title={r.name} />
        </div>
      )}
      {tab === 'versions' && <Versions r={r} />}
      {tab === 'log' && <AccessLog id={r.id} />}
      {sharing && <Share r={r} onClose={() => setSharing(false)} />}
      {scheduling && <Schedule r={r} onClose={() => setScheduling(false)} />}
    </>
  );
}
