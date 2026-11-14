'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useEmployeeOptions } from '@/modules/hr/ui/hooks';
import { RequestTransport } from '@/modules/hr/ui/request-transport';

const TYPES = ['SALOON', 'PICKUP', 'LORRY', 'BUS', 'MOTORCYCLE', 'TRACTOR', 'WATER_BOWSER', 'OTHER'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

interface Slot { number: string; destination: string; until?: string; from?: string; status?: string }
interface Board { vehicles: { id: string; regNo: string; label: string; odometer: number; status: string; current: Slot | null; next: Slot | null }[]; drivers: { id: string; name: string; status: string; licenceExpiry: string; current: Slot | null; next: Slot | null }[] }
interface Alert { kind: string; subject: string; detail: string; due: string | null; overdue: boolean }
interface Trip { id: string; number: string; purpose: string; destination: string; from: string; to: string; passengers: number; status: string; requester: string; department: string; vehicle: string; driver: string; decisionNote?: string; requestedBy: string; ticket?: { number?: string; odometerOut?: number; odometerIn?: number; distance?: number } }
interface Vehicle { id: string; regNo: string; make: string; model: string; year: number | null; type: string; fuelType: string; seats: number | null; status: string; odometer: number; station?: string; purchaseDate: string | null; purchaseCost: string | null; insurance?: { insurer?: string; policyNo?: string; expiresOn?: string | null }; inspectionDue: string | null; lastServiceKm: number; serviceEveryKm: number; fuelCard?: { number?: string; monthlyLimit?: string | null } }
interface Driver { id: string; employeeId: string; name: string; licenceNo: string; licenceClasses: string[]; licenceExpiry: string; active: boolean }

export default function FleetPage() {
  const can = useCan();
  const manage = can('hr.fleet.manage');
  const [tab, setTab] = useState<'board' | 'requests' | 'vehicles' | 'drivers' | 'reports'>('board');
  return (
    <>
      <PageHeader title="Transport & fleet" subtitle="Transport requests approved by departments and allocated to a fit vehicle and licensed driver; work tickets, fuel, repairs, incidents, alerts and reports." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'board', label: 'Status & alerts' },
          { id: 'requests', label: 'Transport requests' },
          { id: 'vehicles', label: 'Vehicles' },
          { id: 'drivers', label: 'Drivers' },
          { id: 'reports', label: 'Reports' },
        ]}
      />
      {tab === 'board' && <BoardTab />}
      {tab === 'requests' && <Requests manage={manage} />}
      {tab === 'vehicles' && <Vehicles manage={manage} />}
      {tab === 'drivers' && <Drivers manage={manage} />}
      {tab === 'reports' && <Reports />}
    </>
  );
}

