'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, TableWrap, Textarea } from './ui';

interface Sponsorship { id: string; number: string; kind: string; beneficiary: string; category: string; purpose: string; amount: string; currency: string; inKind?: string; inKindValue?: string | null; benefits?: string; status: string; paymentNumber?: string; acknowledgement?: string; rejectionReason?: string; createdAt: string }
interface Report { year: number; rows: { kind: string; category: string; count: number; cash: string; inKind: string; paid: string }[]; totals: { count: number; cash: string; inKind: string } }
const KINDS = ['SPONSORSHIP', 'DONATION', 'CSR', 'BURSARY'];
const CATEGORIES = ['COMMUNITY', 'EDUCATION', 'HEALTH', 'SPORTS', 'ENVIRONMENT', 'EVENT', 'RELIEF', 'OTHER'];
const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function NewModal({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: 'SPONSORSHIP', beneficiary: '', beneficiaryContact: '', category: 'COMMUNITY', purpose: '', amount: '', inKind: '', inKindValue: '', benefits: '' });
  const save = useMutation({
    mutationFn: () => api.post('/sponsorships', { ...f, entityId, amount: f.amount || '0', inKindValue: f.inKindValue || null, beneficiaryContact: f.beneficiaryContact || undefined, inKind: f.inKind || undefined, benefits: f.benefits || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sponsorships'] }); onClose(); },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open title="Propose a sponsorship or donation" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.beneficiary.length < 2 || f.purpose.length < 3}>Propose</Button></>}>
      <ErrorBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind"><Select value={f.kind} onChange={t('kind')}>{KINDS.map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
        <Field label="Category"><Select value={f.category} onChange={t('category')}>{CATEGORIES.map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
        <Field label="Beneficiary"><Input value={f.beneficiary} onChange={t('beneficiary')} /></Field>
        <Field label="Contact"><Input value={f.beneficiaryContact} onChange={t('beneficiaryContact')} /></Field>
        <Field label="Purpose" className="sm:col-span-2"><Textarea rows={2} value={f.purpose} onChange={t('purpose')} /></Field>
        <Field label="Cash amount"><Input inputMode="decimal" value={f.amount} onChange={t('amount')} /></Field>
        <Field label="In-kind value"><Input inputMode="decimal" value={f.inKindValue} onChange={t('inKindValue')} /></Field>
        <Field label="In-kind support" className="sm:col-span-2"><Input value={f.inKind} onChange={t('inKind')} /></Field>
        <Field label="What we get (branding, report…)" className="sm:col-span-2"><Input value={f.benefits} onChange={t('benefits')} /></Field>
      </div>
    </Modal>
  );
}

/** The sponsorships and donations register with approval, payment and the yearly report. */
export function SponsorshipsPage() {
  const { entity, can } = useSession();
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['sponsorships', year], queryFn: () => api.get<Sponsorship[]>('/sponsorships', { year: String(year) }) });
  const report = useQuery({ queryKey: ['sponsorships', 'report', year], queryFn: () => api.get<Report>('/sponsorships/report', { year: String(year) }), enabled: can('expenses.approve') });
  const act = useMutation({ mutationFn: (x: { id: string; action: string; body?: object }) => api.post(`/sponsorships/${x.id}/${x.action}`, x.body), onSuccess: () => qc.invalidateQueries({ queryKey: ['sponsorships'] }) });
  return (
    <div className="space-y-4">
      <PageHeader title="Sponsorships and donations" description="Every sponsorship, donation, bursary and CSR commitment: proposed, approved by someone else, paid and acknowledged." actions={<><Input className="w-24" inputMode="numeric" value={String(year)} onChange={(e) => setYear(Number(e.target.value) || year)} />{can('expenses.submit') && entity && <Button onClick={() => setAdding(true)}>Propose</Button>}</>} />
      <ErrorBanner error={list.error || act.error} />
      {report.data && report.data.rows.length > 0 && (
        <Card title={`${year}: ${report.data.totals.count} approved, cash ${formatAmount(report.data.totals.cash)}, in kind ${formatAmount(report.data.totals.inKind)}`} padded={false}>
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-500"><th className="p-2">Kind</th><th>Category</th><th className="text-right">Count</th><th className="text-right">Cash</th><th className="text-right">Paid</th><th className="text-right">In kind</th></tr></thead>
            <tbody>{report.data.rows.map((r) => <tr key={`${r.kind}${r.category}`} className="border-t"><td className="p-2">{words(r.kind)}</td><td>{words(r.category)}</td><td className="text-right">{r.count}</td><td className="text-right">{formatAmount(r.cash)}</td><td className="text-right">{formatAmount(r.paid)}</td><td className="text-right">{formatAmount(r.inKind)}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="Nothing in the register this year" /> : (
        <TableWrap>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th className="p-2">Number</th><th>Beneficiary</th><th>Purpose</th><th className="text-right">Cash</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-t align-top">
                  <td className="p-2">{s.number}<div className="text-xs text-gray-500">{words(s.kind)} · {words(s.category)} · {formatDate(s.createdAt)}</div></td>
                  <td>{s.beneficiary}</td>
                  <td>{s.purpose}{s.inKind && <div className="text-xs text-gray-500">In kind: {s.inKind}{s.inKindValue ? ` (${formatAmount(s.inKindValue)})` : ''}</div>}{s.acknowledgement && <div className="text-xs text-green-700">Acknowledged: {s.acknowledgement}</div>}{s.rejectionReason && <div className="text-xs text-red-600">{s.rejectionReason}</div>}</td>
                  <td className="text-right">{formatAmount(s.amount)}{s.paymentNumber && <div className="text-xs text-gray-500">{s.paymentNumber}</div>}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="space-y-1 whitespace-nowrap">
                    {s.status === 'PROPOSED' && can('expenses.approve') && <div className="flex gap-1"><Button size="sm" onClick={() => act.mutate({ id: s.id, action: 'decide', body: { approve: true } })}>Approve</Button><Input className="w-24" placeholder="Reason" value={input[s.id] ?? ''} onChange={(e) => setInput({ ...input, [s.id]: e.target.value })} /><Button size="sm" variant="secondary" disabled={!input[s.id]} onClick={() => act.mutate({ id: s.id, action: 'decide', body: { approve: false, reason: input[s.id] } })}>Reject</Button></div>}
                    {s.status === 'APPROVED' && can('expenses.pay') && <div className="flex gap-1"><Input className="w-40" placeholder="Payment id" value={input[s.id] ?? ''} onChange={(e) => setInput({ ...input, [s.id]: e.target.value })} /><Button size="sm" disabled={!input[s.id]} onClick={() => act.mutate({ id: s.id, action: 'paid', body: { paymentId: input[s.id] } })}>Mark paid</Button></div>}
                    {['APPROVED', 'PAID'].includes(s.status) && !s.acknowledgement && <div className="flex gap-1"><Input className="w-40" placeholder="Acknowledgement received" value={input[`a${s.id}`] ?? ''} onChange={(e) => setInput({ ...input, [`a${s.id}`]: e.target.value })} /><Button size="sm" variant="secondary" disabled={(input[`a${s.id}`] ?? '').length < 3} onClick={() => act.mutate({ id: s.id, action: 'acknowledge', body: { text: input[`a${s.id}`] } })}>Record</Button></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {adding && entity && <NewModal entityId={entity.id} onClose={() => setAdding(false)} />}
    </div>
  );
}
