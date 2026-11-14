'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, Select } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDateTime, label } from '@/lib/format';
import { useMe } from '@/lib/session';
import { api } from '@/modules/ict/ui/api';

interface Memo { id: string; number: string; kind: string; title: string; body: string; reference?: string; status: string; issuedBy: string; issuedByName: string; issuedAt?: string; approverId?: string | null; requiresAck: boolean; recalledReason?: string; recipients: { userId: string; name: string; readAt?: string; ackAt?: string; ackComment?: string }[]; minutes: { byName: string; toName?: string; text: string; at: string }[] }

export default function MemoPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const people = useDirectory();
  const { data: m, error, isLoading } = useQuery({ queryKey: ['circulars', id], queryFn: () => api.get<Memo>(`/circulars/${id}`) });
  const [f, setF] = useState({ comment: '', to: '', minute: '', reason: '' });
  const act = useMutation({ mutationFn: (x: { path: string; body?: object }) => api.post(`/circulars/${id}/${x.path}`, x.body ?? {}), onSuccess: () => { setF({ comment: '', to: '', minute: '', reason: '' }); qc.invalidateQueries({ queryKey: ['circulars'] }); } });
  if (isLoading || !m) return <><ErrorBox error={error} />{isLoading && <Loading />}</>;
  const mine = m.recipients.find((r) => r.userId === me?.id);
  const issuer = m.issuedBy === me?.id;
  return (
    <>
      <PageHeader title={`${m.number}: ${m.title}`} subtitle={<>{label(m.kind)} from {m.issuedByName}{m.issuedAt && ` · ${fmtDateTime(m.issuedAt)}`} <Badge value={m.status} /></>} />
      <ErrorBox error={act.error} />
      {m.status === 'RECALLED' && <Notice tone="amber">Recalled: {m.recalledReason}</Notice>}
      <Card>
        {m.reference && <p className="mb-2 text-xs text-muted">Ref: {m.reference}</p>}
        <div className="whitespace-pre-line text-sm">{m.body}</div>
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Action">
          {m.status === 'DRAFT' && issuer && <Button onClick={() => act.mutate({ path: 'send' })}>{m.approverId ? 'Send for approval' : 'Issue'}</Button>}
          {m.status === 'PENDING_APPROVAL' && m.approverId === me?.id && (
            <div className="flex flex-wrap gap-2"><Input placeholder="Comment" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} className="max-w-xs" /><Button onClick={() => act.mutate({ path: 'approve', body: { approve: true, comment: f.comment || undefined } })}>Approve and issue</Button><Button variant="secondary" onClick={() => act.mutate({ path: 'approve', body: { approve: false, comment: f.comment || undefined } })}>Return</Button></div>
          )}
          {m.status === 'ISSUED' && mine && (m.requiresAck ? (mine.ackAt ? <p className="text-sm text-muted">You acknowledged this {fmtDateTime(mine.ackAt)}.</p> : <div className="flex flex-wrap gap-2"><Input placeholder="Comment (optional)" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} className="max-w-xs" /><Button onClick={() => act.mutate({ path: 'acknowledge', body: { comment: f.comment || undefined } })}>Acknowledge</Button></div>) : <p className="text-sm text-muted">Read {fmtDateTime(mine.readAt ?? null)}.</p>)}
          {m.status === 'ISSUED' && (mine || issuer) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Field label="Minute to"><Select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">Choose</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              <Field label="Minute"><Input value={f.minute} onChange={(e) => setF({ ...f, minute: e.target.value })} placeholder="Please action" /></Field>
              <Button className="self-end" disabled={!f.to || f.minute.length < 2} onClick={() => act.mutate({ path: 'forward', body: { userId: f.to, minute: f.minute } })}>Send on</Button>
            </div>
          )}
          {m.status === 'ISSUED' && issuer && <div className="mt-3 flex gap-2"><Input placeholder="Reason to recall" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className="max-w-xs" /><Button variant="secondary" disabled={f.reason.length < 3} onClick={() => act.mutate({ path: 'recall', body: { reason: f.reason } })}>Recall</Button></div>}
          {m.minutes.length > 0 && <ul className="mt-3 space-y-1 text-sm">{m.minutes.map((x, i) => <li key={i}><b>{x.byName}</b>{x.toName && ` → ${x.toName}`}: {x.text} <span className="text-xs text-muted">{fmtDateTime(x.at)}</span></li>)}</ul>}
        </Card>
        {m.recipients.length > 1 && (
          <Card title={`Recipients (${m.recipients.filter((r) => r.readAt).length} of ${m.recipients.length} read)`} padded={false}>
            <table className="table-base"><thead><tr><th>Name</th><th>Read</th>{m.requiresAck && <th>Acknowledged</th>}</tr></thead>
              <tbody>{m.recipients.map((r) => <tr key={r.userId}><td>{r.name}</td><td className="text-xs">{r.readAt ? fmtDateTime(r.readAt) : '—'}</td>{m.requiresAck && <td className="text-xs">{r.ackAt ? `${fmtDateTime(r.ackAt)}${r.ackComment ? ` · ${r.ackComment}` : ''}` : '—'}</td>}</tr>)}</tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}
