'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Stat, Tabs, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label, today } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';
import { Finding, RatingBadge, RATINGS } from '@/modules/internalaudit/ui/shared';

interface Engagement {
  id: string;
  number: string;
  title: string;
  kind: string;
  area?: string;
  status: string;
  objectives?: string;
  scope?: string;
  start?: string;
  end?: string;
  leadId: string;
  lead: string;
  team: string[];
  teamMembers: { id: string; name: string; email: string }[];
  restricted: boolean;
  budgetHours: number;
  tasks: { id: string; title: string; assigneeId: string; assignee: string; due?: string; done: boolean }[];
  workpapers: { id: string; ref: string; title: string; status: string; confidential: boolean; preparedByName?: string; reviewedByName?: string; version: number; hidden?: boolean }[];
  findings: Finding[];
  time: { id: string; userName: string; date: string; hours: number; activity: string; note?: string }[];
  costs: { id: string; date: string; description: string; amount: string }[];
  totals: { hours: number; budgetHours: number; timeCost: string; otherCosts: string; cost: string; hoursUsedPct: number | null };
  report: { status: string; summary?: string; conclusion?: string; opinion?: string; draftedAt?: string; reviewedAt?: string; approvedAt?: string; issuedAt?: string; returnNote?: string; draftedBy?: string; reviewedBy?: string };
  canWork: boolean;
}
type Tab = 'overview' | 'papers' | 'findings' | 'time' | 'report' | 'log';

