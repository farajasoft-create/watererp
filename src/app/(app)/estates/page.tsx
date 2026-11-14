'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Stat, Tabs } from '@/components/ui';
import { currentPeriod, fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/estates/ui/api';

interface Unit { id: string; code: string; description?: string; marketRent: string; active: boolean }
interface Property { id: string; code: string; name: string; location?: string; kind: string; units: Unit[] }
interface Tenant { id: string; name: string; kind: string; phone?: string; email?: string; kraPin?: string; idNumber?: string }
interface Roll {
  rows: { propertyId: string; property: string; unit: string; description?: string; occupied: boolean; marketRent: string; lease: { id: string; number: string; tenant: string; rent: string; endDate: string; balance: string; arrearsDays: number; band: string; depositHeld: string } | null }[];
  totals: { units: number; occupied: number; occupancyPct: number | null; monthlyRent: string; arrears: string; depositsHeld: string; expiringIn90Days: number };
}

function PropertyForm({ p, onClose }: { p?: Property; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: p?.code ?? '', name: p?.name ?? '', location: p?.location ?? '', kind: p?.kind ?? 'COMMERCIAL' });
  const [units, setUnits] = useState(p?.units.map((u) => ({ id: u.id, code: u.code, description: u.description ?? '', marketRent: u.marketRent })) ?? [{ id: undefined as string | undefined, code: '', description: '', marketRent: '' }]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, location: f.location || undefined, units: units.filter((u) => u.code).map((u) => ({ ...u, description: u.description || undefined, marketRent: u.marketRent || '0' })) };
      return p ? api.put(`/properties/${p.id}`, body) : api.post('/properties', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['estates-properties'] }); qc.invalidateQueries({ queryKey: ['estates-roll'] }); onClose(); },
  });
  const set = (i: number, k: string, v: string) => setUnits(units.map((u, j) => (j === i ? { ...u, [k]: v } : u)));
  return (
    <Modal open wide onClose={onClose} title={p ? `Edit ${p.name}` : 'New property'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['COMMERCIAL', 'RESIDENTIAL', 'LAND', 'MIXED'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Units</div>
        {units.map((u, i) => (
          <div key={u.id ?? `n${i}`} className="grid gap-2 sm:grid-cols-[100px_2fr_1fr_auto]">
            <Input placeholder="Code" value={u.code} onChange={(e) => set(i, 'code', e.target.value.toUpperCase())} />
            <Input placeholder="Description" value={u.description} onChange={(e) => set(i, 'description', e.target.value)} />
            <Input placeholder="Market rent" value={u.marketRent} onChange={(e) => set(i, 'marketRent', e.target.value)} />
            <Button variant="secondary" onClick={() => setUnits(units.filter((_, j) => j !== i))} aria-label="Remove unit">✕</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setUnits([...units, { id: undefined, code: '', description: '', marketRent: '' }])}>Add a unit</Button>
      </div>
    </Modal>
  );
}

function TenantForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', kind: 'COMPANY', idNumber: '', kraPin: '', phone: '', email: '' });
  const save = useMutation({ mutationFn: () => api.post('/tenants', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || undefined]))), onSuccess: () => { qc.invalidateQueries({ queryKey: ['estates-tenants'] }); onClose(); } });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title="New tenant" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={t('name')} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={t('kind')}><option value="COMPANY">Company</option><option value="INDIVIDUAL">Individual</option></Select></Field>
        <Field label="ID / registration number"><Input value={f.idNumber} onChange={t('idNumber')} /></Field>
        <Field label="KRA PIN"><Input value={f.kraPin} onChange={t('kraPin')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={t('phone')} /></Field>
        <Field label="Email"><Input value={f.email} onChange={t('email')} /></Field>
      </div>
    </Modal>
  );
}

