'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, Suspense } from 'react';
import { ReportFilters, ReportTitle, useReportParams } from '@/modules/finance/ui/components/report-filters';
import { Badge, Empty, ErrorBanner, Loading, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';

interface BS {
  currency: string;
  asOf: string;
  fiscalYearStart: string | null;
  sections: { title: string; accountClass: string; lines: { accountId: string | null; code: string; name: string; amount: string }[]; total: string }[];
  totals: { assets: string; liabilities: string; equity: string; liabilitiesAndEquity: string };
  balanced: boolean;
}

function BalanceSheet() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [p, set] = useReportParams({ asOf: today() });
  const { data, isLoading, error } = useQuery({
    queryKey: ['bs', entity?.id, p],
    queryFn: () =>
      api.get<BS>('/reports/balance-sheet', {
        entityId: entity!.id,
        asOf: p.asOf,
        branchIds: p.branchIds,
        departmentId: p.departmentId,
        costCentreId: p.costCentreId,
        projectId: p.projectId,
      }),
    enabled: !!p.asOf,
  });
  const dp = precision(data?.currency);
  const yearStart = data?.fiscalYearStart?.slice(0, 10);

  return (
    <>
      <ReportFilters values={p} set={set} mode="asOf" />
      <ReportTitle
        title="Balance sheet"
        subtitle={
          <>
            As of {formatDate(p.asOf)} · {data?.currency}{' '}
            {data && (data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="amber">Not balanced for this filter</Badge>)}
          </>
        }
      />
      {p.branchIds && (
        <p className="mb-3 text-xs text-muted">
          Branch balance sheets balance only when each journal balances per branch. Use the inter-branch clearing account for cross-branch entries.
        </p>
      )}
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap className="max-w-3xl">
        {isLoading ? (
          <Loading />
        ) : !data ? (
          <Empty title="No data" />
        ) : (
          <table className="table-base">
            <tbody>
              {data.sections.map((s) => (
                <Fragment key={s.accountClass}>
                  <tr>
                    <td colSpan={3} className="pt-4 text-xs font-semibold uppercase tracking-wider text-muted">{s.title}</td>
                  </tr>
                  {s.lines.map((l) => (
                    <tr key={l.code + l.name}>
                      <td className="w-20 font-mono text-xs">{l.code}</td>
                      <td>
                        {l.accountId ? (
                          <Link
                            className="hover:text-brand-700 hover:underline"
                            href={`/finance/reports/account-activity?accountId=${l.accountId}&from=${yearStart ?? p.asOf.slice(0, 4) + '-01-01'}&to=${p.asOf}`}
                          >
                            {l.name}
                          </Link>
                        ) : (
                          <span className="italic">{l.name}</span>
                        )}
                      </td>
                      <td className="num">{formatAmount(l.amount, dp, { parens: true })}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td colSpan={2}>Total {s.title.toLowerCase()}</td>
                    <td className="num">{formatAmount(s.total, dp, { parens: true })}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Liabilities and equity</td>
                <td className="num">{formatAmount(data.totals.liabilitiesAndEquity, dp, { parens: true })}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
    </>
  );
}

export default function BalanceSheetPage() {
  return (
    <Suspense fallback={<Loading />}>
      <BalanceSheet />
    </Suspense>
  );
}
