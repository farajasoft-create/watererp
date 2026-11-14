'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, Suspense } from 'react';
import { downloadCsv, ReportFilters, ReportTitle, useReportParams } from '@/modules/finance/ui/components/report-filters';
import { Checkbox, cx, Empty, ErrorBanner, Loading, TableWrap, Button } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';

interface Section {
  title: string;
  accountClass: string;
  lines: { accountId: string; code: string; name: string; values: Record<string, string>; total: string }[];
  totals: Record<string, string>;
  total: string;
}
interface PL {
  currency: string;
  columns: { id: string; code: string; name: string }[];
  sections: Section[];
  grossProfit: Record<string, string>;
  netProfit: Record<string, string>;
  totals: { revenue: string; costOfSales: string; grossProfit: string; expenses: string; netProfit: string };
}

function ProfitAndLoss() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [p, set] = useReportParams({ from: startOfYear(), to: today() });
  const byBranch = p.byBranch === 'true';
  const { data, isLoading, error } = useQuery({
    queryKey: ['pl', entity?.id, p],
    queryFn: () =>
      api.get<PL>('/reports/profit-and-loss', {
        entityId: entity!.id,
        from: p.from,
        to: p.to,
        branchIds: p.branchIds,
        departmentId: p.departmentId,
        costCentreId: p.costCentreId,
        projectId: p.projectId,
        byBranch,
      }),
    enabled: !!p.from && !!p.to,
  });
  const dp = precision(data?.currency);
  const cols = data?.columns ?? [];
  const multi = byBranch && cols.length > 0;
  const fmt = (v: string | undefined) => formatAmount(v ?? '0', dp, { parens: true });

  const exportCsv = () => {
    if (!data) return;
    const rows: string[][] = [];
    for (const s of data.sections) {
      for (const l of s.lines) rows.push([s.title, l.code, l.name, ...cols.map((c) => l.values[c.id] ?? '0'), ...(multi ? [l.total] : [])]);
      rows.push([s.title, '', `Total ${s.title.toLowerCase()}`, ...cols.map((c) => s.totals[c.id]), ...(multi ? [s.total] : [])]);
    }
    rows.push(['', '', 'Net profit', ...cols.map((c) => data.netProfit[c.id]), ...(multi ? [data.totals.netProfit] : [])]);
    downloadCsv(`profit-and-loss-${entity!.code}-${p.from}-${p.to}.csv`, ['Section', 'Code', 'Account', ...cols.map((c) => c.code), ...(multi ? ['Total'] : [])], rows);
  };

  const row = (label: string, values: Record<string, string>, total: string, strong = false) => (
    <tr className={cx(strong && 'bg-gray-50 font-semibold')}>
      <td colSpan={2} className={strong ? '' : 'pl-6'}>{label}</td>
      {cols.map((c) => (
        <td key={c.id} className="num">{fmt(values[c.id])}</td>
      ))}
      {multi && <td className="num">{fmt(total)}</td>}
    </tr>
  );

  return (
    <>
      <ReportFilters
        values={p}
        set={set}
        mode="range"
        extra={
          <>
            <div className="pb-2">
              <Checkbox label="Columns by branch" checked={byBranch} onChange={(v) => set({ byBranch: v ? 'true' : '' })} />
            </div>
            {data && <Button size="sm" onClick={exportCsv}>Export CSV</Button>}
          </>
        }
      />
      <ReportTitle title="Profit & loss" subtitle={`${formatDate(p.from)} – ${formatDate(p.to)} · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data ? (
          <Empty title="No data" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-20">Code</th>
                <th>Account</th>
                {cols.map((c) => (
                  <th key={c.id} className="num" title={c.name}>{multi ? c.code : 'Amount'}</th>
                ))}
                {multi && <th className="num">Total</th>}
              </tr>
            </thead>
            <tbody>
              {data.sections.map((s, i) => (
                <Fragment key={s.accountClass}>
                  <tr>
                    <td colSpan={2 + cols.length + (multi ? 1 : 0)} className="pt-4 text-xs font-semibold uppercase tracking-wider text-muted">
                      {s.title}
                    </td>
                  </tr>
                  {s.lines.map((l) => (
                    <tr key={l.accountId}>
                      <td className="font-mono text-xs">{l.code}</td>
                      <td>
                        <Link
                          className="hover:text-brand-700 hover:underline"
                          href={`/finance/reports/account-activity?accountId=${l.accountId}&from=${p.from}&to=${p.to}${p.branchIds ? `&branchIds=${p.branchIds}` : ''}`}
                        >
                          {l.name}
                        </Link>
                      </td>
                      {cols.map((c) => (
                        <td key={c.id} className="num">{formatAmount(l.values[c.id] ?? '0', dp, { parens: true, blankZero: true })}</td>
                      ))}
                      {multi && <td className="num">{fmt(l.total)}</td>}
                    </tr>
                  ))}
                  {row(`Total ${s.title.toLowerCase()}`, s.totals, s.total, true)}
                  {i === 1 && row('Gross profit', data.grossProfit, data.totals.grossProfit, true)}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Net profit</td>
                {cols.map((c) => (
                  <td key={c.id} className="num">{fmt(data.netProfit[c.id])}</td>
                ))}
                {multi && <td className="num">{fmt(data.totals.netProfit)}</td>}
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
    </>
  );
}

export default function ProfitAndLossPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProfitAndLoss />
    </Suspense>
  );
}
