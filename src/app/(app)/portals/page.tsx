'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { uploadDocument } from '@/components/attachments';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import { label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/portals/ui/api';

interface Item { id: string; title: string; author?: string; category: string; year?: number; summary?: string; tags: string[]; documentId?: string | null; url?: string; audience: string; downloads: number; active: boolean }
const CATS = ['POLICY', 'REPORT', 'STRATEGIC_PLAN', 'TARIFF', 'TENDER', 'MANUAL', 'PUBLICATION', 'FORM', 'RESEARCH', 'OTHER'];

function ItemForm({ item, onClose }: { item?: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: item?.title ?? '', author: item?.author ?? '', category: item?.category ?? 'PUBLICATION', year: item?.year ? String(item.year) : '', summary: item?.summary ?? '', tags: (item?.tags ?? []).join(', '), url: item?.url ?? '', audience: item?.audience ?? 'STAFF', active: item?.active ?? true });
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const documentId = file ? (await uploadDocument(file, { module: 'portals', category: 'LIBRARY', access: f.audience === 'PUBLIC' ? 'ORGANISATION' : 'ORGANISATION' })).id : (item?.documentId ?? null);
      const body = { ...f, author: f.author || undefined, summary: f.summary || undefined, url: f.url || undefined, year: f.year ? Number(f.year) : null, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), documentId };
      return item ? api.put(`/library/${item.id}`, body) : api.post('/library', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portals-library'] }); onClose(); },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title={item ? `Edit ${item.title}` : 'Add to the library'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 2 || (!file && !f.url && !item?.documentId)}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Who can read it"><Select value={f.audience} onChange={t('audience')}><option value="STAFF">Staff only</option><option value="PUBLIC">The public (on the library portal)</option></Select></Field>
        <Field label="Author"><Input value={f.author} onChange={t('author')} /></Field>
        <Field label="Kind"><Select value={f.category} onChange={t('category')}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
        <Field label="Year"><Input inputMode="numeric" value={f.year} onChange={t('year')} /></Field>
        <Field label="Summary" className="sm:col-span-3"><Textarea rows={2} value={f.summary} onChange={t('summary')} /></Field>
        <Field label="Subjects (comma separated)" className="sm:col-span-3"><Input value={f.tags} onChange={t('tags')} /></Field>
        <Field label="File" className="sm:col-span-2"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></Field>
        <Field label="Or a link"><Input value={f.url} onChange={t('url')} placeholder="https://" /></Field>
      </div>
      {item && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Shown</label>}
    </Modal>
  );
}

export default function LibraryPage() {
  const can = useCan();
  const { data: me } = useMe();
  const [q, setQ] = useState({ search: '', category: '' });
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['portals-library', q], queryFn: () => api.get<Item[]>('/library', Object.fromEntries(Object.entries(q).filter(([, v]) => v))) });
  const code = me?.organisation?.code?.toLowerCase();
  return (
    <>
      <PageHeader title="E-library" subtitle={<>Policies, reports, plans, manuals and publications. Public items are also on the {code ? <a className="text-brand-700 hover:underline" href={`/library/${code}`} target="_blank" rel="noreferrer">public library</a> : 'public library'}.</>} actions={can('portals.manage') && <Button onClick={() => setEditing('new')}>Add an item</Button>} />
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="max-w-sm" />
        <Select value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })} className="max-w-48"><option value="">All kinds</option>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
      </div>
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing in the library yet.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Title</th><th>Kind</th><th>Year</th><th>Readers</th><th className="num">Opened</th></tr></thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'text-muted'}>
                  <td><a href={`/api/v1/portals/library/${i.id}/open`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">{i.title}</a>{i.author && <span className="text-xs text-muted"> · {i.author}</span>}{can('portals.manage') && <button type="button" className="ml-2 text-xs text-muted hover:underline" onClick={() => setEditing(i)}>edit</button>}<div className="text-xs text-muted">{i.summary}</div></td>
                  <td>{label(i.category)}</td>
                  <td>{i.year ?? '—'}</td>
                  <td><Badge tone={i.audience === 'PUBLIC' ? 'green' : 'gray'}>{i.audience === 'PUBLIC' ? 'public' : 'staff'}</Badge></td>
                  <td className="num">{i.downloads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && <ItemForm item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
