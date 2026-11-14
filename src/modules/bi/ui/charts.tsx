'use client';

import { fmtMoney } from '@/lib/format';

export type FieldType = 'text' | 'number' | 'money' | 'date';
export interface Column { key: string; label: string; type: FieldType }
export interface Trend { direction: 'up' | 'down' | 'flat'; changePct: number | null; slope: number; forecast: { period: string; value: number }[]; anomalies: { period: string; value: number; expected: number }[] }
export interface Pivot { rowKey: string; colKey: string; measure: string; rowValues: unknown[]; colValues: unknown[]; cells: Record<string, Record<string, number | null>>; rowTotals: Record<string, number>; colTotals: Record<string, number>; total: number }
export interface Result { dataset: { key: string; label: string }; columns: Column[]; rows: Record<string, unknown>[]; truncated: boolean; pivot?: Pivot; trend?: Trend; ranAt: string }

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569'];

export function fmtCell(c: Column | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (c?.type === 'date') {
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
  if (c?.type === 'money') return fmtMoney(Number(v));
  if (c?.type === 'number') return Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  return String(v);
}

/** The first non-measure column is the category, the first measure column is the value. */
export function axes(r: Result) {
  const cat = r.columns.find((c) => !c.key.includes('_')) ?? r.columns[0];
  const val = r.columns.find((c) => c.key !== cat.key && (c.type === 'number' || c.type === 'money')) ?? r.columns[1];
  return { cat, val };
}

const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function BarChart({ r, onPick }: { r: Result; onPick?: (row: Record<string, unknown>) => void }) {
  const { cat, val } = axes(r);
  if (!val) return null;
  const rows = r.rows.slice(0, 30);
  const max = Math.max(1, ...rows.map((x) => Number(x[val.key] ?? 0)));
  const h = 200;
  const bw = Math.max(12, Math.min(48, 560 / Math.max(rows.length, 1)));
  const w = rows.length * (bw + 8) + 40;
  return (
    <svg viewBox={`0 0 ${w} ${h + 46}`} className="h-64 w-full" role="img" aria-label={`${val.label} by ${cat.label}`}>
      <line x1="30" y1={h} x2={w} y2={h} stroke="#cbd5e1" />
      {rows.map((x, i) => {
        const v = Number(x[val.key] ?? 0);
        const bh = (Math.max(v, 0) / max) * (h - 10);
        const xpos = 36 + i * (bw + 8);
        return (
          <g key={i} onClick={() => onPick?.(x)} className={onPick ? 'cursor-pointer' : ''}>
            <title>{`${fmtCell(cat, x[cat.key])}: ${fmtCell(val, v)}`}</title>
            <rect x={xpos} y={h - bh} width={bw} height={bh} rx="2" fill={PALETTE[0]} opacity="0.85" />
            <text x={xpos + bw / 2} y={h + 14} fontSize="9" textAnchor="middle" fill="#64748b">{short(fmtCell(cat, x[cat.key]), 10)}</text>
          </g>
        );
      })}
      <text x="2" y="10" fontSize="9" fill="#64748b">{fmtCell(val, max)}</text>
    </svg>
  );
}

export function LineChart({ r, onPick }: { r: Result; onPick?: (row: Record<string, unknown>) => void }) {
  const { cat, val } = axes(r);
  if (!val) return null;
  const pts = r.rows.map((x) => ({ label: fmtCell(cat, x[cat.key]), v: Number(x[val.key] ?? 0), row: x }));
  const fc = r.trend?.forecast ?? [];
  const all = [...pts.map((p) => p.v), ...fc.map((f) => f.value)];
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const n = pts.length + fc.length;
  const w = 600;
  const h = 200;
  const x = (i: number) => 36 + (i * (w - 50)) / Math.max(n - 1, 1);
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 14);
  const anomalies = new Set(r.trend?.anomalies.map((a) => a.period) ?? []);
  return (
    <svg viewBox={`0 0 ${w} ${h + 30}`} className="h-64 w-full" role="img" aria-label={`${val.label} over time`}>
      <line x1="30" y1={h} x2={w} y2={h} stroke="#cbd5e1" />
      <polyline fill="none" stroke={PALETTE[0]} strokeWidth="2" points={pts.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} />
      {fc.length > 0 && pts.length > 0 && (
        <polyline fill="none" stroke={PALETTE[0]} strokeWidth="2" strokeDasharray="5 4" opacity="0.6" points={[`${x(pts.length - 1)},${y(pts[pts.length - 1].v)}`, ...fc.map((f, i) => `${x(pts.length + i)},${y(f.value)}`)].join(' ')} />
      )}
      {pts.map((p, i) => (
        <g key={i} onClick={() => onPick?.(p.row)} className={onPick ? 'cursor-pointer' : ''}>
          <title>{`${p.label}: ${fmtCell(val, p.v)}`}</title>
          <circle cx={x(i)} cy={y(p.v)} r={anomalies.has(p.label.slice(0, 7)) || anomalies.has(p.label) ? 6 : 3.5} fill={anomalies.has(p.label.slice(0, 7)) || anomalies.has(p.label) ? PALETTE[3] : PALETTE[0]} />
          {(i % Math.ceil(n / 8) === 0 || i === pts.length - 1) && <text x={x(i)} y={h + 14} fontSize="9" textAnchor="middle" fill="#64748b">{short(p.label, 10)}</text>}
        </g>
      ))}
      {fc.map((f, i) => (
        <g key={`f${i}`}>
          <title>{`Forecast ${f.period}: ${fmtCell(val, f.value)}`}</title>
          <circle cx={x(pts.length + i)} cy={y(f.value)} r="3" fill="white" stroke={PALETTE[0]} />
        </g>
      ))}
      <text x="2" y="10" fontSize="9" fill="#64748b">{fmtCell(val, max)}</text>
    </svg>
  );
}

