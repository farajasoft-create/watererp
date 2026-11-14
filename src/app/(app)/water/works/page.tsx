'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Pager, Select, Stat, Tabs, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, fmtUnits, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { useFacilities } from '@/modules/water/ui/facilities';
import { useZones } from '@/modules/water/ui/hooks';
import { JobComplete } from '@/modules/water/ui/job-complete';
import { Page } from '@/modules/water/ui/types';
import { WORK_PRIORITIES, WORK_TYPES, WorkOrder } from '@/modules/water/ui/works';

interface Plan {
  id: string;
  name: string;
  facilityId?: string | null;
  assetRef?: string;
  frequencyDays: number;
  leadDays: number;
  nextDue: string;
  checklist: string[];
  active: boolean;
}

interface Stats {
  open: number;
  overdue: number;
  completed: number;
  onTimePercent: number | null;
  byType: { type: string; jobs: number; onTimePercent: number; avgHours: number; materialsCost: string }[];
}

function NewJob({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const { data: facilities } = useFacilities();
  const { data: users } = useDirectory('water');
  const [f, setF] = useState({ type: 'CORRECTIVE', priority: 'NORMAL', title: '', description: '', facilityId: '', assetRef: '', zoneId: '', location: '', dueAt: '', assignedTo: [] as string[], checklist: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post<WorkOrder>('/work-orders', {
        type: f.type,
        priority: f.priority,
        title: f.title,
        description: f.description || undefined,
        facilityId: f.facilityId || null,
        assetRef: f.assetRef || undefined,
        zoneId: f.zoneId || null,
        location: f.location || undefined,
        dueAt: f.dueAt || null,
        assignedTo: f.assignedTo,
        checklist: f.checklist.split('\n').map((x) => x.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title="New field job" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 3}>Raise job</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{WORK_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
        <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{WORK_PRIORITIES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
        <Field label="Due" hint="Defaults by priority"><Input type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Title" className="sm:col-span-3"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Facility"><Select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}><option value="">—</option>{facilities?.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></Field>
        <Field label="Asset / vehicle no." hint="Pump, generator, fleet number"><Input value={f.assetRef} onChange={(e) => setF({ ...f, assetRef: e.target.value })} /></Field>
        <Field label="Zone"><Select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}><option value="">—</option>{zones?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}</Select></Field>
        <Field label="Location" className="sm:col-span-3"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Details" className="sm:col-span-3"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Checklist (one item per line)" className="sm:col-span-3"><Textarea rows={2} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></Field>
      </div>
      <Field label="Assign to">
        <div className="flex flex-wrap gap-3 text-sm">
          {users?.map((u) => (
            <label key={u.id} className="flex items-center gap-1"><input type="checkbox" checked={f.assignedTo.includes(u.id)} onChange={(e) => setF({ ...f, assignedTo: e.target.checked ? [...f.assignedTo, u.id] : f.assignedTo.filter((x) => x !== u.id) })} />{u.name}</label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const { data: users } = useDirectory('water');
  const { data: job, error } = useQuery({ queryKey: ['work-order', id], queryFn: () => api.get<WorkOrder>(`/work-orders/${id}`) });
  const [assign, setAssign] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [completing, setCompleting] = useState(false);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(`/work-orders/${id}/${path}`, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      qc.invalidateQueries({ queryKey: ['work-order', id] });
    },
  });
  const manage = can('water.works.manage');
  const active = job && ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(job.status);
  return (
    <Modal open wide onClose={onClose} title={job ? `${job.number} · ${job.title}` : 'Job'}>
      <ErrorBox error={error || act.error} />
      {!job ? (
        <Loading />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge value={job.status} />
            <Badge tone="blue">{label(job.type)}</Badge>
            {job.priority !== 'NORMAL' && <Badge tone="red">{label(job.priority)}</Badge>}
            {job.overdue && <Badge tone="red">Overdue</Badge>}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Due</dt><dd>{fmtDateTime(job.dueAt)}</dd></div>
            <div><dt className="text-xs text-muted">Crew</dt><dd>{job.assignedTo.map((a) => job.names?.[a] ?? '—').join(', ') || 'Not assigned'}</dd></div>
            {job.ticket && <div><dt className="text-xs text-muted">Complaint</dt><dd>{job.ticket.number}: {job.ticket.subject}</dd></div>}
            {job.customer && <div><dt className="text-xs text-muted">Customer</dt><dd><Link className="text-brand-700 hover:underline" href={`/water/customers/${job.customerId}`}>{job.customer.accountNo} · {job.customer.name}</Link> {job.customer.phone}</dd></div>}
            {job.facility && <div><dt className="text-xs text-muted">Facility</dt><dd>{job.facility.code} · {job.facility.name}</dd></div>}
            {job.assetRef && <div><dt className="text-xs text-muted">Asset</dt><dd>{job.assetRef}</dd></div>}
            {job.location && <div className="sm:col-span-2"><dt className="text-xs text-muted">Location</dt><dd>{job.location}{job.gps?.lat && <> · <a className="text-brand-700 hover:underline" href={`https://www.google.com/maps?q=${job.gps.lat},${job.gps.lng}`} target="_blank" rel="noreferrer">map</a></>}</dd></div>}
            {job.description && <div className="sm:col-span-2"><dt className="text-xs text-muted">Details</dt><dd className="whitespace-pre-wrap">{job.description}</dd></div>}
            {job.findings && <div className="sm:col-span-2"><dt className="text-xs text-muted">Findings</dt><dd>{job.findings} ({fmtUnits(job.labourHours)} h)</dd></div>}
          </dl>
          {!!job.materials?.length && (
            <table className="table-base">
              <thead><tr><th>Material</th><th className="num">Qty</th><th className="num">Unit cost</th></tr></thead>
              <tbody>{job.materials.map((m, i) => <tr key={i}><td>{m.itemCode ? `${m.itemCode} · ` : ''}{m.description}</td><td className="num">{fmtUnits(m.quantity)}</td><td className="num"><Money value={m.unitCost} /></td></tr>)}<tr><td className="font-medium">Total</td><td /><td className="num font-medium"><Money value={job.materialsCost} /></td></tr></tbody>
            </table>
          )}
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
            {manage && active && (
              <>
                <Field label="Crew" className="min-w-[14rem] flex-1">
                  <Select multiple value={assign} onChange={(e) => setAssign([...e.target.selectedOptions].map((o) => o.value))} className="h-24">
                    {users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Button variant="secondary" disabled={!assign.length} onClick={() => act.mutate({ path: 'assign', body: { assignedTo: assign } })}>Assign</Button>
              </>
            )}
            {active && job.status !== 'IN_PROGRESS' && <Button variant="secondary" onClick={() => act.mutate({ path: 'start' })}>Start</Button>}
            {active && <Button onClick={() => setCompleting(true)}>Report done</Button>}
            {job.status === 'DONE' && manage && (
              <>
                <Input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} className="max-w-xs" />
                <Button onClick={() => act.mutate({ path: 'close', body: { accept: true, note: note || undefined } })}>Accept and close</Button>
                <Button variant="ghost" onClick={() => act.mutate({ path: 'close', body: { accept: false, note: note || undefined } })}>Send back</Button>
              </>
            )}
          </div>
          <ol className="space-y-1 border-l-2 border-line pl-3 text-sm">
            {job.history?.map((h, i) => (
              <li key={i}><span className="text-xs text-muted">{fmtDateTime(h.at)} · {h.by ? (job.names?.[h.by] ?? 'Staff') : 'System'}</span><div><b>{label(h.action)}</b>{h.note ? `: ${h.note}` : ''}</div></li>
            ))}
          </ol>
          {completing && <JobComplete job={job} onClose={() => setCompleting(false)} />}
        </>
      )}
    </Modal>
  );
}

function Jobs() {
  const params = useSearchParams();
  const can = useCan();
  const [q, setQ] = useState({ view: 'active', type: '', search: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get('id'));
  const monthStart = `${today().slice(0, 7)}-01`;
  const { data, error, isLoading } = useQuery({ queryKey: ['work-orders', q], queryFn: () => api.get<Page<WorkOrder>>('/work-orders', { active: q.view === 'active' || undefined, overdue: q.view === 'overdue' || undefined, status: ['DONE', 'CLOSED'].includes(q.view) ? q.view : undefined, type: q.type, search: q.search, page: q.page, pageSize: 50 }) });
  const { data: stats } = useQuery({ queryKey: ['work-orders', 'stats', monthStart], queryFn: () => api.get<Stats>('/work-orders/stats', { from: monthStart, to: today() }) });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));
  return (
    <>
      {stats && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Open jobs" value={stats.open} />
          <Stat label="Past due" value={stats.overdue} tone={stats.overdue ? 'bad' : 'good'} />
          <Stat label="Done this month" value={stats.completed} />
          <Stat label="Done on time" value={stats.onTimePercent === null ? '—' : `${stats.onTimePercent}%`} />
        </div>
      )}
      <Card padded={false} title="Job cards" actions={can('water.works.manage') && <Button onClick={() => setCreating(true)}>New job</Button>}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select value={q.view} onChange={(e) => set({ view: e.target.value })} className="max-w-[12rem]">
            <option value="active">Open</option>
            <option value="overdue">Past due</option>
            <option value="DONE">Done, to check</option>
            <option value="CLOSED">Closed</option>
            <option value="all">All</option>
          </Select>
          <Select value={q.type} onChange={(e) => set({ type: e.target.value })} className="max-w-[12rem]"><option value="">Any type</option>{WORK_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>
          <Input placeholder="Job, title, place, asset" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No jobs.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Job</th><th>Type</th><th>Title</th><th>Crew</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {data.items.map((j) => (
                <tr key={j.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(j.id)}>
                  <td className="font-medium text-brand-700">{j.number}</td>
                  <td>{label(j.type)}{j.priority !== 'NORMAL' && <div className="text-xs text-red-700">{label(j.priority)}</div>}</td>
                  <td className="max-w-sm">{j.title}{j.location && <div className="text-xs text-muted">{j.location}</div>}</td>
                  <td className="text-sm">{j.assignedNames?.join(', ') || '—'}</td>
                  <td className={j.overdue ? 'whitespace-nowrap text-red-700' : 'whitespace-nowrap'}>{fmtDateTime(j.dueAt)}</td>
                  <td><Badge value={j.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {stats && stats.byType.length > 0 && (
        <Card padded={false} title="This month by type" className="mt-4">
          <table className="table-base">
            <thead><tr><th>Type</th><th className="num">Jobs</th><th className="num">On time</th><th className="num">Average turnaround</th><th className="num">Materials</th></tr></thead>
            <tbody>{stats.byType.map((t) => <tr key={t.type}><td>{label(t.type)}</td><td className="num">{t.jobs}</td><td className="num">{t.onTimePercent}%</td><td className="num">{t.avgHours} h</td><td className="num"><Money value={t.materialsCost} /></td></tr>)}</tbody>
          </table>
        </Card>
      )}
      {creating && <NewJob onClose={() => setCreating(false)} />}
      {openId && <JobDetail id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function Plans() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: facilities } = useFacilities();
  const { data, error } = useQuery({ queryKey: ['maintenance-plans'], queryFn: () => api.get<Plan[]>('/maintenance-plans') });
  const [editing, setEditing] = useState<{ id?: string; name: string; facilityId: string; assetRef: string; frequencyDays: string; leadDays: string; nextDue: string; checklist: string; active: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const e = editing!;
      const body = { name: e.name, facilityId: e.facilityId || null, assetRef: e.assetRef || undefined, frequencyDays: Number(e.frequencyDays), leadDays: Number(e.leadDays), nextDue: e.nextDue, checklist: e.checklist.split('\n').map((x) => x.trim()).filter(Boolean), active: e.active };
      return e.id ? api.patch(`/maintenance-plans/${e.id}`, body) : api.post('/maintenance-plans', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-plans'] });
      setEditing(null);
    },
  });
  const raise = useMutation({ mutationFn: () => api.post<{ raised: string[] }>('/maintenance-plans/raise-due'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance-plans'] }); qc.invalidateQueries({ queryKey: ['work-orders'] }); } });
  return (
    <Card
      padded={false}
      title="Preventive maintenance plans"
      actions={
        can('water.works.manage') && (
          <>
            <Button variant="secondary" onClick={() => raise.mutate()} disabled={raise.isPending}>Raise jobs now due</Button>
            <Button onClick={() => setEditing({ name: '', facilityId: '', assetRef: '', frequencyDays: '90', leadDays: '7', nextDue: today(), checklist: '', active: true })}>New plan</Button>
          </>
        )
      }
    >
      <ErrorBox error={error || raise.error} />
      {raise.data && <div className="px-4 pt-3 text-sm text-muted">{raise.data.raised.length ? `Raised ${raise.data.raised.join(', ')}` : 'Nothing is due.'}</div>}
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <Empty>No plans: add servicing schedules for pumps, generators, valves, reservoirs and vehicles.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Plan</th><th>Asset</th><th>Every</th><th>Next due</th><th /></tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}{!p.active && <Badge tone="gray">Paused</Badge>}</td>
                <td>{facilities?.find((f) => f.id === p.facilityId)?.name ?? p.assetRef ?? '—'}</td>
                <td>{p.frequencyDays} days</td>
                <td className={p.nextDue < today() ? 'text-red-700' : ''}>{fmtDate(p.nextDue)}</td>
                <td className="text-right">{can('water.works.manage') && <Button variant="ghost" onClick={() => setEditing({ id: p.id, name: p.name, facilityId: p.facilityId ?? '', assetRef: p.assetRef ?? '', frequencyDays: String(p.frequencyDays), leadDays: String(p.leadDays), nextDue: p.nextDue.slice(0, 10), checklist: p.checklist.join('\n'), active: p.active })}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} title={editing.id ? 'Edit plan' : 'New maintenance plan'} footer={<Button onClick={() => save.mutate()} disabled={save.isPending || editing.name.length < 3}>Save</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Facility"><Select value={editing.facilityId} onChange={(e) => setEditing({ ...editing, facilityId: e.target.value })}><option value="">—</option>{facilities?.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></Field>
            <Field label="Asset / vehicle no."><Input value={editing.assetRef} onChange={(e) => setEditing({ ...editing, assetRef: e.target.value })} /></Field>
            <Field label="Every (days)"><Input type="number" min={1} value={editing.frequencyDays} onChange={(e) => setEditing({ ...editing, frequencyDays: e.target.value })} /></Field>
            <Field label="Raise the job (days before)"><Input type="number" min={0} value={editing.leadDays} onChange={(e) => setEditing({ ...editing, leadDays: e.target.value })} /></Field>
            <Field label="Next due"><Input type="date" value={editing.nextDue} onChange={(e) => setEditing({ ...editing, nextDue: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
            <Field label="Checklist (one per line)" className="sm:col-span-2"><Textarea rows={3} value={editing.checklist} onChange={(e) => setEditing({ ...editing, checklist: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function WorksPage() {
  const [tab, setTab] = useState<'jobs' | 'plans'>('jobs');
  return (
    <>
      <PageHeader title="Field jobs & maintenance" subtitle="Job cards for repairs, connections and meter work; preventive maintenance of the network, plant, equipment and vehicles" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'jobs', label: 'Job cards' }, { id: 'plans', label: 'Preventive maintenance' }]} />
      <Suspense>{tab === 'jobs' ? <Jobs /> : <Plans />}</Suspense>
    </>
  );
}
