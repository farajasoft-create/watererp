'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select, Tabs } from '@/components/ui';
import { fmtDate, fmtUnits, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { CustomerPicker } from '@/modules/water/ui/customer-picker';
import { useFacilities } from '@/modules/water/ui/facilities';
import { Customer } from '@/modules/water/ui/types';

interface Sales {
  rows: { id: string; facilityId: string; date: string; jerricans: number; volume: string; amount: string }[];
  summary: { kioskId: string; code: string; name: string; operator?: string; days: number; jerricans: number; volume: string; amount: string }[];
}

interface Trip {
  id: string;
  number: string;
  date: string;
  vehicleReg: string;
  driver?: string;
  destination: string;
  volume: string;
  amount: string;
  chargeable: boolean;
  billRunId?: string | null;
}

const monthStart = () => `${today().slice(0, 7)}-01`;

function KioskSales() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: kiosks } = useFacilities('KIOSK');
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data, error } = useQuery({ queryKey: ['kiosk-sales', range], queryFn: () => api.get<Sales>('/kiosks/sales', range) });
  const [f, setF] = useState({ facilityId: '', date: today(), jerricans: '', amount: '' });
  const save = useMutation({ mutationFn: () => api.post('/kiosks/sales', { facilityId: f.facilityId, date: f.date, jerricans: Number(f.jerricans), amount: f.amount || null }), onSuccess: () => qc.invalidateQueries({ queryKey: ['kiosk-sales'] }) });
  return (
    <div className="space-y-4">
      {can('water.kiosk.manage') && (
        <Card title="Daily kiosk sales" actions={<Button onClick={() => save.mutate()} disabled={save.isPending || !f.facilityId || !f.jerricans}>Save</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Kiosk"><Select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}><option value="">Choose…</option>{kiosks?.map((k) => <option key={k.id} value={k.id}>{k.code} · {k.name}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="20 L jerricans sold"><Input inputMode="numeric" value={f.jerricans} onChange={(e) => setF({ ...f, jerricans: e.target.value })} /></Field>
            <Field label="Takings (KES)" hint="Defaults to jerricans × kiosk price"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          </div>
        </Card>
      )}
      <Card padded={false} title="By kiosk" actions={<><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" /><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" /></>}>
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : !data.summary.length ? (
          <Empty>Add kiosks under Production &amp; quality → Facilities.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Kiosk</th><th>Operator</th><th className="num">Days</th><th className="num">Jerricans</th><th className="num">m³</th><th className="num">Takings</th></tr></thead>
            <tbody>{data.summary.map((k) => <tr key={k.kioskId}><td>{k.code} · {k.name}</td><td>{k.operator ?? '—'}</td><td className="num">{k.days}</td><td className="num">{k.jerricans.toLocaleString()}</td><td className="num">{fmtUnits(k.volume)}</td><td className="num"><Money value={k.amount} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Bowsers() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: sources } = useFacilities();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data, error } = useQuery({ queryKey: ['bowser-trips', range], queryFn: () => api.get<Trip[]>('/bowser-trips', range) });
  const [adding, setAdding] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ date: today(), vehicleReg: '', driver: '', sourceFacilityId: '', destination: '', volume: '', rate: '', chargeable: true });
  const save = useMutation({
    mutationFn: () => api.post('/bowser-trips', { ...f, driver: f.driver || undefined, sourceFacilityId: f.sourceFacilityId || null, customerId: customer?.id ?? null, rate: f.rate || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bowser-trips'] });
      setAdding(false);
      setCustomer(null);
    },
  });
  return (
    <Card padded={false} title="Bowser deliveries" actions={<><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" /><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" />{can('water.kiosk.manage') && <Button onClick={() => setAdding(true)}>Record delivery</Button>}</>}>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <Empty>No deliveries in this period.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Trip</th><th>Date</th><th>Vehicle</th><th>To</th><th className="num">m³</th><th className="num">Charge</th><th /></tr></thead>
          <tbody>{data.map((t) => <tr key={t.id}><td className="font-medium">{t.number}</td><td>{fmtDate(t.date)}</td><td>{t.vehicleReg}<div className="text-xs text-muted">{t.driver}</div></td><td>{t.destination}</td><td className="num">{fmtUnits(t.volume)}</td><td className="num">{t.chargeable ? <Money value={t.amount} /> : <Badge tone="gray">Free</Badge>}</td><td>{t.billRunId && <Badge tone="blue">Billed</Badge>}</td></tr>)}</tbody>
        </table>
      )}
      {adding && (
        <Modal open wide onClose={() => setAdding(false)} title="Record a bowser delivery" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !f.vehicleReg || !f.destination || !f.volume}>Save</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Vehicle reg."><Input value={f.vehicleReg} onChange={(e) => setF({ ...f, vehicleReg: e.target.value })} /></Field>
            <Field label="Driver"><Input value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} /></Field>
            <Field label="Filled at"><Select value={f.sourceFacilityId} onChange={(e) => setF({ ...f, sourceFacilityId: e.target.value })}><option value="">—</option>{sources?.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></Field>
            <Field label="Delivered to" className="sm:col-span-2"><Input value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></Field>
            <Field label="Volume (m³)"><Input inputMode="decimal" value={f.volume} onChange={(e) => setF({ ...f, volume: e.target.value })} /></Field>
            <Field label="Rate (KES per m³)"><Input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.chargeable} onChange={(e) => setF({ ...f, chargeable: e.target.checked })} /> Chargeable</label>
          </div>
          {f.chargeable && (
            <>
              <p className="text-sm text-muted">Bill it to a customer account (a supplementary bill for approval):</p>
              {customer ? <div className="text-sm"><b>{customer.accountNo}</b> · {customer.name} <Button variant="ghost" onClick={() => setCustomer(null)}>Change</Button></div> : <CustomerPicker onPick={setCustomer} />}
            </>
          )}
        </Modal>
      )}
    </Card>
  );
}

export default function KiosksPage() {
  const [tab, setTab] = useState<'kiosks' | 'bowsers'>('kiosks');
  return (
    <>
      <PageHeader title="Kiosks & bowsers" subtitle="Water kiosk sales by jerrican and water bowser deliveries" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'kiosks', label: 'Kiosks' }, { id: 'bowsers', label: 'Bowsers' }]} />
      {tab === 'kiosks' ? <KioskSales /> : <Bowsers />}
    </>
  );
}
