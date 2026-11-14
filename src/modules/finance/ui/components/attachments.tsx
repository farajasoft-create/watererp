'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDate, formatDateTime, today } from '@/modules/finance/ui/lib/format';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Loading, Notice, PageHeader, Select, TableWrap } from './ui';

export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'INVOICE', label: 'Invoice' },
  { id: 'RECEIPT', label: 'Receipt' },
  { id: 'CONTRACT', label: 'Contract' },
  { id: 'PURCHASE_ORDER', label: 'Purchase order' },
  { id: 'DELIVERY_NOTE', label: 'Delivery note' },
  { id: 'BANK_STATEMENT', label: 'Bank statement' },
  { id: 'TAX', label: 'Tax document' },
  { id: 'APPROVAL_EVIDENCE', label: 'Approval evidence' },
  { id: 'CORRESPONDENCE', label: 'Correspondence' },
  { id: 'OTHER', label: 'Other' },
];
const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.docx,.doc,.csv,.txt,.eml';

interface AttachmentRow {
  id: string;
  name: string;
  category: string;
  description: string;
  mimeType: string;
  size: number;
  version: number;
  versions?: number;
  uploadedByName: string;
  createdAt: string;
  inline: boolean;
  scanStatus?: 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'ERROR';
  recordType: string;
  recordLabel: string;
  link?: string;
  sha256: string;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const href = (a: { id: string; inline: boolean }) => `/api/v1/finance/attachments/${a.id}/content${a.inline ? '?inline=1' : ''}`;

type Uploaded = AttachmentRow & { duplicates: { recordLabel: string; name: string }[] };

/**
 * With object storage the file goes straight to the bucket through a signed URL, then the server checks
 * it; otherwise it is sent to the API as the raw request body.
 */
async function uploadFile(params: { recordType: string; recordId: string; name: string; category: string; replaces?: string }, file: File, opts: { direct: boolean; maxBytes: number }) {
  if (file.size > opts.maxBytes) throw new Error(`${file.name} is larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`);
  if (opts.direct) {
    const ticket = await api.post<{ id: string; uploadUrl: string; headers: Record<string, string> }>('/attachments/uploads', { ...params, size: file.size, replaces: params.replaces ?? null });
    const put = await fetch(ticket.uploadUrl, { method: 'PUT', body: file, headers: ticket.headers });
    if (!put.ok) throw new Error(`Upload of ${file.name} to storage failed (${put.status})`);
    return api.post<Uploaded>(`/attachments/uploads/${ticket.id}/complete`);
  }
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  const res = await fetch(`/api/v1/finance/attachments?${q}`, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.errors);
  return data as Uploaded;
}

/** Supporting documents for one record: upload, open, new versions and history, retention-aware removal. */
export function AttachmentsCard({ recordType, recordId, className, compact }: { recordType: string; recordId: string; className?: string; compact?: boolean }) {
  const queryClient = useQueryClient();
  const key = ['attachments', recordType, recordId];
  const { data, isLoading, error: loadError } = useQuery({ queryKey: key, queryFn: () => api.get<{ canUpload: boolean; locked: boolean; directUploads: boolean; maxBytes: number; items: AttachmentRow[] }>('/attachments', { recordType, recordId }) });
  const [category, setCategory] = useState(recordType === 'Invoice' ? 'INVOICE' : recordType === 'ExpenseClaim' ? 'RECEIPT' : 'OTHER');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const versions = useQuery({ queryKey: ['attachment-versions', history], queryFn: () => api.get<AttachmentRow[]>(`/attachments/${history}/versions`), enabled: !!history });
  const upload = useMutation({
    mutationFn: async ({ files, replaces }: { files: File[]; replaces?: string }) => {
      const dupes: string[] = [];
      for (const file of files) {
        const r = await uploadFile({ recordType, recordId, name: file.name, category, replaces }, file, { direct: !!data?.directUploads, maxBytes: data?.maxBytes ?? 4 * 1024 * 1024 });
        dupes.push(...r.duplicates.map((d) => `${file.name} is also attached to ${d.recordLabel}`));
      }
      return dupes;
    },
    onSuccess: (dupes) => {
      setError(null);
      setWarning(dupes.length ? `${dupes.join('; ')}. Check that this is not a duplicate.` : null);
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['attachment-versions'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/attachments/${id}`),
    onSuccess: () => (setError(null), queryClient.invalidateQueries({ queryKey: key })),
    onError: (err) => setError(errorMessage(err)),
  });
  if (loadError instanceof ApiError && loadError.status === 403) return null;
  const items = data?.items ?? [];
  return (
    <Card
      className={className ?? 'mt-4'}
      padded={false}
      title={<span>Documents {items.length > 0 && <span className="text-xs font-normal text-muted">({items.length})</span>}</span>}
      actions={
        data?.canUpload && (
          <div className="flex items-center gap-2">
            <Select className="h-7 w-36 text-xs" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Document type">
              {CATEGORIES.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
            </Select>
            <Button size="sm" loading={upload.isPending && !replacing} onClick={() => fileInput.current?.click()}>Attach files</Button>
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (e.target.files?.length && upload.mutate({ files: [...e.target.files] }), (e.target.value = ''))} />
            <input ref={versionInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => (e.target.files?.[0] && upload.mutate({ files: [e.target.files[0]], replaces: replacing ?? undefined }, { onSettled: () => setReplacing(null) }), (e.target.value = ''))} />
          </div>
        )
      }
    >
      <div className="space-y-2 p-3 empty:hidden">
        {error && <ErrorBanner error={error} />}
        {warning && <Notice tone="amber">{warning}</Notice>}
      </div>
      {isLoading ? (
        <Loading />
      ) : !items.length ? (
        <p className="px-4 pb-4 text-sm text-muted">{data?.canUpload ? `No documents yet. Attach the supplier invoice, receipts, contracts or approval evidence (PDF, images, Office files; up to ${Math.round((data?.maxBytes ?? 4 * 1024 * 1024) / 1024 / 1024)} MB each).` : 'No documents.'}</p>
      ) : (
        <table className="table-base">
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <a className="font-medium text-brand-700 hover:underline" href={href(a)} target="_blank" rel="noreferrer">{a.name}</a>
                  {a.scanStatus === 'CLEAN' && <span className="ml-1 text-[11px] text-emerald-700" title="Scanned for viruses">✓ scanned</span>}
                  {a.scanStatus === 'ERROR' && <span className="ml-1 text-[11px] text-amber-700" title="The virus scan will be retried">scan pending</span>}
                  {!compact && a.description && <p className="text-xs text-muted">{a.description}</p>}
                  {history === a.id && versions.data && (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {versions.data.map((v) => (
                        <li key={v.id}>
                          <a className="text-brand-700 hover:underline" href={href(v)} target="_blank" rel="noreferrer">Version {v.version}</a> · {v.name} · {v.uploadedByName} · {formatDateTime(v.createdAt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="whitespace-nowrap"><Badge tone="gray">{categoryLabel(a.category)}</Badge></td>
                {!compact && <td className="whitespace-nowrap text-xs text-muted">{a.uploadedByName} · {formatDate(a.createdAt)}</td>}
                <td className="whitespace-nowrap text-right text-xs text-muted">{size(a.size)}</td>
                <td className="whitespace-nowrap text-right">
                  {(a.versions ?? 1) > 1 && <Button size="sm" variant="ghost" onClick={() => setHistory(history === a.id ? null : a.id)}>v{a.version} · history</Button>}
                  {data?.canUpload && <Button size="sm" variant="ghost" onClick={() => (setReplacing(a.id), versionInput.current?.click())}>New version</Button>}
                  {data?.canUpload && !data.locked && <Button size="sm" variant="ghost" onClick={() => remove.mutate(a.id)}>Remove</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.locked && items.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-muted">Documents on posted or approved records are kept under the retention policy; upload a new version to correct one.</p>}
    </Card>
  );
}

const RECORD_TYPES = [
  ['Invoice', 'Invoices & bills'],
  ['Payment', 'Receipts & payments'],
  ['Journal', 'Journals'],
  ['PurchaseOrder', 'Purchase orders'],
  ['PurchaseRequisition', 'Requisitions'],
  ['ExpenseClaim', 'Expense claims'],
  ['FixedAsset', 'Fixed assets'],
  ['Customer', 'Customers'],
  ['Supplier', 'Suppliers'],
  ['BankAccount', 'Bank accounts'],
] as const;

export function DocumentsPage() {
  const [q, setQ] = useState({ q: '', recordType: '', category: '', from: '', to: today() });
  const [search, setSearch] = useState(q);
  const { data, isLoading, error } = useQuery({ queryKey: ['attachment-search', search], queryFn: () => api.get<AttachmentRow[]>('/attachments/search', { ...search, from: search.from || undefined }) });
  return (
    <>
      <PageHeader title="Documents" description="Every supporting document you can see — supplier invoices, receipts, contracts, statements and approval evidence — searchable by name, description, record number or uploader." />
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <Field label="Search"><Input className="w-64" placeholder="File name, record number…" value={q.q} onChange={(e) => setQ({ ...q, q: e.target.value })} /></Field>
        <Field label="Attached to">
          <Select value={q.recordType} onChange={(e) => setQ({ ...q, recordType: e.target.value })}>
            <option value="">Anything</option>
            {RECORD_TYPES.map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
          </Select>
        </Field>
        <Field label="Uploaded from"><Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="to"><Input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
        <Button type="submit" variant="primary">Search</Button>
      </form>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty title="No documents found" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Document</th><th>Type</th><th>Attached to</th><th>Uploaded</th><th className="num">Size</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a className="font-medium text-brand-700 hover:underline" href={href(a)} target="_blank" rel="noreferrer">{a.name}</a>
                    {a.version > 1 && <span className="ml-1 text-xs text-muted">v{a.version}</span>}
                    {a.description && <p className="text-xs text-muted">{a.description}</p>}
                  </td>
                  <td><Badge tone="gray">{categoryLabel(a.category)}</Badge></td>
                  <td className="text-sm">{a.link ? <Link className="hover:underline" href={a.link}>{a.recordLabel}</Link> : a.recordLabel}</td>
                  <td className="whitespace-nowrap text-xs">{a.uploadedByName} · {formatDate(a.createdAt)}</td>
                  <td className="num text-xs">{size(a.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}