export function PieChart({ r, onPick }: { r: Result; onPick?: (row: Record<string, unknown>) => void }) {
  const { cat, val } = axes(r);
  if (!val) return null;
  const rows = r.rows.filter((x) => Number(x[val.key] ?? 0) > 0).slice(0, 10);
  const total = rows.reduce((s, x) => s + Number(x[val.key]), 0) || 1;
  // Where each slice starts: the running share of the total, from twelve o'clock.
  const starts = rows.map((_, i) => -Math.PI / 2 + (rows.slice(0, i).reduce((s, x) => s + Number(x[val.key]), 0) / total) * 2 * Math.PI);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="-110 -110 220 220" className="h-56 w-56" role="img" aria-label={`${val.label} by ${cat.label}`}>
        {rows.map((x, i) => {
          const frac = Number(x[val.key]) / total;
          const a = starts[i];
          const a2 = a + frac * 2 * Math.PI;
          const large = frac > 0.5 ? 1 : 0;
          const d = frac >= 0.999 ? 'M 0 -100 A 100 100 0 1 1 -0.01 -100 Z' : `M 0 0 L ${100 * Math.cos(a)} ${100 * Math.sin(a)} A 100 100 0 ${large} 1 ${100 * Math.cos(a2)} ${100 * Math.sin(a2)} Z`;
          return (
            <path key={i} d={d} fill={PALETTE[i % PALETTE.length]} stroke="white" strokeWidth="1" onClick={() => onPick?.(x)} className={onPick ? 'cursor-pointer' : ''}>
              <title>{`${fmtCell(cat, x[cat.key])}: ${fmtCell(val, x[val.key])} (${Math.round(frac * 100)}%)`}</title>
            </path>
          );
        })}
      </svg>
      <ul className="space-y-1 text-xs">
        {rows.map((x, i) => (
          <li key={i} className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />{fmtCell(cat, x[cat.key])} · {fmtCell(val, x[val.key])} ({Math.round((Number(x[val.key]) / total) * 100)}%)</li>
        ))}
      </ul>
    </div>
  );
}

export function Kpi({ r }: { r: Result }) {
  const { val } = axes(r);
  if (!val) return null;
  const total = r.rows.reduce((s, x) => s + Number(x[val.key] ?? 0), 0);
  return (
    <div>
      <div className="text-3xl font-semibold tabular-nums">{fmtCell(val, total)}</div>
      <div className="text-xs text-muted">{val.label}</div>
      {r.trend && <div className={`mt-1 text-xs ${r.trend.direction === 'up' ? 'text-emerald-700' : r.trend.direction === 'down' ? 'text-red-700' : 'text-muted'}`}>{r.trend.direction === 'up' ? '▲' : r.trend.direction === 'down' ? '▼' : '■'} {r.trend.changePct ?? 0}% over the period</div>}
    </div>
  );
}

