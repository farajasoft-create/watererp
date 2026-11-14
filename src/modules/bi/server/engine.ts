import { Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Db } from '@/platform/db';
import { DATASETS, datasetByKey, DatasetDef, FieldDef, FieldType } from './datasets';

export const FILTER_OPS = ['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'] as const;
export const AGGS = ['count', 'sum', 'avg', 'min', 'max', 'countDistinct'] as const;
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;

export interface Filter { field: string; op: (typeof FILTER_OPS)[number]; value?: unknown; to?: unknown }
export interface GroupBy { field: string; bucket?: (typeof BUCKETS)[number] }
export interface Measure { field?: string; agg: (typeof AGGS)[number]; label?: string }

/** What a report asks for: rows of a dataset (columns), or groups with totals, optionally pivoted. */
export interface QuerySpec {
  dataset: string;
  filters: Filter[];
  /** Detail rows: the fields to show. */
  columns?: string[];
  groupBy?: GroupBy[];
  measures?: Measure[];
  /** With two groupings: the second becomes the columns of a cross-tab. */
  pivot?: boolean;
  sort?: { key: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface ResultColumn { key: string; label: string; type: FieldType }
export interface QueryResult {
  dataset: { key: string; label: string };
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  pivot?: { rowKey: string; colKey: string; measure: string; rowValues: unknown[]; colValues: unknown[]; cells: Record<string, Record<string, number | null>>; rowTotals: Record<string, number>; colTotals: Record<string, number>; total: number };
  trend?: Trend;
  ranAt: Date;
}

export interface Trend {
  measure: string;
  /** Average change per period from a straight line fitted through the series. */
  slope: number;
  changePct: number | null;
  direction: 'up' | 'down' | 'flat';
  forecast: { period: string; value: number }[];
  /** Periods far from the fitted line (more than three robust standard deviations). */
  anomalies: { period: string; value: number; expected: number }[];
}

const MAX_DETAIL = 5000;
const MAX_GROUPS = 2000;

/** Datasets the user may query: module switched on and one of its permissions held. */
export function datasetsFor(user: AuthUser): DatasetDef[] {
  return DATASETS.filter((d) => (d.module === 'core' || user.modules.includes(d.module)) && (user.isAdmin || d.permissions.some((p) => hasPermission(user, p))));
}

export function fieldsFor(user: AuthUser, d: DatasetDef): FieldDef[] {
  return d.fields.filter((f) => !f.permission || user.isAdmin || hasPermission(user, f.permission));
}

export function catalogue(user: AuthUser) {
  return datasetsFor(user).map((d) => ({ key: d.key, label: d.label, module: d.module, description: d.description, dateField: d.dateField, fields: fieldsFor(user, d).map(({ key, label, type }) => ({ key, label, type })) }));
}

const measureKey = (m: Measure) => `${m.agg}_${m.field ?? 'rows'}`;

function bucketExpr(field: string, bucket?: GroupBy['bucket']) {
  if (!bucket) return `$${field}`;
  return { $dateTrunc: { date: `$${field}`, unit: bucket, ...(bucket === 'week' && { startOfWeek: 'monday' }), timezone: 'Africa/Nairobi' } };
}

function coerce(type: FieldType, v: unknown) {
  if (v === null || v === undefined || v === '') return v;
  if (type === 'date') {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`"${v}" is not a date`);
    return d;
  }
  if (type === 'number' || type === 'money') {
    const n = Number(v);
    if (Number.isNaN(n)) throw new BadRequestException(`"${v}" is not a number`);
    return n;
  }
  return String(v);
}

function filterStage(f: Filter, type: FieldType): Record<string, unknown> {
  const k = f.field;
  const v = coerce(type, f.value);
  switch (f.op) {
    case 'eq':
      // A date filter on a whole day matches the whole day.
      if (type === 'date' && v instanceof Date) return { [k]: { $gte: v, $lt: new Date(v.getTime() + 86_400_000) } };
      return { [k]: v === '' || v === undefined ? null : v };
    case 'ne':
      return { [k]: { $ne: v } };
    case 'in':
      return { [k]: { $in: (Array.isArray(f.value) ? f.value : [f.value]).map((x) => coerce(type, x)) } };
    case 'contains':
      return { [k]: { $regex: String(f.value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
    case 'gt':
      return { [k]: { $gt: v } };
    case 'gte':
      return { [k]: { $gte: v } };
    case 'lt':
      return { [k]: { $lt: v } };
    case 'lte':
      return { [k]: type === 'date' && v instanceof Date ? { $lt: new Date(v.getTime() + 86_400_000) } : { $lte: v } };
    case 'between': {
      const to = coerce(type, f.to);
      return { [k]: { $gte: v, ...(type === 'date' && to instanceof Date ? { $lt: new Date(to.getTime() + 86_400_000) } : { $lte: to }) } };
    }
    case 'empty':
      return { [k]: { $in: [null, ''] } };
    case 'notEmpty':
      return { [k]: { $nin: [null, ''] } };
  }
}

/** Builds and runs the aggregation for a report specification. */
export async function runQuery(db: Db, user: AuthUser, spec: QuerySpec): Promise<QueryResult> {
  const d = datasetByKey(spec.dataset);
  if (!d) throw new NotFoundException('Dataset not found');
  if (!datasetsFor(user).includes(d)) throw new ForbiddenException(`You cannot report on ${d.label}`);
  const fields = fieldsFor(user, d);
  const field = (key: string) => {
    const f = fields.find((x) => x.key === key);
    if (!f) throw new BadRequestException(`Unknown field "${key}" in ${d.label}`);
    return f;
  };
  const groups = spec.groupBy ?? [];
  const measures = spec.measures?.length ? spec.measures : groups.length ? [{ agg: 'count' as const }] : [];
  for (const g of groups) if (g.bucket && field(g.field).type !== 'date') throw new BadRequestException(`${field(g.field).label} is not a date`);
  for (const m of measures) {
    if (m.agg !== 'count' && !m.field) throw new BadRequestException(`Choose the field to ${m.agg}`);
    if (m.field && ['sum', 'avg'].includes(m.agg) && !['number', 'money'].includes(field(m.field).type)) throw new BadRequestException(`${field(m.field).label} is not a number`);
  }
  const detailKeys = groups.length ? [] : spec.columns?.length ? spec.columns : fields.slice(0, 8).map((f) => f.key);
  const used = new Set([...(spec.filters ?? []).map((f) => f.field), ...groups.map((g) => g.field), ...(measures.map((m) => m.field).filter(Boolean) as string[]), ...detailKeys]);
  const project = Object.fromEntries([...used].map((k) => [k, field(k).expr]));

  const pipeline: PipelineStage[] = [{ $match: { organisationId: user.organisationId } }, ...(d.stages ?? []), { $project: { _id: 0, ...project } }];
  const where = (spec.filters ?? []).map((f) => filterStage(f, field(f.field).type));
  if (where.length) pipeline.push({ $match: { $and: where } });

  let columns: ResultColumn[];
  let limit: number;
  if (groups.length) {
    const id = Object.fromEntries(groups.map((g, i) => [`g${i}`, bucketExpr(g.field, g.bucket)]));
    const acc: Record<string, unknown> = {};
    for (const m of measures) {
      const k = measureKey(m);
      acc[k] = m.agg === 'count' ? { $sum: 1 } : m.agg === 'countDistinct' ? { $addToSet: `$${m.field}` } : { [`$${m.agg}`]: `$${m.field}` };
    }
    pipeline.push({ $group: { _id: id, ...acc } });
    pipeline.push({ $project: { _id: 0, ...Object.fromEntries(groups.map((g, i) => [g.field, `$_id.g${i}`])), ...Object.fromEntries(measures.map((m) => [measureKey(m), m.agg === 'countDistinct' ? { $size: `$${measureKey(m)}` } : m.agg === 'avg' ? { $round: [`$${measureKey(m)}`, 2] } : `$${measureKey(m)}`])) } });
    columns = [
      ...groups.map((g) => ({ key: g.field, label: `${field(g.field).label}${g.bucket ? ` (${g.bucket})` : ''}`, type: g.bucket ? ('date' as const) : field(g.field).type })),
      ...measures.map((m) => ({ key: measureKey(m), label: m.label || (m.agg === 'count' ? 'Count' : `${{ sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', countDistinct: 'Distinct' }[m.agg]} ${field(m.field!).label.toLowerCase()}`), type: (m.agg === 'count' || m.agg === 'countDistinct' ? 'number' : field(m.field!).type === 'date' ? 'date' : field(m.field!).type) as FieldType })),
    ];
    limit = Math.min(spec.limit ?? MAX_GROUPS, MAX_GROUPS);
  } else {
    columns = detailKeys.map((k) => ({ key: k, label: field(k).label, type: field(k).type }));
    pipeline.push({ $project: Object.fromEntries(detailKeys.map((k) => [k, 1])) });
    limit = Math.min(spec.limit ?? MAX_DETAIL, MAX_DETAIL);
  }
  const sortKey = spec.sort?.key && columns.some((c) => c.key === spec.sort!.key) ? spec.sort.key : groups.length ? (groups[0].bucket ? groups[0].field : measureKey(measures[0])) : (columns.find((c) => c.key === d.dateField)?.key ?? columns[0].key);
  const dir = spec.sort?.key ? (spec.sort.dir === 'asc' ? 1 : -1) : groups[0]?.bucket ? 1 : -1;
  pipeline.push({ $sort: { [sortKey]: dir } }, { $limit: limit + 1 });

  const rows = await db.connection.collection(d.collection).aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 30_000 }).toArray();
  const truncated = rows.length > limit;
  if (truncated) rows.pop();
  for (const r of rows) for (const c of columns) if (c.type === 'money' && typeof r[c.key] === 'number') r[c.key] = Math.round((r[c.key] as number) * 100) / 100;

  const result: QueryResult = { dataset: { key: d.key, label: d.label }, columns, rows, truncated, ranAt: new Date() };
  if (spec.pivot && groups.length === 2) result.pivot = pivotOf(rows, groups[0].field, groups[1].field, measureKey(measures[0]));
  if (groups.length === 1 && groups[0].bucket && rows.length >= 3) result.trend = trendOf(rows, groups[0].field, measureKey(measures[0]), groups[0].bucket);
  return result;
}

const keyOf = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '(blank)' : String(v));

export function pivotOf(rows: Record<string, unknown>[], rowKey: string, colKey: string, measure: string): NonNullable<QueryResult['pivot']> {
  const rowValues = [...new Map(rows.map((r) => [keyOf(r[rowKey]), r[rowKey]])).values()];
  const colValues = [...new Map(rows.map((r) => [keyOf(r[colKey]), r[colKey]])).values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const cells: Record<string, Record<string, number | null>> = {};
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const rk = keyOf(r[rowKey]);
    const ck = keyOf(r[colKey]);
    const v = Number(r[measure] ?? 0);
    (cells[rk] ??= {})[ck] = v;
    rowTotals[rk] = (rowTotals[rk] ?? 0) + v;
    colTotals[ck] = (colTotals[ck] ?? 0) + v;
    total += v;
  }
  return { rowKey, colKey, measure, rowValues, colValues, cells, rowTotals, colTotals, total };
}

function nextPeriod(d: Date, bucket: GroupBy['bucket'], n: number) {
  const x = new Date(d);
  if (bucket === 'day') x.setUTCDate(x.getUTCDate() + n);
  else if (bucket === 'week') x.setUTCDate(x.getUTCDate() + 7 * n);
  else if (bucket === 'month') x.setUTCMonth(x.getUTCMonth() + n);
  else if (bucket === 'quarter') x.setUTCMonth(x.getUTCMonth() + 3 * n);
  else x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
}

/** A least-squares line through a time series: direction, change, a three-period forecast and outliers. */
export function trendOf(rows: Record<string, unknown>[], dateKey: string, measure: string, bucket: GroupBy['bucket']): Trend {
  const series = rows.filter((r) => r[dateKey] instanceof Date).map((r) => ({ at: r[dateKey] as Date, v: Number(r[measure] ?? 0) })).sort((a, b) => a.at.getTime() - b.at.getTime());
  const n = series.length;
  const xs = series.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = series.reduce((s, p) => s + p.v, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (series[i].v - my), 0) / sxx : 0;
  const intercept = my - slope * mx;
  const fitted = xs.map((x) => intercept + slope * x);
  const resid = series.map((p, i) => p.v - fitted[i]);
  // Spread from the median absolute deviation, so one large outlier cannot hide itself.
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const centre = med(resid);
  const sd = 1.4826 * med(resid.map((r) => Math.abs(r - centre)));
  const label = (d: Date) => d.toISOString().slice(0, bucket === 'year' ? 4 : bucket === 'month' || bucket === 'quarter' ? 7 : 10);
  const first = series[0].v;
  const last = series[n - 1].v;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    measure,
    slope: round(slope),
    changePct: first ? Math.round(((last - first) / Math.abs(first)) * 1000) / 10 : null,
    direction: Math.abs(slope) < Math.max(Math.abs(my) * 0.01, 1e-9) ? 'flat' : slope > 0 ? 'up' : 'down',
    forecast: [1, 2, 3].map((k) => ({ period: label(nextPeriod(series[n - 1].at, bucket, k)), value: round(Math.max(intercept + slope * (n - 1 + k), 0)) })),
    anomalies: sd && n >= 4 ? series.map((p, i) => ({ period: label(p.at), value: p.v, expected: round(fitted[i]), z: (resid[i] - centre) / sd })).filter((a) => Math.abs(a.z) > 3).map(({ period, value, expected }) => ({ period, value, expected })) : [],
  };
}

/** Drill-through: the detail rows behind one group of a grouped report. */
export function drillSpec(spec: QuerySpec, values: Record<string, unknown>): QuerySpec {
  const filters = [...(spec.filters ?? [])];
  for (const g of spec.groupBy ?? []) {
    if (!(g.field in values)) continue;
    const v = values[g.field];
    if (g.bucket && v) {
      const from = new Date(String(v));
      filters.push({ field: g.field, op: 'between', value: from.toISOString(), to: new Date(nextPeriod(from, g.bucket, 1).getTime() - 86_400_000).toISOString() });
    } else filters.push({ field: g.field, op: v === null || v === undefined || v === '(blank)' ? 'empty' : 'eq', value: v });
  }
  return { dataset: spec.dataset, filters, sort: undefined, limit: 1000 };
}

export const oid = (v: string) => new Types.ObjectId(v);
