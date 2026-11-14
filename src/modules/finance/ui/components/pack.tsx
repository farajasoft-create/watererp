'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, formatDateTime } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import { MonthlyChart } from './monthly-chart';
import { Badge, Button, cx, ErrorBanner, Field, Input, Loading } from './ui';

type Money = string;
interface PlSection {
  title: string;
  lines: { code: string; name: string; values: Record<string, Money>; total: Money }[];
  totals: Record<string, Money>;
  total: Money;
}
interface Pack {
  entity: { name: string; legalName: string; code: string };
  currency: string;
  month: string;
  from: string;
  to: string;
  ytdFrom: string;
  preparedBy: string;
  preparedAt: string;
  commentary: string[];
  kpis: null | {
    revenue: { ytd: Money; mtd: Money };
    grossMargin: { percent: string | null };
    ebitda: { ytd: Money };
    netProfit: { ytd: Money };
    cash: { balance: Money; forecastLow: Money };
    receivables: { balance: Money; dso: number | null };
    payables: { balance: Money; dpo: number | null };
    workingCapital: { amount: Money; currentRatio: string | null };
  };
  trend: null | { month: string; revenue: Money; netProfit: Money }[];
  profitAndLoss: null | { columns: { id: string; code: string; name: string }[]; sections: PlSection[]; grossProfit: Record<string, Money>; netProfit: Record<string, Money>; totals: { revenue: Money; grossProfit: Money; netProfit: Money } };
  profitAndLossYtd: null | { totals: { revenue: Money; costOfSales: Money; grossProfit: Money; expenses: Money; netProfit: Money } };
  balanceSheet: null | { sections: { title: string; lines: { code: string; name: string; amount: Money }[]; total: Money }[]; totals: { assets: Money; liabilitiesAndEquity: Money }; balanced: boolean };
  cashFlow: null | { operating: { total: Money }; investing: { total: Money }; financing: { total: Money }; openingCash: Money; closingCash: Money; netChange: Money };
  budget: null | { name: string; rows: { code: string; name: string; accountClass: string; budget: Money; actual: Money; variance: Money; variancePercent: string | null; favourable: boolean }[]; totals: { revenueBudget: Money; revenueActual: Money; netBudget: Money; netActual: Money } };
  receivables: null | { totals: Record<string, Money>; top: { name: string; total: Money; buckets: Record<string, Money> }[] };
  payables: null | { totals: Record<string, Money>; top: { name: string; total: Money; buckets: Record<string, Money> }[] };
  cash: null | { name: string; currency: string; balance: Money; unmatchedStatementLines: number; reconciledTo: string | null }[];
  fx: null | { rows: { currency: string; net: Money; atRate: Money; unrealised: Money; sensitivity10: Money }[] };
  inventory: null | { total: Money; difference: Money; items: number; belowReorder: string[]; top: { code: string; name: string; quantity: string; value: Money }[] };
  capex: null | { number: string; name: string; date: string; cost: Money; branch: string }[];
  projects: null | { code: string; name: string; contractValue: Money | null; revenue: Money; cost: Money; margin: Money; marginPercent: string | null }[];
  exceptions: null | { severity: 'high' | 'medium' | 'low'; title: string; detail: string; date: string | null }[];
}

const BUCKETS: [string, string][] = [
  ['current', 'Current'],
  ['days1to30', '1–30 days'],
  ['days31to60', '31–60 days'],
  ['days61to90', '61–90 days'],
  ['over90', 'Over 90'],
];

function Section({ title, children, breakBefore }: { title: string; children: ReactNode; breakBefore?: boolean }) {
  return (
    <section className={cx('mb-8 break-inside-avoid', breakBefore && 'print:break-before-page')}>
      <h2 className="mb-2 border-b-2 border-brand-700 pb-1 text-base font-semibold text-brand-900">{title}</h2>
      {children}
    </section>
  );
}