function BoardTab() {
  const board = useQuery({ queryKey: ['hr-fleet-board'], queryFn: () => api.get<Board>('/fleet/board') });
  const alerts = useQuery({ queryKey: ['hr-fleet-alerts'], queryFn: () => api.get<Alert[]>('/fleet/alerts', { days: '30' }) });
  const slot = (s: Slot | null, word: string) => (s ? `${word} ${s.number} · ${s.destination}${s.until ? ` until ${fmtDateTime(s.until)}` : s.from ? ` ${fmtDateTime(s.from)}` : ''}` : '');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Alerts (next 30 days)">
        {alerts.isLoading ? <Loading /> : !alerts.data?.length ? <Empty>Nothing due.</Empty> : (
          <ul className="space-y-1 text-sm">
            {alerts.data.map((a, i) => (
              <li key={i}>{a.overdue ? <Badge tone="red">Overdue</Badge> : <Badge tone="amber">{label(a.kind)}</Badge>} <strong>{a.subject}</strong>: {a.detail}{a.due && ` ${fmtDate(a.due)}`}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Drivers">
        {!board.data ? <Loading /> : !board.data.drivers.length ? <Empty>No drivers.</Empty> : (
          <ul className="space-y-1 text-sm">{board.data.drivers.map((d) => <li key={d.id}><Badge value={d.status} /> {d.name} <span className="text-xs text-muted">{slot(d.current, 'On') || slot(d.next, 'Next')}</span></li>)}</ul>
        )}
      </Card>
      <Card title="Vehicles" className="lg:col-span-2">
        {!board.data ? <Loading /> : !board.data.vehicles.length ? <Empty>No vehicles.</Empty> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Vehicle</th><th>Status</th><th className="text-right">Odometer</th><th>Now</th><th>Next booking</th></tr></thead>
            <tbody>
              {board.data.vehicles.map((v) => (
                <tr key={v.id} className="border-t border-line"><td className="py-2 font-medium">{v.regNo} <span className="text-xs text-muted">{v.label}</span></td><td><Badge value={v.status} /></td><td className="text-right">{v.odometer.toLocaleString()}</td><td className="text-xs">{slot(v.current, '')}</td><td className="text-xs">{slot(v.next, '')}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Requests({ manage }: { manage: boolean }) {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['hr-fleet-trips', status], queryFn: () => api.get<Trip[]>('/fleet/trips', status ? { status } : undefined) });
  const [asking, setAsking] = useState(false);
  const [allocating, setAllocating] = useState<Trip | null>(null);
  const [pick, setPick] = useState({ vehicleId: '', driverId: '' });
  const [ticket, setTicket] = useState<null | { t: Trip; reading: string; remarks: string }>(null);
  const refresh = () => ['hr-fleet-trips', 'hr-fleet-board'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const options = useQuery({ queryKey: ['hr-fleet-options', allocating?.id], queryFn: () => api.get<{ vehicles: { id: string; label: string; problems: string[] }[]; drivers: { id: string; name: string; problems: string[] }[] }>(`/fleet/trips/${allocating!.id}/options`), enabled: !!allocating });
  const act = useMutation({ mutationFn: (v: { id: string; path: string; body?: unknown }) => api.post(`/fleet/trips/${v.id}/${v.path}`, v.body ?? {}), onSuccess: () => (setAllocating(null), setTicket(null), refresh()) });
  return (
    <Card
      title={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All requests</option>{['PENDING', 'APPROVED', 'ALLOCATED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>}
      actions={<Button onClick={() => setAsking(true)}>Request transport</Button>}
    >
      <ErrorBox error={act.error} />
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty>No requests.</Empty> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Number</th><th>When</th><th>Where / why</th><th>Requested by</th><th>Vehicle · driver</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="py-2 font-mono text-xs">{t.number}{t.ticket?.number && <div>{t.ticket.number}</div>}</td>
                <td className="text-xs">{fmtDateTime(t.from)}<br />{fmtDateTime(t.to)}</td>
                <td>{t.destination}<div className="text-xs text-muted">{t.purpose} · {t.passengers} pax</div></td>
                <td>{t.requester}<div className="text-xs text-muted">{t.department}</div></td>
                <td className="text-xs">{t.vehicle}{t.driver && ` · ${t.driver}`}{t.ticket?.distance ? ` · ${t.ticket.distance} km` : ''}</td>
                <td><Badge value={t.status} /></td>
                <td className="whitespace-nowrap text-right">
                  {t.status === 'PENDING' && can('hr.fleet.approve') && t.requestedBy !== me?.id && (
                    <>
                      <Button variant="secondary" onClick={() => act.mutate({ id: t.id, path: 'decide', body: { approve: false, note: 'Not approved' } })}>Reject</Button>
                      <Button onClick={() => act.mutate({ id: t.id, path: 'decide', body: { approve: true } })}>Approve</Button>
                    </>
                  )}
                  {manage && ['APPROVED', 'ALLOCATED'].includes(t.status) && <Button variant="secondary" onClick={() => (setPick({ vehicleId: '', driverId: '' }), setAllocating(t))}>{t.status === 'ALLOCATED' ? 'Reallocate' : 'Allocate'}</Button>}
                  {manage && t.status === 'ALLOCATED' && <Button onClick={() => setTicket({ t, reading: '', remarks: '' })}>Issue work ticket</Button>}
                  {manage && t.status === 'IN_PROGRESS' && <Button onClick={() => setTicket({ t, reading: '', remarks: '' })}>Close work ticket</Button>}
                  {['PENDING', 'APPROVED', 'ALLOCATED'].includes(t.status) && (manage || t.requestedBy === me?.id) && <Button variant="secondary" onClick={() => act.mutate({ id: t.id, path: 'cancel' })}>Cancel</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={asking} onClose={() => setAsking(false)} title="Request transport"><RequestTransport onDone={() => (setAsking(false), refresh())} /></Modal>
      <Modal open={!!allocating} onClose={() => setAllocating(null)} title={allocating ? `Allocate ${allocating.number}` : ''} footer={<><Button variant="secondary" onClick={() => setAllocating(null)}>Cancel</Button><Button disabled={!pick.vehicleId || !pick.driverId || act.isPending} onClick={() => act.mutate({ id: allocating!.id, path: 'allocate', body: pick })}>Allocate</Button></>}>
        {!options.data ? <Loading /> : (
          <div className="space-y-3">
            <ErrorBox error={act.error} />
            <Field label="Vehicle"><Select value={pick.vehicleId} onChange={(e) => setPick({ ...pick, vehicleId: e.target.value })}><option value="">Choose…</option>{options.data.vehicles.map((v) => <option key={v.id} value={v.id} disabled={v.problems.length > 0}>{v.label}{v.problems.length ? ` — ${v.problems.join('; ')}` : ''}</option>)}</Select></Field>
            <Field label="Driver"><Select value={pick.driverId} onChange={(e) => setPick({ ...pick, driverId: e.target.value })}><option value="">Choose…</option>{options.data.drivers.map((d) => <option key={d.id} value={d.id} disabled={d.problems.length > 0}>{d.name}{d.problems.length ? ` — ${d.problems.join('; ')}` : ''}</option>)}</Select></Field>
          </div>
        )}
      </Modal>
      <Modal open={!!ticket} onClose={() => setTicket(null)} title={ticket ? (ticket.t.status === 'ALLOCATED' ? `Work ticket for ${ticket.t.number}` : `Close ${ticket.t.ticket?.number ?? ''}`) : ''} footer={<><Button variant="secondary" onClick={() => setTicket(null)}>Cancel</Button><Button disabled={!ticket?.reading || act.isPending} onClick={() => act.mutate(ticket!.t.status === 'ALLOCATED' ? { id: ticket!.t.id, path: 'dispatch', body: { odometerOut: Number(ticket!.reading) } } : { id: ticket!.t.id, path: 'return', body: { odometerIn: Number(ticket!.reading), remarks: ticket!.remarks || undefined } })}>Save</Button></>}>
        {ticket && (
          <div className="space-y-3">
            <ErrorBox error={act.error} />
            <Field label={ticket.t.status === 'ALLOCATED' ? 'Odometer out' : `Odometer in (out was ${ticket.t.ticket?.odometerOut ?? ''})`}><Input inputMode="numeric" value={ticket.reading} onChange={(e) => /^\d{0,7}$/.test(e.target.value) && setTicket({ ...ticket, reading: e.target.value })} /></Field>
            {ticket.t.status === 'IN_PROGRESS' && <Field label="Remarks"><Input value={ticket.remarks} onChange={(e) => setTicket({ ...ticket, remarks: e.target.value })} /></Field>}
          </div>
        )}
      </Modal>
    </Card>
  );
}

const blankVehicle = () => ({ regNo: '', make: '', model: '', year: '', type: 'PICKUP', fuelType: 'DIESEL', seats: '', odometer: '0', station: '', purchaseDate: '', purchaseCost: '', insurer: '', policyNo: '', insuranceExpires: '', inspectionDue: '', serviceEveryKm: '5000', lastServiceKm: '0', fuelCard: '', fuelLimit: '' });

function Vehicles({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['hr-fleet-vehicles'], queryFn: () => api.get<Vehicle[]>('/fleet/vehicles') });
  const [form, setForm] = useState<null | (ReturnType<typeof blankVehicle> & { id?: string })>(null);
  const [open, setOpen] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const body = {
        regNo: f.regNo, make: f.make, model: f.model || undefined, year: f.year ? Number(f.year) : null, type: f.type, fuelType: f.fuelType, seats: f.seats ? Number(f.seats) : null,
        odometer: Number(f.odometer || 0), station: f.station || undefined, purchaseDate: f.purchaseDate || null, purchaseCost: f.purchaseCost || null,
        insurance: { insurer: f.insurer || undefined, policyNo: f.policyNo || undefined, expiresOn: f.insuranceExpires || null }, inspectionDue: f.inspectionDue || null,
        serviceEveryKm: Number(f.serviceEveryKm || 5000), lastServiceKm: Number(f.lastServiceKm || 0), fuelCard: { number: f.fuelCard || undefined, monthlyLimit: f.fuelLimit || null },
      };
      return f.id ? api.patch(`/fleet/vehicles/${f.id}`, body) : api.post('/fleet/vehicles', body);
    },
    onSuccess: () => (setForm(null), qc.invalidateQueries({ queryKey: ['hr-fleet-vehicles'] })),
  });
  const edit = (v: Vehicle) => setForm({ ...blankVehicle(), id: v.id, regNo: v.regNo, make: v.make, model: v.model ?? '', year: v.year ? String(v.year) : '', type: v.type, fuelType: v.fuelType, seats: v.seats ? String(v.seats) : '', odometer: String(v.odometer), station: v.station ?? '', purchaseDate: v.purchaseDate?.slice(0, 10) ?? '', purchaseCost: v.purchaseCost ?? '', insurer: v.insurance?.insurer ?? '', policyNo: v.insurance?.policyNo ?? '', insuranceExpires: v.insurance?.expiresOn?.slice(0, 10) ?? '', inspectionDue: v.inspectionDue?.slice(0, 10) ?? '', serviceEveryKm: String(v.serviceEveryKm), lastServiceKm: String(v.lastServiceKm), fuelCard: v.fuelCard?.number ?? '', fuelLimit: v.fuelCard?.monthlyLimit ?? '' });
  const field = (k: keyof ReturnType<typeof blankVehicle>, l: string, type = 'text') => <Field label={l}><Input type={type} value={form![k]} onChange={(e) => setForm({ ...form!, [k]: e.target.value })} /></Field>;
  return (
    <Card title="Vehicles" actions={manage && <Button onClick={() => setForm(blankVehicle())}>Add vehicle</Button>}>
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty>No vehicles yet.</Empty> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Registration</th><th>Vehicle</th><th>Status</th><th className="text-right">Odometer</th><th>Insurance</th><th>Inspection</th><th /></tr></thead>
          <tbody>
            {list.data.map((v) => (
              <tr key={v.id} className="border-t border-line">
                <td className="py-2 font-medium">{v.regNo}</td>
                <td>{v.make} {v.model} {v.year && `(${v.year})`}<div className="text-xs text-muted">{label(v.type)}{v.station && ` · ${v.station}`}</div></td>
                <td><Badge value={v.status} /></td>
                <td className="text-right">{v.odometer.toLocaleString()}</td>
                <td>{v.insurance?.expiresOn ? fmtDate(v.insurance.expiresOn) : '—'}</td>
                <td>{v.inspectionDue ? fmtDate(v.inspectionDue) : '—'}</td>
                <td className="whitespace-nowrap text-right"><Button variant="secondary" onClick={() => setOpen(v.id)}>History</Button>{manage && <Button variant="secondary" onClick={() => edit(v)}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal wide open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit vehicle' : 'Add vehicle'} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button disabled={save.isPending || !form?.regNo || !form?.make} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorBox error={save.error} />
            <div className="grid gap-3 sm:grid-cols-4">
              {field('regNo', 'Registration')}
              {field('make', 'Make')}
              {field('model', 'Model')}
              {field('year', 'Year')}
              <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
              <Field label="Fuel"><Select value={form.fuelType} onChange={(e) => setForm({ ...form, fuelType: e.target.value })}>{['DIESEL', 'PETROL', 'ELECTRIC'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
              {field('seats', 'Seats')}
              {field('odometer', 'Odometer (km)')}
              {field('station', 'Station')}
              {field('purchaseDate', 'Bought', 'date')}
              {field('purchaseCost', 'Cost')}
              {field('insurer', 'Insurer')}
              {field('policyNo', 'Policy number')}
              {field('insuranceExpires', 'Insurance expires', 'date')}
              {field('inspectionDue', 'Inspection due', 'date')}
              {field('serviceEveryKm', 'Service every (km)')}
              {field('lastServiceKm', 'Last service at (km)')}
              {field('fuelCard', 'Fuel card number')}
              {field('fuelLimit', 'Fuel card monthly limit')}
            </div>
          </div>
        )}
      </Modal>
      {open && <VehicleHistory id={open} manage={manage} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function VehicleHistory({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['hr-fleet-vehicle', id], queryFn: () => api.get<{ vehicle: Vehicle; trips: Trip[]; fuel: { id: string; date: string; litres: number; amount: string; odometer: number; station?: string }[]; maintenance: { id: string; date: string; kind: string; description: string; cost: string; garage?: string }[]; incidents: { id: string; number: string; date: string; kind: string; description: string; status: string }[]; assessment: { recommendation: string; reasons: string[]; maintenanceTotal: string; costPerKm: string | null } }>(`/fleet/vehicles/${id}`) });
  const [entry, setEntry] = useState<null | { kind: 'fuel' | 'maintenance' | 'incident' | 'status'; f: Record<string, string> }>(null);
  const refresh = () => ['hr-fleet-vehicle', 'hr-fleet-vehicles', 'hr-fleet-board'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const save = useMutation({
    mutationFn: () => {
      const { kind, f } = entry!;
      if (kind === 'fuel') return api.post('/fleet/fuel', { vehicleId: id, date: f.date, litres: Number(f.litres), amount: f.amount, odometer: Number(f.odometer), station: f.station || undefined, viaCard: f.viaCard === 'yes' });
      if (kind === 'maintenance') return api.post('/fleet/maintenance', { vehicleId: id, date: f.date, kind: f.type || 'SERVICE', description: f.description, garage: f.garage || undefined, cost: f.amount || '0', odometer: f.odometer ? Number(f.odometer) : null });
      if (kind === 'incident') return api.post('/fleet/incidents', { vehicleId: id, date: f.date, kind: f.type || 'ACCIDENT', location: f.location || undefined, description: f.description, policeAbstract: f.abstract || undefined, groundVehicle: f.ground === 'yes' });
      return api.post(`/fleet/vehicles/${id}/status`, { status: f.status, note: f.description || undefined });
    },
    onSuccess: () => (setEntry(null), refresh()),
  });
  const v = data?.vehicle;
  const set = (k: string, val: string) => setEntry({ ...entry!, f: { ...entry!.f, [k]: val } });
  return (
    <Modal wide open onClose={onClose} title={v ? `${v.regNo} · ${v.make} ${v.model ?? ''}` : 'Vehicle'}>
      {!data || !v ? <Loading /> : (
        <div className="space-y-3 text-sm">
          <p><Badge value={v.status} /> {v.odometer.toLocaleString()} km · last service at {v.lastServiceKm.toLocaleString()} km · <strong>{label(data.assessment.recommendation)}</strong>{data.assessment.reasons.length > 0 && `: ${data.assessment.reasons.join('; ')}`} · repairs to date {fmtMoney(data.assessment.maintenanceTotal)}{data.assessment.costPerKm && ` (${data.assessment.costPerKm}/km)`}</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEntry({ kind: 'fuel', f: { date: today(), litres: '', amount: '', odometer: String(v.odometer), station: '', viaCard: 'no' } })}>Record fuel</Button>
              <Button variant="secondary" onClick={() => setEntry({ kind: 'maintenance', f: { date: today(), type: 'SERVICE', description: '', amount: '', odometer: String(v.odometer), garage: '' } })}>Record service or repair</Button>
              <Button variant="secondary" onClick={() => setEntry({ kind: 'incident', f: { date: today(), type: 'ACCIDENT', description: '', location: '', abstract: '', ground: 'no' } })}>Report incident</Button>
              <Button variant="secondary" onClick={() => setEntry({ kind: 'status', f: { status: v.status === 'ACTIVE' ? 'UNDER_REPAIR' : 'ACTIVE', description: '' } })}>Change status</Button>
            </div>
          )}
          {entry && (
            <div className="grid gap-2 rounded border border-line p-3 sm:grid-cols-3">
              <ErrorBox error={save.error} />
              {entry.kind !== 'status' && <Field label="Date"><Input type="date" value={entry.f.date} onChange={(e) => set('date', e.target.value)} /></Field>}
              {entry.kind === 'fuel' && (
                <>
                  <Field label="Litres"><Input value={entry.f.litres} onChange={(e) => set('litres', e.target.value)} /></Field>
                  <Field label="Amount"><Input value={entry.f.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
                  <Field label="Odometer"><Input value={entry.f.odometer} onChange={(e) => set('odometer', e.target.value)} /></Field>
                  <Field label="Station"><Input value={entry.f.station} onChange={(e) => set('station', e.target.value)} /></Field>
                  <Field label="Paid with the fuel card"><Select value={entry.f.viaCard} onChange={(e) => set('viaCard', e.target.value)}><option value="no">No</option><option value="yes">Yes</option></Select></Field>
                </>
              )}
              {entry.kind === 'maintenance' && (
                <>
                  <Field label="Kind"><Select value={entry.f.type} onChange={(e) => set('type', e.target.value)}>{['SERVICE', 'REPAIR', 'TYRES', 'INSPECTION', 'BODYWORK'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
                  <Field label="Cost"><Input value={entry.f.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
                  <Field label="Odometer"><Input value={entry.f.odometer} onChange={(e) => set('odometer', e.target.value)} /></Field>
                  <Field label="Garage"><Input value={entry.f.garage} onChange={(e) => set('garage', e.target.value)} /></Field>
                  <Field label="Work done" className="sm:col-span-2"><Input value={entry.f.description} onChange={(e) => set('description', e.target.value)} /></Field>
                </>
              )}
              {entry.kind === 'incident' && (
                <>
                  <Field label="Kind"><Select value={entry.f.type} onChange={(e) => set('type', e.target.value)}>{['ACCIDENT', 'BREAKDOWN', 'THEFT', 'TRAFFIC_OFFENCE', 'DAMAGE'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
                  <Field label="Where"><Input value={entry.f.location} onChange={(e) => set('location', e.target.value)} /></Field>
                  <Field label="Police abstract / OB"><Input value={entry.f.abstract} onChange={(e) => set('abstract', e.target.value)} /></Field>
                  <Field label="Take off the road"><Select value={entry.f.ground} onChange={(e) => set('ground', e.target.value)}><option value="no">No</option><option value="yes">Yes, under repair</option></Select></Field>
                  <Field label="What happened" className="sm:col-span-3"><Textarea rows={2} value={entry.f.description} onChange={(e) => set('description', e.target.value)} /></Field>
                </>
              )}
              {entry.kind === 'status' && (
                <>
                  <Field label="Status"><Select value={entry.f.status} onChange={(e) => set('status', e.target.value)}>{['ACTIVE', 'UNDER_REPAIR', 'GROUNDED', 'DISPOSED'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
                  <Field label="Note" className="sm:col-span-2"><Input value={entry.f.description} onChange={(e) => set('description', e.target.value)} /></Field>
                </>
              )}
              <div className="flex gap-2 sm:col-span-3"><Button variant="secondary" onClick={() => setEntry(null)}>Cancel</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div><p className="font-semibold">Repairs and services</p>{data.maintenance.length ? <ul>{data.maintenance.map((m) => <li key={m.id}>{fmtDate(m.date)} · {label(m.kind)} · {m.description} · {fmtMoney(m.cost)}{m.garage && ` · ${m.garage}`}</li>)}</ul> : <p className="text-muted">None.</p>}</div>
            <div><p className="font-semibold">Fuel</p>{data.fuel.length ? <ul>{data.fuel.slice(0, 15).map((f) => <li key={f.id}>{fmtDate(f.date)} · {f.litres} L · {fmtMoney(f.amount)} · {f.odometer.toLocaleString()} km</li>)}</ul> : <p className="text-muted">None.</p>}</div>
            <div><p className="font-semibold">Trips</p>{data.trips.length ? <ul>{data.trips.slice(0, 15).map((t) => <li key={t.id}>{fmtDate(t.from)} · {t.destination} · {t.driver}{t.ticket?.distance ? ` · ${t.ticket.distance} km` : ''}</li>)}</ul> : <p className="text-muted">None.</p>}</div>
            <div><p className="font-semibold">Incidents</p>{data.incidents.length ? <ul>{data.incidents.map((i) => <li key={i.id}>{i.number} · {fmtDate(i.date)} · {label(i.kind)} · {i.description} <Badge value={i.status} /></li>)}</ul> : <p className="text-muted">None.</p>}</div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Drivers({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions(manage);
  const list = useQuery({ queryKey: ['hr-fleet-drivers'], queryFn: () => api.get<Driver[]>('/fleet/drivers') });
  const [form, setForm] = useState<null | { employeeId: string; licenceNo: string; licenceClasses: string; licenceExpiry: string; active: boolean }>(null);
  const save = useMutation({ mutationFn: () => api.post('/fleet/drivers', { ...form, licenceClasses: form!.licenceClasses.split(/[\s,]+/).filter(Boolean) }), onSuccess: () => (setForm(null), qc.invalidateQueries({ queryKey: ['hr-fleet-drivers'] })) });
  return (
    <Card title="Drivers" actions={manage && <Button onClick={() => setForm({ employeeId: '', licenceNo: '', licenceClasses: 'B', licenceExpiry: '', active: true })}>Add driver</Button>}>
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty>No drivers yet.</Empty> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Driver</th><th>Licence</th><th>Classes</th><th>Expires</th><th>Active</th><th /></tr></thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="py-2">{d.name}</td><td>{d.licenceNo}</td><td>{d.licenceClasses.join(', ')}</td><td>{fmtDate(d.licenceExpiry)}{new Date(d.licenceExpiry) < new Date() && <Badge tone="red">Expired</Badge>}</td><td>{d.active ? 'Yes' : 'No'}</td>
                <td className="text-right">{manage && <Button variant="secondary" onClick={() => setForm({ employeeId: d.employeeId, licenceNo: d.licenceNo, licenceClasses: d.licenceClasses.join(', '), licenceExpiry: d.licenceExpiry.slice(0, 10), active: d.active })}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={!!form} onClose={() => setForm(null)} title="Driver" footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button disabled={save.isPending || !form?.employeeId || !form?.licenceNo || !form?.licenceExpiry} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBox error={save.error} />
            <Field label="Employee"><Select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}><option value="">Select…</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}</Select></Field>
            <Field label="Licence number"><Input value={form.licenceNo} onChange={(e) => setForm({ ...form, licenceNo: e.target.value })} /></Field>
            <Field label="Classes"><Input value={form.licenceClasses} onChange={(e) => setForm({ ...form, licenceClasses: e.target.value })} /></Field>
            <Field label="Expires"><Input type="date" value={form.licenceExpiry} onChange={(e) => setForm({ ...form, licenceExpiry: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />Active</label>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Reports() {
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const report = useQuery({ queryKey: ['hr-fleet-report', range], queryFn: () => api.get<{ days: number; requests: number; byStatus: Record<string, number>; departments: { department: string; trips: number; distance: number }[]; vehicles: { vehicleId: string; regNo: string; trips: number; distance: number; daysInUse: number; utilisationPercent: number; fuelCost: string; repairCost: string; incidents: number }[] }>('/fleet/report', range) });
  const fuel = useQuery({ queryKey: ['hr-fleet-fuel', range], queryFn: () => api.get<{ vehicleId: string; regNo: string; litres: number; cost: string; distance: number; kmPerLitre: number | null; costPerKm: string | null; flag: string }[]>('/fleet/fuel-analysis', range) });
  const assess = useQuery({ queryKey: ['hr-fleet-assess'], queryFn: () => api.get<{ vehicleId: string; regNo: string; age: number | null; odometer: number; maintenanceLastYear: string; lastYearPercentOfCost: number | null; recommendation: string; reasons: string[] }[]>('/fleet/assessment') });
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2"><Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field><Button variant="secondary" onClick={() => window.print()}>Print</Button></div>
      {report.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Requests" value={report.data.requests} />
            <Stat label="Completed" value={report.data.byStatus.COMPLETED ?? 0} />
            <Stat label="Kilometres" value={report.data.vehicles.reduce((a, v) => a + v.distance, 0).toLocaleString()} />
            <Stat label="Incidents" value={report.data.vehicles.reduce((a, v) => a + v.incidents, 0)} />
          </div>
          <Card title="Transport by department">
            {!report.data.departments.length ? <Empty>No completed trips.</Empty> : <ul className="text-sm">{report.data.departments.map((d) => <li key={d.department}>{d.department}: {d.trips} trip{d.trips === 1 ? '' : 's'}, {d.distance.toLocaleString()} km</li>)}</ul>}
          </Card>
          <Card title="Fleet use and cost">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Vehicle</th><th className="text-right">Trips</th><th className="text-right">Km</th><th className="text-right">Days used</th><th className="text-right">Utilisation</th><th className="text-right">Fuel</th><th className="text-right">Repairs</th><th className="text-right">Incidents</th></tr></thead>
              <tbody>{report.data.vehicles.map((v) => <tr key={v.vehicleId} className="border-t border-line"><td className="py-2">{v.regNo}</td><td className="text-right">{v.trips}</td><td className="text-right">{v.distance}</td><td className="text-right">{v.daysInUse}</td><td className="text-right">{v.utilisationPercent}%</td><td className="text-right">{fmtMoney(v.fuelCost)}</td><td className="text-right">{fmtMoney(v.repairCost)}</td><td className="text-right">{v.incidents}</td></tr>)}</tbody>
            </table>
          </Card>
        </>
      )}
      <Card title="Fuel consumption">
        {!fuel.data?.length ? <Empty>No fuel recorded in this period.</Empty> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Vehicle</th><th className="text-right">Litres</th><th className="text-right">Cost</th><th className="text-right">Km</th><th className="text-right">Km / litre</th><th className="text-right">Cost / km</th><th /></tr></thead>
            <tbody>{fuel.data.map((r) => <tr key={r.vehicleId} className="border-t border-line"><td className="py-2">{r.regNo}</td><td className="text-right">{r.litres}</td><td className="text-right">{fmtMoney(r.cost)}</td><td className="text-right">{r.distance}</td><td className="text-right">{r.kmPerLitre ?? '—'}</td><td className="text-right">{r.costPerKm ?? '—'}</td><td>{r.flag && <Badge tone="amber">{r.flag}</Badge>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card title="Keep or dispose">
        {!assess.data?.length ? <Empty>No vehicles.</Empty> : (
          <ul className="space-y-1 text-sm">{assess.data.map((a) => <li key={a.vehicleId}><Badge tone={a.recommendation === 'DISPOSE' ? 'red' : a.recommendation === 'REVIEW' ? 'amber' : 'green'}>{label(a.recommendation)}</Badge> {a.regNo}{a.age !== null && ` · ${a.age} years`} · {a.odometer.toLocaleString()} km · repairs last year {fmtMoney(a.maintenanceLastYear)}{a.lastYearPercentOfCost !== null && ` (${a.lastYearPercentOfCost}% of cost)`}{a.reasons.length > 0 && ` — ${a.reasons.join('; ')}`}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}