function LeaseForm({ properties, tenants, onClose }: { properties: Property[]; tenants: Tenant[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ tenantId: '', propertyId: properties[0]?.id ?? '', unitId: '', startDate: '', endDate: '', rent: '', serviceCharge: '0', escalationPct: '0', dueDay: '5', deposit: '0' });
  const units = properties.find((p) => p.id === f.propertyId)?.units.filter((u) => u.active) ?? [];
  const save = useMutation({ mutationFn: () => api.post('/leases', { ...f, escalationPct: Number(f.escalationPct) || 0, dueDay: Number(f.dueDay) || 5 }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['estates-roll'] }); onClose(); } });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title="New lease" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.tenantId || !f.unitId || !f.startDate || !f.endDate || !Number(f.rent)}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tenant"><Select value={f.tenantId} onChange={t('tenantId')}><option value="">Choose</option>{tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Property"><Select value={f.propertyId} onChange={(e) => setF({ ...f, propertyId: e.target.value, unitId: '' })}>{properties.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
        <Field label="Unit"><Select value={f.unitId} onChange={t('unitId')}><option value="">Choose</option>{units.map((u) => <option key={u.id} value={u.id}>{u.code}{u.description ? ` · ${u.description}` : ''}</option>)}</Select></Field>
        <Field label="Starts"><Input type="date" value={f.startDate} onChange={t('startDate')} /></Field>
        <Field label="Ends"><Input type="date" value={f.endDate} onChange={t('endDate')} /></Field>
        <Field label="Rent due on day"><Input inputMode="numeric" value={f.dueDay} onChange={t('dueDay')} /></Field>
        <Field label="Monthly rent"><Input inputMode="decimal" value={f.rent} onChange={t('rent')} /></Field>
        <Field label="Service charge"><Input inputMode="decimal" value={f.serviceCharge} onChange={t('serviceCharge')} /></Field>
        <Field label="Yearly escalation %"><Input inputMode="decimal" value={f.escalationPct} onChange={t('escalationPct')} /></Field>
        <Field label="Deposit"><Input inputMode="decimal" value={f.deposit} onChange={t('deposit')} /></Field>
      </div>
    </Modal>
  );
}

