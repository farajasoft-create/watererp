'use client';

import { fmtMoney } from '@/lib/format';

/** A progress bar with a percentage, coloured by how it compares to the time used. */
export function Progress({ value, against }: { value: number | null | undefined; against?: number | null }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const behind = against !== null && against !== undefined && value + 15 < against;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded bg-slate-100"><div className={`h-2 rounded ${behind ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
      <span className="text-xs tabular-nums">{value}%</span>
    </div>
  );
}

/** Monthly spending as small bars. */
export function MonthlyBars({ rows }: { rows: { month: string; amount: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No spending posted yet.</p>;
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="flex h-32 items-end gap-1">
      {rows.map((r) => (
        <div key={r.month} className="flex flex-1 flex-col items-center gap-1" title={`${r.month}: ${fmtMoney(r.amount)}`}>
          <div className="w-full rounded-t bg-brand-500" style={{ height: `${Math.max(2, (r.amount / max) * 100)}px` }} />
          <span className="text-[10px] text-muted">{r.month.slice(2)}</span>
        </div>
      ))}
    </div>
  );
}
