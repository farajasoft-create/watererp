'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Stat, Tabs } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtUnits, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { Facility, useFacilities } from '@/modules/water/ui/facilities';
import { useZones, zoneName } from '@/modules/water/ui/hooks';

const FACILITY_TYPES = ['INTAKE', 'BOREHOLE', 'SPRING', 'TREATMENT_WORKS', 'PUMP_STATION', 'RESERVOIR', 'TANK', 'KIOSK', 'BOWSER_POINT', 'OFFICE', 'OTHER'];
const POINTS = ['RAW', 'TREATED', 'RESERVOIR', 'NETWORK', 'CONSUMER_TAP', 'KIOSK'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Chemical {
  id: string;
  code: string;
  name: string;
  unit: string;
  stock: string;
  reorderLevel: string;
  low: boolean;
}

interface Production {
  rows: { id: string; facilityId: string; date: string; abstracted: string; treated: string; supplied: string; powerKwh: string; pumpHours: string; chemicals: { chemicalId: string; quantity: string }[]; note?: string }[];
  totals: Record<string, string>;
  kwhPerM3: string | null;
}

interface QualityTest {
  id: string;
  sampledAt: string;
  point: string;
  location?: string;
  zoneId?: string;
  residualChlorine?: string;
  turbidity?: string;
  ph?: string;
  eColi?: string;
  passed: boolean;
  failures: string[];
}

const monthStart = () => `${today().slice(0, 7)}-01`;

function ProductionTab() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: facilities } = useFacilities();
  const { data: chemicals } = useQuery({ queryKey: ['chemicals'], queryFn: () => api.get<Chemical[]>('/chemicals') });
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data, error } = useQuery({ queryKey: ['production', range], queryFn: () => api.get<Production>('/production', range) });
  const [f, setF] = useState({ facilityId: '', date: today(), abstracted: '', treated: '', supplied: '', pumpHours: '', powerKwh: '', downtimeHours: '', note: '' });
  const [doses, setDoses] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api.post('/production', {
        ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')),
        chemicals: Object.entries(doses).filter(([, q]) => Number(q) > 0).map(([chemicalId, quantity]) => ({ chemicalId, quantity })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['production'] });
      qc.invalidateQueries({ queryKey: ['chemicals'] });
      setDoses({});
    },
  });
  const sources = facilities?.filter((x) => ['INTAKE', 'BOREHOLE', 'SPRING', 'TREATMENT_WORKS', 'PUMP_STATION'].includes(x.type));
  const name = (id: string) => facilities?.find((x) => x.id === id)?.code ?? '—';
  return (
    <div className="space-y-4">
      {can('water.production.record') && (
        <Card title="Daily production log" actions={<Button onClick={() => save.mutate()} disabled={save.isPending || !f.facilityId}>Save day</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Facility">
              <Select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>
                <option value="">Choose…</option>
                {sources?.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Abstracted (m³)"><Input inputMode="decimal" value={f.abstracted} onChange={(e) => setF({ ...f, abstracted: e.target.value })} /></Field>
            <Field label="Treated (m³)"><Input inputMode="decimal" value={f.treated} onChange={(e) => setF({ ...f, treated: e.target.value })} /></Field>
            <Field label="Supplied (m³)"><Input inputMode="decimal" value={f.supplied} onChange={(e) => setF({ ...f, supplied: e.target.value })} /></Field>
            <Field label="Pump hours"><Input inputMode="decimal" value={f.pumpHours} onChange={(e) => setF({ ...f, pumpHours: e.target.value })} /></Field>
            <Field label="Power (kWh)"><Input inputMode="decimal" value={f.powerKwh} onChange={(e) => setF({ ...f, powerKwh: e.target.value })} /></Field>
            <Field label="Downtime (h)"><Input inputMode="decimal" value={f.downtimeHours} onChange={(e) => setF({ ...f, downtimeHours: e.target.value })} /></Field>
            {chemicals?.map((c) => (
              <Field key={c.id} label={`${c.name} dosed (${c.unit})`} hint={`${fmtUnits(c.stock)} in stock`}>
                <Input inputMode="decimal" value={doses[c.id] ?? ''} onChange={(e) => setDoses({ ...doses, [c.id]: e.target.value })} />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Saving a day that already has a log replaces it; the chemicals of the old entry go back into stock.</p>
        </Card>
      )}
      <Card
        padded={false}
        title="Production"
        actions={
          <>
            <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" />
            <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" />
          </>
        }
      >
        <ErrorBox error={error} />
        {data && (
          <div className="grid gap-3 p-3 sm:grid-cols-4">
            <Stat label="Abstracted (m³)" value={fmtUnits(data.totals.abstracted)} />
            <Stat label="Supplied (m³)" value={fmtUnits(data.totals.supplied)} />
            <Stat label="Power (kWh)" value={fmtUnits(data.totals.powerKwh)} />
            <Stat label="Energy per m³" value={data.kwhPerM3 ? `${data.kwhPerM3} kWh` : '—'} />
          </div>
        )}
        {!data ? (
          <Loading />
        ) : !data.rows.length ? (
          <Empty>No production logged in this period.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Date</th><th>Facility</th><th className="num">Abstracted</th><th className="num">Treated</th><th className="num">Supplied</th><th className="num">kWh</th><th>Chemicals</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.date)}</td>
                  <td>{name(r.facilityId)}</td>
                  <td className="num">{fmtUnits(r.abstracted)}</td>
                  <td className="num">{fmtUnits(r.treated)}</td>
                  <td className="num">{fmtUnits(r.supplied)}</td>
                  <td className="num">{fmtUnits(r.powerKwh)}</td>
                  <td className="text-xs">{r.chemicals.map((c) => `${chemicals?.find((x) => x.id === c.chemicalId)?.code ?? '?'} ${fmtUnits(c.quantity)}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ChemicalsTab() {
  const qc = useQueryClient();
  const can = useCan();
  const { data, error } = useQuery({ queryKey: ['chemicals'], queryFn: () => api.get<Chemical[]>('/chemicals') });
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<Chemical | null>(null);
  const [f, setF] = useState({ code: '', name: '', unit: 'kg', reorderLevel: '' });
  const [r, setR] = useState({ date: today(), quantity: '', type: 'RECEIPT', reference: '' });
  const add = useMutation({ mutationFn: () => api.post('/chemicals', { ...f, reorderLevel: f.reorderLevel || '0' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['chemicals'] }); setAdding(false); } });
  const receive = useMutation({ mutationFn: () => api.post('/chemicals/movements', { ...r, chemicalId: receiving!.id, reference: r.reference || undefined }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['chemicals'] }); setReceiving(null); } });
  return (
    <Card padded={false} title="Treatment chemicals" actions={can('water.production.record') && <Button onClick={() => setAdding(true)}>Add chemical</Button>}>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <Empty>No chemicals yet (chlorine, alum, soda ash…).</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Code</th><th>Chemical</th><th className="num">In stock</th><th className="num">Re-order at</th><th /></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.code}</td>
                <td>{c.name}</td>
                <td className="num">{fmtUnits(c.stock)} {c.unit} {c.low && <Badge tone="red">Re-order</Badge>}</td>
                <td className="num">{fmtUnits(c.reorderLevel)}</td>
                <td className="text-right">{can('water.production.record') && <Button variant="ghost" onClick={() => setReceiving(c)}>Receive / adjust</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <Modal open onClose={() => setAdding(false)} title="Add chemical" footer={<Button onClick={() => add.mutate()} disabled={add.isPending || !f.code || !f.name}>Save</Button>}>
          <ErrorBox error={add.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Unit"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
            <Field label="Re-order level"><Input inputMode="decimal" value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {receiving && (
        <Modal open onClose={() => setReceiving(null)} title={`${receiving.name}: receive or adjust`} footer={<Button onClick={() => receive.mutate()} disabled={receive.isPending || !r.quantity}>Save</Button>}>
          <ErrorBox error={receive.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select value={r.type} onChange={(e) => setR({ ...r, type: e.target.value })}>
                <option value="RECEIPT">Received</option>
                <option value="ADJUSTMENT">Stock-take correction (+/−)</option>
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={r.date} onChange={(e) => setR({ ...r, date: e.target.value })} /></Field>
            <Field label={`Quantity (${receiving.unit})`}><Input inputMode="decimal" value={r.quantity} onChange={(e) => setR({ ...r, quantity: e.target.value })} /></Field>
            <Field label="Reference (GRN, issue voucher)"><Input value={r.reference} onChange={(e) => setR({ ...r, reference: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function QualityTab() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: zones } = useZones();
  const { data: facilities } = useFacilities();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data, error } = useQuery({ queryKey: ['quality', range], queryFn: () => api.get<QualityTest[]>('/quality', range) });
  const { data: compliance } = useQuery({ queryKey: ['quality', 'compliance', range], queryFn: () => api.get<{ samples: number; passed: number; chlorineCompliancePercent: number | null; bacteriaCompliancePercent: number | null }>('/quality/compliance', range) });
  const [f, setF] = useState({ sampledAt: `${today()}T09:00`, point: 'NETWORK', facilityId: '', zoneId: '', location: '', residualChlorine: '', turbidity: '', ph: '', eColi: '', totalColiforms: '', colour: '', conductivity: '', lab: '', sampledBy: '' });
  const save = useMutation({
    mutationFn: () => api.post<QualityTest>('/quality', { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), sampledAt: new Date(f.sampledAt).toISOString() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quality'] }),
  });
  const num = (k: keyof typeof f, l: string) => (
    <Field label={l}><Input inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
  );
  return (
    <div className="space-y-4">
      {compliance && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Samples meeting the standard" value={`${compliance.passed} of ${compliance.samples}`} />
          <Stat label="Residual chlorine compliance" value={compliance.chlorineCompliancePercent === null ? '—' : `${compliance.chlorineCompliancePercent}%`} tone={compliance.chlorineCompliancePercent !== null && compliance.chlorineCompliancePercent < 90 ? 'bad' : 'good'} hint="WASREB: 95% good" />
          <Stat label="Bacteriological compliance" value={compliance.bacteriaCompliancePercent === null ? '—' : `${compliance.bacteriaCompliancePercent}%`} tone={compliance.bacteriaCompliancePercent !== null && compliance.bacteriaCompliancePercent < 95 ? 'bad' : 'good'} hint="WASREB: 98% good" />
        </div>
      )}
      {can('water.quality.record') && (
        <Card title="Record a sample" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save result</Button>}>
          <ErrorBox error={save.error} />
          {save.data && (save.data.passed ? <Notice tone="green">Meets the drinking water standard.</Notice> : <Notice tone="amber">Fails: {save.data.failures.join('; ')}. An incident ticket was raised for the technical team.</Notice>)}
          <div className="mt-2 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Sampled at"><Input type="datetime-local" value={f.sampledAt} onChange={(e) => setF({ ...f, sampledAt: e.target.value })} /></Field>
            <Field label="Sample point">
              <Select value={f.point} onChange={(e) => setF({ ...f, point: e.target.value })}>
                {POINTS.map((p) => <option key={p} value={p}>{label(p)}</option>)}
              </Select>
            </Field>
            <Field label="Facility">
              <Select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}>
                <option value="">—</option>
                {facilities?.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
              </Select>
            </Field>
            <Field label="Zone">
              <Select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
                <option value="">—</option>
                {zones?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}
              </Select>
            </Field>
            <Field label="Location" className="sm:col-span-2"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
            {num('residualChlorine', 'Residual chlorine (mg/L)')}
            {num('turbidity', 'Turbidity (NTU)')}
            {num('ph', 'pH')}
            {num('eColi', 'E. coli (per 100 mL)')}
            {num('totalColiforms', 'Total coliforms (per 100 mL)')}
            {num('colour', 'Colour (TCU)')}
            {num('conductivity', 'Conductivity (µS/cm)')}
            <Field label="Laboratory"><Input value={f.lab} onChange={(e) => setF({ ...f, lab: e.target.value })} /></Field>
          </div>
        </Card>
      )}
      <Card
        padded={false}
        title="Results"
        actions={
          <>
            <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" />
            <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" />
          </>
        }
      >
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : !data.length ? (
          <Empty>No samples in this period.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Sampled</th><th>Point</th><th>Where</th><th className="num">Cl (mg/L)</th><th className="num">NTU</th><th className="num">pH</th><th className="num">E. coli</th><th>Result</th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(t.sampledAt)}</td>
                  <td>{label(t.point)}</td>
                  <td>{t.location ?? zoneName(zones, t.zoneId)}</td>
                  <td className="num">{t.residualChlorine ?? '—'}</td>
                  <td className="num">{t.turbidity ?? '—'}</td>
                  <td className="num">{t.ph ?? '—'}</td>
                  <td className="num">{t.eColi ?? '—'}</td>
                  <td>{t.passed ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>}{!t.passed && <div className="text-xs text-red-700">{t.failures.join('; ')}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function StorageTab() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: zones } = useZones();
  const { data: levels } = useQuery({ queryKey: ['reservoirs'], queryFn: () => api.get<{ facility: Facility; latest: { at: string; levelPercent?: number; volume?: string } | null }[]>('/reservoirs') });
  const { data: schedules } = useQuery({ queryKey: ['schedules'], queryFn: () => api.get<{ id: string; zoneId: string; days: number[]; from: string; to: string; note?: string }[]>('/supply-schedules') });
  const { data: hours } = useQuery({ queryKey: ['schedules', 'hours'], queryFn: () => api.get<{ zoneId: string; code: string; name: string; hours: number }[]>('/supply-schedules/hours') });
  const [level, setLevel] = useState<{ facilityId: string; levelPercent: string } | null>(null);
  const [row, setRow] = useState({ zoneId: '', days: [1, 2, 3, 4, 5] as number[], from: '06:00', to: '18:00', note: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['schedules'] });
  const saveLevel = useMutation({ mutationFn: () => api.post('/reservoirs/levels', { facilityId: level!.facilityId, at: new Date().toISOString(), levelPercent: Number(level!.levelPercent) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['reservoirs'] }); setLevel(null); } });
  const addRow = useMutation({ mutationFn: () => api.post('/supply-schedules', { ...row, note: row.note || undefined }), onSuccess: invalidate });
  const delRow = useMutation({ mutationFn: (id: string) => api.delete(`/supply-schedules/${id}`), onSuccess: invalidate });
  return (
    <div className="space-y-4">
      <Card padded={false} title="Reservoirs and tanks">
        {!levels?.length ? (
          <Empty>Add reservoirs and tanks under Facilities.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Reservoir</th><th className="num">Capacity (m³)</th><th>Level</th><th>Read</th><th /></tr></thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.facility.id}>
                  <td>{l.facility.code} · {l.facility.name}</td>
                  <td className="num">{fmtUnits(l.facility.capacity)}</td>
                  <td>
                    {l.latest?.levelPercent !== undefined ? (
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-32 overflow-hidden rounded bg-slate-100"><div className={l.latest.levelPercent < 25 ? 'h-full bg-red-500' : 'h-full bg-brand-500'} style={{ width: `${l.latest.levelPercent}%` }} /></div>
                        <span className="tabular-nums">{l.latest.levelPercent}%</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td>{fmtDateTime(l.latest?.at)}</td>
                  <td className="text-right">{can('water.production.record') && <Button variant="ghost" onClick={() => setLevel({ facilityId: l.facility.id, levelPercent: '' })}>Record level</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card padded={false} title="Supply timetable (rationing)">
        {hours && (
          <div className="flex flex-wrap gap-2 p-3 text-sm">
            {hours.map((h) => <Badge key={h.zoneId} tone={h.hours >= 21 ? 'green' : h.hours >= 16 ? 'amber' : 'red'}>{h.code}: {h.hours} h/day</Badge>)}
          </div>
        )}
        <table className="table-base">
          <thead><tr><th>Zone</th><th>Days</th><th>Hours</th><th>Note</th><th /></tr></thead>
          <tbody>
            {schedules?.map((r) => (
              <tr key={r.id}>
                <td>{zoneName(zones, r.zoneId)}</td>
                <td>{r.days.map((d) => DAYS[d]).join(', ')}</td>
                <td>{r.from}–{r.to}</td>
                <td className="text-sm">{r.note}</td>
                <td className="text-right">{can('water.production.record') && <Button variant="ghost" onClick={() => delRow.mutate(r.id)}>Remove</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {can('water.production.record') && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line p-3">
            <ErrorBox error={addRow.error} />
            <Field label="Zone">
              <Select value={row.zoneId} onChange={(e) => setRow({ ...row, zoneId: e.target.value })}>
                <option value="">Choose…</option>
                {zones?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}
              </Select>
            </Field>
            <div className="flex gap-1 text-xs">
              {DAYS.map((d, i) => (
                <label key={d} className="flex flex-col items-center"><input type="checkbox" checked={row.days.includes(i)} onChange={(e) => setRow({ ...row, days: e.target.checked ? [...row.days, i] : row.days.filter((x) => x !== i) })} />{d}</label>
              ))}
            </div>
            <Field label="From"><Input type="time" value={row.from} onChange={(e) => setRow({ ...row, from: e.target.value })} /></Field>
            <Field label="To"><Input type="time" value={row.to} onChange={(e) => setRow({ ...row, to: e.target.value })} /></Field>
            <Field label="Note"><Input value={row.note} onChange={(e) => setRow({ ...row, note: e.target.value })} /></Field>
            <Button onClick={() => addRow.mutate()} disabled={!row.zoneId || !row.days.length}>Add</Button>
          </div>
        )}
      </Card>
      {level && (
        <Modal open onClose={() => setLevel(null)} title="Record level" footer={<Button onClick={() => saveLevel.mutate()} disabled={saveLevel.isPending || level.levelPercent === ''}>Save</Button>}>
          <ErrorBox error={saveLevel.error} />
          <Field label="Level now (%)"><Input type="number" min={0} max={100} value={level.levelPercent} onChange={(e) => setLevel({ ...level, levelPercent: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function FacilitiesTab() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: zones } = useZones();
  const { data, error } = useFacilities();
  const [editing, setEditing] = useState<Partial<Facility> | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const e = editing!;
      const body = { code: e.code, name: e.name, type: e.type, zoneId: e.zoneId || null, capacity: e.capacity || '0', gps: e.gps?.lat && e.gps?.lng ? { lat: Number(e.gps.lat), lng: Number(e.gps.lng) } : null, operator: e.operator, pricePerJerrican: e.pricePerJerrican || '0', active: e.active ?? true };
      return e.id ? api.patch(`/facilities/${e.id}`, body) : api.post('/facilities', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities'] });
      setEditing(null);
    },
  });
  return (
    <Card padded={false} title="Facilities" actions={can('water.network.manage') && <Button onClick={() => setEditing({ type: 'BOREHOLE', active: true })}>Add facility</Button>}>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <Empty>No facilities yet: add intakes, boreholes, works, pump stations, reservoirs and kiosks.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Zone</th><th className="num">Capacity</th><th>GPS</th><th /></tr></thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id}>
                <td className="font-medium">{x.code}</td>
                <td>{x.name}{!x.active && <Badge tone="gray">Inactive</Badge>}</td>
                <td>{label(x.type)}</td>
                <td>{zoneName(zones, x.zoneId)}</td>
                <td className="num">{fmtUnits(x.capacity)}</td>
                <td className="text-xs">{x.gps?.lat ? `${x.gps.lat.toFixed(5)}, ${x.gps.lng?.toFixed(5)}` : '—'}</td>
                <td className="text-right">{can('water.network.manage') && <Button variant="ghost" onClick={() => setEditing(x)}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} title={editing.id ? `Edit ${editing.code}` : 'Add facility'} footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !editing.code || !editing.name}>Save</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                {FACILITY_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </Select>
            </Field>
            <Field label="Zone">
              <Select value={editing.zoneId ?? ''} onChange={(e) => setEditing({ ...editing, zoneId: e.target.value })}>
                <option value="">—</option>
                {zones?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}
              </Select>
            </Field>
            <Field label={['RESERVOIR', 'TANK'].includes(editing.type ?? '') ? 'Capacity (m³)' : 'Capacity (m³/day)'}><Input inputMode="decimal" value={editing.capacity ?? ''} onChange={(e) => setEditing({ ...editing, capacity: e.target.value })} /></Field>
            <Field label="Latitude"><Input inputMode="decimal" value={editing.gps?.lat ?? ''} onChange={(e) => setEditing({ ...editing, gps: { ...editing.gps, lat: e.target.value as unknown as number } })} /></Field>
            <Field label="Longitude"><Input inputMode="decimal" value={editing.gps?.lng ?? ''} onChange={(e) => setEditing({ ...editing, gps: { ...editing.gps, lng: e.target.value as unknown as number } })} /></Field>
            {editing.type === 'KIOSK' && (
              <>
                <Field label="Operator"><Input value={editing.operator?.name ?? ''} onChange={(e) => setEditing({ ...editing, operator: { ...editing.operator, name: e.target.value } })} /></Field>
                <Field label="Operator phone"><Input value={editing.operator?.phone ?? ''} onChange={(e) => setEditing({ ...editing, operator: { ...editing.operator, phone: e.target.value } })} /></Field>
                <Field label="Price per 20 L jerrican (KES)"><Input inputMode="decimal" value={editing.pricePerJerrican ?? ''} onChange={(e) => setEditing({ ...editing, pricePerJerrican: e.target.value })} /></Field>
              </>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> In use</label>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function ProductionPage() {
  const [tab, setTab] = useState<'production' | 'quality' | 'chemicals' | 'storage' | 'facilities'>('production');
  return (
    <>
      <PageHeader title="Production & water quality" subtitle="Abstraction, treatment and dosing, drinking water tests, reservoirs and the supply timetable" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'production', label: 'Production' },
          { id: 'quality', label: 'Water quality' },
          { id: 'chemicals', label: 'Chemicals' },
          { id: 'storage', label: 'Reservoirs & timetable' },
          { id: 'facilities', label: 'Facilities' },
        ]}
      />
      {tab === 'production' && <ProductionTab />}
      {tab === 'quality' && <QualityTab />}
      {tab === 'chemicals' && <ChemicalsTab />}
      {tab === 'storage' && <StorageTab />}
      {tab === 'facilities' && <FacilitiesTab />}
    </>
  );
}
