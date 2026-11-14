'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/projects/ui/api';
import { Progress } from '@/modules/projects/ui/shared';

interface Donor { id: string; name: string; type: string; contactName?: string; email?: string; phone?: string; portalEnabled: boolean }
interface Grant { id: string; code: string; title: string; donor: string; currency: string; status: string; startDate?: string; endDate?: string; fundCode?: string; position: { fundLinked: boolean; amount: string; received: string; spent: string; absorptionPct: number | null; timeElapsedPct: number | null; pace: string | null } }
const TYPES = ['BILATERAL', 'MULTILATERAL', 'GOVERNMENT', 'NGO', 'PRIVATE', 'OTHER'];

function DonorForm({ d, onClose }: { d?: Donor; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: d?.name ?? '', type: d?.type ?? 'MULTILATERAL', contactName: d?.contactName ?? '', email: d?.email ?? '', phone: d?.phone ?? '' });
  const save = useMutation({ mutationFn: () => (d ? api.put(`/donors/${d.id}`, f) : api.post('/donors', f)), onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects-donors'] }); onClose(); } });
  return (
    <Modal open onClose={onClose} title={d ? `Edit ${d.name}` : 'New donor'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
        <Field label="Contact person"><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function GrantForm({ donors, onClose }: { donors: Donor[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ donorId: donors[0]?.id ?? '', code: '', title: '', agreementRef: '', currency: 'KES', amount: '', startDate: '', endDate: '', fundCode: '', reportingFrequency: 'QUARTERLY', conditions: '' });
  const [lines, setLines] = useState([{ code: '', name: '', amount: '', prefixes: '' }]);
  const save = useMutation({
    mutationFn: () => api.post('/grants', { ...f, agreementRef: f.agreementRef || undefined, conditions: f.conditions || undefined, fundCode: f.fundCode || undefined, startDate: f.startDate || null, endDate: f.endDate || null, amount: f.amount || '0', budgetLines: lines.filter((l) => l.code && l.name).map((l) => ({ code: l.code, name: l.name, amount: l.amount || '0', accountPrefixes: l.prefixes.split(/[\s,]+/).filter(Boolean) })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects-grants'] }); onClose(); },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Modal open wide onClose={onClose} title="New grant" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.donorId || !f.code || f.title.length < 3}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Donor"><Select value={f.donorId} onChange={t('donorId')}>{donors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Agreement reference"><Input value={f.agreementRef} onChange={t('agreementRef')} /></Field>
        <Field label="Title" className="sm:col-span-3"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Amount"><Input inputMode="decimal" value={f.amount} onChange={t('amount')} /></Field>
        <Field label="Currency"><Input value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
        <Field label="Finance fund code" hint="The FUND dimension spending is tagged with"><Input value={f.fundCode} onChange={(e) => setF({ ...f, fundCode: e.target.value.toUpperCase() })} /></Field>
        <Field label="Starts"><Input type="date" value={f.startDate} onChange={t('startDate')} /></Field>
        <Field label="Ends"><Input type="date" value={f.endDate} onChange={t('endDate')} /></Field>
        <Field label="Reports due"><Select value={f.reportingFrequency} onChange={t('reportingFrequency')}>{['MONTHLY', 'QUARTERLY', 'BIANNUAL', 'ANNUAL'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select></Field>
        <Field label="Conditions" className="sm:col-span-3"><Textarea rows={2} value={f.conditions} onChange={t('conditions')} /></Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Budget lines (each covers ledger accounts whose code starts with the prefixes)</div>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[100px_2fr_1fr_1fr_auto]">
            <Input placeholder="Code" value={l.code} onChange={(e) => set(i, 'code', e.target.value.toUpperCase())} />
            <Input placeholder="Line" value={l.name} onChange={(e) => set(i, 'name', e.target.value)} />
            <Input placeholder="Amount" value={l.amount} onChange={(e) => set(i, 'amount', e.target.value)} />
            <Input placeholder="Account prefixes, e.g. 15, 61" value={l.prefixes} onChange={(e) => set(i, 'prefixes', e.target.value)} />
            <Button variant="secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">✕</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setLines([...lines, { code: '', name: '', amount: '', prefixes: '' }])}>Add a line</Button>
      </div>
    </Modal>
  );
}

function DonorPortal({ d }: { d: Donor }) {
  const qc = useQueryClient();
  const [path, setPath] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (enable: boolean) => api.post<{ path: string | null }>(`/donors/${d.id}/portal`, { enable }), onSuccess: (r) => { setPath(r.path); qc.invalidateQueries({ queryKey: ['projects-donors'] }); } });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => toggle.mutate(true)} disabled={toggle.isPending}>{d.portalEnabled ? 'New link' : 'Give a portal link'}</Button>
        {d.portalEnabled && <Button variant="secondary" onClick={() => toggle.mutate(false)} disabled={toggle.isPending}>Withdraw</Button>}
      </div>
      {path && <Input readOnly value={`${origin}${path}`} onFocus={(e) => e.target.select()} />}
    </div>
  );
}

export default function GrantsPage() {
  const can = useCan();
  const donors = useQuery({ queryKey: ['projects-donors'], queryFn: () => api.get<Donor[]>('/donors') });
  const { data, error, isLoading } = useQuery({ queryKey: ['projects-grants'], queryFn: () => api.get<Grant[]>('/grants') });
  const [donor, setDonor] = useState<Donor | 'new' | null>(null);
  const [grant, setGrant] = useState(false);
  const manage = can('projects.manage');
  return (
    <>
      <PageHeader title="Grants and donors" subtitle="Donor funds received and spent, against each agreed budget line" actions={manage && <><Button variant="secondary" onClick={() => setDonor('new')}>New donor</Button><Button onClick={() => setGrant(true)} disabled={!donors.data?.length}>New grant</Button></>} />
      <ErrorBox error={error || donors.error} />
      <Card padded={false} title="Grants" className="mb-5">
        {isLoading ? <Loading /> : !data?.length ? <Empty>No grants yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Grant</th><th>Donor</th><th>Status</th><th>Period</th><th className="num">Amount</th><th className="num">Received</th><th className="num">Spent</th><th>Absorbed</th><th>Pace</th></tr></thead>
              <tbody>
                {data.map((g) => (
                  <tr key={g.id}>
                    <td><Link href={`/projects/grants/${g.id}`} className="font-medium text-brand-700 hover:underline">{g.code}</Link> {g.title}{!g.position.fundLinked && <div className="text-xs text-amber-800">No finance fund {g.fundCode ?? ''} yet</div>}</td>
                    <td>{g.donor}</td>
                    <td><Badge value={g.status} /></td>
                    <td>{g.startDate ? `${fmtDate(g.startDate)} – ${fmtDate(g.endDate ?? null)}` : '—'}</td>
                    <td className="num">{g.currency} <Money value={g.position.amount} /></td>
                    <td className="num"><Money value={g.position.received} /></td>
                    <td className="num"><Money value={g.position.spent} /></td>
                    <td><Progress value={g.position.absorptionPct} against={g.position.timeElapsedPct} /></td>
                    <td>{g.position.pace ? <Badge tone={g.position.pace === 'BEHIND' ? 'amber' : g.position.pace === 'AHEAD' ? 'blue' : 'green'}>{label(g.position.pace)}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card padded={false} title="Donors">
        {!donors.data?.length ? <Empty>No donors yet.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Donor</th><th>Type</th><th>Contact</th>{manage && <th>Donor portal</th>}</tr></thead>
            <tbody>
              {donors.data.map((d) => (
                <tr key={d.id}>
                  <td>{manage ? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setDonor(d)}>{d.name}</button> : d.name}</td>
                  <td>{label(d.type)}</td>
                  <td className="text-sm">{[d.contactName, d.email, d.phone].filter(Boolean).join(' · ')}</td>
                  {manage && <td><DonorPortal d={d} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {manage && <div className="p-3"><Notice>A portal link lets the donor see their grants, receipts, budget against actual, projects and KPIs, read-only and live. The link is shown once; withdrawing it stops it working.</Notice></div>}
      </Card>
      {donor && <DonorForm d={donor === 'new' ? undefined : donor} onClose={() => setDonor(null)} />}
      {grant && donors.data && <GrantForm donors={donors.data} onClose={() => setGrant(false)} />}
    </>
  );
}
