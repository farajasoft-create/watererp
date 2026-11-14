'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, Select } from '@/components/ui';
import { api, downloadPost } from './api';
import { CHART_TYPES, ChartType, FieldType, Result, ResultTable, ResultView, TrendNote } from './charts';

export interface Dataset { key: string; label: string; module: string; description: string; dateField: string; fields: { key: string; label: string; type: FieldType }[] }
export interface Filter { field: string; op: string; value?: unknown; to?: unknown }
export interface Spec { dataset: string; filters: Filter[]; columns?: string[]; groupBy?: { field: string; bucket?: string }[]; measures?: { field?: string; agg: string; label?: string }[]; pivot?: boolean; sort?: { key: string; dir: 'asc' | 'desc' }; limit?: number }

const OPS: Record<FieldType, { op: string; label: string }[]> = {
  text: [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'contains', label: 'contains' }, { op: 'in', label: 'is one of (comma list)' }, { op: 'empty', label: 'is blank' }, { op: 'notEmpty', label: 'is not blank' }],
  number: [{ op: 'eq', label: '=' }, { op: 'gt', label: '>' }, { op: 'gte', label: '≥' }, { op: 'lt', label: '<' }, { op: 'lte', label: '≤' }, { op: 'between', label: 'between' }, { op: 'empty', label: 'is blank' }],
  money: [{ op: 'gt', label: '>' }, { op: 'gte', label: '≥' }, { op: 'lt', label: '<' }, { op: 'lte', label: '≤' }, { op: 'between', label: 'between' }, { op: 'eq', label: '=' }],
  date: [{ op: 'between', label: 'between' }, { op: 'gte', label: 'on or after' }, { op: 'lte', label: 'on or before' }, { op: 'eq', label: 'on' }, { op: 'empty', label: 'is blank' }],
};
const AGGS = [{ agg: 'sum', label: 'Total' }, { agg: 'avg', label: 'Average' }, { agg: 'min', label: 'Lowest' }, { agg: 'max', label: 'Highest' }, { agg: 'count', label: 'Count of rows' }, { agg: 'countDistinct', label: 'Count of different' }];
const BUCKETS = ['', 'day', 'week', 'month', 'quarter', 'year'];

/** Shows the rows behind a group of a summary (drill-through). */
export function DrillModal({ spec, values, onClose }: { spec: Spec; values: Record<string, unknown>; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-drill', spec, values], queryFn: () => api.post<Result>('/query/drill', { spec, values }) });
  return (
    <Modal open wide onClose={onClose} title={`Rows behind ${Object.values(values).map((v) => String(v ?? '(blank)').slice(0, 10)).join(' · ')}`}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : data && <><p className="mb-2 text-xs text-muted">{data.rows.length}{data.truncated ? '+' : ''} rows</p><ResultTable r={data} /></>}
    </Modal>
  );
}

