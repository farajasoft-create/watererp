'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, Empty, ErrorBox, Input, Modal, Select } from './ui';

export interface StoredDocument {
  id: string;
  name: string;
  version: number;
  category: string;
  size: number;
  contentType: string;
  tags?: string[];
  module?: string | null;
  entity?: string | null;
  entityId?: string | null;
  uploadedByName?: string;
  createdAt: string;
}

const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Sends a file to the document store; the details travel in the query string. */
export async function uploadDocument(file: File, meta: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.fromEntries(Object.entries({ name: file.name, ...meta }).filter(([, v]) => v)) as Record<string, string>);
  const res = await fetch(`/api/v1/documents?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? 'Upload failed');
  return data as StoredDocument;
}

export function DocumentRow({ d, onVersion }: { d: StoredDocument; onVersion?: (d: StoredDocument) => void }) {
  return (
    <tr>
      <td>
        <a className="font-medium text-brand-700 hover:underline" href={`/api/v1/documents/${d.id}/download`} target="_blank" rel="noreferrer">{d.name}</a>
        {d.version > 1 && <span className="ml-1 text-xs text-muted">v{d.version}</span>}
        {!!d.tags?.length && <div className="text-xs text-muted">{d.tags.join(', ')}</div>}
      </td>
      <td className="text-sm">{d.category}</td>
      <td className="text-sm">{size(d.size)}</td>
      <td className="text-sm">{d.uploadedByName}<div className="text-xs text-muted">{fmtDateTime(d.createdAt)}</div></td>
      <td className="text-right">{onVersion && <Button variant="ghost" onClick={() => onVersion(d)}>New version</Button>}</td>
    </tr>
  );
}

/**
 * Files attached to one record (a customer, an employee, a supplier, an audit engagement): scanned
 * letters, certificates, contracts. Drop it on any page.
 */
export function Attachments({ module, entity, entityId, categories = ['GENERAL'], title = 'Documents' }: { module: string; entity: string; entityId: string; categories?: string[]; title?: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(categories[0]);
  const [replacing, setReplacing] = useState<StoredDocument | null>(null);
  const key = ['documents', module, entity, entityId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ items: StoredDocument[] }>('/documents', { module, entity, entityId, pageSize: 100 }) });
  const upload = useMutation({
    mutationFn: (file: File) => uploadDocument(file, replacing ? { replaces: replacing.id } : { module, entity, entityId, category }),
    onSuccess: () => {
      setReplacing(null);
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const pick = () => input.current?.click();
  return (
    <Card
      title={title}
      padded={false}
      actions={
        <>
          {categories.length > 1 && <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-40">{categories.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
          <Button variant="secondary" onClick={pick} disabled={upload.isPending}>{upload.isPending ? 'Uploading…' : 'Attach file'}</Button>
        </>
      }
    >
      <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
      <ErrorBox error={error || upload.error} />
      {!data?.items.length ? (
        <Empty>No files yet.</Empty>
      ) : (
        <table className="table-base">
          <tbody>{data.items.map((d) => <DocumentRow key={d.id} d={d} onVersion={(x) => { setReplacing(x); setTimeout(pick, 0); }} />)}</tbody>
        </table>
      )}
      {replacing && upload.isPending && <Modal open onClose={() => undefined} title="Uploading"><Input disabled value={replacing.name} /></Modal>}
    </Card>
  );
}
