'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select } from '@/components/ui';
import { fmtDateTime, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';

interface Point { id: string; code: string; name: string; kind: string; unit: string; low: number | null; high: number | null; lastValue: number | null; lastAt: string | null; alarm: 'NONE' | 'LOW' | 'HIGH'; alarmSince: string | null; active: boolean }
interface Series { samples: { at: string; value: number }[]; min: number | null; max: number | null; avg: number | null }
const KINDS = ['LEVEL', 'FLOW', 'PRESSURE', 'PUMP', 'CHLORINE', 'TURBIDITY', 'POWER', 'OTHER'];

/** A small line of the day's values, with the alarm limits as dashed lines. */
function Spark({ s, p }: { s: Series; p: Point }) {
  if (s.samples.length < 2) return <p className="text-sm text-muted">Not enough values in the period.</p>;
  const vals = [...s.samples.map((x) => x.value), ...(p.low !== null ? [p.low] : []), ...(p.high !== null ? [p.high] : [])];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const y = (v: number) => 110 - ((v - lo) / (hi - lo || 1)) * 100;
  const t0 = new Date(s.samples[0].at).getTime();
  const span = new Date(s.samples[s.samples.length - 1].at).getTime() - t0 || 1;
  const pts = s.samples.map((x) => `${((new Date(x.at).getTime() - t0) / span) * 600},${y(x.value)}`).join(' ');
  return (
    <svg viewBox="0 0 600 120" className="h-32 w-full" role="img" aria-label={`${p.name} over time`}>
      {p.low !== null && <line x1="0" x2="600" y1={y(p.low)} y2={y(p.low)} stroke="#d97706" strokeDasharray="4 4" />}
      {p.high !== null && <line x1="0" x2="600" y1={y(p.high)} y2={y(p.high)} stroke="#dc2626" strokeDasharray="4 4" />}
      <polyline points={pts} fill="none" stroke="#1d4ed8" strokeWidth="2" />
    </svg>
  );
}

export default function TelemetryPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Point | 'new' | null>(null);
  const [open, setOpen] = useState<Point | null>(null);
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const { data, error, isLoading } = useQuery({ queryKey: ['telemetry'], queryFn: () => api.get<Point[]>('/telemetry/points'), refetchInterval: 60_000 });
  const series = useQuery({ queryKey: ['telemetry-series', open?.id, day], queryFn: () => api.get<Series>(`/telemetry/points/${open!.id}/series`, { from: day, to: day }), enabled: !!open });
  const [f, setF] = useState({ code: '', name: '', kind: 'LEVEL', unit: '', low: '', high: '' });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, unit: f.unit || undefined, low: f.low === '' ? null : Number(f.low), high: f.high === '' ? null : Number(f.high) };
      return edit && edit !== 'new' ? api.put(`/telemetry/points/${edit.id}`, body) : api.post('/telemetry/points', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['telemetry'] }); setEdit(null); },
  });
  const start = (p: Point | 'new') => {
    setF(p === 'new' ? { code: '', name: '', kind: 'LEVEL', unit: '', low: '', high: '' } : { code: p.code, name: p.name, kind: p.kind, unit: p.unit, low: p.low?.toString() ?? '', high: p.high?.toString() ?? '' });
    setEdit(p);
  };
  const alarms = data?.filter((p) => p.alarm !== 'NONE') ?? [];
  return (
    <>
      <PageHeader title="SCADA and telemetry" subtitle="Values from SCADA, data loggers and smart meters, sent by the gateway to POST /api/v1/water/telemetry with an API key; operations staff are alerted when a point goes out of its limits." actions={can('water.network.manage') && <Button onClick={() => start('new')}>New point</Button>} />
      <ErrorBox error={error} />
      {alarms.length > 0 && <Card className="mb-3"><p className="text-sm font-medium text-red-700">{alarms.length} point(s) in alarm: {alarms.map((a) => `${a.name} (${a.lastValue} ${a.unit}, ${a.alarm.toLowerCase()})`).join('; ')}</p></Card>}
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No telemetry points yet.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Point</th><th>Kind</th><th className="num">Latest</th><th>Limits</th><th>When</th><th>State</th><th /></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><button type="button" className="text-left font-medium text-brand-700 hover:underline" onClick={() => setOpen(p)}>{p.name}</button><div className="text-xs text-muted">{p.code}</div></td>
                  <td>{label(p.kind)}</td>
                  <td className="num">{p.lastValue ?? '—'} {p.unit}</td>
                  <td className="text-xs">{p.low ?? '—'} to {p.high ?? '—'}</td>
                  <td className="text-xs">{fmtDateTime(p.lastAt)}</td>
                  <td>{p.alarm === 'NONE' ? <Badge tone="green">normal</Badge> : <Badge tone="red">{p.alarm.toLowerCase()} since {fmtDateTime(p.alarmSince)}</Badge>}</td>
                  <td className="text-right">{can('water.network.manage') && <Button variant="secondary" onClick={() => start(p)}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open && (
        <Modal open wide onClose={() => setOpen(null)} title={`${open.name} (${open.unit})`}>
          <Field label="Day"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="max-w-xs" /></Field>
          {series.data ? <><Spark s={series.data} p={open} /><p className="text-sm">{series.data.samples.length} values · min {series.data.min ?? '—'} · average {series.data.avg ?? '—'} · max {series.data.max ?? '—'}</p></> : <Loading />}
        </Modal>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit === 'new' ? 'New telemetry point' : `Edit ${edit.name}`} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tag code (as the gateway sends it)"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
            <Field label="Unit"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="m, m³/h, bar, mg/l" /></Field>
            <Field label="Low alarm"><Input inputMode="decimal" value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} /></Field>
            <Field label="High alarm"><Input inputMode="decimal" value={f.high} onChange={(e) => setF({ ...f, high: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
