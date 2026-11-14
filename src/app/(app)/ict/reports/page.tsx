'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Stat, Tabs } from '@/components/ui';
import { label, today } from '@/lib/format';
import { api } from '@/modules/ict/ui/api';

type Group = { key: string; raised: number; resolved: number; avgResolveHours: number | null; slaMetPct: number | null; avgRating: number | null };
interface Helpdesk {
  raised: number;
  resolved: number;
  reopened: number;
  open: number;
  overdue: number;
  responseSlaPct: number | null;
  resolutionSlaPct: number | null;
  avgResponseHours: number | null;
  avgResolveHours: number | null;
  satisfaction: { rated: number; average: number | null; satisfiedPct: number | null };
  byCategory: Group[];
  byPriority: Group[];
  byOfficer: Group[];
  byChannel: Group[];
  backlog: { age: string; count: number }[];
}
interface Admin {
  equipment: { total: number; issued: number; inStore: number; underRepair: number; poorOrFaulty: number; utilisationPct: number | null; byKind: { key: string; count: number }[]; byDepartment: { key: string; count: number }[] };
  consumables: { issues: number; byDepartment: { key: string; quantity: number }[]; byItem: { key: string; quantity: number }[]; toReorder: { code: string; name: string; onHand: number; reorderLevel: number; unit: string }[] };
  repeatFaults: { key: string; count: number }[];
  openAssetTickets: number;
}

const n = (v: number | null, unit = '') => (v === null ? '—' : `${v}${unit}`);

function GroupTable({ title, rows, keyLabel = (k: string) => k }: { title: string; rows: Group[]; keyLabel?: (k: string) => string }) {
  return (
    <Card padded={false} title={title}>
      {!rows.length ? <Empty>Nothing in this period.</Empty> : (
        <table className="table-base">
          <thead><tr><th /><th className="num">Raised</th><th className="num">Resolved</th><th className="num">Avg hours</th><th className="num">On time</th><th className="num">Rating</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.key}><td>{keyLabel(r.key)}</td><td className="num">{r.raised}</td><td className="num">{r.resolved}</td><td className="num">{n(r.avgResolveHours)}</td><td className="num">{n(r.slaMetPct, '%')}</td><td className="num">{n(r.avgRating)}</td></tr>)}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function List({ title, rows, unit }: { title: string; rows: { key: string; count?: number; quantity?: number }[]; unit?: string }) {
  return (
    <Card title={title}>
      {!rows.length ? <p className="text-sm text-muted">None.</p> : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => <li key={r.key} className="flex justify-between gap-3"><span>{label(r.key) || r.key}</span><span className="tabular-nums">{r.count ?? r.quantity}{unit}</span></li>)}
        </ul>
      )}
    </Card>
  );
}

export default function IctReportsPage() {
  const [tab, setTab] = useState<'helpdesk' | 'admin'>('helpdesk');
  const [range, setRange] = useState({ from: `${today().slice(0, 7)}-01`, to: today() });
  const hd = useQuery({ queryKey: ['ict-report', range], queryFn: () => api.get<Helpdesk>('/helpdesk/report', range), enabled: tab === 'helpdesk' });
  const ad = useQuery({ queryKey: ['ict-admin-report', range], queryFn: () => api.get<Admin>('/admin-report', range), enabled: tab === 'admin' });
  return (
    <>
      <PageHeader
        title="ICT and administration reports"
        subtitle="Help desk performance and office asset use"
        actions={
          <div className="flex items-end gap-2">
            <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </div>
        }
      />
      <Tabs tabs={[{ id: 'helpdesk', label: 'Help desk' }, { id: 'admin', label: 'Administrative efficiency' }]} value={tab} onChange={setTab} />
      {tab === 'helpdesk' && (
        <>
          <ErrorBox error={hd.error} />
          {hd.isLoading ? <Loading /> : hd.data && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                <Stat label="Raised" value={hd.data.raised} />
                <Stat label="Resolved" value={hd.data.resolved} hint={`${hd.data.reopened} reopened`} />
                <Stat label="Open now" value={hd.data.open} hint={`${hd.data.overdue} overdue`} tone={hd.data.overdue ? 'warn' : undefined} />
                <Stat label="Responded on time" value={n(hd.data.responseSlaPct, '%')} hint={`avg ${n(hd.data.avgResponseHours)} h`} />
                <Stat label="Resolved on time" value={n(hd.data.resolutionSlaPct, '%')} hint={`avg ${n(hd.data.avgResolveHours)} h`} />
                <Stat label="Satisfaction" value={n(hd.data.satisfaction.average, '/5')} hint={`${hd.data.satisfaction.rated} rated, ${n(hd.data.satisfaction.satisfiedPct, '%')} satisfied`} />
              </div>
              <a href={`/api/v1/ict/helpdesk/report?format=csv&from=${range.from}&to=${range.to}`} className="inline-block text-sm text-brand-700 hover:underline">Every ticket raised in the period (CSV)</a>
              <div className="grid gap-5 lg:grid-cols-2">
                <GroupTable title="By officer" rows={hd.data.byOfficer} />
                <GroupTable title="By category" rows={hd.data.byCategory} />
                <GroupTable title="By priority" rows={hd.data.byPriority} keyLabel={label} />
                <GroupTable title="By channel" rows={hd.data.byChannel} keyLabel={label} />
              </div>
              <List title="Open tickets by age" rows={hd.data.backlog.map((b) => ({ key: b.age, count: b.count }))} />
            </div>
          )}
        </>
      )}
      {tab === 'admin' && (
        <>
          <ErrorBox error={ad.error} />
          {ad.isLoading ? <Loading /> : ad.data && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <Stat label="Equipment" value={ad.data.equipment.total} />
                <Stat label="Issued to staff" value={ad.data.equipment.issued} hint={`${n(ad.data.equipment.utilisationPct, '%')} in use`} />
                <Stat label="Idle in store" value={ad.data.equipment.inStore} />
                <Stat label="Under repair" value={ad.data.equipment.underRepair} />
                <Stat label="Poor or faulty" value={ad.data.equipment.poorOrFaulty} tone={ad.data.equipment.poorOrFaulty ? 'warn' : undefined} />
                <Stat label="Consumable issues" value={ad.data.consumables.issues} />
              </div>
              <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                <List title="Equipment by kind" rows={ad.data.equipment.byKind} />
                <List title="Equipment in use by department" rows={ad.data.equipment.byDepartment} />
                <List title="Repeat faults (more than one ticket)" rows={ad.data.repeatFaults} unit=" tickets" />
                <List title="Consumables issued by department" rows={ad.data.consumables.byDepartment} />
                <List title="Consumables issued by item" rows={ad.data.consumables.byItem} />
                <Card title="To re-order">
                  {!ad.data.consumables.toReorder.length ? <p className="text-sm text-muted">Nothing.</p> : (
                    <ul className="space-y-1 text-sm">{ad.data.consumables.toReorder.map((r) => <li key={r.code}>{r.name}: {r.onHand} {r.unit} left (re-order at {r.reorderLevel})</li>)}</ul>
                  )}
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
