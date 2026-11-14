'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Suspense } from 'react';
import { downloadCsv, ReportFilters, ReportTitle, useReportParams } from '@/modules/finance/ui/components/report-filters';
import { Badge, Button, Empty, ErrorBanner, Loading, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';

interface TbRow {
  accountId: string | null;
  code: string;
  name: string;
  accountClass: string;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
}
interface Tb {
  currency: string;
  rows: TbRow[];
  totals: Omit<TbRow, 'accountId' | 'code' | 'name' | 'accountClass'>;
  balanced: boolean;
  fiscalYearStart: string | null;
}

const COLS = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;

function TrialBalance() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [p, set] = useReportParams({ from: startOfYear(), to: today() });
  const { data, isLoading, error } = useQuery({
    queryKey: ['tb', entity?.id, p],
    queryFn: () =>
      api.get<Tb>('/reports/trial-balance', {
        entityId: entity!.id,
        from: p.from,
        to: p.to,
        branchIds: p.branchIds,
        departmentId: p.departmentId,
        costCentreId: p.costCentreId,
        projectId: p.projectId,
      }),
    enabled: !!p.from && !!p.to,
  });
  const dp = precision(data?.currency);
  const drill = (accountId: string) => `/reports/account-activity?accountId=${accountId}&from=${p.from}&to=${p.to}${p.branchIds ? `&branchIds=${p.branchIds}` : ''}`;

  return (
    <>
      <ReportFilters
        values={p}
        set={set}
        mode="range"
        extra={
          data && (
            <Button
              size="sm"
              onClick={() =>
                downloadCsv(
                  `trial-balance-${entity!.code}-${p.from}-${p.to}.csv`,
                  ['Code', 'Account', 'Class', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr'],
                  data.rows.map((r) => [r.code, r.name, r.accountClass, ...COLS.map((c) => r[c])]),
                )
              }
            >
              Export CSV
            </Button>
          )
        }
      />
      <ReportTitle
        title="Trial balance"
        subtitle={
          <>
            {formatDate(p.from)} – {formatDate(p.to)} · {data?.currency}{' '}
            {data && (data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="red">Out of balance</Badge>)}
          </>
        }
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty title="No posted transactions in this range" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th rowSpan={2}>Code</th>
                <th rowSpan={2}>Account</th>
                <th colSpan={2} className="text-center!">Opening</th>
                <th colSpan={2} className="text-center!">Movement</th>
                <th colSpan={2} className="text-center!">Closing</th>
              </tr>
              <tr>
                {COLS.map((c) => (
                  <th key={c} className="num">{c.toLowerCase().includes('debit') ? 'Debit' : 'Credit'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.code + r.name}>
                  <td className="font-mono text-xs">{r.code}</td>
                  <td>
                    {r.accountId ? (
                      <Link href={drill(r.accountId)} className="hover:text-brand-700 hover:underline">{r.name}</Link>
                    ) : (
                      r.name
                    )}
                  </td>
                  {COLS.map((c) => (
                    <td key={c} className="num">{formatAmount(r[c], dp, { blankZero: true })}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                {COLS.map((c) => (
                  <td key={c} className="num">{formatAmount(data.totals[c], dp)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
      {data?.fiscalYearStart && (
        <p className="mt-2 text-xs text-muted">
          Income and expense balances reset at the fiscal year start ({formatDate(data.fiscalYearStart)}); earlier results are carried in retained earnings.
        </p>
      )}
    </>
  );
}

export default function TrialBalancePage() {
  return (
    <Suspense fallback={<Loading />}>
      <TrialBalance />
    </Suspense>
  );
}