export function SpecEditor({ spec, setSpec, datasets }: { spec: Spec; setSpec: (s: Spec) => void; datasets: Dataset[] }) {
  const d = datasets.find((x) => x.key === spec.dataset);
  const fields = d?.fields ?? [];
  const type = (k: string) => fields.find((f) => f.key === k)?.type ?? 'text';
  const summary = Boolean(spec.groupBy?.length);
  const setFilter = (i: number, f: Partial<Filter>) => setSpec({ ...spec, filters: spec.filters.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  const numeric = fields.filter((f) => f.type === 'number' || f.type === 'money');
  return (
    <div className="space-y-4">
      <Field label="Data">
        <Select value={spec.dataset} onChange={(e) => setSpec({ dataset: e.target.value, filters: [] })}>
          <option value="">Choose what to report on</option>
          {datasets.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </Select>
      </Field>
      {d && (
        <>
          <p className="text-xs text-muted">{d.description}</p>
          <div>
            <div className="mb-1 text-sm font-medium">Filters</div>
            <div className="space-y-2">
              {spec.filters.map((f, i) => {
                const t = type(f.field);
                return (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                    <Select value={f.field} onChange={(e) => setFilter(i, { field: e.target.value, op: OPS[type(e.target.value)][0].op, value: '', to: undefined })}>{fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>
                    <Select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })}>{OPS[t].map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</Select>
                    {f.op === 'empty' || f.op === 'notEmpty' ? <span /> : (
                      <div className="flex gap-1">
                        <Input type={t === 'date' ? 'date' : 'text'} value={Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '')} onChange={(e) => setFilter(i, { value: f.op === 'in' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value })} />
                        {f.op === 'between' && <Input type={t === 'date' ? 'date' : 'text'} value={String(f.to ?? '')} onChange={(e) => setFilter(i, { to: e.target.value })} />}
                      </div>
                    )}
                    <Button variant="secondary" onClick={() => setSpec({ ...spec, filters: spec.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">✕</Button>
                  </div>
                );
              })}
              <Button variant="secondary" onClick={() => setSpec({ ...spec, filters: [...spec.filters, { field: d.dateField, op: 'between', value: '', to: '' }] })}>Add filter</Button>
            </div>
          </div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={!summary} onChange={() => setSpec({ ...spec, groupBy: undefined, measures: undefined, pivot: undefined, columns: fields.slice(0, 6).map((f) => f.key) })} /> List of rows</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={summary} onChange={() => setSpec({ ...spec, columns: undefined, groupBy: [{ field: fields.find((f) => f.type === 'text')?.key ?? fields[0].key }], measures: [{ agg: numeric.length ? 'sum' : 'count', field: numeric[0]?.key }] })} /> Summary (grouped totals)</label>
          </div>
          {!summary ? (
            <Field label="Columns">
              <div className="flex flex-wrap gap-3 text-sm">
                {fields.map((f) => {
                  const cols = spec.columns ?? fields.slice(0, 8).map((x) => x.key);
                  return <label key={f.key} className="flex items-center gap-1"><input type="checkbox" checked={cols.includes(f.key)} onChange={(e) => setSpec({ ...spec, columns: e.target.checked ? [...cols, f.key] : cols.filter((c) => c !== f.key) })} /> {f.label}</label>;
                })}
              </div>
            </Field>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {[0, 1].map((i) => {
                  const g = spec.groupBy?.[i];
                  return (
                    <Field key={i} label={i === 0 ? 'Group by' : 'Then by (optional)'}>
                      <div className="flex gap-1">
                        <Select value={g?.field ?? ''} onChange={(e) => {
                          const groups = [...(spec.groupBy ?? [])];
                          if (e.target.value) groups[i] = { field: e.target.value, ...(type(e.target.value) === 'date' && { bucket: 'month' }) };
                          else groups.splice(i, 1);
                          setSpec({ ...spec, groupBy: groups.filter(Boolean), ...(groups.length < 2 && { pivot: false }) });
                        }}>
                          {i > 0 && <option value="">—</option>}
                          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                        {g && type(g.field) === 'date' && (
                          <Select value={g.bucket ?? ''} onChange={(e) => setSpec({ ...spec, groupBy: spec.groupBy!.map((x, j) => (j === i ? { ...x, bucket: e.target.value || undefined } : x)) })}>
                            {BUCKETS.map((b) => <option key={b} value={b}>{b ? `by ${b}` : 'exact'}</option>)}
                          </Select>
                        )}
                      </div>
                    </Field>
                  );
                })}
              </div>
              <div>
                <div className="mb-1 text-sm font-medium">Show</div>
                <div className="space-y-2">
                  {(spec.measures ?? []).map((m, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <Select value={m.agg} onChange={(e) => setSpec({ ...spec, measures: spec.measures!.map((x, j) => (j === i ? { ...x, agg: e.target.value, ...(e.target.value === 'count' && { field: undefined }) } : x)) })}>{AGGS.map((a) => <option key={a.agg} value={a.agg}>{a.label}</option>)}</Select>
                      {m.agg === 'count' ? <span /> : (
                        <Select value={m.field ?? ''} onChange={(e) => setSpec({ ...spec, measures: spec.measures!.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                          <option value="">Choose</option>
                          {(['sum', 'avg'].includes(m.agg) ? numeric : fields).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                      )}
                      <Button variant="secondary" onClick={() => setSpec({ ...spec, measures: spec.measures!.filter((_, j) => j !== i) })} aria-label="Remove">✕</Button>
                    </div>
                  ))}
                  <Button variant="secondary" onClick={() => setSpec({ ...spec, measures: [...(spec.measures ?? []), { agg: 'count' }] })}>Add a figure</Button>
                </div>
              </div>
              {spec.groupBy?.length === 2 && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={Boolean(spec.pivot)} onChange={(e) => setSpec({ ...spec, pivot: e.target.checked })} /> Cross-tab (pivot): second grouping across the top</label>}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Runs a spec and shows the result with chart choice, trend, drill-through and exports. */
export function Runner({ spec, chart, setChart, title, reportId, extra = [] }: { spec: Spec; chart: ChartType; setChart?: (c: ChartType) => void; title: string; reportId?: string; extra?: Filter[] }) {
  const [drill, setDrill] = useState<Record<string, unknown> | null>(null);
  // A saved report runs through its own endpoint, so runs and exports are in its access log.
  const run = useQuery({
    queryKey: ['bi-run', reportId ?? spec, extra],
    queryFn: () => (reportId ? api.post<{ result: Result }>(`/reports/${reportId}/run`, { filters: extra }).then((x) => x.result) : api.post<Result>('/query', spec)),
    enabled: Boolean(spec.dataset),
    retry: false,
  });
  const exp = useMutation({ mutationFn: (format: string) => (reportId ? downloadPost(`/reports/${reportId}/export`, { format, filters: extra }, `${title}.${format}`) : downloadPost('/query/export', { spec, format, title }, `${title}.${format}`)) });
  const drillSpec = extra.length ? { ...spec, filters: [...spec.filters, ...extra] } : spec;
  const grouped = Boolean(spec.groupBy?.length);
  return (
    <Card
      title={run.data ? `${run.data.rows.length}${run.data.truncated ? '+' : ''} ${grouped ? 'groups' : 'rows'}` : 'Result'}
      actions={
        <>
          {setChart && <Select value={chart} onChange={(e) => setChart(e.target.value as ChartType)} className="max-w-32">{CHART_TYPES.map((c) => <option key={c} value={c}>{c === 'kpi' ? 'KPI figure' : c === 'heatmap' ? 'heat map' : c}</option>)}</Select>}
          {['xls', 'pdf', 'doc', 'pptx', 'csv'].map((f) => <Button key={f} variant="secondary" onClick={() => exp.mutate(f)} disabled={!run.data || exp.isPending}>{f === 'xls' ? 'Excel' : f === 'doc' ? 'Word' : f === 'pptx' ? 'PowerPoint' : f.toUpperCase()}</Button>)}
        </>
      }
    >
      <ErrorBox error={run.error || exp.error} />
      {run.isLoading ? <Loading /> : run.data && (
        <div className="space-y-2">
          <ResultView r={run.data} chart={chart} onPick={grouped ? (row) => setDrill(row) : undefined} />
          {run.data.trend && <TrendNote t={run.data.trend} label={run.data.columns[run.data.columns.length - 1]?.label ?? 'The figure'} />}
          {grouped && <p className="text-xs text-muted">Click a bar, slice, point or row to see the records behind it.</p>}
        </div>
      )}
      {drill && <DrillModal spec={drillSpec} values={drill} onClose={() => setDrill(null)} />}
    </Card>
  );
}