export function ManagementPack() {
  const { entity } = useSession();
  const d = new Date();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const requested = useSearchParams().get('month');
  const [month, setMonth] = useState(requested && /^\d{4}-\d{2}$/.test(requested) ? requested : last);
  const { data, isLoading, error } = useQuery({ queryKey: ['pack', entity?.id, month], queryFn: () => api.get<Pack>('/reports/pack', { entityId: entity!.id, month }), enabled: /^\d{4}-\d{2}$/.test(month) });
  // Packs are read at a glance: whole currency units.
  const n = (v: Money | null | undefined) => (v === null || v === undefined ? '' : formatAmount(v, 0, { parens: true }));
  const monthName = data ? new Date(`${data.month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Button variant="primary" onClick={() => window.print()} disabled={!data}>Print / save as PDF</Button>
        <p className="ml-auto max-w-md text-xs text-muted">The pack includes only the sections you have access to. Use your browser&apos;s “Save as PDF” to distribute it.</p>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <article className="mx-auto max-w-[900px] rounded-lg border border-line bg-white p-8 shadow-xs print:max-w-none print:border-0 print:p-0 print:shadow-none">
          <header className="mb-8 border-b border-line pb-6">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">Management reporting pack</p>
            <h1 className="mt-1 text-2xl font-semibold">{data.entity.legalName || data.entity.name}</h1>
            <p className="text-sm text-muted">
              {monthName} · year to date from {formatDate(data.ytdFrom)} · amounts in {data.currency}
            </p>
            <p className="mt-2 text-xs text-muted">Prepared by {data.preparedBy} on {formatDateTime(data.preparedAt)} from the posted ledger.</p>
          </header>

          <Section title="Executive summary">
            {data.kpis && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ['Revenue (month)', n(data.profitAndLoss?.totals.revenue ?? data.kpis.revenue.mtd)],
                    ['Revenue (YTD)', n(data.kpis.revenue.ytd)],
                    ['Gross margin (YTD)', data.kpis.grossMargin.percent ? `${data.kpis.grossMargin.percent}%` : '—'],
                    ['Net profit (YTD)', n(data.kpis.netProfit.ytd)],
                    ['EBITDA (YTD)', n(data.kpis.ebitda.ytd)],
                    ['Cash & bank', n(data.kpis.cash.balance)],
                    ['Receivables', `${n(data.kpis.receivables.balance)}${data.kpis.receivables.dso !== null ? ` · ${data.kpis.receivables.dso}d` : ''}`],
                    ['Working capital', `${n(data.kpis.workingCapital.amount)}${data.kpis.workingCapital.currentRatio ? ` · ${data.kpis.workingCapital.currentRatio}×` : ''}`],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded-md border border-line p-2">
                    <p className="text-[11px] text-muted">{label}</p>
                    <p className="font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
            )}
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {data.commentary.map((c, i) => (<li key={i}>{c}</li>))}
            </ul>
            {data.trend && (
              <div className="mt-4">
                <MonthlyChart currency={data.currency} data={data.trend.map((t) => ({ month: t.month, revenue: t.revenue, costs: String(Number(t.revenue) - Number(t.netProfit)), netProfit: t.netProfit }))} />
              </div>
            )}
          </Section>

          {data.profitAndLoss && (
            <Section title={`Profit and loss — ${monthName}, by branch`} breakBefore>
              <table className="table-base text-xs">
                <thead>
                  <tr>
                    <th>Account</th>
                    {data.profitAndLoss.columns.map((c) => (<th key={c.id} className="num">{c.code}</th>))}
                    {data.profitAndLoss.columns.length > 1 && <th className="num">Total</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.profitAndLoss.sections.map((s) => [
                    <tr key={s.title} className="bg-gray-50"><td colSpan={data.profitAndLoss!.columns.length + 2} className="font-semibold">{s.title}</td></tr>,
                    ...s.lines.map((l) => (
                      <tr key={l.code}>
                        <td><span className="font-mono">{l.code}</span> {l.name}</td>
                        {data.profitAndLoss!.columns.map((c) => (<td key={c.id} className="num">{n(l.values[c.id])}</td>))}
                        {data.profitAndLoss!.columns.length > 1 && <td className="num">{n(l.total)}</td>}
                      </tr>
                    )),
                  ])}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Gross profit</td>
                    {data.profitAndLoss.columns.map((c) => (<td key={c.id} className="num">{n(data.profitAndLoss!.grossProfit[c.id])}</td>))}
                    {data.profitAndLoss.columns.length > 1 && <td className="num">{n(data.profitAndLoss.totals.grossProfit)}</td>}
                  </tr>
                  <tr>
                    <td>Net profit</td>
                    {data.profitAndLoss.columns.map((c) => (<td key={c.id} className="num">{n(data.profitAndLoss!.netProfit[c.id])}</td>))}
                    {data.profitAndLoss.columns.length > 1 && <td className="num">{n(data.profitAndLoss.totals.netProfit)}</td>}
                  </tr>
                </tfoot>
              </table>
              {data.profitAndLossYtd && (
                <p className="mt-2 text-xs text-muted">
                  Year to date: revenue {n(data.profitAndLossYtd.totals.revenue)}, gross profit {n(data.profitAndLossYtd.totals.grossProfit)}, operating costs {n(data.profitAndLossYtd.totals.expenses)}, net profit {n(data.profitAndLossYtd.totals.netProfit)}.
                </p>
              )}
            </Section>
          )}

          <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
            {data.balanceSheet && (
              <Section title={`Balance sheet at ${formatDate(data.to)}`}>
                <table className="w-full text-xs">
                  <tbody>
                    {data.balanceSheet.sections.map((s) => [
                      <tr key={s.title}><td colSpan={2} className="pt-2 font-semibold">{s.title}</td></tr>,
                      ...s.lines.map((l, i) => (
                        <tr key={`${s.title}-${i}`}>
                          <td className="py-0.5 pl-2">{l.name}</td>
                          <td className="py-0.5 text-right tabular-nums">{n(l.amount)}</td>
                        </tr>
                      )),
                      <tr key={`${s.title}-t`} className="font-medium"><td className="border-t border-line py-0.5">Total {s.title.toLowerCase()}</td><td className="border-t border-line py-0.5 text-right tabular-nums">{n(s.total)}</td></tr>,
                    ])}
                  </tbody>
                </table>
                {!data.balanceSheet.balanced && <p className="mt-1 text-xs text-red-700">The balance sheet does not balance.</p>}
              </Section>
            )}
            {data.cashFlow && (
              <Section title="Cash flow (year to date)">
                <table className="w-full text-xs">
                  <tbody>
                    {(
                      [
                        ['Cash at the start of the year', data.cashFlow.openingCash],
                        ['Operating activities', data.cashFlow.operating.total],
                        ['Investing activities', data.cashFlow.investing.total],
                        ['Financing activities', data.cashFlow.financing.total],
                        ['Cash at the end of the month', data.cashFlow.closingCash],
                      ] as const
                    ).map(([label, v], i) => (
                      <tr key={label} className={i === 4 ? 'font-semibold' : ''}>
                        <td className={cx('py-0.5', i === 4 && 'border-t border-line')}>{label}</td>
                        <td className={cx('py-0.5 text-right tabular-nums', i === 4 && 'border-t border-line')}>{n(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.cash && (
                  <table className="mt-3 w-full text-xs">
                    <thead><tr className="text-muted"><th className="text-left font-medium">Account</th><th className="text-right font-medium">Balance</th><th className="text-right font-medium">Reconciled to</th></tr></thead>
                    <tbody>
                      {data.cash.map((b) => (
                        <tr key={b.name}>
                          <td className="py-0.5">{b.name}</td>
                          <td className="py-0.5 text-right tabular-nums">{n(b.balance)} {b.currency}</td>
                          <td className="py-0.5 text-right">{b.reconciledTo ? formatDate(b.reconciledTo) : '—'}{b.unmatchedStatementLines > 0 && <span className="text-amber-700"> · {b.unmatchedStatementLines} open</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
            )}
          </div>

          {data.budget && (
            <Section title={`Budget vs actual (year to date) — ${data.budget.name}`} breakBefore>
              <table className="table-base text-xs">
                <thead><tr><th>Account</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">%</th></tr></thead>
                <tbody>
                  {[...data.budget.rows].sort((a, b) => Math.abs(Number(b.variance)) - Math.abs(Number(a.variance))).slice(0, 12).map((r) => (
                    <tr key={r.code}>
                      <td><span className="font-mono">{r.code}</span> {r.name}</td>
                      <td className="num">{n(r.budget)}</td>
                      <td className="num">{n(r.actual)}</td>
                      <td className={cx('num', r.favourable ? 'text-emerald-700' : 'text-red-700')}>{n(r.variance)}</td>
                      <td className="num">{r.variancePercent !== null ? `${r.variancePercent}%` : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Net result</td><td className="num">{n(data.budget.totals.netBudget)}</td><td className="num">{n(data.budget.totals.netActual)}</td><td /><td /></tr></tfoot>
              </table>
              <p className="mt-1 text-xs text-muted">The twelve largest variances are shown.</p>
            </Section>
          )}

          <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
            {(
              [
                ['Receivables ageing', data.receivables],
                ['Payables ageing', data.payables],
              ] as const
            ).map(([title, aging]) =>
              aging ? (
                <Section key={title} title={title}>
                  <div className="mb-2 grid grid-cols-5 gap-1 text-center text-[11px]">
                    {BUCKETS.map(([b, label]) => (
                      <div key={b} className="rounded border border-line p-1">
                        <p className="text-muted">{label}</p>
                        <p className={cx('font-medium tabular-nums', b !== 'current' && Number(aging.totals[b]) > 0 && 'text-amber-700')}>{n(aging.totals[b])}</p>
                      </div>
                    ))}
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {aging.top.map((r) => (
                        <tr key={r.name}><td className="py-0.5">{r.name}</td><td className="py-0.5 text-right tabular-nums">{n(r.total)}</td></tr>
                      ))}
                      <tr className="font-semibold"><td className="border-t border-line py-0.5">Total</td><td className="border-t border-line py-0.5 text-right tabular-nums">{n(aging.totals.total)}</td></tr>
                    </tbody>
                  </table>
                </Section>
              ) : null,
            )}
          </div>

          <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
            {data.fx && data.fx.rows.length > 0 && (
              <Section title="Foreign currency exposure">
                <table className="w-full text-xs">
                  <thead><tr className="text-muted"><th className="text-left font-medium">Currency</th><th className="text-right font-medium">At closing rate</th><th className="text-right font-medium">Unrealised</th><th className="text-right font-medium">±10%</th></tr></thead>
                  <tbody>
                    {data.fx.rows.map((r) => (
                      <tr key={r.currency}><td className="py-0.5">{r.currency}</td><td className="py-0.5 text-right tabular-nums">{n(r.atRate)}</td><td className="py-0.5 text-right tabular-nums">{n(r.unrealised)}</td><td className="py-0.5 text-right tabular-nums">{n(r.sensitivity10)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
            {data.inventory && data.inventory.items > 0 && (
              <Section title="Inventory">
                <p className="mb-1 text-xs">Stock value {n(data.inventory.total)} across {data.inventory.items} items{data.inventory.belowReorder.length ? `; below reorder level: ${data.inventory.belowReorder.join(', ')}` : ''}.</p>
                <table className="w-full text-xs">
                  <tbody>
                    {data.inventory.top.map((r) => (
                      <tr key={r.code}><td className="py-0.5"><span className="font-mono">{r.code}</span> {r.name}</td><td className="py-0.5 text-right tabular-nums">{r.quantity}</td><td className="py-0.5 text-right tabular-nums">{n(r.value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>

          {data.capex && data.capex.length > 0 && (
            <Section title="Capital expenditure (year to date)">
              <table className="w-full text-xs">
                <tbody>
                  {data.capex.map((a) => (
                    <tr key={a.number}><td className="py-0.5 font-mono">{a.number}</td><td className="py-0.5">{a.name}</td><td className="py-0.5">{a.branch}</td><td className="py-0.5">{formatDate(a.date)}</td><td className="py-0.5 text-right tabular-nums">{n(a.cost)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {data.projects && data.projects.length > 0 && (
            <Section title="Project performance">
              <table className="w-full text-xs">
                <thead><tr className="text-muted"><th className="text-left font-medium">Project</th><th className="text-right font-medium">Contract</th><th className="text-right font-medium">Revenue</th><th className="text-right font-medium">Cost</th><th className="text-right font-medium">Margin</th></tr></thead>
                <tbody>
                  {data.projects.map((p) => (
                    <tr key={p.code}><td className="py-0.5"><span className="font-mono">{p.code}</span> {p.name}</td><td className="py-0.5 text-right tabular-nums">{n(p.contractValue)}</td><td className="py-0.5 text-right tabular-nums">{n(p.revenue)}</td><td className="py-0.5 text-right tabular-nums">{n(p.cost)}</td><td className="py-0.5 text-right tabular-nums">{n(p.margin)}{p.marginPercent ? ` (${p.marginPercent}%)` : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {data.exceptions && (
            <Section title="Key exceptions and action points">
              {!data.exceptions.length ? (
                <p className="text-sm text-muted">No exceptions were flagged this month.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {data.exceptions.map((e, i) => (
                    <li key={i}>
                      <Badge tone={e.severity === 'high' ? 'red' : e.severity === 'medium' ? 'amber' : 'gray'}>{e.severity}</Badge> <span className="font-medium">{e.title}</span>
                      <span className="block text-xs text-muted">{e.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </article>
      )}
    </>
  );
}
