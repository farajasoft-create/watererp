'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/estates/ui/api';

interface Request { id: string; number: string; property: string; unit: string; tenant: string; category: string; description: string; priority: string; status: string; raisedBy: string; resolution?: string; createdAt: string; doneAt?: string }
interface Property { id: string; code: string; name: string; units: { id: string; code: string }[] }
const CATS = ['PLUMBING', 'ELECTRICAL', 'STRUCTURAL', 'SECURITY', 'CLEANING', 'OTHER'];

export default function MaintenancePage() {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<{ id: string; resolution: string; cost: string } | null>(null);
  const [f, setF] = useState({ propertyId: '', unitId: '', category: 'OTHER', description: '', priority: 'NORMAL' });
  const { data, error, isLoading } = useQuery({ queryKey: ['estates-maint', status], queryFn: () => api.get<Request[]>('/maintenance', status ? { status } : {}) });
  const properties = useQuery({ queryKey: ['estates-properties'], queryFn: () => api.get<Property[]>('/properties') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['estates-maint'] });
  const create = useMutation({ mutationFn: () => api.post('/maintenance', { ...f, unitId: f.unitId || null }), onSuccess: () => { setCreating(false); refresh(); } });
  const update = useMutation({ mutationFn: (x: { id: string; status: string; resolution?: string; cost?: string }) => api.patch(`/maintenance/${x.id}`, x), onSuccess: () => { setDone(null); refresh(); } });
  const work = can('estates.maintain');
  return (
    <>
      <PageHeader title="Maintenance" subtitle="Repair requests from tenants (through their portal) and staff" actions={work && <Button onClick={() => setCreating(true)}>New request</Button>} />
      <ErrorBox error={error || update.error} />
      <div className="mb-3 w-48"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option><option value="">All</option></Select></div>
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing here.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Request</th><th>Where</th><th>Tenant</th><th>What</th><th>Priority</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>{r.number}<div className="text-xs text-muted">{fmtDate(r.createdAt)} · {r.raisedBy === 'TENANT' ? 'from tenant' : 'staff'}</div></td>
                  <td>{r.property} {r.unit}</td>
                  <td>{r.tenant || '—'}</td>
                  <td>{label(r.category)}: {r.description}{r.resolution && <div className="text-xs text-muted">Done: {r.resolution}</div>}</td>
                  <td><Badge tone={r.priority === 'URGENT' ? 'red' : 'gray'}>{r.priority.toLowerCase()}</Badge></td>
                  <td><Badge value={r.status} /></td>
                  <td>{work && r.status === 'OPEN' && <Button variant="secondary" onClick={() => update.mutate({ id: r.id, status: 'IN_PROGRESS' })}>Start</Button>}{work && ['OPEN', 'IN_PROGRESS'].includes(r.status) && <Button onClick={() => setDone({ id: r.id, resolution: '', cost: '' })}>Done</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && (
        <Modal open onClose={() => setCreating(false)} title="New maintenance request" footer={<Button onClick={() => create.mutate()} disabled={!f.propertyId || f.description.length < 3 || create.isPending}>Save</Button>}>
          <ErrorBox error={create.error} />
          <div className="grid gap-2">
            <Select value={f.propertyId} onChange={(e) => setF({ ...f, propertyId: e.target.value, unitId: '' })}><option value="">Property</option>{properties.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select>
            <Select value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}><option value="">Common area</option>{properties.data?.find((p) => p.id === f.propertyId)?.units.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}</Select>
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
            <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></Select>
            <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What needs fixing" />
          </div>
        </Modal>
      )}
      {done && (
        <Modal open onClose={() => setDone(null)} title="Mark done" footer={<Button onClick={() => update.mutate({ id: done.id, status: 'DONE', resolution: done.resolution, cost: done.cost || undefined })} disabled={done.resolution.length < 3}>Save</Button>}>
          <div className="grid gap-2">
            <Textarea rows={3} value={done.resolution} onChange={(e) => setDone({ ...done, resolution: e.target.value })} placeholder="What was done (the tenant is told by SMS)" />
            <Input placeholder="Cost" value={done.cost} onChange={(e) => setDone({ ...done, cost: e.target.value })} />
          </div>
        </Modal>
      )}
    </>
  );
}
