'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Stat, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';
import { RatingBadge } from '@/modules/internalaudit/ui/shared';

interface Item { id: string; universeId: string | null; title: string; kind: string; quarter: number; start: string | null; end: string | null; hours: number; cost: string; leadId: string | null; rating?: string; area: { code: string; name: string } | null; engagement: { id: string; number: string; status: string } | null; lead: string | null }
interface Plan { id: string; year: string; title: string; status: string; version: number; availableHours: number; hours: number; cost: string; overCapacity: boolean; items: Item[]; preparedBy?: string; submittedAt?: string; decidedAt?: string; decisionNote?: string }
interface Area { id: string; code: string; name: string; rating: string }
type Row = { id?: string; universeId: string; title: string; kind: string; quarter: string; start: string; end: string; hours: string; leadId: string };

const KINDS = ['ASSURANCE', 'CONSULTING', 'INVESTIGATION', 'FOLLOW_UP', 'SPECIAL'];
const toRow = (i: Item): Row => ({ id: i.id, universeId: i.universeId ?? '', title: i.title, kind: i.kind, quarter: String(i.quarter), start: i.start?.slice(0, 10) ?? '', end: i.end?.slice(0, 10) ?? '', hours: String(i.hours), leadId: i.leadId ?? '' });

function EditItems({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const qc = useQueryClient();
  const areas = useQuery({ queryKey: ['ia-universe'], queryFn: () => api.get<Area[]>('/universe') });
  const staff = useDirectory('internalaudit');
  const [rows, setRows] = useState<Row[]>(plan.items.map(toRow));
  const [hours, setHours] = useState(String(plan.availableHours || ''));
  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = useMutation({
    mutationFn: () => api.put(`/plans/${plan.id}/items`, { availableHours: Number(hours) || 0, items: rows.map((r) => ({ id: r.id, universeId: r.universeId || null, title: r.title, kind: r.kind, quarter: Number(r.quarter), start: r.start || null, end: r.end || null, hours: Number(r.hours) || 0, leadId: r.leadId || null })) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-plan', plan.id] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title="Audits in the plan" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || rows.some((r) => r.title.length < 3)}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <Field label="Audit team hours available"><Input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} className="max-w-32" /></Field>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Area</th><th>Audit</th><th>Kind</th><th>Q</th><th>Start</th><th>End</th><th>Hours</th><th>Lead</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? `new-${i}`}>
                <td><Select value={r.universeId} onChange={(e) => set(i, 'universeId', e.target.value)} className="min-w-32"><option value="">—</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</Select></td>
                <td><Input value={r.title} onChange={(e) => set(i, 'title', e.target.value)} className="min-w-48" /></td>
                <td><Select value={r.kind} onChange={(e) => set(i, 'kind', e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></td>
                <td><Select value={r.quarter} onChange={(e) => set(i, 'quarter', e.target.value)}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>{q}</option>)}</Select></td>
                <td><Input type="date" value={r.start} onChange={(e) => set(i, 'start', e.target.value)} /></td>
                <td><Input type="date" value={r.end} onChange={(e) => set(i, 'end', e.target.value)} /></td>
                <td><Input inputMode="numeric" value={r.hours} onChange={(e) => set(i, 'hours', e.target.value)} className="w-20" /></td>
                <td><Select value={r.leadId} onChange={(e) => set(i, 'leadId', e.target.value)}><option value="">—</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></td>
                <td><Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">✕</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button variant="secondary" onClick={() => setRows([...rows, { universeId: '', title: '', kind: 'ASSURANCE', quarter: '1', start: '', end: '', hours: '80', leadId: '' }])}>Add an audit</Button>
      <p className="text-xs text-muted">Cost is worked from the hours at the hourly rate in the module settings.</p>
    </Modal>
  );
}

function Decide({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (approve: boolean) => api.post(`/plans/${plan.id}/decide`, { approve, note: note || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-plan', plan.id] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`Decide on ${plan.title}`} footer={<><Button variant="secondary" onClick={() => decide.mutate(false)} disabled={decide.isPending || !note}>Send back</Button><Button onClick={() => decide.mutate(true)} disabled={decide.isPending}>Approve</Button></>}>
      <ErrorBox error={decide.error} />
      <Field label="Note (needed to send back)"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Approved by the audit committee at its meeting of …" /></Field>
    </Modal>
  );
}

function OpenEngagement({ plan, item, onClose }: { plan: Plan; item: Item; onClose: () => void }) {
  const router = useRouter();
  const staff = useDirectory('internalaudit');
  const programmes = useQuery({ queryKey: ['ia-programmes'], queryFn: () => api.get<{ id: string; name: string }[]>('/programmes') });
  const [f, setF] = useState({ leadId: item.leadId ?? '', team: [] as string[], programmeId: '', start: item.start?.slice(0, 10) ?? '', end: item.end?.slice(0, 10) ?? '' });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/engagements', { title: item.title, kind: item.kind, universeId: item.universeId, planId: plan.id, planItemId: item.id, leadId: f.leadId, team: f.team, programmeId: f.programmeId || null, start: f.start || null, end: f.end || null, budgetHours: item.hours }),
    onSuccess: (e) => router.push(`/internalaudit/engagements/${e.id}`),
  });
  return (
    <Modal open onClose={onClose} title={`Open engagement: ${item.title}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || !f.leadId}>Open</Button></>}>
      <ErrorBox error={create.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Lead auditor"><Select value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}><option value="">Choose</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <Field label="Audit programme"><Select value={f.programmeId} onChange={(e) => setF({ ...f, programmeId: e.target.value })}><option value="">None</option>{programmes.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Start"><Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="End"><Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
      </div>
      <Field label="Team">
        <div className="flex flex-wrap gap-3 text-sm">
          {staff.data?.filter((u) => u.id !== f.leadId).map((u) => (
            <label key={u.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.team.includes(u.id)} onChange={(e) => setF({ ...f, team: e.target.checked ? [...f.team, u.id] : f.team.filter((t) => t !== u.id) })} /> {u.name}</label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

export default function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const { data: me } = useMe();
  const [editing, setEditing] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [opening, setOpening] = useState<Item | null>(null);
  const { data: p, error, isLoading } = useQuery({ queryKey: ['ia-plan', id], queryFn: () => api.get<Plan>(`/plans/${id}`) });
  const submit = useMutation({ mutationFn: () => api.post(`/plans/${id}/submit`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ia-plan', id] }) });
  if (isLoading) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  const manage = can('internalaudit.plan.manage');
  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={<span className="flex items-center gap-2"><Badge value={p.status} /> {p.year}{p.version > 1 && ` · version ${p.version}`}{p.submittedAt && ` · submitted ${fmtDateTime(p.submittedAt)}`}</span>}
        actions={
          <>
            {manage && p.status === 'DRAFT' && <Button variant="secondary" onClick={() => setEditing(true)}>Edit audits</Button>}
            {manage && p.status === 'DRAFT' && <Button onClick={() => submit.mutate()} disabled={submit.isPending || !p.items.length}>Submit for approval</Button>}
            {can('internalaudit.plan.approve') && p.status === 'SUBMITTED' && p.preparedBy !== me?.id && <Button onClick={() => setDeciding(true)}>Approve or send back</Button>}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={submit.error} />
        {p.overCapacity && <Notice tone="amber">The plan needs {p.hours} hours but the team has {p.availableHours}.</Notice>}
        {p.decisionNote && <Notice tone={p.status === 'APPROVED' ? 'green' : 'amber'}>{p.status === 'APPROVED' ? 'Approved' : 'Sent back'} {p.decidedAt && fmtDate(p.decidedAt)}: {p.decisionNote}</Notice>}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Audits" value={p.items.length} />
        <Stat label="Hours" value={`${p.hours}${p.availableHours ? ` / ${p.availableHours}` : ''}`} tone={p.overCapacity ? 'warn' : undefined} />
        <Stat label="Cost (KES)" value={<Money value={p.cost} />} />
        <Stat label="Started" value={p.items.filter((i) => i.engagement).length} />
      </div>
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Q</th><th>Audit</th><th>Area</th><th>Risk</th><th>Kind</th><th>Dates</th><th className="num">Hours</th><th>Lead</th><th>Engagement</th></tr></thead>
            <tbody>
              {[...p.items].sort((a, b) => a.quarter - b.quarter).map((i) => (
                <tr key={i.id}>
                  <td>Q{i.quarter}</td>
                  <td>{i.title}</td>
                  <td>{i.area ? `${i.area.code} · ${i.area.name}` : '—'}</td>
                  <td><RatingBadge r={i.rating} /></td>
                  <td>{label(i.kind)}</td>
                  <td>{i.start ? `${fmtDate(i.start)} – ${fmtDate(i.end)}` : '—'}</td>
                  <td className="num">{i.hours}</td>
                  <td>{i.lead ?? '—'}</td>
                  <td>
                    {i.engagement ? <Link href={`/internalaudit/engagements/${i.engagement.id}`} className="text-brand-700 hover:underline">{i.engagement.number}</Link>
                      : p.status === 'APPROVED' && can('internalaudit.engagement.manage') ? <Button variant="secondary" onClick={() => setOpening(i)}>Open</Button> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <EditItems plan={p} onClose={() => setEditing(false)} />}
      {deciding && <Decide plan={p} onClose={() => setDeciding(false)} />}
      {opening && <OpenEngagement plan={p} item={opening} onClose={() => setOpening(null)} />}
    </>
  );
}
