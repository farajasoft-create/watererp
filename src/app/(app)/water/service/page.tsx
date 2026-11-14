'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pager, Select, Stat, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDateTime, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { CustomerPicker } from '@/modules/water/ui/customer-picker';
import { useZones } from '@/modules/water/ui/hooks';
import { Customer, Page } from '@/modules/water/ui/types';

const CATEGORIES = ['BILLING', 'NO_WATER', 'LOW_PRESSURE', 'LEAK', 'BURST', 'METER', 'WATER_QUALITY', 'SEWER', 'NEW_CONNECTION', 'RECONNECTION', 'ILLEGAL_CONNECTION', 'STAFF_CONDUCT', 'OTHER'];
const CHANNELS = ['WALK_IN', 'PHONE', 'CALL_CENTRE', 'SMS', 'EMAIL', 'FIELD', 'SOCIAL_MEDIA'];
const PRIORITIES = ['LOW', 'NORMAL', 'URGENT', 'EMERGENCY'];

interface Ticket {
  id: string;
  number: string;
  category: string;
  channel: string;
  priority: string;
  status: string;
  customerId?: string | null;
  accountNo?: string;
  name?: string;
  phone?: string;
  subject: string;
  description?: string;
  location?: string;
  assignedTo?: string | null;
  assignedName?: string | null;
  slaDueAt: string;
  escalationLevel?: number;
  resolution?: string;
  satisfaction?: number | null;
  workOrderId?: string | null;
  createdAt: string;
  resolvedAt?: string;
  overdue?: boolean;
  history?: { at: string; by?: string | null; action: string; note?: string; status?: string }[];
  names?: Record<string, string>;
}

interface Stats {
  total: number;
  resolved: number;
  openOverdue: number;
  slaCompliancePercent: number | null;
  avgResolutionHours: number | null;
  avgFirstResponseHours: number | null;
  csat: number | null;
  csatResponses: number;
  nps: number | null;
  npsResponses: number;
  byCategory: { id: string; n: number }[];
}

