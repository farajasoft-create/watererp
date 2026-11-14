'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';
import { heatClass, RatingBadge } from '@/modules/internalaudit/ui/shared';

interface Area { id: string; code: string; name: string; kind: string; owner?: string; description?: string; impact: number; likelihood: number; lastAuditedAt: string | null; active: boolean; score: number; rating: string; risks: number; dueAt: string | null; overdue: boolean }
interface Risk { id: string; code: string; title: string; category: string; universeId: string | null; owner?: string; cause?: string; consequence?: string; impact: number; likelihood: number; controls?: string; residualImpact: number; residualLikelihood: number; treatment: string; reviewDate?: string | null; status: string; inherentScore: number; inherentRating: string; residualScore: number; residualRating: string }
interface Cell { impact: number; likelihood: number; score: number; count: number; codes: string[] }
interface Heat { total: number; inherent: Cell[][]; residual: Cell[][] }

const KINDS = ['DEPARTMENT', 'PROCESS', 'SYSTEM', 'PROJECT', 'BRANCH', 'OTHER'];
const CATEGORIES = ['STRATEGIC', 'OPERATIONAL', 'FINANCIAL', 'COMPLIANCE', 'ICT', 'FRAUD', 'REPUTATIONAL'];
const SCALE = [1, 2, 3, 4, 5];
const ScoreSelect = ({ value, onChange }: { value: number; onChange: (n: number) => void }) => (
  <Select value={value} onChange={(e) => onChange(Number(e.target.value))}>{SCALE.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
);

function AreaForm({ area, onClose }: { area?: Area; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: area?.code ?? '', name: area?.name ?? '', kind: area?.kind ?? 'PROCESS', owner: area?.owner ?? '', description: area?.description ?? '', impact: area?.impact ?? 3, likelihood: area?.likelihood ?? 3, lastAuditedAt: area?.lastAuditedAt?.slice(0, 10) ?? '', active: area?.active ?? true });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, owner: f.owner || undefined, description: f.description || undefined, lastAuditedAt: f.lastAuditedAt || null };
      return area ? api.put(`/universe/${area.id}`, body) : api.post('/universe', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-universe'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={area ? `Edit ${area.code}` : 'New auditable area'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={20} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Owner"><Input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} placeholder="Commercial manager" /></Field>
        <Field label="Last audited"><Input type="date" value={f.lastAuditedAt} onChange={(e) => setF({ ...f, lastAuditedAt: e.target.value })} /></Field>
        <Field label="Impact (1–5)" hint="Used until the area has risks in the register"><ScoreSelect value={f.impact} onChange={(impact) => setF({ ...f, impact })} /></Field>
        <Field label="Likelihood (1–5)"><ScoreSelect value={f.likelihood} onChange={(likelihood) => setF({ ...f, likelihood })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {area && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Still auditable</label>}
      </div>
    </Modal>
  );
}

