'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, ErrorBanner, Field, Input, Notice, Select, Textarea } from '../ui';

interface Evaluation {
  status: 'OPEN' | 'COMPLETED';
  committee: { userId: string; name: string; role: 'CHAIR' | 'SECRETARY' | 'MEMBER'; signedAt: string | null }[];
  criteria: { name: string; weight: number }[];
  passMark: number;
  financialWeight: number;
  functionalCurrency: string;
  rows: { supplierId: string; supplierName: string; criteria: { name: string; average: number | null }[]; technical: number | null; responsive: boolean; price: string | null; financial: number | null; combined: number | null; rank: number | null }[];
  pending: { member: string; supplier: string }[];
  recommendedSupplierId: string | null;
  recommendation: string;
  completedAt: string | null;
  mine: { supplierId: string; criterion: string; score: number; comment: string }[];
}
const ROLE = { CHAIR: 'Chair', SECRETARY: 'Secretary', MEMBER: 'Member' } as const;
const n = (v: number | null) => (v === null ? '—' : v.toFixed(2));

/** Committee evaluation of the bids on a request for quotes. */
export function EvaluationPanel({ rfqId, status, bidders }: { rfqId: string; status: string; bidders: { supplierId: string; supplierName: string }[] }) {
  const { me, can } = useSession();
  const precision = usePrecision();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['rfq-evaluation', rfqId], queryFn: () => api.get<{ evaluation: Evaluation | null }>(`/rfqs/${rfqId}/evaluation`) });
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<null | { members: { userId: string; role: keyof typeof ROLE }[]; criteria: { name: string; weight: string }[]; passMark: string; financialWeight: string }>(null);
  const [scoring, setScoring] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, { score: string; comment: string }>>({});
  const [recommendation, setRecommendation] = useState('');
  const directory = useQuery({ queryKey: ['directory-users'], queryFn: () => api.get<{ users: { id: string; name: string }[] }>('/directory').then((d) => d.users), enabled: !!setup });
  const refresh = () => ['rfq-evaluation', 'rfq'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const ev = data?.evaluation ?? null;
  const fp = precision(ev?.functionalCurrency);
  const me_ = ev?.committee.find((m) => m.userId === me.id);

  const appoint = useMutation({
    mutationFn: () => api.post(`/rfqs/${rfqId}/committee`, { members: setup!.members.filter((m) => m.userId), criteria: setup!.criteria.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), weight: Number(c.weight) })), passMark: Number(setup!.passMark), financialWeight: Number(setup!.financialWeight) }),
    onSuccess: () => (setSetup(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const score = useMutation({
    mutationFn: () => api.post(`/rfqs/${rfqId}/evaluation/scores`, { supplierId: scoring, scores: ev!.criteria.map((c) => ({ criterion: c.name, score: Number(scores[c.name]?.score || 0), comment: scores[c.name]?.comment || undefined })) }),
    onSuccess: () => (setScoring(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const complete = useMutation({
    mutationFn: () => api.post(`/rfqs/${rfqId}/evaluation/complete`, { recommendation: recommendation || undefined }),
    onSuccess: () => (setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const startScoring = (supplierId: string) => {
    const mine = ev!.mine.filter((s) => s.supplierId === supplierId);
    setScores(Object.fromEntries(ev!.criteria.map((c) => [c.name, { score: String(mine.find((s) => s.criterion === c.name)?.score ?? ''), comment: mine.find((s) => s.criterion === c.name)?.comment ?? '' }])));
    setScoring(supplierId);
  };

  if (!ev && !(can('procurement.approve') && ['SENT', 'CLOSED'].includes(status))) return null;
  return (
    <Card title="Evaluation committee">
      <div className="space-y-3 text-sm">
        <ErrorBanner error={error} />
        {!ev && !setup && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted">Appoint at least three members and set the evaluation criteria before the bids are opened.</p>
            <Button size="sm" onClick={() => setSetup({ members: [{ userId: '', role: 'CHAIR' }, { userId: '', role: 'SECRETARY' }, { userId: '', role: 'MEMBER' }], criteria: [{ name: 'Experience', weight: '40' }, { name: 'Technical capacity', weight: '60' }], passMark: '70', financialWeight: '30' })}>Appoint committee</Button>
          </div>
        )}
        {setup && (
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase text-muted">Members</p>
            {setup.members.map((m, i) => (
              <div key={i} className="flex gap-2">
                <Select className="flex-1" value={m.userId} onChange={(e) => setSetup({ ...setup, members: setup.members.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)) })} aria-label="Member">
                  <option value="">Choose a person…</option>
                  {directory.data?.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                </Select>
                <Select className="w-32" value={m.role} onChange={(e) => setSetup({ ...setup, members: setup.members.map((x, j) => (j === i ? { ...x, role: e.target.value as keyof typeof ROLE } : x)) })} aria-label="Role">
                  {Object.entries(ROLE).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
                </Select>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSetup({ ...setup, members: [...setup.members, { userId: '', role: 'MEMBER' }] })}>+ Member</Button>
            <p className="text-xs font-semibold uppercase text-muted">Technical criteria (weights add up to 100)</p>
            {setup.criteria.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input className="flex-1" value={c.name} onChange={(e) => setSetup({ ...setup, criteria: setup.criteria.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Criterion" />
                <Input className="w-20 text-right" value={c.weight} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setSetup({ ...setup, criteria: setup.criteria.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)) })} aria-label="Weight" />
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSetup({ ...setup, criteria: [...setup.criteria, { name: '', weight: '' }] })}>+ Criterion</Button>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Technical pass mark %"><Input value={setup.passMark} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setSetup({ ...setup, passMark: e.target.value })} /></Field>
              <Field label="Weight given to price %" hint="0: the lowest-priced bid that passes wins"><Input value={setup.financialWeight} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setSetup({ ...setup, financialWeight: e.target.value })} /></Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setSetup(null)}>Cancel</Button>
              <Button size="sm" variant="primary" loading={appoint.isPending} onClick={() => appoint.mutate()}>Appoint</Button>
            </div>
          </div>
        )}
        {ev && (
          <>
            <p>
              {ev.committee.map((m) => `${m.name} (${ROLE[m.role]})`).join(', ')} · pass mark {ev.passMark}% · price {ev.financialWeight}%{' '}
              {ev.status === 'COMPLETED' ? <Badge tone="green">Completed {ev.completedAt && formatDate(ev.completedAt)}</Badge> : <Badge tone="amber">In progress</Badge>}
            </p>
            {status === 'SENT' && ev.status === 'OPEN' && <Notice tone="blue">Scoring opens once the request for quotes is closed.</Notice>}
            <table className="table-base">
              <thead>
                <tr><th>Bidder</th>{ev.criteria.map((c) => (<th key={c.name} className="num">{c.name} ({c.weight})</th>))}<th className="num">Technical</th><th className="num">Price ({ev.functionalCurrency})</th><th className="num">Combined</th><th className="num">Rank</th><th /></tr>
              </thead>
              <tbody>
                {ev.rows.map((r) => (
                  <tr key={r.supplierId} className={r.supplierId === ev.recommendedSupplierId && ev.status === 'COMPLETED' ? 'bg-emerald-50' : ''}>
                    <td>{r.supplierName}{r.technical !== null && !r.responsive && <Badge tone="red">Below pass mark</Badge>}</td>
                    {r.criteria.map((c) => (<td key={c.name} className="num">{n(c.average)}</td>))}
                    <td className="num">{n(r.technical)}</td>
                    <td className="num">{r.price ? formatAmount(r.price, fp) : '—'}</td>
                    <td className="num">{n(r.combined)}</td>
                    <td className="num">{r.rank ?? '—'}</td>
                    <td className="text-right">{me_ && ev.status === 'OPEN' && status === 'CLOSED' && <Button size="sm" variant="ghost" onClick={() => startScoring(r.supplierId)}>{ev.mine.some((s) => s.supplierId === r.supplierId) ? 'Rescore' : 'Score'}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ev.status === 'OPEN' && ev.pending.length > 0 && <p className="text-xs text-muted">Still to score: {ev.pending.map((p) => `${p.member} → ${p.supplier}`).join('; ')}</p>}
            {scoring && (
              <div className="space-y-2 rounded border border-line p-3">
                <p className="font-medium">Your scores for {bidders.find((b) => b.supplierId === scoring)?.supplierName ?? ev.rows.find((r) => r.supplierId === scoring)?.supplierName} (out of 100)</p>
                {ev.criteria.map((c) => (
                  <div key={c.name} className="grid gap-2 sm:grid-cols-[12rem_6rem_1fr]">
                    <span className="self-center">{c.name}</span>
                    <Input value={scores[c.name]?.score ?? ''} onChange={(e) => /^\d{0,3}(\.\d{0,2})?$/.test(e.target.value) && setScores({ ...scores, [c.name]: { ...scores[c.name], score: e.target.value } })} aria-label={`${c.name} score`} />
                    <Input placeholder="Comment" value={scores[c.name]?.comment ?? ''} onChange={(e) => setScores({ ...scores, [c.name]: { ...scores[c.name], comment: e.target.value } })} aria-label={`${c.name} comment`} />
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setScoring(null)}>Cancel</Button>
                  <Button size="sm" variant="primary" loading={score.isPending} onClick={() => score.mutate()}>Save scores</Button>
                </div>
              </div>
            )}
            {me_?.role === 'CHAIR' && ev.status === 'OPEN' && status === 'CLOSED' && (
              <div className="space-y-2">
                <Field label="Recommendation notes"><Textarea rows={2} value={recommendation} onChange={(e) => setRecommendation(e.target.value)} /></Field>
                <Button size="sm" variant="primary" disabled={ev.pending.length > 0} loading={complete.isPending} onClick={() => complete.mutate()}>Complete evaluation</Button>
              </div>
            )}
            <Button size="sm" onClick={() => window.open(`/api/v1/finance/rfqs/${rfqId}/evaluation/report`, '_blank', 'noopener')}>Evaluation report (PDF)</Button>
          </>
        )}
      </div>
    </Card>
  );
}
