'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { DocumentRow, StoredDocument, uploadDocument } from '@/components/attachments';
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pager, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const CATEGORIES = ['GENERAL', 'POLICY', 'MEMO', 'NOTICE', 'CONTRACT', 'MINUTES', 'REPORT', 'CORRESPONDENCE', 'CERTIFICATE', 'KYC', 'TENDER', 'FINANCIAL', 'PERSONNEL'];

function Trail({ doc, onClose }: { doc: StoredDocument; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['doc-trail', doc.id], queryFn: () => api.get<{ id: string; createdAt: string; action: string; userName?: string; ip?: string }[]>(`/documents/${doc.id}/trail`) });
  const { data: versions } = useQuery({ queryKey: ['doc-versions', doc.id], queryFn: () => api.get<StoredDocument[]>(`/documents/${doc.id}/versions`) });
  return (
    <Modal open wide onClose={onClose} title={doc.name}>
      <div className="text-sm font-medium">Versions</div>
      <ul className="text-sm">{versions?.map((v) => <li key={v.id}><a className="text-brand-700 hover:underline" href={`/api/v1/documents/${v.id}/download`} target="_blank" rel="noreferrer">v{v.version} · {v.name}</a> <span className="text-muted">{fmtDateTime(v.createdAt)}</span></li>)}</ul>
      <div className="text-sm font-medium">Who did what</div>
      <ul className="text-sm">{data?.map((r) => <li key={r.id}>{fmtDateTime(r.createdAt)} · {r.userName ?? '—'} · {r.action.replace('document.', '')}{r.ip ? ` · ${r.ip}` : ''}</li>)}</ul>
    </Modal>
  );
}

/** The organisation's document registry: policies, memos, notices, contracts and every file attached to a record. */
export default function DocumentsPage() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState({ search: '', category: '', page: 1 });
  const [meta, setMeta] = useState({ category: 'GENERAL', tags: '', access: 'ORGANISATION' });
  const [trail, setTrail] = useState<StoredDocument | null>(null);
  const [replaces, setReplaces] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['documents', 'all', q], queryFn: () => api.get<{ items: StoredDocument[]; total: number; page: number; pageSize: number }>('/documents', { ...q, pageSize: 50 }) });
  const upload = useMutation({
    mutationFn: (file: File) => uploadDocument(file, replaces ? { replaces } : { category: meta.category, tags: meta.tags, access: meta.access }),
    onSuccess: () => {
      setReplaces(null);
      qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  return (
    <>
      <PageHeader title="Documents" subtitle="Policies, memos, notices, contracts and every file attached to a record, with versions and a record of who opened them" />
      <Card title="Add a document" className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Category"><Select value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
          <Field label="Tags (comma separated)"><Input value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} /></Field>
          <Field label="Who can open it"><Select value={meta.access} onChange={(e) => setMeta({ ...meta, access: e.target.value })}><option value="ORGANISATION">Everyone in the organisation</option><option value="RESTRICTED">Only me and administrators</option></Select></Field>
          <Button onClick={() => input.current?.click()} disabled={upload.isPending}>{upload.isPending ? 'Uploading…' : 'Choose file'}</Button>
          <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
        </div>
        <ErrorBox error={upload.error} />
      </Card>
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input placeholder="Search name, tag, description" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} className="max-w-xs" />
          <Select value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value, page: 1 })} className="max-w-[12rem]"><option value="">Any category</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No documents.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Document</th><th>Category</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
            <tbody>
              {data.items.map((d) => (
                <DocumentRow key={d.id} d={d} />
              ))}
            </tbody>
          </table>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ({ ...q, page })} />}
      </Card>
      {data?.items.length ? (
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <span className="text-muted">History and versions:</span>
          {data.items.slice(0, 20).map((d) => (
            <span key={d.id} className="flex gap-1">
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setTrail(d)}>{d.name}</button>
              <button type="button" className="text-xs text-muted hover:underline" onClick={() => { setReplaces(d.id); input.current?.click(); }}>(new version)</button>
            </span>
          ))}
        </div>
      ) : null}
      {trail && <Trail doc={trail} onClose={() => setTrail(null)} />}
    </>
  );
}
