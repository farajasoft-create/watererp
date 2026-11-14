'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';
import { EvidencePicker, Finding, RatingBadge, RATINGS } from '@/modules/internalaudit/ui/shared';

const OPEN = ['AGREED', 'IN_PROGRESS'];

function Section({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null;
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{k}</div>
      <p className="whitespace-pre-wrap text-sm">{v}</p>
    </div>
  );
}

/** The action owner's part: management's response before issue, then progress and evidence. */
function OwnerPanel({ f, refresh }: { f: Finding; refresh: () => void }) {
  const [r, setR] = useState({ accepted: 'true', response: f.response ?? '', action: f.action ?? '', dueDate: f.dueDate?.slice(0, 10) ?? '' });
  const [p, setP] = useState({ note: '', docs: [] as string[] });
  const respond = useMutation({ mutationFn: () => api.post(`/findings/${f.id}/respond`, { accepted: r.accepted === 'true', response: r.response, action: r.action || undefined, dueDate: r.dueDate || null }), onSuccess: refresh });
  const progress = useMutation({ mutationFn: (implemented: boolean) => api.post(`/findings/${f.id}/progress`, { note: p.note, implemented, documentIds: p.docs }), onSuccess: () => { setP({ note: '', docs: [] }); refresh(); } });
  if (f.status === 'DRAFT') {
    return (
      <Card title="Management's response">
        <ErrorBox error={respond.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Do you accept the finding?"><Select value={r.accepted} onChange={(e) => setR({ ...r, accepted: e.target.value })}><option value="true">Accepted</option><option value="false">Not accepted</option></Select></Field>
          {r.accepted === 'true' && <Field label="Will be done by"><Input type="date" value={r.dueDate} onChange={(e) => setR({ ...r, dueDate: e.target.value })} /></Field>}
          <Field label="Response" className="sm:col-span-2"><Textarea rows={3} value={r.response} onChange={(e) => setR({ ...r, response: e.target.value })} /></Field>
          {r.accepted === 'true' && <Field label="What you will do" className="sm:col-span-2"><Textarea rows={3} value={r.action} onChange={(e) => setR({ ...r, action: e.target.value })} /></Field>}
        </div>
        <div className="mt-2"><Button onClick={() => respond.mutate()} disabled={respond.isPending || r.response.length < 3}>Send response</Button></div>
      </Card>
    );
  }
  if (!OPEN.includes(f.status)) return null;
  return (
    <Card title="Report progress">
      <ErrorBox error={progress.error} />
      <Field label="What has been done"><Textarea rows={3} value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} /></Field>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <EvidencePicker label="Attach evidence" meta={{ access: 'RESTRICTED', category: 'AUDIT_EVIDENCE' }} onUploaded={(ids) => setP((x) => ({ ...x, docs: [...x.docs, ...ids] }))} />
        {p.docs.length > 0 && <span className="text-sm text-muted">{p.docs.length} file{p.docs.length === 1 ? '' : 's'} ready</span>}
        <Button variant="secondary" onClick={() => progress.mutate(false)} disabled={progress.isPending || p.note.length < 3}>Save progress</Button>
        <Button onClick={() => progress.mutate(true)} disabled={progress.isPending || p.note.length < 3}>It is done</Button>
      </div>
      <p className="mt-2 text-xs text-muted">Internal audit checks the evidence before closing the action. Files are seen only by you and the audit team.</p>
    </Card>
  );
}