function Overview({ e, refresh }: { e: Engagement; refresh: () => void }) {
  const can = useCan();
  const { data: me } = useMe();
  const lead = me?.id === e.leadId || can('internalaudit.engagement.manage');
  const [task, setTask] = useState({ title: '', assigneeId: '', due: '' });
  const add = useMutation({ mutationFn: () => api.post(`/engagements/${e.id}/tasks`, { ...task, due: task.due || null }), onSuccess: () => { setTask({ title: '', assigneeId: '', due: '' }); refresh(); } });
  const tick = useMutation({ mutationFn: (t: { id: string; done: boolean }) => api.post(`/engagements/${e.id}/tasks/${t.id}`, { done: t.done }), onSuccess: refresh });
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card title="Objectives and scope">
          <div className="space-y-3 text-sm">
            <div><div className="font-medium">Objectives</div><p className="whitespace-pre-wrap text-muted">{e.objectives || '—'}</p></div>
            <div><div className="font-medium">Scope</div><p className="whitespace-pre-wrap text-muted">{e.scope || '—'}</p></div>
          </div>
        </Card>
        <Card padded={false} title="Tasks">
          <ErrorBox error={add.error || tick.error} />
          {!e.tasks.length ? <Empty>No tasks handed out.</Empty> : (
            <table className="table-base">
              <thead><tr><th /><th>Task</th><th>Who</th><th>Due</th></tr></thead>
              <tbody>
                {e.tasks.map((t) => (
                  <tr key={t.id} className={t.done ? 'text-muted line-through' : ''}>
                    <td><input type="checkbox" checked={t.done} disabled={!e.canWork} onChange={(x) => tick.mutate({ id: t.id, done: x.target.checked })} aria-label="Done" /></td>
                    <td>{t.title}</td>
                    <td>{t.assignee}</td>
                    <td>{t.due ? fmtDate(t.due) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {lead && e.canWork && (
            <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-4">
              <Input placeholder="New task" value={task.title} onChange={(x) => setTask({ ...task, title: x.target.value })} className="sm:col-span-2" />
              <Select value={task.assigneeId} onChange={(x) => setTask({ ...task, assigneeId: x.target.value })}><option value="">Who</option>{e.teamMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
              <div className="flex gap-2"><Input type="date" value={task.due} onChange={(x) => setTask({ ...task, due: x.target.value })} /><Button onClick={() => add.mutate()} disabled={!task.title || !task.assigneeId || add.isPending}>Add</Button></div>
            </div>
          )}
        </Card>
      </div>
      <Card title="Team">
        <ul className="space-y-1 text-sm">
          {e.teamMembers.map((m) => <li key={m.id}>{m.name}{m.id === e.leadId && <> <Badge tone="blue">lead</Badge></>}</li>)}
        </ul>
        {e.restricted && <p className="mt-3 text-xs text-muted">Restricted: only the team, audit managers and the head can see this engagement.</p>}
      </Card>
    </div>
  );
}

function Papers({ e, refresh }: { e: Engagement; refresh: () => void }) {
  const [f, setF] = useState({ ref: '', title: '', confidential: false });
  const add = useMutation({ mutationFn: () => api.post(`/engagements/${e.id}/workpapers`, f), onSuccess: () => { setF({ ref: '', title: '', confidential: false }); refresh(); } });
  const open = !['ISSUED', 'CLOSED', 'CANCELLED'].includes(e.status);
  return (
    <Card padded={false} title="Working papers">
      {!e.workpapers.length ? <Empty>No working papers.</Empty> : (
        <table className="table-base">
          <thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Prepared by</th><th>Reviewed by</th><th className="num">Version</th></tr></thead>
          <tbody>
            {e.workpapers.map((w) => (
              <tr key={w.id}>
                <td>{w.hidden ? w.ref : <Link href={`/internalaudit/workpapers/${w.id}`} className="font-medium text-brand-700 hover:underline">{w.ref}</Link>}</td>
                <td>{w.title}{w.confidential && <> <Badge tone="gray">confidential</Badge></>}</td>
                <td><Badge value={w.status} /></td>
                <td>{w.preparedByName ?? '—'}</td>
                <td>{w.reviewedByName ?? '—'}</td>
                <td className="num">{w.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-4">
          <ErrorBox error={add.error} />
          <Input placeholder="Ref (WP-05)" value={f.ref} onChange={(x) => setF({ ...f, ref: x.target.value.toUpperCase() })} />
          <Input placeholder="Title" value={f.title} onChange={(x) => setF({ ...f, title: x.target.value })} className="sm:col-span-2" />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.confidential} onChange={(x) => setF({ ...f, confidential: x.target.checked })} /> Confidential</label>
            <Button onClick={() => add.mutate()} disabled={!f.ref || f.title.length < 2 || add.isPending}>Add</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function FindingForm({ e, onClose }: { e: Engagement; onClose: () => void }) {
  const people = useDirectory();
  const [f, setF] = useState({ ref: `F-${String(e.findings.length + 1).padStart(2, '0')}`, title: '', condition: '', criteria: '', cause: '', effect: '', rating: 'MEDIUM', recommendation: '', ownerId: '', dueDate: '', workpaperId: '' });
  const save = useMutation({
    mutationFn: () => api.post(`/engagements/${e.id}/findings`, { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? undefined : v])), ownerId: f.ownerId || null, workpaperId: f.workpaperId || null, dueDate: f.dueDate || null }),
    onSuccess: onClose,
  });
  const t = (k: keyof typeof f) => (x: { target: { value: string } }) => setF({ ...f, [k]: x.target.value });
  return (
    <Modal open wide onClose={onClose} title="New finding" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 3 || !f.ref}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Ref"><Input value={f.ref} onChange={t('ref')} /></Field>
        <Field label="Finding" className="sm:col-span-2"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Risk rating"><Select value={f.rating} onChange={t('rating')}>{RATINGS.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}</Select></Field>
        <Field label="Condition (what we found)" className="sm:col-span-2"><Textarea rows={3} value={f.condition} onChange={t('condition')} /></Field>
        <Field label="Criteria (what should be)" className="sm:col-span-2"><Textarea rows={3} value={f.criteria} onChange={t('criteria')} /></Field>
        <Field label="Cause" className="sm:col-span-2"><Textarea rows={2} value={f.cause} onChange={t('cause')} /></Field>
        <Field label="Effect (risk or impact)" className="sm:col-span-2"><Textarea rows={2} value={f.effect} onChange={t('effect')} /></Field>
        <Field label="Recommendation" className="sm:col-span-4"><Textarea rows={2} value={f.recommendation} onChange={t('recommendation')} /></Field>
        <Field label="Action owner (management)" className="sm:col-span-2"><Select value={f.ownerId} onChange={t('ownerId')}><option value="">Not yet</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Working paper"><Select value={f.workpaperId} onChange={t('workpaperId')}><option value="">—</option>{e.workpapers.map((w) => <option key={w.id} value={w.id}>{w.ref}</option>)}</Select></Field>
        <Field label="Due (if agreed)"><Input type="date" value={f.dueDate} onChange={t('dueDate')} /></Field>
      </div>
      <p className="text-xs text-muted">The owner is asked for management&apos;s response and an action plan.</p>
    </Modal>
  );
}

function Findings({ e, refresh }: { e: Engagement; refresh: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card padded={false} title="Findings" actions={e.canWork && ['FIELDWORK', 'REPORTING'].includes(e.status) && <Button onClick={() => setAdding(true)}>Add finding</Button>}>
      {!e.findings.length ? <Empty>No findings.</Empty> : (
        <table className="table-base">
          <thead><tr><th>Ref</th><th>Finding</th><th>Rating</th><th>Owner</th><th>Response</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>
            {e.findings.map((f) => (
              <tr key={f.id}>
                <td><Link href={`/internalaudit/findings/${f.id}`} className="font-medium text-brand-700 hover:underline">{f.ref}</Link></td>
                <td>{f.title}</td>
                <td><RatingBadge r={f.rating} /></td>
                <td>{f.ownerName ?? '—'}</td>
                <td>{f.accepted === true ? 'Accepted' : f.accepted === false ? 'Not accepted' : 'Awaited'}</td>
                <td>{f.dueDate ? fmtDate(f.dueDate) : '—'}</td>
                <td><Badge value={f.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && <FindingForm e={e} onClose={() => { setAdding(false); refresh(); }} />}
    </Card>
  );
}

function Time({ e, refresh }: { e: Engagement; refresh: () => void }) {
  const { data: me } = useMe();
  const can = useCan();
  const [t, setT] = useState({ date: today(), hours: '', activity: 'FIELDWORK', note: '' });
  const [c, setC] = useState({ date: today(), description: '', amount: '' });
  const log = useMutation({ mutationFn: () => api.post(`/engagements/${e.id}/time`, { ...t, hours: Number(t.hours), note: t.note || undefined }), onSuccess: () => { setT({ ...t, hours: '', note: '' }); refresh(); } });
  const cost = useMutation({ mutationFn: () => api.post(`/engagements/${e.id}/costs`, c), onSuccess: () => { setC({ ...c, description: '', amount: '' }); refresh(); } });
  const onTeam = e.team.includes(me?.id ?? '');
  const lead = me?.id === e.leadId || can('internalaudit.engagement.manage');
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Hours" value={`${e.totals.hours}${e.totals.budgetHours ? ` / ${e.totals.budgetHours}` : ''}`} hint={e.totals.hoursUsedPct != null ? `${e.totals.hoursUsedPct}% of budget` : undefined} tone={e.totals.hoursUsedPct != null && e.totals.hoursUsedPct > 100 ? 'bad' : undefined} />
        <Stat label="Time cost (KES)" value={<Money value={e.totals.timeCost} />} />
        <Stat label="Other costs (KES)" value={<Money value={e.totals.otherCosts} />} />
        <Stat label="Engagement cost (KES)" value={<Money value={e.totals.cost} />} />
      </div>
      <Card padded={false} title="Time">
        <ErrorBox error={log.error} />
        {onTeam && (
          <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-5">
            <Input type="date" value={t.date} onChange={(x) => setT({ ...t, date: x.target.value })} />
            <Input inputMode="decimal" placeholder="Hours" value={t.hours} onChange={(x) => setT({ ...t, hours: x.target.value })} />
            <Select value={t.activity} onChange={(x) => setT({ ...t, activity: x.target.value })}>{['PLANNING', 'FIELDWORK', 'REVIEW', 'REPORTING', 'FOLLOW_UP', 'TRAVEL'].map((a) => <option key={a} value={a}>{label(a)}</option>)}</Select>
            <Input placeholder="Note" value={t.note} onChange={(x) => setT({ ...t, note: x.target.value })} />
            <Button onClick={() => log.mutate()} disabled={!Number(t.hours) || log.isPending}>Log time</Button>
          </div>
        )}
        {!e.time.length ? <Empty>No time logged.</Empty> : (
          <table className="table-base"><thead><tr><th>Date</th><th>Who</th><th>Activity</th><th className="num">Hours</th><th>Note</th></tr></thead>
            <tbody>{e.time.map((x) => <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{x.userName}</td><td>{label(x.activity)}</td><td className="num">{x.hours}</td><td>{x.note}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card padded={false} title="Other costs">
        <ErrorBox error={cost.error} />
        {lead && (
          <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-4">
            <Input type="date" value={c.date} onChange={(x) => setC({ ...c, date: x.target.value })} />
            <Input placeholder="Travel, allowances…" value={c.description} onChange={(x) => setC({ ...c, description: x.target.value })} />
            <Input inputMode="decimal" placeholder="Amount" value={c.amount} onChange={(x) => setC({ ...c, amount: x.target.value })} />
            <Button onClick={() => cost.mutate()} disabled={!Number(c.amount) || c.description.length < 2 || cost.isPending}>Add cost</Button>
          </div>
        )}
        {!e.costs.length ? <Empty>No other costs.</Empty> : (
          <table className="table-base"><thead><tr><th>Date</th><th>Description</th><th className="num">KES</th></tr></thead>
            <tbody>{e.costs.map((x) => <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{x.description}</td><td className="num"><Money value={x.amount} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Report({ e, refresh }: { e: Engagement; refresh: () => void }) {
  const can = useCan();
  const { data: me } = useMe();
  const r = e.report ?? { status: 'NONE' };
  const [f, setF] = useState({ summary: r.summary ?? '', conclusion: r.conclusion ?? '', opinion: r.opinion ?? 'NEEDS_IMPROVEMENT' });
  const [note, setNote] = useState('');
  const save = useMutation({ mutationFn: () => api.put(`/engagements/${e.id}/report`, f), onSuccess: refresh });
  const step = useMutation({ mutationFn: (action: string) => api.post(`/engagements/${e.id}/report/${action}`, { note: note || undefined }), onSuccess: () => { setNote(''); refresh(); } });
  const editable = e.canWork && e.status === 'REPORTING' && ['NONE', 'DRAFT'].includes(r.status);
  const own = r.draftedBy === me?.id;
  return (
    <div className="space-y-5">
      <Card title="Sign-off" actions={r.status !== 'NONE' && (
        <>
          <a href={`/api/v1/internalaudit/engagements/${e.id}/report.pdf`} className="text-sm text-brand-700 hover:underline">PDF</a>
          <a href={`/api/v1/internalaudit/engagements/${e.id}/report.doc`} className="text-sm text-brand-700 hover:underline">Word</a>
          <a href={`/api/v1/internalaudit/engagements/${e.id}/report.pptx`} className="text-sm text-brand-700 hover:underline">PowerPoint</a>
        </>
      )}>
        <ol className="grid gap-2 text-sm sm:grid-cols-4">
          {[['Drafted', r.draftedAt], ['Reviewed (audit manager)', r.reviewedAt], ['Approved (head of audit)', r.approvedAt], ['Issued to management', r.issuedAt]].map(([k, at]) => (
            <li key={k} className={`rounded-md border p-2 ${at ? 'border-emerald-200 bg-emerald-50' : 'border-line'}`}><div className="font-medium">{k}</div><div className="text-xs text-muted">{at ? fmtDateTime(at) : 'Not yet'}</div></li>
          ))}
        </ol>
        {r.returnNote && <div className="mt-3"><Notice tone="amber">Sent back: {r.returnNote}</Notice></div>}
        <ErrorBox error={step.error} />
        {r.status !== 'NONE' && r.status !== 'ISSUED' && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Note"><Input value={note} onChange={(x) => setNote(x.target.value)} className="min-w-64" /></Field>
            {r.status === 'DRAFT' && can('internalaudit.engagement.manage') && !own && <Button onClick={() => step.mutate('review')}>Reviewed</Button>}
            {r.status === 'REVIEWED' && can('internalaudit.report.approve') && !own && r.reviewedBy !== me?.id && <Button onClick={() => step.mutate('approve')}>Approve</Button>}
            {r.status === 'APPROVED' && can('internalaudit.report.approve') && <Button onClick={() => step.mutate('issue')}>Issue to management</Button>}
            {can('internalaudit.engagement.manage') && <Button variant="secondary" onClick={() => step.mutate('return')} disabled={!note}>Send back</Button>}
          </div>
        )}
      </Card>
      <Card title="Report" actions={editable && <Button onClick={() => save.mutate()} disabled={save.isPending || f.summary.length < 10 || f.conclusion.length < 3}>Save draft</Button>}>
        <ErrorBox error={save.error} />
        {e.status !== 'REPORTING' && r.status === 'NONE' && <Notice>Move the engagement to reporting (every working paper reviewed) to draft the report.</Notice>}
        <div className="grid gap-3">
          <Field label="Executive summary"><Textarea rows={6} value={f.summary} onChange={(x) => setF({ ...f, summary: x.target.value })} disabled={!editable} /></Field>
          <Field label="Overall opinion">
            <Select value={f.opinion} onChange={(x) => setF({ ...f, opinion: x.target.value })} disabled={!editable}>
              <option value="SATISFACTORY">Satisfactory</option>
              <option value="NEEDS_IMPROVEMENT">Needs improvement</option>
              <option value="UNSATISFACTORY">Unsatisfactory</option>
            </Select>
          </Field>
          <Field label="Conclusion"><Textarea rows={3} value={f.conclusion} onChange={(x) => setF({ ...f, conclusion: x.target.value })} disabled={!editable} /></Field>
        </div>
        <p className="mt-2 text-xs text-muted">The findings, their management responses and agreed actions are added to the report from the Findings tab.</p>
      </Card>
    </div>
  );
}

function AccessLog({ id }: { id: string }) {
  const { data, error, isLoading } = useQuery({ queryKey: ['ia-access', id], queryFn: () => api.get<{ at: string; who: string; action: string; what: string; kind: string; ip: string }[]>(`/engagements/${id}/access-log`) });
  return (
    <Card padded={false} title="Who opened, changed or approved what">
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing yet.</Empty> : (
        <table className="table-base">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Action</th><th>IP</th></tr></thead>
          <tbody>{data.map((r, i) => <tr key={i}><td>{fmtDateTime(r.at)}</td><td>{r.who}</td><td>{r.what}</td><td>{r.kind === 'VIEW' ? <Badge tone="gray">{r.action}</Badge> : r.action}</td><td className="text-xs text-muted">{r.ip}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

export default function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('overview');
  const { data: e, error, isLoading } = useQuery({ queryKey: ['ia-engagement', id], queryFn: () => api.get<Engagement>(`/engagements/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ia-engagement', id] });
  const move = useMutation({ mutationFn: (status: string) => api.post(`/engagements/${id}/status`, { status }), onSuccess: refresh });
  if (isLoading) return <Loading />;
  if (!e) return <ErrorBox error={error} />;
  const manager = can('internalaudit.engagement.manage');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...(e.canWork ? [{ id: 'papers' as Tab, label: `Working papers (${e.workpapers.length})` }] : []),
    { id: 'findings', label: `Findings (${e.findings.length})` },
    ...(e.canWork ? [{ id: 'time' as Tab, label: 'Time and costs' }] : []),
    { id: 'report', label: 'Report' },
    ...(manager ? [{ id: 'log' as Tab, label: 'Access log' }] : []),
  ];
  return (
    <>
      <PageHeader
        title={`${e.number} · ${e.title}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={e.status} /> {label(e.kind)} {e.area && `· ${e.area}`} · lead {e.lead} {e.start && `· ${fmtDate(e.start)} – ${fmtDate(e.end ?? null)}`}</span>}
        actions={e.canWork && (
          <>
            {e.status === 'PLANNING' && <Button onClick={() => move.mutate('FIELDWORK')}>Start fieldwork</Button>}
            {e.status === 'FIELDWORK' && <Button onClick={() => move.mutate('REPORTING')}>Move to reporting</Button>}
            {e.status === 'REPORTING' && e.report?.status === 'DRAFT' && <Button variant="secondary" onClick={() => move.mutate('FIELDWORK')}>Back to fieldwork</Button>}
            {manager && e.status === 'ISSUED' && <Button variant="secondary" onClick={() => move.mutate('CLOSED')}>Close</Button>}
            {manager && ['PLANNING', 'FIELDWORK'].includes(e.status) && <Button variant="secondary" onClick={() => move.mutate('CANCELLED')}>Cancel</Button>}
          </>
        )}
      />
      <ErrorBox error={move.error} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview e={e} refresh={refresh} />}
      {tab === 'papers' && <Papers e={e} refresh={refresh} />}
      {tab === 'findings' && <Findings e={e} refresh={refresh} />}
      {tab === 'time' && <Time e={e} refresh={refresh} />}
      {tab === 'report' && <Report e={e} refresh={refresh} />}
      {tab === 'log' && <AccessLog id={e.id} />}
    </>
  );
}
