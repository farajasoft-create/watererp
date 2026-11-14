'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { fmtDateTime, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/ict/ui/api';
import { PRIORITIES, Priority, PriorityBadge, Ticket } from '@/modules/ict/ui/shared';

const OPEN = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];
type Ask = { title: string; field: string; placeholder?: string; path: string; key: string; extra?: 'rating' | 'priority' };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

/** A modal that asks for one piece of text (a reason, a resolution) and posts it. */
function AskText({ ask, id, onClose }: { ask: Ask; id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rating, setRating] = useState(5);
  const [priority, setPriority] = useState<Priority>('HIGH');
  const send = useMutation({
    mutationFn: () => api.post(`/helpdesk/tickets/${id}/${ask.path}`, ask.extra === 'rating' ? { rating, feedback: text || undefined } : ask.extra === 'priority' ? { priority, reason: text } : { [ask.key]: text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-ticket', id] });
      qc.invalidateQueries({ queryKey: ['ict-mine'] });
      onClose();
    },
  });
  const optional = ask.extra === 'rating' || ask.key === 'reason' && ask.path === 'cancel';
  return (
    <Modal open onClose={onClose} title={ask.title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => send.mutate()} disabled={send.isPending || (!optional && text.trim().length < 3)}>Save</Button></>}>
      <ErrorBox error={send.error} />
      {ask.extra === 'rating' && (
        <Field label="How was the service?">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-label={`${n} out of 5`} onClick={() => setRating(n)} className={`h-9 w-9 rounded-md border text-sm font-medium ${n <= rating ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-line text-muted'}`}>
                {n}
              </button>
            ))}
          </div>
        </Field>
      )}
      {ask.extra === 'priority' && (
        <Field label="New priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
          </Select>
        </Field>
      )}
      <Field label={ask.field}><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={ask.placeholder} /></Field>
    </Modal>
  );
}