function RiskForm({ risk, areas, onClose }: { risk?: Risk; areas: Area[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: risk?.code ?? '',
    title: risk?.title ?? '',
    category: risk?.category ?? 'OPERATIONAL',
    universeId: risk?.universeId ?? '',
    owner: risk?.owner ?? '',
    cause: risk?.cause ?? '',
    consequence: risk?.consequence ?? '',
    impact: risk?.impact ?? 3,
    likelihood: risk?.likelihood ?? 3,
    controls: risk?.controls ?? '',
    residualImpact: risk?.residualImpact ?? 3,
    residualLikelihood: risk?.residualLikelihood ?? 2,
    treatment: risk?.treatment ?? 'REDUCE',
    reviewDate: risk?.reviewDate?.slice(0, 10) ?? '',
    status: risk?.status ?? 'OPEN',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, universeId: f.universeId || null, reviewDate: f.reviewDate || null, owner: f.owner || undefined, cause: f.cause || undefined, consequence: f.consequence || undefined, controls: f.controls || undefined };
      return risk ? api.put(`/risks/${risk.id}`, body) : api.post('/risks', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-risks'] });
      qc.invalidateQueries({ queryKey: ['ia-heat'] });
      qc.invalidateQueries({ queryKey: ['ia-universe'] });
      onClose();
    },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title={risk ? `Edit ${risk.code}` : 'New risk'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || f.title.length < 3}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={20} /></Field>
        <Field label="Category"><Select value={f.category} onChange={t('category')}>{CATEGORIES.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
        <Field label="Area"><Select value={f.universeId} onChange={t('universeId')}><option value="">Organisation-wide</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label="Risk" className="sm:col-span-3"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Cause"><Textarea rows={2} value={f.cause} onChange={t('cause')} /></Field>
        <Field label="Consequence"><Textarea rows={2} value={f.consequence} onChange={t('consequence')} /></Field>
        <Field label="Risk owner"><Input value={f.owner} onChange={t('owner')} /></Field>
        <Field label="Inherent impact"><ScoreSelect value={f.impact} onChange={(impact) => setF({ ...f, impact })} /></Field>
        <Field label="Inherent likelihood"><ScoreSelect value={f.likelihood} onChange={(likelihood) => setF({ ...f, likelihood })} /></Field>
        <div className="self-end pb-2 text-sm">Inherent <b>{f.impact * f.likelihood}</b></div>
        <Field label="Controls in place" className="sm:col-span-3"><Textarea rows={2} value={f.controls} onChange={t('controls')} /></Field>
        <Field label="Residual impact"><ScoreSelect value={f.residualImpact} onChange={(residualImpact) => setF({ ...f, residualImpact })} /></Field>
        <Field label="Residual likelihood"><ScoreSelect value={f.residualLikelihood} onChange={(residualLikelihood) => setF({ ...f, residualLikelihood })} /></Field>
        <div className="self-end pb-2 text-sm">Residual <b>{f.residualImpact * f.residualLikelihood}</b></div>
        <Field label="Treatment"><Select value={f.treatment} onChange={t('treatment')}>{['ACCEPT', 'REDUCE', 'TRANSFER', 'AVOID'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
        <Field label="Next review"><Input type="date" value={f.reviewDate} onChange={t('reviewDate')} /></Field>
        {risk && <Field label="Status"><Select value={f.status} onChange={t('status')}><option value="OPEN">Open</option><option value="CLOSED">Closed</option></Select></Field>}
      </div>
    </Modal>
  );
}

function HeatGrid({ title, grid }: { title: string; grid: Cell[][] }) {
  return (
    <Card title={title}>
      <div className="flex gap-2">
        <div className="flex items-center"><span className="-rotate-90 whitespace-nowrap text-xs text-muted">Impact →</span></div>
        <div className="flex-1">
          <div className="grid grid-cols-5 gap-1">
            {grid.flat().map((c) => (
              <div key={`${c.impact}-${c.likelihood}`} title={c.codes.join(', ') || 'No risks'} className={`flex aspect-square flex-col items-center justify-center rounded text-sm font-semibold ${heatClass(c.score)} ${c.count ? '' : 'opacity-50'}`}>
                {c.count || ''}
              </div>
            ))}
          </div>
          <div className="mt-1 text-center text-xs text-muted">Likelihood →</div>
        </div>
      </div>
    </Card>
  );
}

export default function UniversePage() {
  const can = useCan();
  const manage = can('internalaudit.plan.manage');
  const [tab, setTab] = useState<'universe' | 'risks' | 'heat'>('universe');
  const [area, setArea] = useState<Area | 'new' | null>(null);
  const [risk, setRisk] = useState<Risk | 'new' | null>(null);
  const universe = useQuery({ queryKey: ['ia-universe'], queryFn: () => api.get<Area[]>('/universe') });
  const risks = useQuery({ queryKey: ['ia-risks'], queryFn: () => api.get<Risk[]>('/risks'), enabled: tab === 'risks' });
  const heat = useQuery({ queryKey: ['ia-heat'], queryFn: () => api.get<Heat>('/risks/heat-map'), enabled: tab === 'heat' });
  const areaName = (id: string | null) => universe.data?.find((a) => a.id === id)?.code ?? 'All';
  return (
    <>
      <PageHeader
        title="Audit universe and risks"
        subtitle="What can be audited, how risky each area is, and when it is next due"
        actions={manage && (tab === 'universe' ? <Button onClick={() => setArea('new')}>Add area</Button> : tab === 'risks' ? <Button onClick={() => setRisk('new')}>Add risk</Button> : null)}
      />
      <Tabs tabs={[{ id: 'universe', label: 'Audit universe' }, { id: 'risks', label: 'Risk register' }, { id: 'heat', label: 'Heat map' }]} value={tab} onChange={setTab} />
      <ErrorBox error={universe.error || risks.error || heat.error} />
      {tab === 'universe' && (
        <Card padded={false}>
          {universe.isLoading ? <Loading /> : !universe.data?.length ? <Empty>No auditable areas yet. Add departments, processes and systems.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Code</th><th>Area</th><th>Kind</th><th className="num">Score</th><th>Risk</th><th className="num">Risks</th><th>Last audited</th><th>Next due</th></tr></thead>
                <tbody>
                  {universe.data.map((a) => (
                    <tr key={a.id} className={a.active ? '' : 'text-muted'}>
                      <td>{manage ? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setArea(a)}>{a.code}</button> : a.code}</td>
                      <td>{a.name}<div className="text-xs text-muted">{a.owner}</div></td>
                      <td>{label(a.kind)}</td>
                      <td className="num">{a.score}</td>
                      <td><RatingBadge r={a.rating} /></td>
                      <td className="num">{a.risks}</td>
                      <td>{a.lastAuditedAt ? fmtDate(a.lastAuditedAt) : 'Never'}</td>
                      <td>{a.dueAt ? fmtDate(a.dueAt) : '—'} {a.overdue && <Badge tone="red">due</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {tab === 'risks' && (
        <Card padded={false}>
          {risks.isLoading ? <Loading /> : !risks.data?.length ? <Empty>The risk register is empty.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Code</th><th>Risk</th><th>Area</th><th>Category</th><th className="num">Inherent</th><th className="num">Residual</th><th>Treatment</th><th>Review</th></tr></thead>
                <tbody>
                  {risks.data.map((r) => (
                    <tr key={r.id} className={r.status === 'OPEN' ? '' : 'text-muted'}>
                      <td>{manage ? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setRisk(r)}>{r.code}</button> : r.code}</td>
                      <td>{r.title}<div className="text-xs text-muted">{r.owner}</div></td>
                      <td>{areaName(r.universeId)}</td>
                      <td>{label(r.category)}</td>
                      <td className="num">{r.inherentScore} <RatingBadge r={r.inherentRating} /></td>
                      <td className="num">{r.residualScore} <RatingBadge r={r.residualRating} /></td>
                      <td>{label(r.treatment)}</td>
                      <td>{r.reviewDate ? fmtDate(r.reviewDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {tab === 'heat' && (heat.isLoading ? <Loading /> : heat.data && (
        <>
          <p className="mb-3 text-sm text-muted">{heat.data.total} open risks. Each cell counts the risks at that impact and likelihood; hover to see which.</p>
          <div className="grid gap-5 md:grid-cols-2">
            <HeatGrid title="Inherent risk (before controls)" grid={heat.data.inherent} />
            <HeatGrid title="Residual risk (after controls)" grid={heat.data.residual} />
          </div>
        </>
      ))}
      {area && <AreaForm area={area === 'new' ? undefined : area} onClose={() => setArea(null)} />}
      {risk && <RiskForm risk={risk === 'new' ? undefined : risk} areas={universe.data ?? []} onClose={() => setRisk(null)} />}
    </>
  );
}
