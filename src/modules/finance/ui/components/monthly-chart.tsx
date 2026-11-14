'use client';

import { useState } from 'react';
import { formatAmount, formatCompact } from '@/modules/finance/ui/lib/format';

export interface MonthPoint {
  month: string; // YYYY-MM
  revenue: string;
  costs: string;
  netProfit: string;
}

// Validated categorical pair (light surface): blue = revenue, orange = costs.
const SERIES = [
  { key: 'revenue' as const, label: 'Revenue', color: '#2a78d6' },
  { key: 'costs' as const, label: 'Costs', color: '#eb6834' },
];

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });

/** Grouped monthly bars: one y-axis, thin marks with rounded data-ends, hover tooltip per month. */
export function MonthlyChart({ data, currency }: { data: MonthPoint[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const pad = { top: 12, right: 8, bottom: 26, left: 52 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...data.flatMap((d) => [Number(d.revenue), Number(d.costs)]));
  const niceMax = (() => {
    const pow = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / pow) * pow;
  })();
  const y = (v: number) => pad.top + innerH - (Math.max(0, v) / niceMax) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * niceMax);
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(18, (slot - 10) / 2);

  const bar = (x: number, v: number, color: string) => {
    const top = y(v);
    const h = pad.top + innerH - top;
    if (h <= 0) return null;
    const r = Math.min(4, h, barW / 2);
    // Rounded top only; the end anchored to the baseline stays square.
    const d = `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`;
    return <path d={d} fill={color} />;
  };

  const active = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-muted">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="ml-auto">{currency}</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Monthly revenue and costs">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="#eeeef4" />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="#5e6075">
                {formatCompact(String(t))}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = pad.left + i * slot + (slot - (barW * 2 + 2)) / 2;
            return (
              <g key={d.month}>
                {hover === i && <rect x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} fill="#1b1c2b" opacity="0.04" />}
                {bar(x0, Number(d.revenue), SERIES[0].color)}
                {bar(x0 + barW + 2, Number(d.costs), SERIES[1].color)}
                <text x={pad.left + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#5e6075">
                  {monthLabel(d.month)}
                </text>
                {/* Hit target spans the full month column, larger than the marks. */}
                <rect
                  x={pad.left + i * slot}
                  y={pad.top}
                  width={slot}
                  height={innerH + pad.bottom}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
          <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="#cfd0dc" />
        </svg>
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-48 rounded-md border border-line bg-white p-2.5 text-xs shadow-lg"
            style={{ left: `clamp(0px, calc(${((pad.left + (hover + 0.5) * slot) / W) * 100}% - 6rem), calc(100% - 12rem))` }}
          >
            <p className="mb-1 font-semibold">{new Date(`${active.month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-muted">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="num">{formatAmount(active[s.key])}</span>
              </p>
            ))}
            <p className="mt-1 flex justify-between border-t border-line pt-1 font-medium">
              <span>Net profit</span>
              <span className="num">{formatAmount(active.netProfit, 2, { parens: true })}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