/** A cross-tab, shaded by value (a heat map when shown as one). */
export function PivotTable({ r, heat, onPick }: { r: Result; heat?: boolean; onPick?: (row: Record<string, unknown>) => void }) {
  const p = r.pivot!;
  const rc = r.columns.find((c) => c.key === p.rowKey);
  const cc = r.columns.find((c) => c.key === p.colKey);
  const mc = r.columns.find((c) => c.key === p.measure);
  const key = (v: unknown) => (v === null || v === undefined ? '(blank)' : String(v));
  const max = Math.max(1, ...Object.values(p.cells).flatMap((row) => Object.values(row).map((v) => Number(v ?? 0))));
  const shade = (v: number | null | undefined) => (heat && v ? { background: `rgba(220, 38, 38, ${0.08 + 0.6 * (v / max)})` } : undefined);
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr><th>{rc?.label} \ {cc?.label}</th>{p.colValues.map((c) => <th key={key(c)} className="num">{fmtCell(cc, c)}</th>)}<th className="num">Total</th></tr>
        </thead>
        <tbody>
          {p.rowValues.map((rv) => (
            <tr key={key(rv)}>
              <td className="font-medium">{fmtCell(rc, rv)}</td>
              {p.colValues.map((cv) => {
                const v = p.cells[key(rv)]?.[key(cv)];
                return <td key={key(cv)} className={`num ${onPick ? 'cursor-pointer hover:underline' : ''}`} style={shade(v)} onClick={() => onPick?.({ [p.rowKey]: rv, [p.colKey]: cv })}>{v === undefined || v === null ? '' : fmtCell(mc, v)}</td>;
              })}
              <td className="num font-medium">{fmtCell(mc, p.rowTotals[key(rv)])}</td>
            </tr>
          ))}
          <tr className="font-medium"><td>Total</td>{p.colValues.map((cv) => <td key={key(cv)} className="num">{fmtCell(mc, p.colTotals[key(cv)])}</td>)}<td className="num">{fmtCell(mc, p.total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export function ResultTable({ r, onPick }: { r: Result; onPick?: (row: Record<string, unknown>) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead><tr>{r.columns.map((c) => <th key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i} onClick={() => onPick?.(row)} className={onPick ? 'cursor-pointer hover:bg-slate-50' : ''}>
              {r.columns.map((c) => <td key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num' : ''}>{fmtCell(c, row[c.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {r.truncated && <p className="p-2 text-xs text-muted">Only the first rows are shown. Export to Excel for all of them, or narrow the filters.</p>}
    </div>
  );
}

export const CHART_TYPES = ['table', 'bar', 'line', 'pie', 'kpi', 'heatmap'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** A result shown as the chosen chart; clicking a bar, slice, point or row drills through when allowed. */
export function ResultView({ r, chart, onPick }: { r: Result; chart: ChartType; onPick?: (row: Record<string, unknown>) => void }) {
  if (!r.rows.length) return <p className="p-4 text-sm text-muted">No data for these filters.</p>;
  if (r.pivot) return <PivotTable r={r} heat={chart === 'heatmap'} onPick={onPick} />;
  if (chart === 'bar') return <BarChart r={r} onPick={onPick} />;
  if (chart === 'line') return <LineChart r={r} onPick={onPick} />;
  if (chart === 'pie') return <PieChart r={r} onPick={onPick} />;
  if (chart === 'kpi') return <Kpi r={r} />;
  return <ResultTable r={r} onPick={onPick} />;
}

export function TrendNote({ t, label }: { t: Trend; label: string }) {
  return (
    <p className="text-xs text-muted">
      {label} is trending <b>{t.direction}</b>{t.changePct !== null && <> ({t.changePct > 0 ? '+' : ''}{t.changePct}% first to last)</>}. Forecast: {t.forecast.map((f) => `${f.period} ${f.value.toLocaleString('en-KE')}`).join(', ')}.
      {t.anomalies.length > 0 && <> Unusual: {t.anomalies.map((a) => `${a.period} (${a.value.toLocaleString('en-KE')}, expected about ${a.expected.toLocaleString('en-KE')})`).join(', ')}.</>}
    </p>
  );
}