export default function RentRollPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'roll' | 'properties' | 'tenants'>('roll');
  const [modal, setModal] = useState<'property' | 'tenant' | 'lease' | Property | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const [portal, setPortal] = useState<{ name: string; url: string } | null>(null);
  const roll = useQuery({ queryKey: ['estates-roll'], queryFn: () => api.get<Roll>('/rent-roll') });
  const properties = useQuery({ queryKey: ['estates-properties'], queryFn: () => api.get<Property[]>('/properties') });
  const tenants = useQuery({ queryKey: ['estates-tenants'], queryFn: () => api.get<Tenant[]>('/tenants') });
  const bill = useMutation({ mutationFn: () => api.post<{ billed: number; total: string }>('/rent/bill', { period }), onSuccess: () => qc.invalidateQueries({ queryKey: ['estates-roll'] }) });
  const link = useMutation({ mutationFn: (t: Tenant) => api.post<{ path: string }>(`/tenants/${t.id}/portal`).then((r) => ({ name: t.name, url: `${window.location.origin}${r.path}` })), onSuccess: setPortal });
  const manage = can('estates.manage');
  const t = roll.data?.totals;
  return (
    <>
      <PageHeader
        title="Estates"
        subtitle="Rent roll, leases, arrears and deposits"
        actions={manage && (
          <div className="flex flex-wrap items-end gap-2">
            <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" aria-label="Month to bill" />
            <Button variant="secondary" onClick={() => bill.mutate()} disabled={bill.isPending}>Bill rent for the month</Button>
            <Button onClick={() => setModal('lease')} disabled={!properties.data?.length || !tenants.data?.length}>New lease</Button>
          </div>
        )}
      />
      <ErrorBox error={roll.error || bill.error || link.error} />
      {bill.data && <div className="mb-3"><Notice tone="green">{bill.data.billed} lease{bill.data.billed === 1 ? '' : 's'} billed for {period}, KES {Number(bill.data.total).toLocaleString('en-KE')}. Tenants were sent an SMS.</Notice></div>}
      {portal && <div className="mb-3"><Notice>Portal link for {portal.name} (also texted to them; copy it now, it is not shown again): <Input readOnly value={portal.url} onFocus={(e) => e.target.select()} /></Notice></div>}
      {t && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Units let" value={`${t.occupied} of ${t.units}`} hint={t.occupancyPct !== null ? `${t.occupancyPct}% occupancy` : undefined} />
          <Stat label="Monthly rent" value={<Money value={t.monthlyRent} />} />
          <Stat label="Arrears" value={<Money value={t.arrears} />} tone={Number(t.arrears) > 0 ? 'warn' : undefined} />
          <Stat label="Deposits held" value={<Money value={t.depositsHeld} />} hint="owed back to tenants" />
          <Stat label="Leases ending in 90 days" value={t.expiringIn90Days} />
        </div>
      )}
      <Tabs tabs={[{ id: 'roll', label: 'Rent roll' }, { id: 'properties', label: 'Properties' }, { id: 'tenants', label: 'Tenants' }]} value={tab} onChange={setTab} />
      {tab === 'roll' && (
        <Card padded={false} actions={<a href={`/api/v1/estates/rent-roll?format=${'csv'}`} className="text-sm text-brand-700 hover:underline">CSV</a>} title="Every unit">
          {roll.isLoading ? <Loading /> : !roll.data?.rows.length ? <Empty>No units yet. Add a property.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Unit</th><th>Tenant</th><th>Lease</th><th className="num">Rent</th><th className="num">Owed</th><th>Arrears</th><th className="num">Deposit</th><th>Ends</th></tr></thead>
                <tbody>
                  {roll.data.rows.map((r) => (
                    <tr key={`${r.property}-${r.unit}`}>
                      <td>{r.property} {r.unit}<div className="text-xs text-muted">{r.description}</div></td>
                      <td>{r.lease?.tenant ?? <Badge tone="gray">vacant</Badge>}</td>
                      <td>{r.lease ? <Link href={`/estates/leases/${r.lease.id}`} className="text-brand-700 hover:underline">{r.lease.number}</Link> : '—'}</td>
                      <td className="num"><Money value={r.lease?.rent ?? r.marketRent} /></td>
                      <td className="num">{r.lease ? <Money value={r.lease.balance} /> : '—'}</td>
                      <td>{r.lease ? <Badge tone={r.lease.band === 'Current' ? 'green' : r.lease.band === '1–30' ? 'amber' : 'red'}>{r.lease.band}</Badge> : '—'}</td>
                      <td className="num">{r.lease ? <Money value={r.lease.depositHeld} /> : '—'}</td>
                      <td>{r.lease ? fmtDate(r.lease.endDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {tab === 'properties' && (
        <Card padded={false} title="Properties" actions={manage && <Button onClick={() => setModal('property')}>New property</Button>}>
          {!properties.data?.length ? <Empty>No properties.</Empty> : (
            <table className="table-base"><thead><tr><th>Property</th><th>Kind</th><th>Location</th><th className="num">Units</th></tr></thead><tbody>{properties.data.map((p) => <tr key={p.id}><td>{manage ? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setModal(p)}>{p.code}</button> : p.code} {p.name}</td><td>{label(p.kind)}</td><td>{p.location}</td><td className="num">{p.units.length}</td></tr>)}</tbody></table>
          )}
        </Card>
      )}
      {tab === 'tenants' && (
        <Card padded={false} title="Tenants" actions={manage && <Button onClick={() => setModal('tenant')}>New tenant</Button>}>
          {!tenants.data?.length ? <Empty>No tenants.</Empty> : (
            <table className="table-base"><thead><tr><th>Tenant</th><th>Phone</th><th>Email</th><th>KRA PIN</th>{manage && <th />}</tr></thead><tbody>{tenants.data.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.phone}</td><td>{x.email}</td><td>{x.kraPin}</td>{manage && <td><Button variant="secondary" onClick={() => link.mutate(x)}>Portal link</Button></td>}</tr>)}</tbody></table>
          )}
        </Card>
      )}
      {(modal === 'property' || (modal && typeof modal === 'object')) && <PropertyForm p={typeof modal === 'object' ? modal : undefined} onClose={() => setModal(null)} />}
      {modal === 'tenant' && <TenantForm onClose={() => setModal(null)} />}
      {modal === 'lease' && properties.data && tenants.data && <LeaseForm properties={properties.data} tenants={tenants.data} onClose={() => setModal(null)} />}
    </>
  );
}
