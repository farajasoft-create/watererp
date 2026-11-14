'use client';

import { useQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { downloadCsv, ReportFilters, ReportTitle, useReportParams } from '@/modules/finance/ui/components/report-filters';
import { Button, Empty, ErrorBanner, Loading, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';

interface Row { accountId: string | null; code: string; name: string; opening: string; surplus: string; otherMovements: string; closing: string }
interface Report { currency: string; rows: Row[]; totals: Omit<Row, 'accountId' | 'code' | 'name'> }

function ChangesInNetAssets() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [p, set] = useReportParams({ from: startOfYear(), to: today() });
  const { data, isLoading, error } = useQuery({
    queryKey: ['net-assets', entity?.id, p],
    queryFn: () => api.get<Report>('/reports/changes-in-net-assets', { entityId: entity!.id, from: p.from, to: p.to, branchIds: p.branchIds, departmentId: p.departmentId, costCentreId: p.costCentreId, projectId: p.projectId }),
    enabled: !!p.from && !!p.to,
  });
  const dp = precision(data?.currency);
  const amt = (v: string) => formatAmount(v, dp, { parens: true });
  return (
    <>
      <ReportFilters values={p} set={set} mode="range" />
      <div className="no-print mb-2 flex justify-end">
        {data && (
          <Button onClick={() => downloadCsv(`changes-in-net-assets-${p.from}-${p.to}.csv`, ['Code', 'Component', 'Opening', 'Surplus / (deficit)', 'Other movements', 'Closing'], [...data.rows.map((r) => [r.code, r.name, r.opening, r.surplus, r.otherMovements, r.closing]), ['', 'Total net assets', data.totals.opening, data.totals.surplus, data.totals.otherMovements, data.totals.closing]])}>
            Export CSV
          </Button>
        )}
      </div>
      <ReportTitle title="Statement of changes in net assets" subtitle={`${formatDate(p.from)} – ${formatDate(p.to)} · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty title="No net assets in this period" />
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Component of net assets</th><th className="num">Balance at {formatDate(p.from)}</th><th className="num">Surplus / (deficit) for the period</th><th className="num">Other movements</th><th className="num">Balance at {formatDate(p.to)}</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.accountId ?? i}>
                  <td><span className="font-mono text-xs">{r.code}</span> {r.name}</td>
                  <td className="num">{amt(r.opening)}</td>
                  <td className="num">{amt(r.surplus)}</td>
                  <td className="num">{amt(r.otherMovements)}</td>
                  <td className="num font-medium">{amt(r.closing)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Total net assets</td><td className="num">{amt(data.totals.opening)}</td><td className="num">{amt(data.totals.surplus)}</td><td className="num">{amt(data.totals.otherMovements)}</td><td className="num">{amt(data.totals.closing)}</td></tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <ChangesInNetAssets />
    </Suspense>
  );
}
