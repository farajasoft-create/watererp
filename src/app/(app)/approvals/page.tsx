'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Select, Textarea } from '@/components/ui';
import { SignaturePad } from '@/components/signature-pad';
import { api } from '@/lib/api';
import { fmtDateTime, label } from '@/lib/format';
import { useMe } from '@/lib/session';
import { createDeviceKey, deviceKey, saveDeviceKey, signText } from '@/lib/signing-key';

interface Request {
  id: string;
  module: string;
  docType: string;
  title: string;
  amount: number;
  link?: string;
  requestedByName?: string;
  stepName?: string;
  createdAt: string;
  status: string;
  valid?: boolean;
  current?: number;
  documentHash?: string;
  steps: { name: string; decision?: string | null; byName?: string; at?: string; note?: string; signature?: { method?: string; image?: string; signatureHash?: string } }[];
}

function Decide({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: r, error } = useQuery({ queryKey: ['approval', id], queryFn: () => api.get<Request>(`/approvals/${id}`) });
  const [decision, setDecision] = useState('APPROVED');
  const [note, setNote] = useState('');
  const [sig, setSig] = useState<string | null>(null);
  const [useKey, setUseKey] = useState(false);
  const { data: me } = useMe();
  const save = useMutation({
    mutationFn: async () => {
      let certificate: { keyId: string; signature: string } | undefined;
      if (useKey && me && r) {
        let k = await deviceKey(me.id);
        if (!k) {
          // First use on this device: make a key pair here and register its public half.
          const made = await createDeviceKey();
          const keys = await api.post<{ id: string; fingerprint: string }[]>('/signing-keys', { label: `${navigator.platform || 'Device'} browser key`, pem: made.publicKeyPem });
          await saveDeviceKey(me.id, keys[keys.length - 1].id, made.privateKey);
          k = { keyId: keys[keys.length - 1].id, privateKey: made.privateKey };
        }
        certificate = { keyId: k.keyId, signature: await signText(k.privateKey, `${id}|${r.current ?? 0}|${r.documentHash ?? ''}|${decision}`) };
      }
      return api.post(`/approvals/${id}/decide`, { decision, note: note || undefined, signatureImage: sig, certificate });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title={r?.title ?? 'Approval'} footer={<Button variant={decision === 'APPROVED' ? 'primary' : 'danger'} onClick={() => save.mutate()} disabled={save.isPending || (decision !== 'APPROVED' && !note)}>Sign and {decision === 'APPROVED' ? 'approve' : decision === 'REJECTED' ? 'reject' : 'return'}</Button>}>
      <ErrorBox error={error || save.error} />
      {!r ? (
        <Loading />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">{label(r.docType)}</Badge>
            {r.amount > 0 && <span>KES <Money value={r.amount} /></span>}
            {r.link && <Link className="text-brand-700 hover:underline" href={r.link}>Open the document</Link>}
            {r.valid === false && <Badge tone="red">Signatures do not verify</Badge>}
          </div>
          <ol className="space-y-1 text-sm">
            {r.steps.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <b>{i + 1}. {s.name}</b>
                {s.decision ? <Badge value={s.decision} /> : <Badge tone="gray">Waiting</Badge>}
                {s.byName && <span className="text-muted">{s.byName}, {fmtDateTime(s.at)}</span>}
                {s.note && <span className="text-muted">“{s.note}”</span>}
                {s.signature?.method === 'CERTIFICATE' && <Badge tone="green">digitally signed</Badge>}
                {s.signature?.image && <img src={s.signature.image} alt={`Signature of ${s.byName}`} className="h-8" />}
              </li>
            ))}
          </ol>
          <Field label="Decision">
            <Select value={decision} onChange={(e) => setDecision(e.target.value)} className="max-w-xs">
              <option value="APPROVED">Approve</option>
              <option value="RETURNED">Return for changes</option>
              <option value="REJECTED">Reject</option>
            </Select>
          </Field>
          <Field label={decision === 'APPROVED' ? 'Note (optional)' : 'Reason'}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="Signature (optional; your click is signed either way)">
            <SignaturePad onChange={setSig} />
          </Field>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} /> Sign digitally with this device&apos;s key (made and registered the first time; the private key never leaves this browser)</label>
        </>
      )}
    </Modal>
  );
}

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const { data, error, isLoading } = useQuery({ queryKey: ['approvals', 'inbox'], queryFn: () => api.get<Request[]>('/approvals/inbox') });
  const bulk = useMutation({
    mutationFn: () => api.post<{ results: { ok: boolean }[] }>('/approvals/decide-many', { ids: picked, decision: 'APPROVED' }),
    onSuccess: () => {
      setPicked([]);
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  return (
    <>
      <PageHeader title="Approvals" subtitle="Everything waiting for your signature, from every module" actions={picked.length > 0 && <Button onClick={() => bulk.mutate()} disabled={bulk.isPending}>Approve {picked.length} selected</Button>} />
      <ErrorBox error={error || bulk.error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>Nothing is waiting for you.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th><input type="checkbox" aria-label="Select all" checked={picked.length === data.length} onChange={(e) => setPicked(e.target.checked ? data.map((r) => r.id) : [])} /></th><th>Submitted</th><th>Document</th><th>Module</th><th className="num">Amount</th><th>By</th><th>Your step</th><th /></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Select ${r.title}`} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                  <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td>{r.title}<div className="text-xs text-muted">{label(r.docType)}</div></td>
                  <td>{label(r.module)}</td>
                  <td className="num">{r.amount ? <Money value={r.amount} /> : '—'}</td>
                  <td>{r.requestedByName}</td>
                  <td>{r.stepName}</td>
                  <td className="text-right"><Button variant="ghost" onClick={() => setOpenId(r.id)}>Review</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {openId && <Decide id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
