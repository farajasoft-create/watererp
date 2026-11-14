'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDateTime, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/ict/ui/api';

interface Row { id: string; number: string; kind: string; title: string; status: string; issuedByName: string; issuedAt?: string; createdAt: string; requiresAck: boolean; total: number; read: number; acknowledged: number; mine: { readAt: string | null; ackAt: string | null } | null }

function Compose({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const people = useDirectory();
  const { data: me } = useMe();
  const [f, setF] = useState({ kind: 'MEMO', title: '', body: '', reference: '', audience: 'ALL', audienceUserIds: [] as string[], audienceModule: '', approverId: '', requiresAck: false });
  const save = useMutation({
    mutationFn: async (send: boolean) => {
      const c = await api.post<{ id: string }>('/circulars', { ...f, reference: f.reference || undefined, audienceModule: f.audienceModule || undefined, approverId: f.approverId || null });
      if (send) await api.post(`/circulars/${c.id}/send`);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['circulars'] }); onClose(); },
  });
  const t = (k: 'title' | 'body' | 'reference' | 'kind' | 'audience' | 'audienceModule' | 'approverId') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title="New memo or notice" footer={<><Button variant="secondary" onClick={() => save.mutate(false)} disabled={save.isPending || f.title.length < 3}>Save draft</Button><Button onClick={() => save.mutate(true)} disabled={save.isPending || f.title.length < 3 || f.body.length < 3}>{f.approverId ? 'Send for approval' : 'Issue'}</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Kind"><Select value={f.kind} onChange={t('kind')}><option value="MEMO">Memo</option><option value="NOTICE">Notice</option><option value="CIRCULAR">Circular</option></Select></Field>
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Our reference"><Input value={f.reference} onChange={t('reference')} /></Field>
        <Field label="To"><Select value={f.audience} onChange={t('audience')}><option value="ALL">All staff</option><option value="USERS">Named people</option><option value="MODULE">Users of a module</option></Select></Field>
        {f.audience === 'MODULE' && <Field label="Module"><Select value={f.audienceModule} onChange={t('audienceModule')}><option value="">Choose</option>{me?.modules?.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>}
        <Field label="Approved by (optional)"><Select value={f.approverId} onChange={t('approverId')}><option value="">No approval needed</option>{people.data?.filter((p) => p.id !== me?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Message" className="sm:col-span-3"><Textarea rows={8} value={f.body} onChange={t('body')} /></Field>
      </div>
      {f.audience === 'USERS' && (
        <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-3">
          {people.data?.map((p) => <label key={p.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.audienceUserIds.includes(p.id)} onChange={(e) => setF({ ...f, audienceUserIds: e.target.checked ? [...f.audienceUserIds, p.id] : f.audienceUserIds.filter((x) => x !== p.id) })} /> {p.name}</label>)}
        </div>
      )}
      <label className="mt-2 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.requiresAck} onChange={(e) => setF({ ...f, requiresAck: e.target.checked })} /> Recipients must acknowledge</label>
    </Modal>
  );
}

/** Memos, notices and circulars: what was sent to me, what I sent, and composing new ones. */
export default function MemosPage() {
  const can = useCan();
  const [box, setBox] = useState<'inbox' | 'sent' | 'all'>('inbox');
  const [composing, setComposing] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['circulars', box], queryFn: () => api.get<Row[]>('/circulars', { box }) });
  const issuer = can('ict.circulars.issue');
  return (
    <>
      <PageHeader title="Memos and notices" subtitle="Official communications with read receipts and acknowledgements; minute a memo on to the officer who should act." actions={issuer && <Button onClick={() => setComposing(true)}>New memo</Button>} />
      <ErrorBox error={error} />
      <Tabs tabs={[{ id: 'inbox', label: 'Sent to me' }, { id: 'sent', label: 'Sent by me / to approve' }, ...(issuer ? [{ id: 'all' as const, label: 'All' }] : [])]} value={box} onChange={setBox} />
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing here.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Memo</th><th>From</th><th>Date</th><th>Status</th><th className="num">Read</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className={c.mine && !c.mine.readAt ? 'font-semibold' : ''}>
                  <td><Link href={`/ict/memos/${c.id}`} className="text-brand-700 hover:underline">{c.number}</Link> <span className="text-xs text-muted">{label(c.kind)}</span><div>{c.title}</div></td>
                  <td>{c.issuedByName}</td>
                  <td>{fmtDateTime(c.issuedAt ?? c.createdAt)}</td>
                  <td><Badge value={c.status} />{c.mine && c.requiresAck && !c.mine.ackAt && <Badge tone="amber">to acknowledge</Badge>}</td>
                  <td className="num">{c.status === 'ISSUED' || c.status === 'RECALLED' ? `${c.read}/${c.total}${c.requiresAck ? ` · ${c.acknowledged} ack.` : ''}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {composing && <Compose onClose={() => setComposing(false)} />}
    </>
  );
}
