'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';

interface Row { id: string; number: string; title: string; kind: string; area?: string; status: string; start?: string; end?: string; lead: string; hours: number; budgetHours: number; findings: number; restricted: boolean; report?: { status: string } }
const KINDS = ['ASSURANCE', 'CONSULTING', 'INVESTIGATION', 'FOLLOW_UP', 'SPECIAL'];
const STATUSES = ['PLANNING', 'FIELDWORK', 'REPORTING', 'ISSUED', 'CLOSED', 'CANCELLED'];

/** An engagement outside the plan: an investigation, special review or consulting request. */
function NewEngagement({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const staff = useDirectory('internalaudit');
  const areas = useQuery({ queryKey: ['ia-universe'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/universe') });
  const programmes = useQuery({ queryKey: ['ia-programmes'], queryFn: () => api.get<{ id: string; name: string }[]>('/programmes') });
  const [f, setF] = useState({ title: '', kind: 'SPECIAL', universeId: '', objectives: '', scope: '', start: '', end: '', leadId: '', team: [] as string[], restricted: false, budgetHours: '', programmeId: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/engagements', { ...f, universeId: f.universeId || null, programmeId: f.programmeId || null, start: f.start || null, end: f.end || null, objectives: f.objectives || undefined, scope: f.scope || undefined, budgetHours: Number(f.budgetHours) || 0 }),
    onSuccess: (e) => router.push(`/internalaudit/engagements/${e.id}`),
  });
  return (
    <Modal open wide onClose={onClose} title="New engagement (outside the plan)" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || f.title.length < 3 || !f.leadId}>Open</Button></>}>
      <ErrorBox error={create.error} />
      <p className="text-sm text-muted">Planned audits are opened from the approved annual plan.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
        <Field label="Area"><Select value={f.universeId} onChange={(e) => setF({ ...f, universeId: e.target.value })}><option value="">—</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label="Programme"><Select value={f.programmeId} onChange={(e) => setF({ ...f, programmeId: e.target.value })}><option value="">None</option>{programmes.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Budget hours"><Input inputMode="numeric" value={f.budgetHours} onChange={(e) => setF({ ...f, budgetHours: e.target.value })} /></Field>
        <Field label="Start"><Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="End"><Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
        <Field label="Lead auditor"><Select value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}><option value="">Choose</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <Field label="Objectives" className="sm:col-span-3"><Textarea rows={2} value={f.objectives} onChange={(e) => setF({ ...f, objectives: e.target.value })} /></Field>
        <Field label="Scope" className="sm:col-span-3"><Textarea rows={2} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></Field>
      </div>
      <Field label="Team">
        <div className="flex flex-wrap gap-3 text-sm">
          {staff.data?.filter((u) => u.id !== f.leadId).map((u) => (
            <label key={u.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.team.includes(u.id)} onChange={(e) => setF({ ...f, team: e.target.checked ? [...f.team, u.id] : f.team.filter((t) => t !== u.id) })} /> {u.name}</label>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.restricted || f.kind === 'INVESTIGATION'} disabled={f.kind === 'INVESTIGATION'} onChange={(e) => setF({ ...f, restricted: e.target.checked })} /> Restricted: only the team and audit managers can see it (always for investigations)</label>
    </Modal>
  );
}

export default function EngagementsPage() {
  const can = useCan();
  const [q, setQ] = useState({ status: '', mine: false });
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['ia-engagements', q], queryFn: () => api.get<Row[]>('/engagements', { ...(q.status && { status: q.status }), ...(q.mine && { mine: true }) }) });
  return (
    <>
      <PageHeader title="Engagements" subtitle="Audits, reviews and investigations from planning to close" actions={can('internalaudit.engagement.manage') && <Button onClick={() => setCreating(true)}>New engagement</Button>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <Select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })} className="max-w-44"><option value="">Any stage</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={q.mine} onChange={(e) => setQ({ ...q, mine: e.target.checked })} /> Only mine</label>
        </div>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No engagements.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Number</th><th>Engagement</th><th>Kind</th><th>Stage</th><th>Report</th><th>Lead</th><th>Dates</th><th className="num">Hours</th><th className="num">Findings</th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/internalaudit/engagements/${e.id}`} className="font-medium text-brand-700 hover:underline">{e.number}</Link></td>
                    <td>{e.title}{e.restricted && <> <Badge tone="gray">restricted</Badge></>}<div className="text-xs text-muted">{e.area}</div></td>
                    <td>{label(e.kind)}</td>
                    <td><Badge value={e.status} /></td>
                    <td>{e.report?.status && e.report.status !== 'NONE' ? <Badge value={e.report.status} /> : '—'}</td>
                    <td>{e.lead}</td>
                    <td>{e.start ? `${fmtDate(e.start)} – ${fmtDate(e.end ?? null)}` : '—'}</td>
                    <td className="num">{e.hours}{e.budgetHours ? ` / ${e.budgetHours}` : ''}</td>
                    <td className="num">{e.findings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewEngagement onClose={() => setCreating(false)} />}
    </>
  );
}
