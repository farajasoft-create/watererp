'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Modal, Money, Notice, PageHeader, Stat } from '@/components/ui';
import { fmtDate, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/projects/ui/api';
import { MonthlyBars, Progress } from '@/modules/projects/ui/shared';

interface Grant {
  id: string;
  code: string;
  title: string;
  currency: string;
  status: string;
  agreementRef?: string;
  startDate?: string;
  endDate?: string;
  fundCode?: string;
  reportingFrequency: string;
  conditions?: string;
  donor: { name: string; type: string } | null;
  projects: { id: string; code: string; name: string; status: string }[];
  disbursements: { id: string; date: string; amount: string; reference?: string }[];
  position: { fundLinked: boolean; amount: string; received: string; spent: string; cashBalance: string; undrawn: string; remaining: string; absorptionPct: number | null; timeElapsedPct: number | null; monthlyBurn: string | null; pace: string | null; budget: { code: string; name: string; budget: string; spent: string; remaining: string; usedPct: number | null; overspent: boolean }[]; unallocated: string; monthly: { month: string; amount: number }[] };
}

function Transactions({ id, line, onClose }: { id: string; line: string | null; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({ queryKey: ['projects-tx', id, line], queryFn: () => api.get<{ date: string; journal: string; description: string; account: string; amount: string }[]>(`/grants/${id}/transactions`, line ? { line } : {}) });
  return (
    <Modal open wide onClose={onClose} title={line ? `Postings: ${line}` : 'All postings'}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No postings.</Empty> : (
        <table className="table-base"><thead><tr><th>Date</th><th>Journal</th><th>Account</th><th>Description</th><th className="num">Amount</th></tr></thead><tbody>{data.map((t, i) => <tr key={i}><td>{fmtDate(t.date)}</td><td>{t.journal}</td><td>{t.account}</td><td>{t.description}</td><td className="num"><Money value={t.amount} /></td></tr>)}</tbody></table>
      )}
    </Modal>
  );
}

export default function GrantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const can = useCan();
  const [drill, setDrill] = useState<string | null | undefined>(undefined);
  const [r, setR] = useState({ date: today(), amount: '', reference: '' });
  const { data: g, error, isLoading } = useQuery({ queryKey: ['projects-grant', id], queryFn: () => api.get<Grant>(`/grants/${id}`) });
  const receive = useMutation({ mutationFn: () => api.post(`/grants/${id}/disbursements`, { ...r, reference: r.reference || undefined }), onSuccess: () => { setR({ date: today(), amount: '', reference: '' }); qc.invalidateQueries({ queryKey: ['projects-grant', id] }); } });
  if (isLoading) return <Loading />;
  if (!g) return <ErrorBox error={error} />;
  const s = g.position;
  return (
    <>
      <PageHeader
        title={`${g.code} · ${g.title}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge value={g.status} /> {g.donor?.name} · {g.currency}{g.agreementRef && ` · ${g.agreementRef}`}{g.startDate && ` · ${fmtDate(g.startDate)} – ${fmtDate(g.endDate ?? null)}`} · reports {label(g.reportingFrequency).toLowerCase()}</span>}
        actions={<div className="flex gap-2 text-sm">{['xls', 'pdf', 'doc', 'csv'].map((f) => <a key={f} href={`/api/v1/projects/grants/${id}/report/${f}`} className="text-brand-700 hover:underline">{f === 'xls' ? 'Excel' : f === 'doc' ? 'Word' : f.toUpperCase()}</a>)}</div>}
      />
      {!s.fundLinked && <div className="mb-4"><Notice tone="amber">No FUND dimension {g.fundCode ?? '(not set)'} in Finance yet; tag the grant&apos;s postings with it to see spending here.</Notice></div>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="Grant" value={<Money value={s.amount} />} />
        <Stat label="Received" value={<Money value={s.received} />} hint={`${Number(s.undrawn).toLocaleString('en-KE')} still to come`} />
        <Stat label="Spent" value={<Money value={s.spent} />} />
        <Stat label="Cash held" value={<Money value={s.cashBalance} />} tone={Number(s.cashBalance) < 0 ? 'warn' : undefined} hint={Number(s.cashBalance) < 0 ? 'pre-financed from own funds' : undefined} />
        <Stat label="Absorbed" value={s.absorptionPct === null ? '—' : `${s.absorptionPct}%`} hint={s.timeElapsedPct !== null ? `${s.timeElapsedPct}% of the time used` : undefined} tone={s.pace === 'BEHIND' ? 'warn' : undefined} />
        <Stat label="Monthly burn" value={s.monthlyBurn ? <Money value={s.monthlyBurn} /> : '—'} />
        <Stat label="Unspent" value={<Money value={s.remaining} />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card padded={false} title="Budget against actual" actions={<Button variant="secondary" onClick={() => setDrill(null)}>All postings</Button>}>
          {!s.budget.length ? <Empty>No budget lines.</Empty> : (
            <table className="table-base">
              <thead><tr><th>Line</th><th className="num">Budget</th><th className="num">Spent</th><th className="num">Remaining</th><th>Used</th></tr></thead>
              <tbody>
                {s.budget.map((b) => (
                  <tr key={b.code} className="cursor-pointer hover:bg-slate-50" onClick={() => setDrill(b.code)}>
                    <td>{b.code} {b.name}{b.overspent && <> <Badge tone="red">over</Badge></>}</td>
                    <td className="num"><Money value={b.budget} /></td>
                    <td className="num"><Money value={b.spent} /></td>
                    <td className="num"><Money value={b.remaining} /></td>
                    <td><Progress value={b.usedPct} /></td>
                  </tr>
                ))}
                {Number(s.unallocated) !== 0 && <tr><td className="text-amber-800">Not in any budget line</td><td /><td className="num"><Money value={s.unallocated} /></td><td /><td /></tr>}
              </tbody>
            </table>
          )}
          <p className="p-2 text-xs text-muted">Click a line to see the postings behind it.</p>
        </Card>
        <Card title="Spending by month"><MonthlyBars rows={s.monthly} /></Card>
        <Card padded={false} title="Receipts from the donor">
          {!g.disbursements.length ? <Empty>Nothing received yet.</Empty> : (
            <table className="table-base"><thead><tr><th>Date</th><th>Reference</th><th className="num">Amount</th></tr></thead><tbody>{g.disbursements.map((d) => <tr key={d.id}><td>{fmtDate(d.date)}</td><td>{d.reference}</td><td className="num"><Money value={d.amount} /></td></tr>)}</tbody></table>
          )}
          {can('projects.manage') && (
            <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-4">
              <ErrorBox error={receive.error} />
              <Input type="date" value={r.date} onChange={(e) => setR({ ...r, date: e.target.value })} />
              <Input placeholder="Amount" inputMode="decimal" value={r.amount} onChange={(e) => setR({ ...r, amount: e.target.value })} />
              <Input placeholder="Reference" value={r.reference} onChange={(e) => setR({ ...r, reference: e.target.value })} />
              <Button onClick={() => receive.mutate()} disabled={!Number(r.amount) || receive.isPending}>Record receipt</Button>
            </div>
          )}
        </Card>
        <Card title="Projects funded">
          {!g.projects.length ? <p className="text-sm text-muted">None linked yet.</p> : <ul className="space-y-1 text-sm">{g.projects.map((p) => <li key={p.id}><Link href={`/projects/${p.id}`} className="text-brand-700 hover:underline">{p.code}</Link> {p.name} <Badge value={p.status} /></li>)}</ul>}
          {g.conditions && <p className="mt-3 whitespace-pre-wrap text-xs text-muted"><b>Conditions:</b> {g.conditions}</p>}
        </Card>
      </div>
      {drill !== undefined && <Transactions id={id} line={drill} onClose={() => setDrill(undefined)} />}
    </>
  );
}