function Assign({ t, onClose }: { t: Ticket; onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ['ict-agents'], queryFn: () => api.get<{ id: string; name: string }[]>('/helpdesk/agents') });
  const [to, setTo] = useState(t.assignedTo ?? '');
  const save = useMutation({
    mutationFn: () => api.post(`/helpdesk/tickets/${t.id}/assign`, { assigneeId: to }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-ticket', t.id] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`Assign ${t.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!to || save.isPending}>Assign</Button></>}>
      <ErrorBox error={save.error} />
      <Field label="Officer">
        <Select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose</option>
          {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const { data: me } = useMe();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [reply, setReply] = useState({ body: '', internal: false });
  const { data: t, error, isLoading } = useQuery({ queryKey: ['ict-ticket', id], queryFn: () => api.get<Ticket>(`/helpdesk/tickets/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ict-ticket', id] });
    qc.invalidateQueries({ queryKey: ['ict-desk'] });
  };
  const act = useMutation({ mutationFn: (path: string) => api.post(`/helpdesk/tickets/${id}/${path}`), onSuccess: refresh });
  const take = useMutation({ mutationFn: () => api.post(`/helpdesk/tickets/${id}/assign`, { assigneeId: me?.id }), onSuccess: refresh });
  const comment = useMutation({
    mutationFn: () => api.post(`/helpdesk/tickets/${id}/comments`, reply),
    onSuccess: () => {
      setReply({ body: '', internal: false });
      refresh();
    },
  });

  if (isLoading) return <Loading />;
  if (!t) return <ErrorBox error={error} />;
  const agent = can('ict.helpdesk.work');
  const manager = can('ict.helpdesk.manage');
  const mine = me?.id === t.requesterId;
  const open = OPEN.includes(t.status);
  const canWork = agent && (!t.assignedTo || t.assignedTo === me?.id || manager);
  const done = ['CLOSED', 'CANCELLED'].includes(t.status);

  return (
    <>
      <PageHeader
        title={`${t.number} · ${t.subject}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={t.status} /> <PriorityBadge p={t.priority} /> {t.category}
            {t.overdue && <Badge tone="red">overdue</Badge>}
            {t.escalationLevel > 0 && <Badge tone="red">escalated {t.escalationLevel}</Badge>}
          </span>
        }
        actions={
          <>
            {agent && open && !t.assignedTo && <Button variant="secondary" onClick={() => take.mutate()} disabled={take.isPending}>Take it</Button>}
            {manager && open && <Button variant="secondary" onClick={() => setAssigning(true)}>Assign</Button>}
            {canWork && ['OPEN', 'ASSIGNED', 'REOPENED'].includes(t.status) && <Button onClick={() => act.mutate('start')} disabled={act.isPending}>Start work</Button>}
            {canWork && t.status === 'ON_HOLD' && <Button onClick={() => act.mutate('resume')} disabled={act.isPending}>Resume</Button>}
            {canWork && ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(t.status) && <Button variant="secondary" onClick={() => setAsk({ title: 'Put on hold', field: 'Waiting for what', placeholder: 'A spare part from the supplier', path: 'hold', key: 'reason' })}>Hold</Button>}
            {canWork && open && <Button variant="secondary" onClick={() => setAsk({ title: 'Change priority', field: 'Why', path: 'priority', key: 'reason', extra: 'priority' })}>Priority</Button>}
            {canWork && open && <Button onClick={() => setAsk({ title: `Resolve ${t.number}`, field: 'What was done', placeholder: 'Replaced the toner and cleared the paper path', path: 'resolve', key: 'resolution' })}>Resolve</Button>}
            {mine && t.status === 'RESOLVED' && <Button onClick={() => setAsk({ title: 'Confirm it is fixed', field: 'Comment (optional)', path: 'confirm', key: 'feedback', extra: 'rating' })}>Confirm fixed</Button>}
            {(mine || agent) && ['RESOLVED', 'CLOSED'].includes(t.status) && <Button variant="secondary" onClick={() => setAsk({ title: 'Reopen', field: 'What is still wrong', path: 'reopen', key: 'reason' })}>Reopen</Button>}
            {(mine || manager) && ['OPEN', 'ASSIGNED'].includes(t.status) && <Button variant="secondary" onClick={() => setAsk({ title: 'Withdraw the request', field: 'Why (optional)', path: 'cancel', key: 'reason' })}>Withdraw</Button>}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={act.error || take.error} />
        {mine && t.status === 'RESOLVED' && <Notice tone="amber">The help desk says this is fixed. Confirm it and rate the service, or reopen it if not. It closes by itself after a few days without a reply.</Notice>}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Request">
            <p className="whitespace-pre-wrap text-sm">{t.description || <span className="text-muted">No details given.</span>}</p>
            {t.resolution && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                <b>Resolution:</b> {t.resolution}
                {t.rating && <div className="mt-1">Rated {t.rating}/5{t.feedback ? `: ${t.feedback}` : ''}</div>}
              </div>
            )}
          </Card>
          <Card title="Conversation">
            <div className="space-y-3">
              {!t.comments?.length && <p className="text-sm text-muted">No messages yet.</p>}
              {t.comments?.map((c) => (
                <div key={c.id} className={`rounded-md border p-3 text-sm ${c.internal ? 'border-amber-200 bg-amber-50' : 'border-line'}`}>
                  <div className="mb-1 text-xs text-muted">{c.byName} · {fmtDateTime(c.at)}{c.internal && ' · internal note'}</div>
                  <div className="whitespace-pre-wrap">{c.body}</div>
                </div>
              ))}
              {!done && (
                <div className="space-y-2">
                  <ErrorBox error={comment.error} />
                  <Textarea rows={3} value={reply.body} onChange={(e) => setReply({ ...reply, body: e.target.value })} placeholder={agent && !mine ? 'Reply to the requester, or add an internal note' : 'Add information or ask a question'} />
                  <div className="flex items-center justify-between gap-3">
                    {agent ? (
                      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={reply.internal} onChange={(e) => setReply({ ...reply, internal: e.target.checked })} /> Internal note (the requester does not see it)</label>
                    ) : <span />}
                    <Button onClick={() => comment.mutate()} disabled={!reply.body.trim() || comment.isPending}>Send</Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
          {agent && t.history && (
            <Card title="History">
              <ol className="space-y-1.5 text-sm">
                {t.history.map((h, i) => (
                  <li key={i}><span className="text-muted">{fmtDateTime(h.at)}</span> · <b>{label(h.action)}</b> by {h.byName ?? 'System'}{h.note && <> · {h.note}</>}</li>
                ))}
              </ol>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card title="Details">
            <Row k="Requester" v={t.requesterName} />
            {t.department && <Row k="Department" v={t.department} />}
            {t.location && <Row k="Location" v={t.location} />}
            {t.phone && <Row k="Phone" v={t.phone} />}
            <Row k="Received by" v={label(t.channel)} />
            <Row k="Raised" v={fmtDateTime(t.createdAt)} />
            <Row k="Officer" v={t.assignedName ?? 'Not yet assigned'} />
            <Row k="Respond by" v={<>{fmtDateTime(t.respondBy)}{t.firstResponseAt && <div className="text-xs text-muted">responded {fmtDateTime(t.firstResponseAt)}</div>}</>} />
            <Row k="Resolve by" v={fmtDateTime(t.resolveBy)} />
            {t.resolvedAt && <Row k="Resolved" v={fmtDateTime(t.resolvedAt)} />}
            {t.closedAt && <Row k="Closed" v={fmtDateTime(t.closedAt)} />}
            {t.assetTag && <Row k="Asset" v={t.assetTag} />}
          </Card>
          {!!t.related?.length && (
            <Card title={`Other tickets for ${t.assetTag}`}>
              <ul className="space-y-1 text-sm">
                {t.related.map((r) => (
                  <li key={r.id}><Link href={`/ict/tickets/${r.id}`} className="text-brand-700 hover:underline">{r.number}</Link> {r.subject} <Badge value={r.status} /></li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      {ask && <AskText ask={ask} id={t.id} onClose={() => setAsk(null)} />}
      {assigning && <Assign t={t} onClose={() => setAssigning(false)} />}
    </>
  );
}
