'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useMe } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';
import { EvidencePicker } from '@/modules/internalaudit/ui/shared';

interface Workpaper {
  id: string;
  ref: string;
  title: string;
  procedure?: string;
  content?: string;
  conclusion?: string;
  confidential: boolean;
  status: string;
  preparedBy?: string;
  preparedByName?: string;
  preparedAt?: string;
  reviewedByName?: string;
  reviewedAt?: string;
  reviewNotes: { at: string; byName: string; note: string }[];
  version: number;
  versions: { version: number; content?: string; conclusion?: string; savedByName: string; at: string }[];
  sample?: { population: number; size: number; method: string; seed: number; items: number[]; drawnAt: string } | null;
  population?: { label: string; count: number; total?: number; valueField?: string; columns: { key: string; label: string }[]; preview: Record<string, unknown>[]; pulledAt: string; truncated?: boolean } | null;
  sampleRows?: Record<string, unknown>[] | null;
  engagement: { id: string; number: string; title: string; status: string };
  documents: { id: string; name: string; createdAt: string; version: number }[];
}

interface Dataset { key: string; label: string; module: string; fields: { key: string; label: string; type: string }[] }

/** Pulls the transactions to test from any module (read-only; the query and rows are kept on the paper). */
function Pull({ w, onClose }: { w: Workpaper; onClose: () => void }) {
  const qc = useQueryClient();
  const cat = useQuery({ queryKey: ['ia-catalogue'], queryFn: () => api.get<Dataset[]>('/data/catalogue') });
  const [f, setF] = useState({ dataset: '', field: '', op: 'between', value: '', to: '', valueField: '' });
  const d = cat.data?.find((x) => x.key === f.dataset);
  const pull = useMutation({
    mutationFn: () => api.post(`/workpapers/${w.id}/population`, { dataset: f.dataset, filters: f.field && f.value ? [{ field: f.field, op: f.op, value: f.value, ...(f.op === 'between' && { to: f.to }) }] : [], columns: d?.fields.slice(0, 10).map((x) => x.key), valueField: f.valueField || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ia-workpaper', w.id] }); onClose(); },
  });
  return (
    <Modal open wide onClose={onClose} title="Pull the transactions to test" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => pull.mutate()} disabled={!f.dataset || pull.isPending}>Pull</Button></>}>
      <ErrorBox error={pull.error || cat.error} />
      <p className="mb-2 text-xs text-muted">Read-only: the rows are copied into this working paper as they are now (up to 5,000) and the pull is in the audit trail.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" className="sm:col-span-2"><Select value={f.dataset} onChange={(e) => setF({ ...f, dataset: e.target.value, field: '', valueField: '' })}><option value="">Choose the data</option>{cat.data?.map((x) => <option key={x.key} value={x.key}>{x.module}: {x.label}</option>)}</Select></Field>
        {d && (
          <>
            <Field label="Filter on"><Select value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="">Everything</option>{d.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select></Field>
            <Field label="Condition"><Select value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}><option value="between">between</option><option value="eq">equals</option><option value="contains">contains</option><option value="gte">at least</option><option value="lte">at most</option></Select></Field>
            {f.field && <Field label="Value"><Input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="e.g. 2026-01-01" /></Field>}
            {f.field && f.op === 'between' && <Field label="and"><Input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>}
            <Field label="Amount to sample by (monetary unit)" className="sm:col-span-2"><Select value={f.valueField} onChange={(e) => setF({ ...f, valueField: e.target.value })}><option value="">None</option>{d.fields.filter((x) => x.type === 'money' || x.type === 'number').map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function Sample({ w, onClose }: { w: Workpaper; onClose: () => void }) {
  const qc = useQueryClient();
  const pulled = Boolean(w.population?.count);
  const [f, setF] = useState({ population: '', method: 'RANDOM', size: '', confidence: '95', tolerableRate: '5', values: '' });
  const draw = useMutation({
    mutationFn: () =>
      api.post(`/workpapers/${w.id}/sample`, {
        ...(!pulled && { population: Number(f.population) }),
        method: f.method,
        ...(f.size ? { size: Number(f.size) } : { confidence: Number(f.confidence), tolerableRate: Number(f.tolerableRate) }),
        ...(f.method === 'MONETARY' && !pulled && { values: f.values.split(/[\s,;]+/).filter(Boolean).map(Number) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-workpaper', w.id] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Draw a sample" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => draw.mutate()} disabled={draw.isPending || (!pulled && !Number(f.population))}>Draw</Button></>}>
      <ErrorBox error={draw.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {pulled ? <p className="text-sm sm:col-span-2">From the {w.population!.count} transactions pulled from {w.population!.label}.</p> : <Field label="Items in the population"><Input inputMode="numeric" value={f.population} onChange={(e) => setF({ ...f, population: e.target.value })} /></Field>}
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="RANDOM">Simple random</option>
            <option value="SYSTEMATIC">Systematic (every nth)</option>
            <option value="MONETARY">Monetary unit (by value)</option>
          </Select>
        </Field>
        <Field label="Sample size" hint="Leave blank to work it out from confidence and tolerable error"><Input inputMode="numeric" value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} /></Field>
        {!f.size && (
          <>
            <Field label="Confidence %"><Input inputMode="decimal" value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value })} /></Field>
            <Field label="Tolerable error rate %"><Input inputMode="decimal" value={f.tolerableRate} onChange={(e) => setF({ ...f, tolerableRate: e.target.value })} /></Field>
          </>
        )}
        {f.method === 'MONETARY' && !pulled && <Field label="Item values, in population order" hint="Paste a column from a spreadsheet" className="sm:col-span-2"><Textarea rows={4} value={f.values} onChange={(e) => setF({ ...f, values: e.target.value })} /></Field>}
      </div>
      <p className="text-xs text-muted">The seed is kept so the same sample can be drawn again and checked.</p>
    </Modal>
  );
}

export default function WorkpaperPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: w, error, isLoading } = useQuery({ queryKey: ['ia-workpaper', id], queryFn: () => api.get<Workpaper>(`/workpapers/${id}`) });
  const [draft, setDraft] = useState<{ content: string; conclusion: string } | null>(null);
  const [note, setNote] = useState('');
  const [sampling, setSampling] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [history, setHistory] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ia-workpaper', id] });
  const save = useMutation({ mutationFn: () => api.patch(`/workpapers/${id}`, draft!), onSuccess: () => { setDraft(null); refresh(); } });
  const sign = useMutation({ mutationFn: (action: string) => api.post(`/workpapers/${id}/sign`, { action, note: note || undefined }), onSuccess: () => { setNote(''); refresh(); } });
  const attach = useMutation({ mutationFn: (documentIds: string[]) => api.post(`/workpapers/${id}/evidence`, { documentIds }), onSuccess: refresh });
  if (isLoading) return <Loading />;
  if (!w) return <ErrorBox error={error} />;
  const open = !['ISSUED', 'CLOSED', 'CANCELLED'].includes(w.engagement.status);
  const text = draft ?? { content: w.content ?? '', conclusion: w.conclusion ?? '' };
  const reviewer = w.status === 'PREPARED' && w.preparedBy !== me?.id;
  return (
    <>
      <PageHeader
        title={`${w.ref} · ${w.title}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={w.status} /> <Link href={`/internalaudit/engagements/${w.engagement.id}`} className="text-brand-700 hover:underline">{w.engagement.number} {w.engagement.title}</Link> · version {w.version}{w.confidential && <Badge tone="gray">confidential</Badge>}</span>}
        actions={
          <>
            {w.versions.length > 0 && <Button variant="secondary" onClick={() => setHistory(true)}>Versions ({w.versions.length})</Button>}
            {open && w.status !== 'REVIEWED' && <Button variant="secondary" onClick={() => setPulling(true)}>Pull transactions</Button>}
            {open && w.status !== 'REVIEWED' && <Button variant="secondary" onClick={() => setSampling(true)}>Draw sample</Button>}
            {open && w.status === 'DRAFT' && <Button onClick={() => sign.mutate('PREPARE')} disabled={!!draft || sign.isPending}>Sign as prepared</Button>}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={save.error || sign.error || attach.error} />
        {w.status === 'PREPARED' && <Notice>Prepared by {w.preparedByName} {w.preparedAt && fmtDateTime(w.preparedAt)}. Waiting for review by the engagement lead or an audit manager.</Notice>}
        {w.status === 'REVIEWED' && <Notice tone="green">Prepared by {w.preparedByName}, reviewed by {w.reviewedByName} {w.reviewedAt && fmtDateTime(w.reviewedAt)}. Editing it sends it back to draft.</Notice>}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {w.procedure && <Card title="Procedure"><p className="whitespace-pre-wrap text-sm">{w.procedure}</p></Card>}
          <Card title="Work done and results" actions={open && draft && <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
            <Field label="Work done"><Textarea rows={12} value={text.content} onChange={(e) => setDraft({ ...text, content: e.target.value })} disabled={!open} /></Field>
            <Field label="Conclusion"><Textarea rows={3} value={text.conclusion} onChange={(e) => setDraft({ ...text, conclusion: e.target.value })} disabled={!open} /></Field>
          </Card>
          {reviewer && (
            <Card title="Review">
              <Field label="Review note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="mt-2 flex gap-2">
                <Button onClick={() => sign.mutate('REVIEW')} disabled={sign.isPending}>Sign as reviewed</Button>
                <Button variant="secondary" onClick={() => sign.mutate('RETURN')} disabled={sign.isPending || !note}>Return to preparer</Button>
              </div>
            </Card>
          )}
          {w.population && (
            <Card title={w.sampleRows ? `Sampled transactions (${w.sampleRows.length})` : 'Pulled transactions (first 20)'} padded={false}>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead><tr>{w.sampleRows && <th>Item</th>}{w.population.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>{(w.sampleRows ?? w.population.preview).map((r, i) => <tr key={i}>{w.sampleRows && <td>{String(r.item)}</td>}{w.population!.columns.map((c) => <td key={c.key} className="text-xs">{r[c.key] === null || r[c.key] === undefined ? '' : String(r[c.key]).slice(0, 60)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </Card>
          )}
          {w.reviewNotes.length > 0 && (
            <Card title="Review notes">
              <ul className="space-y-1 text-sm">{w.reviewNotes.map((n, i) => <li key={i}><span className="text-muted">{fmtDateTime(n.at)} · {n.byName}:</span> {n.note}</li>)}</ul>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card title="Evidence" actions={open && <EvidencePicker meta={{ module: 'internalaudit', access: 'RESTRICTED', category: 'AUDIT_EVIDENCE' }} onUploaded={(ids) => attach.mutateAsync(ids)} />}>
            {!w.documents.length ? <p className="text-sm text-muted">No files yet. Only the engagement team and audit managers can open them.</p> : (
              <ul className="space-y-1 text-sm">
                {w.documents.map((d) => <li key={d.id}><a href={`/api/v1/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{d.name}</a> <span className="text-xs text-muted">{fmtDateTime(d.createdAt)}</span></li>)}
              </ul>
            )}
          </Card>
          {w.sample && (
            <Card title="Sample">
              <p className="text-sm">{w.sample.size} of {w.sample.population} items, {w.sample.method.toLowerCase()} (seed {w.sample.seed}), drawn {fmtDateTime(w.sample.drawnAt)}.</p>
              <p className="mt-2 max-h-48 overflow-y-auto text-xs tabular-nums text-muted">{w.sample.items.join(', ')}</p>
            </Card>
          )}
          {w.population && (
            <Card title="Population">
              <p className="text-sm">{w.population.count} transactions from {w.population.label}{w.population.total !== undefined && w.population.total !== null ? `, total ${w.population.total.toLocaleString('en-KE')}` : ''}; pulled {fmtDateTime(w.population.pulledAt)}{w.population.truncated ? ' (first 5,000 only)' : ''}.</p>
            </Card>
          )}
        </div>
      </div>
      {sampling && <Sample w={w} onClose={() => setSampling(false)} />}
      {pulling && <Pull w={w} onClose={() => setPulling(false)} />}
      {history && (
        <Modal open wide onClose={() => setHistory(false)} title={`${w.ref}: earlier versions`}>
          <div className="space-y-3">
            {[...w.versions].reverse().map((v) => (
              <div key={v.version} className="rounded-md border border-line p-3 text-sm">
                <div className="mb-1 text-xs text-muted">Version {v.version} · replaced by {v.savedByName} {fmtDateTime(v.at)}</div>
                <p className="whitespace-pre-wrap">{v.content || <span className="text-muted">(empty)</span>}</p>
                {v.conclusion && <p className="mt-1"><b>Conclusion:</b> {v.conclusion}</p>}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