/** The audit side: edit a draft finding, verify an implemented action, agree a new date. */
function AuditPanel({ f, refresh }: { f: Finding; refresh: () => void }) {
  const can = useCan();
  const people = useDirectory();
  const [e, setE] = useState({ title: f.title, rating: f.rating, condition: f.condition ?? '', criteria: f.criteria ?? '', cause: f.cause ?? '', effect: f.effect ?? '', recommendation: f.recommendation ?? '', ownerId: f.ownerId ?? '', dueDate: f.dueDate?.slice(0, 10) ?? '' });
  const [v, setV] = useState('');
  const [x, setX] = useState({ dueDate: '', reason: '' });
  const edit = useMutation({ mutationFn: () => api.patch(`/findings/${f.id}`, { ...e, ownerId: e.ownerId || null, dueDate: e.dueDate || null }), onSuccess: refresh });
  const verify = useMutation({ mutationFn: (verified: boolean) => api.post(`/findings/${f.id}/verify`, { verified, note: v }), onSuccess: () => { setV(''); refresh(); } });
  const extend = useMutation({ mutationFn: () => api.post(`/findings/${f.id}/extend`, x), onSuccess: () => { setX({ dueDate: '', reason: '' }); refresh(); } });
  const t = (k: keyof typeof e) => (ev: { target: { value: string } }) => setE({ ...e, [k]: ev.target.value });
  return (
    <>
      {f.status === 'DRAFT' && can('internalaudit.engagement.work') && (
        <Card title="Edit finding" actions={<Button onClick={() => edit.mutate()} disabled={edit.isPending}>Save</Button>}>
          <ErrorBox error={edit.error} />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Finding" className="sm:col-span-3"><Input value={e.title} onChange={t('title')} /></Field>
            <Field label="Rating"><Select value={e.rating} onChange={t('rating')}>{RATINGS.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}</Select></Field>
            <Field label="Condition" className="sm:col-span-2"><Textarea rows={3} value={e.condition} onChange={t('condition')} /></Field>
            <Field label="Criteria" className="sm:col-span-2"><Textarea rows={3} value={e.criteria} onChange={t('criteria')} /></Field>
            <Field label="Cause" className="sm:col-span-2"><Textarea rows={2} value={e.cause} onChange={t('cause')} /></Field>
            <Field label="Effect" className="sm:col-span-2"><Textarea rows={2} value={e.effect} onChange={t('effect')} /></Field>
            <Field label="Recommendation" className="sm:col-span-4"><Textarea rows={2} value={e.recommendation} onChange={t('recommendation')} /></Field>
            <Field label="Action owner" className="sm:col-span-2"><Select value={e.ownerId} onChange={t('ownerId')}><option value="">Not yet</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Due"><Input type="date" value={e.dueDate} onChange={t('dueDate')} /></Field>
          </div>
        </Card>
      )}
      {f.status === 'IMPLEMENTED' && (
        <Card title="Verify">
          <ErrorBox error={verify.error} />
          <Field label="What audit checked"><Textarea rows={2} value={v} onChange={(ev) => setV(ev.target.value)} /></Field>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => verify.mutate(true)} disabled={verify.isPending || v.length < 3}>Verified, close it</Button>
            <Button variant="secondary" onClick={() => verify.mutate(false)} disabled={verify.isPending || v.length < 3}>Not done yet</Button>
          </div>
        </Card>
      )}
      {OPEN.includes(f.status) && can('internalaudit.engagement.manage') && (
        <Card title="Agree a new due date">
          <ErrorBox error={extend.error} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Input type="date" value={x.dueDate} onChange={(ev) => setX({ ...x, dueDate: ev.target.value })} />
            <Input placeholder="Reason" value={x.reason} onChange={(ev) => setX({ ...x, reason: ev.target.value })} />
            <Button variant="secondary" onClick={() => extend.mutate()} disabled={!x.dueDate || x.reason.length < 3 || extend.isPending}>Agree</Button>
          </div>
        </Card>
      )}
    </>
  );
}

export default function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const { data: f, error, isLoading } = useQuery({ queryKey: ['ia-finding', id], queryFn: () => api.get<Finding>(`/findings/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ia-finding', id] });
  if (isLoading) return <Loading />;
  if (!f) return <ErrorBox error={error} />;
  const auditor = can('internalaudit.engagement.work');
  return (
    <>
      <PageHeader
        title={`${f.ref} · ${f.title}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={f.status} /> <RatingBadge r={f.rating} /> {f.engagement && (auditor ? <Link href={`/internalaudit/engagements/${f.engagement.id}`} className="text-brand-700 hover:underline">{f.engagement.number} {f.engagement.title}</Link> : `${f.engagement.number} ${f.engagement.title}`)}</span>}
      />
      {(f.daysOverdue ?? 0) > 0 && <div className="mb-4"><Notice tone="amber">{f.daysOverdue} days overdue (was due {fmtDate(f.dueDate ?? null)}).</Notice></div>}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Finding">
            <div className="space-y-3">
              <Section k="Condition" v={f.condition} />
              <Section k="Criteria" v={f.criteria} />
              <Section k="Cause" v={f.cause} />
              <Section k="Effect" v={f.effect} />
              <Section k="Recommendation" v={f.recommendation} />
            </div>
          </Card>
          {(f.response || f.action) && (
            <Card title="Management's response">
              <div className="space-y-3">
                <div className="text-sm">{f.accepted === false ? <Badge tone="red">not accepted</Badge> : <Badge tone="green">accepted</Badge>}</div>
                <Section k="Response" v={f.response} />
                <Section k="Agreed action" v={f.action} />
              </div>
            </Card>
          )}
          {f.isOwner && <OwnerPanel f={f} refresh={refresh} />}
          {auditor && !f.isOwner && <AuditPanel f={f} refresh={refresh} />}
          {!!f.updates?.length && (
            <Card title="Progress">
              <ol className="space-y-2 text-sm">
                {f.updates.map((u, i) => <li key={i}><span className="text-muted">{fmtDateTime(u.at)} · {u.byName} · {label(u.kind)}</span><div>{u.note}</div></li>)}
              </ol>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card title="Action">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-muted">Owner</dt><dd>{f.ownerName ?? '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Due</dt><dd>{f.dueDate ? fmtDate(f.dueDate) : '—'}</dd></div>
              {f.originalDueDate && f.originalDueDate !== f.dueDate && <div className="flex justify-between gap-2"><dt className="text-muted">Originally due</dt><dd>{fmtDate(f.originalDueDate)}</dd></div>}
              <div className="flex justify-between gap-2"><dt className="text-muted">Ageing</dt><dd>{f.band ?? '—'}</dd></div>
            </dl>
          </Card>
          <Card title="Evidence">
            {!f.documents?.length ? <p className="text-sm text-muted">None yet.</p> : (
              <ul className="space-y-1 text-sm">{f.documents.map((d) => <li key={d.id}><a href={`/api/v1/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{d.name}</a> <span className="text-xs text-muted">{fmtDateTime(d.createdAt)}</span></li>)}</ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
