'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/ict/ui/api';

const KINDS = ['COMPUTER', 'LAPTOP', 'PRINTER', 'PHONE', 'TABLET', 'MONITOR', 'NETWORK', 'FURNITURE', 'VEHICLE_ACCESSORY', 'OTHER'];
const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'FAULTY'];

interface Asset { id: string; tag: string; description: string; kind: string; make?: string; model?: string; serialNo?: string; location?: string; condition: string; status: string; holderId?: string | null; holderName?: string; department?: string; issuedAt?: string | null }
interface AssetDetail extends Asset {
  allocations: { id: string; holderName: string; department?: string; issuedAt: string; conditionOut?: string; returnedAt?: string; conditionIn?: string; note?: string }[];
  tickets: { id: string; number: string; subject: string; status: string; createdAt: string }[];
}
interface Consumable { id: string; code: string; name: string; unit: string; onHand: number; reorderLevel: number; active: boolean; low: boolean }
interface Move { id: string; kind: string; quantity: number; toName?: string; department?: string; reference?: string; date: string }

const blank = { tag: '', description: '', kind: 'LAPTOP', make: '', model: '', serialNo: '', location: '', condition: 'GOOD' };

function AssetForm({ asset, onClose }: { asset?: Asset; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(asset ? { tag: asset.tag, description: asset.description, kind: asset.kind, make: asset.make ?? '', model: asset.model ?? '', serialNo: asset.serialNo ?? '', location: asset.location ?? '', condition: asset.condition } : blank);
  const save = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? undefined : v]));
      return asset ? api.put(`/assets/${asset.id}`, body) : api.post('/assets', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-assets'] });
      qc.invalidateQueries({ queryKey: ['ict-asset'] });
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={asset ? `Edit ${asset.tag}` : 'New equipment'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.tag || f.description.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tag" hint="The fixed-asset tag, if it has one"><Input value={f.tag} onChange={set('tag')} maxLength={40} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={set('kind')}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
        <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={set('description')} maxLength={200} /></Field>
        <Field label="Make"><Input value={f.make} onChange={set('make')} /></Field>
        <Field label="Model"><Input value={f.model} onChange={set('model')} /></Field>
        <Field label="Serial number"><Input value={f.serialNo} onChange={set('serialNo')} /></Field>
        <Field label="Location"><Input value={f.location} onChange={set('location')} /></Field>
        <Field label="Condition"><Select value={f.condition} onChange={set('condition')}>{CONDITIONS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

function AssetPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const people = useDirectory();
  const manage = can('ict.assets.manage');
  const { data: a, error } = useQuery({ queryKey: ['ict-asset', id], queryFn: () => api.get<AssetDetail>(`/assets/${id}`) });
  const [issue, setIssue] = useState({ holderId: '', department: '', note: '' });
  const [back, setBack] = useState({ condition: 'GOOD', note: '' });
  const [editing, setEditing] = useState(false);
  const done = () => {
    qc.invalidateQueries({ queryKey: ['ict-asset', id] });
    qc.invalidateQueries({ queryKey: ['ict-assets'] });
  };
  const doIssue = useMutation({ mutationFn: () => api.post(`/assets/${id}/issue`, { holderId: issue.holderId, department: issue.department || undefined, note: issue.note || undefined }), onSuccess: done });
  const doReturn = useMutation({ mutationFn: () => api.post(`/assets/${id}/return`, { condition: back.condition, note: back.note || undefined }), onSuccess: done });
  const doStatus = useMutation({ mutationFn: (status: string) => api.post(`/assets/${id}/status`, { status }), onSuccess: done });
  return (
    <Modal open wide onClose={onClose} title={a ? `${a.tag} · ${a.description}` : 'Equipment'}>
      <ErrorBox error={error || doIssue.error || doReturn.error || doStatus.error} />
      {!a ? (
        <Loading />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge value={a.status} /> {label(a.kind)} · {[a.make, a.model].filter(Boolean).join(' ')} {a.serialNo && `· serial ${a.serialNo}`} · condition {a.condition.toLowerCase()}
            {manage && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
          </div>
          {manage && a.status === 'IN_STORE' && (
            <div className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-4">
              <Field label="Issue to">
                <Select value={issue.holderId} onChange={(e) => setIssue({ ...issue, holderId: e.target.value })}>
                  <option value="">Choose</option>
                  {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Department"><Input value={issue.department} onChange={(e) => setIssue({ ...issue, department: e.target.value })} /></Field>
              <Field label="Note"><Input value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })} /></Field>
              <div className="flex items-end"><Button onClick={() => doIssue.mutate()} disabled={!issue.holderId || doIssue.isPending}>Issue</Button></div>
            </div>
          )}
          {manage && a.status === 'ISSUED' && (
            <div className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-4">
              <div className="sm:col-span-4">With <b>{a.holderName}</b>{a.department && ` (${a.department})`} since {fmtDate(a.issuedAt ?? null)}.</div>
              <Field label="Returned in condition"><Select value={back.condition} onChange={(e) => setBack({ ...back, condition: e.target.value })}>{CONDITIONS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <Field label="Note" className="sm:col-span-2"><Input value={back.note} onChange={(e) => setBack({ ...back, note: e.target.value })} /></Field>
              <div className="flex items-end"><Button onClick={() => doReturn.mutate()} disabled={doReturn.isPending}>Take back</Button></div>
            </div>
          )}
          {manage && (a.status === 'IN_STORE' || a.status === 'UNDER_REPAIR') && (
            <div className="flex flex-wrap gap-2">
              {a.status === 'IN_STORE' && <Button variant="secondary" onClick={() => doStatus.mutate('UNDER_REPAIR')}>Send for repair</Button>}
              {a.status === 'UNDER_REPAIR' && <Button variant="secondary" onClick={() => doStatus.mutate('IN_STORE')}>Back from repair</Button>}
              <Button variant="secondary" onClick={() => doStatus.mutate('DISPOSED')}>Disposed of</Button>
            </div>
          )}
          <div>
            <div className="mb-1 font-medium">Issue history</div>
            {!a.allocations.length ? <p className="text-muted">Never issued.</p> : (
              <table className="table-base">
                <thead><tr><th>Held by</th><th>Issued</th><th>Out</th><th>Returned</th><th>In</th><th>Note</th></tr></thead>
                <tbody>
                  {[...a.allocations].reverse().map((x) => (
                    <tr key={x.id}><td>{x.holderName}<div className="text-xs text-muted">{x.department}</div></td><td>{fmtDate(x.issuedAt)}</td><td>{x.conditionOut?.toLowerCase()}</td><td>{x.returnedAt ? fmtDate(x.returnedAt) : 'still held'}</td><td>{x.conditionIn?.toLowerCase()}</td><td>{x.note}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <div className="mb-1 font-medium">Help desk tickets</div>
            {!a.tickets.length ? <p className="text-muted">None.</p> : (
              <ul className="space-y-1">
                {a.tickets.map((t) => <li key={t.id}><Link href={`/ict/tickets/${t.id}`} className="text-brand-700 hover:underline">{t.number}</Link> {t.subject} <Badge value={t.status} /> <span className="text-muted">{fmtDate(t.createdAt)}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      {editing && a && <AssetForm asset={a} onClose={() => setEditing(false)} />}
    </Modal>
  );
}

function Equipment() {
  const can = useCan();
  const [q, setQ] = useState({ status: '', search: '' });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['ict-assets', q], queryFn: () => api.get<Asset[]>('/assets', { ...(q.status && { status: q.status }), ...(q.search && { search: q.search }) }) });
  return (
    <Card
      padded={false}
      actions={
        <>
          <a href={`/api/v1/ict/assets?format=${'csv'}`} className="text-sm text-brand-700 hover:underline">CSV</a>
          {can('ict.assets.manage') && <Button onClick={() => setCreating(true)}>Add equipment</Button>}
        </>
      }
      title="Equipment"
    >
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        <Input placeholder="Tag, item, serial, holder" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="max-w-xs" />
        <Select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })} className="max-w-44">
          <option value="">Any status</option>
          <option value="ISSUED">Issued</option>
          <option value="IN_STORE">In store</option>
          <option value="UNDER_REPAIR">Under repair</option>
          <option value="DISPOSED">Disposed</option>
        </Select>
      </div>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No equipment recorded.</Empty> : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Tag</th><th>Item</th><th>Kind</th><th>Status</th><th>Condition</th><th>Held by</th><th>Since</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td><button type="button" onClick={() => setOpen(a.id)} className="font-medium text-brand-700 hover:underline">{a.tag}</button></td>
                  <td>{a.description}<div className="text-xs text-muted">{[a.make, a.model, a.serialNo].filter(Boolean).join(' · ')}</div></td>
                  <td>{label(a.kind)}</td>
                  <td><Badge value={a.status} /></td>
                  <td>{a.condition.toLowerCase()}</td>
                  <td>{a.holderName ?? '—'}<div className="text-xs text-muted">{a.department}</div></td>
                  <td>{a.issuedAt ? fmtDate(a.issuedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <AssetForm onClose={() => setCreating(false)} />}
      {open && <AssetPanel id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function StockMove({ item, onClose }: { item: Consumable; onClose: () => void }) {
  const qc = useQueryClient();
  const people = useDirectory();
  const [f, setF] = useState({ kind: 'ISSUE', quantity: '', toId: '', department: '', reference: '' });
  const moves = useQuery({ queryKey: ['ict-moves', item.id], queryFn: () => api.get<Move[]>(`/consumables/${item.id}/moves`) });
  const save = useMutation({
    mutationFn: () => api.post(`/consumables/${item.id}/moves`, { kind: f.kind, quantity: Number(f.quantity), toId: f.toId || null, department: f.department || undefined, reference: f.reference || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-consumables'] });
      qc.invalidateQueries({ queryKey: ['ict-moves', item.id] });
      setF({ ...f, quantity: '', reference: '' });
    },
  });
  return (
    <Modal open wide onClose={onClose} title={`${item.name} · ${item.onHand} ${item.unit} in stock`}>
      <ErrorBox error={save.error} />
      <div className="grid gap-2 sm:grid-cols-5">
        <Field label="Movement">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="ISSUE">Issue</option>
            <option value="RECEIPT">Receive</option>
            <option value="ADJUSTMENT">Count correction (+/−)</option>
          </Select>
        </Field>
        <Field label={`Quantity (${item.unit})`}><Input inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
        {f.kind === 'ISSUE' ? (
          <>
            <Field label="To">
              <Select value={f.toId} onChange={(e) => setF({ ...f, toId: e.target.value })}>
                <option value="">Department only</option>
                {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
          </>
        ) : (
          <Field label="Reference" className="sm:col-span-2"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="LPO or delivery note" /></Field>
        )}
        <div className="flex items-end"><Button onClick={() => save.mutate()} disabled={save.isPending || !Number(f.quantity)}>Save</Button></div>
      </div>
      <table className="table-base mt-3">
        <thead><tr><th>Date</th><th>Movement</th><th className="num">Quantity</th><th>To / reference</th></tr></thead>
        <tbody>
          {moves.data?.map((m) => <tr key={m.id}><td>{fmtDateTime(m.date)}</td><td>{label(m.kind)}</td><td className="num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td><td>{[m.toName, m.department, m.reference].filter(Boolean).join(' · ')}</td></tr>)}
        </tbody>
      </table>
    </Modal>
  );
}

function Consumables() {
  const qc = useQueryClient();
  const can = useCan();
  const manage = can('ict.assets.manage');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: '', name: '', unit: 'each', reorderLevel: '0' });
  const [moving, setMoving] = useState<Consumable | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['ict-consumables'], queryFn: () => api.get<Consumable[]>('/consumables') });
  const create = useMutation({
    mutationFn: () => api.post('/consumables', { ...f, reorderLevel: Number(f.reorderLevel) || 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-consumables'] });
      setAdding(false);
      setF({ code: '', name: '', unit: 'each', reorderLevel: '0' });
    },
  });
  return (
    <Card padded={false} title="Consumables" actions={manage && <Button onClick={() => setAdding(true)}>Add item</Button>}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No consumables recorded.</Empty> : (
        <table className="table-base">
          <thead><tr><th>Code</th><th>Item</th><th className="num">In stock</th><th className="num">Re-order at</th><th /></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'text-muted'}>
                <td className="font-medium">{c.code}</td>
                <td>{c.name}</td>
                <td className="num">{c.onHand} {c.unit} {c.low && <Badge tone="amber">re-order</Badge>}</td>
                <td className="num">{c.reorderLevel}</td>
                <td>{manage && <Button variant="secondary" onClick={() => setMoving(c)}>Issue / receive</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <Modal open onClose={() => setAdding(false)} title="New consumable" footer={<Button onClick={() => create.mutate()} disabled={create.isPending || !f.code || f.name.length < 2}>Save</Button>}>
          <ErrorBox error={create.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="TONER85A" /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Unit"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
            <Field label="Re-order when down to"><Input inputMode="numeric" value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {moving && <StockMove item={moving} onClose={() => setMoving(null)} />}
    </Card>
  );
}

export default function OfficeAssetsPage() {
  const [tab, setTab] = useState<'equipment' | 'consumables'>('equipment');
  return (
    <>
      <PageHeader title="Office assets" subtitle="Equipment issued to staff, and office consumables" />
      <Tabs tabs={[{ id: 'equipment', label: 'Equipment' }, { id: 'consumables', label: 'Consumables' }]} value={tab} onChange={setTab} />
      {tab === 'equipment' ? <Equipment /> : <Consumables />}
    </>
  );
}
