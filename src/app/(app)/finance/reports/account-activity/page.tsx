'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Suspense } from 'react';
import { downloadCsv, ReportFilters, ReportTitle, useReportParams } from '@/modules/finance/ui/components/report-filters';
import { Button, Empty, ErrorBanner, Field, Loading, Notice, Select, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, isZero, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';

interface Activity {
  currency: string;
  account: { id: string; code: string; name: string; accountClass: string };
  openingBalance: string;
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
  truncated: boolean;
  rows: {
    id: string;
    journalId: string;
    journalNumber: string;
    date: string;
    description: string;
    branchId: string;
    currency: string;
    exchangeRate: string;
    debitTx: string;
    creditTx: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
}

function AccountActivity() {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const { data: branches = [] } = useBranches(entity?.id);
  const [p, set] = useReportParams({ from: startOfYear(), to: today() });
  const { data, isLoading, error } = useQuery({
    queryKey: ['activity', entity?.id, p],
    queryFn: () =>
      api.get<Activity>('/reports/account-activity', {
        entityId: entity!.id,
        accountId: p.accountId,
        from: p.from,
        to: p.to,
        branchIds: p.branchIds,
        departmentId: p.departmentId,
        costCentreId: p.costCentreId,
        projectId: p.projectId,
      }),
    enabled: !!p.accountId && !!p.from && !!p.to,
  });
  const dp = precision(data?.currency);
  const foreign = data?.rows.some((r) => r.currency !== data.currency);
  const bal = (v: string) => formatAmount(v, dp, { parens: true });

  return (
    <>
      <ReportFilters
        values={p}
        set={set}
        mode="range"
        extra={
          <>
            <Field label="Account">
              <Select className="w-72" value={p.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                <option value="">Select an account…</option>
                {accounts.filter((a) => a.isPostable).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            {data && (
              <Button
                size="sm"
                onClick={() =>
                  downloadCsv(
                    `account-${data.account.code}-${p.from}-${p.to}.csv`,
                    ['Date', 'Journal', 'Description', 'Branch', 'Currency', 'Rate', 'Debit (tx)', 'Credit (tx)', 'Debit', 'Credit', 'Balance'],
                    data.rows.map((r) => [
                      r.date.slice(0, 10),
                      r.journalNumber,
                      r.description,
                      branches.find((b) => b.id === r.branchId)?.code,
                      r.currency,
                      r.exchangeRate,
                      r.debitTx,
                      r.creditTx,
                      r.debit,
                      r.credit,
                      r.balance,
                    ]),
                  )
                }
              >
                Export CSV
              </Button>
            )}
          </>
        }
      />
      {!p.accountId ? (
        <Notice>Choose an account to see its transactions with a running balance.</Notice>
      ) : (
        <>
          <ReportTitle
            title={data ? `${data.account.code} · ${data.account.name}` : 'Account activity'}
            subtitle={`${formatDate(p.from)} – ${formatDate(p.to)} · ${data?.currency ?? ''} · balances shown as debit (credit)`}
          />
          <ErrorBanner error={error} className="mb-3" />
          {data?.truncated && <Notice tone="amber">Showing the first 5,000 entries. Narrow the date range to see the rest.</Notice>}
          <TableWrap className="mt-2">
            {isLoading ? (
              <Loading />
            ) : !data ? (
              <Empty title="No data" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Journal</th>
                    <th>Description</th>
                    <th>Branch</th>
                    {foreign && (
                      <>
                        <th>Currency</th>
                        <th className="num">Tx amount</th>
                        <th className="num">Rate</th>
                      </>
                    )}
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-gray-50">
                    <td colSpan={foreign ? 9 : 6} className="font-medium">Opening balance</td>
                    <td className="num font-medium">{bal(data.openingBalance)}</td>
                  </tr>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{formatDate(r.date)}</td>
                      <td className="font-mono text-xs">
                        <Link href={`/finance/journals/${r.journalId}`} className="text-brand-700 hover:underline">{r.journalNumber}</Link>
                      </td>
                      <td className="max-w-sm truncate">{r.description}</td>
                      <td>{branches.find((b) => b.id === r.branchId)?.code}</td>
                      {foreign && (
                        <>
                          <td>{r.currency}</td>
                          <td className="num">{r.currency === data.currency ? '' : formatAmount(!isZero(r.debitTx) ? r.debitTx : `-${r.creditTx}`, precision(r.currency), { parens: true })}</td>
                          <td className="num">{r.currency === data.currency ? '' : r.exchangeRate}</td>
                        </>
                      )}
                      <td className="num">{formatAmount(r.debit, dp, { blankZero: true })}</td>
                      <td className="num">{formatAmount(r.credit, dp, { blankZero: true })}</td>
                      <td className="num">{bal(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={foreign ? 7 : 4}>Closing balance</td>
                    <td className="num">{formatAmount(data.totalDebit, dp)}</td>
                    <td className="num">{formatAmount(data.totalCredit, dp)}</td>
                    <td className="num">{bal(data.closingBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </TableWrap>
        </>
      )}
    </>
  );
}

export default function AccountActivityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AccountActivity />
    </Suspense>
  );
}