function NewTicket({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ category: 'NO_WATER', channel: 'WALK_IN', priority: '', name: '', phone: '', subject: '', description: '', location: '', zoneId: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post<Ticket>('/tickets', {
        ...f,
        priority: f.priority || undefined,
        customerId: customer?.id ?? null,
        name: f.name || undefined,
        phone: f.phone || undefined,
        description: f.description || undefined,
        location: f.location || undefined,
        zoneId: f.zoneId || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title="Log a complaint or request" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || f.subject.length < 3}>Save and text the reference</Button>}>
      <ErrorBox error={save.error} />
      {customer ? (
        <div className="flex items-center justify-between rounded border border-line px-3 py-2 text-sm">
          <span>
            <b>{customer.accountNo}</b> · {customer.name}
          </span>
          <Button variant="ghost" onClick={() => setCustomer(null)}>Change</Button>
        </div>
      ) : (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand-700">Link a customer account (optional)</summary>
          <div className="mt-2"><CustomerPicker onPick={setCustomer} /></div>
        </details>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
        </Field>
        <Field label="Received by">
          <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            {CHANNELS.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
        </Field>
        <Field label="Priority" hint="Bursts and sewers default to urgent">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            <option value="">Default</option>
            {PRIORITIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
        </Field>
        {!customer && (
          <>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </>
        )}
        <Field label="Zone">
          <Select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
            <option value="">{customer ? "The account's zone" : 'Unknown'}</option>
            {zones?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}
          </Select>
        </Field>
        <Field label="Subject" className="sm:col-span-3"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Location / landmark" className="sm:col-span-3"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Details" className="sm:col-span-3"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function TicketDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const { data: users } = useDirectory('water');
  const { data: t, error } = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<Ticket>(`/tickets/${id}`) });
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [rating, setRating] = useState('');
  const [recommend, setRecommend] = useState('');
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api.post(`/tickets/${id}/${path}`, body),
    onSuccess: () => {
      setNote('');
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket', id] });
    },
  });
  const manage = can('water.service.manage');
  const open = t && ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(t.status);
  return (
    <Modal open wide onClose={onClose} title={t ? `${t.number} · ${t.subject}` : 'Ticket'}>
      <ErrorBox error={error || act.error} />
      {!t ? (
        <Loading />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge value={t.status} />
            <Badge tone={t.priority === 'EMERGENCY' || t.priority === 'URGENT' ? 'red' : 'gray'}>{label(t.priority)}</Badge>
            <Badge tone="blue">{label(t.category)}</Badge>
            {t.overdue && <Badge tone="red">Overdue{t.escalationLevel ? ` · escalated L${t.escalationLevel}` : ''}</Badge>}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Customer</dt><dd>{t.customerId ? <Link className="text-brand-700 hover:underline" href={`/water/customers/${t.customerId}`}>{t.accountNo} · {t.name}</Link> : t.name ?? '—'} {t.phone && <span className="text-muted">· {t.phone}</span>}</dd></div>
            <div><dt className="text-xs text-muted">Received</dt><dd>{fmtDateTime(t.createdAt)} by {label(t.channel)}</dd></div>
            <div><dt className="text-xs text-muted">Resolve by</dt><dd>{fmtDateTime(t.slaDueAt)}</dd></div>
            <div><dt className="text-xs text-muted">Assigned to</dt><dd>{t.assignedTo ? (t.names?.[t.assignedTo] ?? '—') : 'Nobody yet'}</dd></div>
            {t.location && <div className="sm:col-span-2"><dt className="text-xs text-muted">Location</dt><dd>{t.location}</dd></div>}
            {t.description && <div className="sm:col-span-2"><dt className="text-xs text-muted">Details</dt><dd className="whitespace-pre-wrap">{t.description}</dd></div>}
            {t.resolution && <div className="sm:col-span-2"><dt className="text-xs text-muted">Resolution</dt><dd>{t.resolution}</dd></div>}
            {t.workOrderId && <div><dt className="text-xs text-muted">Field job</dt><dd><Link className="text-brand-700 hover:underline" href={`/water/works?id=${t.workOrderId}`}>Open the job</Link></dd></div>}
          </dl>
          {manage && (
            <div className="space-y-2 rounded-md border border-line p-3">
              {open && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Assign to" className="min-w-[14rem] flex-1">
                    <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                      <option value="">Choose…</option>
                      {users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Select>
                  </Field>
                  <Button variant="secondary" disabled={!assignee || act.isPending} onClick={() => act.mutate({ path: 'assign', body: { assignedTo: assignee } })}>Assign</Button>
                  {t.status !== 'IN_PROGRESS' && <Button variant="secondary" onClick={() => act.mutate({ path: 'start', body: {} })}>Start work</Button>}
                  {!t.workOrderId && <Button variant="secondary" onClick={() => act.mutate({ path: 'work-order', body: {} })}>Raise field job</Button>}
                </div>
              )}
              <Field label={open ? 'Note or resolution' : 'Note'}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={!note || act.isPending} onClick={() => act.mutate({ path: 'comment', body: { note } })}>Add note</Button>
                {open && <Button disabled={note.length < 3 || act.isPending} onClick={() => act.mutate({ path: 'resolve', body: { resolution: note } })}>Resolve and text the customer</Button>}
                {t.status === 'RESOLVED' && (
                  <>
                    <Select value={rating} onChange={(e) => setRating(e.target.value)} className="w-44">
                      <option value="">Customer rating…</option>
                      {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} of 5</option>)}
                    </Select>
                    <Select value={recommend} onChange={(e) => setRecommend(e.target.value)} className="w-56" aria-label="Would recommend us">
                      <option value="">Would recommend us (0–10)…</option>
                      {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                    <Button onClick={() => act.mutate({ path: 'close', body: { customerConfirmed: true, satisfaction: rating ? Number(rating) : null, recommend: recommend ? Number(recommend) : null, note: note || undefined } })}>Customer confirmed: close</Button>
                  </>
                )}
                {(t.status === 'RESOLVED' || t.status === 'CLOSED') && <Button variant="ghost" disabled={note.length < 3} onClick={() => act.mutate({ path: 'reopen', body: { note } })}>Reopen</Button>}
              </div>
            </div>
          )}
          <ol className="space-y-1 border-l-2 border-line pl-3 text-sm">
            {t.history?.map((h, i) => (
              <li key={i}>
                <span className="text-xs text-muted">{fmtDateTime(h.at)} · {h.by ? (t.names?.[h.by] ?? 'Staff') : 'System / customer'}</span>
                <div><b>{label(h.action)}</b>{h.note ? `: ${h.note}` : ''}</div>
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}

export default function ServicePage() {
  const qc = useQueryClient();
  const can = useCan();
  const [q, setQ] = useState({ view: 'open', category: '', search: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const monthStart = `${today().slice(0, 7)}-01`;
  const params = { open: q.view === 'open' || undefined, overdue: q.view === 'overdue' || undefined, mine: q.view === 'mine' || undefined, status: q.view === 'closed' ? 'CLOSED' : undefined, category: q.category, search: q.search, page: q.page, pageSize: 50 };
  const { data, error, isLoading } = useQuery({ queryKey: ['tickets', q], queryFn: () => api.get<Page<Ticket>>('/tickets', params) });
  const { data: stats } = useQuery({ queryKey: ['tickets', 'stats', monthStart], queryFn: () => api.get<Stats>('/tickets/stats', { from: monthStart, to: today() }) });
  const checks = useMutation({ mutationFn: () => api.post<{ escalated: number; closed: number }>('/tickets/housekeeping'), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));
  return (
    <>
      <PageHeader
        title="Customer service"
        subtitle="Complaints, incidents and requests from the counter, phone, call centre, SMS, USSD and the customer portal"
        actions={
          <>
            {can('water.service.manage') && <Button variant="secondary" onClick={() => checks.mutate()} disabled={checks.isPending}>Escalate overdue</Button>}
            <Button onClick={() => setCreating(true)}>Log complaint</Button>
          </>
        }
      />
      <ErrorBox error={error || checks.error} />
      {checks.data && <p className="mb-3 text-sm text-muted">{checks.data.escalated} escalated, {checks.data.closed} closed after no reply.</p>}
      {stats && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <Stat label="Received this month" value={stats.total} />
          <Stat label="Resolved" value={stats.resolved} />
          <Stat label="Open past deadline" value={stats.openOverdue} tone={stats.openOverdue ? 'bad' : 'good'} />
          <Stat label="Resolved on time" value={stats.slaCompliancePercent === null ? '—' : `${stats.slaCompliancePercent}%`} tone={stats.slaCompliancePercent !== null && stats.slaCompliancePercent < 80 ? 'warn' : undefined} />
          <Stat label="Average time to resolve" value={stats.avgResolutionHours === null ? '—' : `${stats.avgResolutionHours} h`} hint={stats.avgFirstResponseHours !== null ? `first response ${stats.avgFirstResponseHours} h` : undefined} />
          <Stat label="Customer satisfaction" value={stats.csat === null ? '—' : `${stats.csat} / 5`} hint={`${stats.csatResponses} ratings`} />
          <Stat label="Net promoter score" value={stats.nps === null ? '—' : stats.nps} hint={`${stats.npsResponses} answers, −100 to +100`} tone={stats.nps !== null && stats.nps < 0 ? 'warn' : undefined} />
        </div>
      )}
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select value={q.view} onChange={(e) => set({ view: e.target.value })} className="max-w-[12rem]">
            <option value="open">Open</option>
            <option value="overdue">Past deadline</option>
            <option value="mine">Assigned to me</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </Select>
          <Select value={q.category} onChange={(e) => set({ category: e.target.value })} className="max-w-[12rem]">
            <option value="">Any category</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
          <Input placeholder="Ticket, account, name, phone, place" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
        </div>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Ticket</th><th>Received</th><th>Category</th><th>Subject</th><th>Customer</th><th>Assigned</th><th>Resolve by</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.items.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(t.id)}>
                    <td className="font-medium text-brand-700">{t.number}</td>
                    <td className="whitespace-nowrap">{fmtDateTime(t.createdAt)}<div className="text-xs text-muted">{label(t.channel)}</div></td>
                    <td>{label(t.category)}{t.priority !== 'NORMAL' && <div className="text-xs text-red-700">{label(t.priority)}</div>}</td>
                    <td className="max-w-xs">{t.subject}{t.location && <div className="text-xs text-muted">{t.location}</div>}</td>
                    <td>{t.accountNo ?? t.name ?? t.phone ?? '—'}</td>
                    <td>{t.assignedName ?? '—'}</td>
                    <td className={t.overdue ? 'whitespace-nowrap text-red-700' : 'whitespace-nowrap'}>{fmtDateTime(t.slaDueAt)}</td>
                    <td><Badge value={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {creating && <NewTicket onClose={() => setCreating(false)} />}
      {openId && <TicketDetail id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
