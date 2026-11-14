'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount } from '@/modules/finance/ui/lib/format';
import { useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { FiscalYear } from '@/modules/finance/ui/lib/types';
import { downloadCsv } from './report-filters';
import { Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, TableWrap, Textarea } from './ui';

interface Kpi { id: string; indicator: string; unit: string; baseline: string; target: string }
interface Programme { id: string; code: string; name: string; parentId: string | null; objective: string; outcome: string; departmentIds: string[]; projectIds: string[]; kpis: (Kpi & { actuals: { fiscalYearId: string; quarter: number; value: string }[] })[]; isActive: boolean }
interface Line {
  id: string;
  code: string;
  name: string;
  objective: string;
  budget: string;
  actual: string;
  balance: string;
  absorptionPercent: string | null;
  kpis: { id: string; indicator: string; unit: string; baseline: string; target: string; quarters: { quarter: number; value: string }[]; latest: string | null }[];
}
interface Report { currency: string; budget: { name: string } | null; rows: (Line & { subProgrammes: Line[] })[]; unallocated: { budget: string; actual: string }; totals: { budget: string; actual: string } }

type Form = { id?: string; code: string; name: string; parentId: string; objective: string; outcome: string; departmentIds: string[]; projectIds: string[]; kpis: Kpi[]; isActive: boolean };

export function ProgrammesPage() {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const qc = useQueryClient();
  const fp = precision(entity?.functionalCurrency);
  const { data: dimensions = [] } = useDimensions();
  const years = useQuery({ queryKey: ['fiscal-years', entity?.id], queryFn: () => api.get<FiscalYear[]>('/fiscal-years', { entityId: entity!.id }), enabled: !!entity });
  const [yearId, setYearId] = useState('');
  const fy = years.data?.find((y) => y.id === yearId) ?? years.data?.[0];
  const list = useQuery({ queryKey: ['programmes'], queryFn: () => api.get<Programme[]>('/programmes') });
  const report = useQuery({ queryKey: ['programme-report', entity?.id, fy?.id], queryFn: () => api.get<Report>('/reports/programmes', { entityId: entity!.id, fiscalYearId: fy!.id }), enabled: !!fy });
  const [form, setForm] = useState<Form | null>(null);
  const [kpiFor, setKpiFor] = useState<null | { programmeId: string; kpi: Line['kpis'][number] }>(null);
  const [kpiValue, setKpiValue] = useState({ quarter: 1, value: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => ['programmes', 'programme-report'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const departments = dimensions.filter((d) => d.type === 'DEPARTMENT' && d.isActive);
  const projects = dimensions.filter((d) => d.type === 'PROJECT' && d.isActive);
  const top = (list.data ?? []).filter((p) => !p.parentId);
  const amt = (v: string) => formatAmount(v, fp, { parens: true });

  const save = useMutation({
    mutationFn: () => {
      const { id, ...f } = form!;
      const body = { ...f, parentId: f.parentId || null, kpis: f.kpis.filter((k) => k.indicator.trim()).map((k) => ({ ...k, id: k.id || null })) };
      return id ? api.patch(`/programmes/${id}`, body) : api.post('/programmes', body);
    },
    onSuccess: () => (setForm(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const saveKpi = useMutation({
    mutationFn: () => api.post(`/programmes/${kpiFor!.programmeId}/kpis/${kpiFor!.kpi.id}`, { fiscalYearId: fy!.id, quarter: kpiValue.quarter, value: kpiValue.value, note: kpiValue.note || undefined }),
    onSuccess: () => (setKpiFor(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const open = (p?: Programme) => {
    setError(null);
    setForm(
      p
        ? { id: p.id, code: p.code, name: p.name, parentId: p.parentId ?? '', objective: p.objective, outcome: p.outcome, departmentIds: p.departmentIds, projectIds: p.projectIds, kpis: p.kpis.map((k) => ({ id: k.id, indicator: k.indicator, unit: k.unit, baseline: k.baseline, target: k.target })), isActive: p.isActive }
        : { code: '', name: '', parentId: '', objective: '', outcome: '', departmentIds: [], projectIds: [], kpis: [], isActive: true },
    );
  };
  const toggle = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  const row = (l: Line, sub: boolean) => (
    <Fragment key={l.id}>
      <tr className={sub ? '' : 'bg-gray-50 font-medium'}>
        <td className={sub ? 'pl-8' : ''}>
          <span className="font-mono text-xs">{l.code}</span> {l.name}
          {can('budgets.manage') && <button className="ml-2 text-xs text-accent hover:underline" onClick={() => open(list.data?.find((p) => p.id === l.id))}>Edit</button>}
        </td>
        <td className="num">{amt(l.budget)}</td>
        <td className="num">{amt(l.actual)}</td>
        <td className="num">{amt(l.balance)}</td>
        <td className="num">{l.absorptionPercent === null ? '—' : `${l.absorptionPercent}%`}</td>
      </tr>
      {l.kpis.map((k) => (
        <tr key={k.id} className="text-xs text-muted">
          <td className={sub ? 'pl-12' : 'pl-4'} colSpan={4}>
            KPI: {k.indicator}{k.unit ? ` (${k.unit})` : ''} · baseline {k.baseline || '—'} · target {k.target || '—'} · {k.quarters.length ? k.quarters.map((q) => `Q${q.quarter}: ${q.value}`).join(', ') : 'no results yet'}
          </td>
          <td className="text-right">
            {can('budgets.manage') && <button className="text-accent hover:underline" onClick={() => (setError(null), setKpiValue({ quarter: (k.quarters.at(-1)?.quarter ?? 0) + 1 > 4 ? 4 : (k.quarters.at(-1)?.quarter ?? 0) + 1, value: '', note: '' }), setKpiFor({ programmeId: l.id, kpi: k }))}>Report</button>}
          </td>
        </tr>
      ))}
    </Fragment>
  );

  return (
    <>
      <PageHeader
        title="Programmes"
        description="Programme-based budget: programmes and sub-programmes are delivered by departments and projects, whose budget and spending roll up to them, and each reports on its key performance indicators."
        actions={
          <>
            <Select className="w-40" value={fy?.id ?? ''} onChange={(e) => setYearId(e.target.value)} aria-label="Fiscal year">
              {years.data?.map((y) => (<option key={y.id} value={y.id}>{y.name}</option>))}
            </Select>
            {report.data && (
              <Button onClick={() => downloadCsv(`programme-budget-${fy?.name}.csv`, ['Code', 'Programme', 'Budget', 'Actual', 'Balance', 'Absorption %'], report.data!.rows.flatMap((r) => [r, ...r.subProgrammes]).map((r) => [r.code, r.name, r.budget, r.actual, r.balance, r.absorptionPercent]))}>Export CSV</Button>
            )}
            {can('budgets.manage') && <Button variant="primary" onClick={() => open()}>New programme</Button>}
          </>
        }
      />
      <ErrorBanner error={!form && !kpiFor ? error : null} className="mb-3" />
      <TableWrap>
        {report.isLoading || list.isLoading ? (
          <Loading />
        ) : !report.data?.rows.length ? (
          <Empty title="No programmes yet">Create programmes, then sub-programmes under them, and assign each the departments and projects that deliver it.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Programme</th><th className="num">Approved budget</th><th className="num">Actual</th><th className="num">Balance</th><th className="num">Absorption</th></tr></thead>
            <tbody>
              {report.data.rows.map((r) => [row(r, false), ...r.subProgrammes.map((s) => row(s, true))])}
              {(report.data.unallocated.budget !== '0' || report.data.unallocated.actual !== '0') && (
                <tr className="text-muted"><td>Not assigned to a programme</td><td className="num">{amt(report.data.unallocated.budget)}</td><td className="num">{amt(report.data.unallocated.actual)}</td><td /><td /></tr>
              )}
            </tbody>
            <tfoot><tr><td>Total{report.data.budget ? ` · ${report.data.budget.name}` : ' · no approved budget'}</td><td className="num">{amt(report.data.totals.budget)}</td><td className="num">{amt(report.data.totals.actual)}</td><td /><td /></tr></tfoot>
          </table>
        )}
      </TableWrap>

      <Modal open={!!kpiFor} onClose={() => setKpiFor(null)} title={kpiFor ? `Report: ${kpiFor.kpi.indicator}` : ''} footer={<><Button onClick={() => setKpiFor(null)}>Cancel</Button><Button variant="primary" disabled={!kpiValue.value.trim()} loading={saveKpi.isPending} onClick={() => saveKpi.mutate()}>Save</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={kpiFor ? error : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Quarter"><Select value={kpiValue.quarter} onChange={(e) => setKpiValue({ ...kpiValue, quarter: Number(e.target.value) })}>{[1, 2, 3, 4].map((q) => (<option key={q} value={q}>Q{q} {fy?.name}</option>))}</Select></Field>
            <Field label={`Achieved${kpiFor?.kpi.unit ? ` (${kpiFor.kpi.unit})` : ''}`}><Input value={kpiValue.value} onChange={(e) => setKpiValue({ ...kpiValue, value: e.target.value })} /></Field>
          </div>
          <Field label="Note"><Textarea rows={2} value={kpiValue.note} onChange={(e) => setKpiValue({ ...kpiValue, note: e.target.value })} /></Field>
        </div>
      </Modal>

      <Modal wide open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit programme' : 'New programme'} footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Sub-programme of" className="sm:col-span-3">
                <Select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                  <option value="">— This is a programme —</option>
                  {top.filter((p) => p.id !== form.id).map((p) => (<option key={p.id} value={p.id}>{p.code} · {p.name}</option>))}
                </Select>
              </Field>
            </div>
            <Field label="Objective"><Textarea rows={2} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></Field>
            <Field label="Expected outcome"><Textarea rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="Delivered by departments">
                <div className="max-h-40 space-y-1 overflow-auto text-sm">
                  {departments.map((d) => (<label key={d.id} className="flex items-center gap-2"><input type="checkbox" checked={form.departmentIds.includes(d.id)} onChange={() => setForm({ ...form, departmentIds: toggle(form.departmentIds, d.id) })} />{d.code} · {d.name}</label>))}
                </div>
              </Card>
              <Card title="And projects">
                <div className="max-h-40 space-y-1 overflow-auto text-sm">
                  {projects.length ? projects.map((d) => (<label key={d.id} className="flex items-center gap-2"><input type="checkbox" checked={form.projectIds.includes(d.id)} onChange={() => setForm({ ...form, projectIds: toggle(form.projectIds, d.id) })} />{d.code} · {d.name}</label>)) : <p className="text-muted">No projects.</p>}
                </div>
              </Card>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Key performance indicators</p>
              {form.kpis.map((k, n) => {
                const set = (p: Partial<Kpi>) => setForm({ ...form, kpis: form.kpis.map((x, j) => (j === n ? { ...x, ...p } : x)) });
                return (
                  <div key={k.id || n} className="mb-2 grid gap-2 sm:grid-cols-[1fr_7rem_6rem_6rem_2rem]">
                    <Input placeholder="Indicator" value={k.indicator} onChange={(e) => set({ indicator: e.target.value })} />
                    <Input placeholder="Unit" value={k.unit} onChange={(e) => set({ unit: e.target.value })} />
                    <Input placeholder="Baseline" value={k.baseline} onChange={(e) => set({ baseline: e.target.value })} />
                    <Input placeholder="Target" value={k.target} onChange={(e) => set({ target: e.target.value })} />
                    <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, kpis: form.kpis.filter((_, j) => j !== n) })} aria-label="Remove">×</Button>
                  </div>
                );
              })}
              <Button size="sm" onClick={() => setForm({ ...form, kpis: [...form.kpis, { id: '', indicator: '', unit: '', baseline: '', target: '' }] })}>Add indicator</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
