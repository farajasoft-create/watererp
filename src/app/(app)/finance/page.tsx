'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { MonthlyChart } from '@/modules/finance/ui/components/monthly-chart';
import { Button, Card, ErrorBanner, Loading, PageHeader, StatusBadge } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { addAll, formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';

interface Dashboard {
  currency: string;
  asOf: string;
  fiscalYearStart: string;
  kpis: Record<'cash' | 'receivables' | 'payables' | 'revenueYtd' | 'grossProfitYtd' | 'expensesYtd' | 'netProfitYtd', string> & {
    grossMarginPct: string | null;
  };
  months: { month: string; revenue: string; costOfSales: string; expenses: string; netProfit: string }[];
  workflow: { pendingApproval: number; awaitingPosting: number; drafts: number; invoicesAwaiting: number; billsAwaiting: number; paymentsAwaiting: number };
  overdue: { receivables: string; payables: string };
  currentPeriod: { id: string; name: string; status: string } | null;
}

function Kpi({ label, value, currency, sub }: { label: string; value: string; currency: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4 shadow-xs">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {formatAmount(value, 0, { parens: true })}
        <span className="ml-1 text-xs font-normal text-muted">{currency}</span>
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { entity, can, me } = useSession();
  const [showTable, setShowTable] = useState(false);
  const asOf = today();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', entity?.id, asOf],
    queryFn: () => api.get<Dashboard>('/reports/dashboard', { entityId: entity!.id, asOf }),
    enabled: !!entity && can('reports.view'),
  });

  if (!can('reports.view')) {
    return <PageHeader title={`Welcome, ${me.name}`} description="Use the navigation to get started." />;
  }

  return (
    <>
      <PageHeader
        title={entity!.name}
        description={data ? `Year to date from ${formatDate(data.fiscalYearStart)} to ${formatDate(data.asOf)} · ${data.currency}` : undefined}
        actions={
          can('journal.create') && (
            <Link href="/finance/journals/new" className="inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
              New journal
            </Link>
          )
        }
      />
      <ErrorBanner error={error} className="mb-4" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Cash & bank" value={data.kpis.cash} currency={data.currency} />
            <Kpi label="Revenue (YTD)" value={data.kpis.revenueYtd} currency={data.currency} />
            <Kpi
              label="Gross profit (YTD)"
              value={data.kpis.grossProfitYtd}
              currency={data.currency}
              sub={data.kpis.grossMarginPct !== null ? `${data.kpis.grossMarginPct}% gross margin` : undefined}
            />
            <Kpi label="Net profit (YTD)" value={data.kpis.netProfitYtd} currency={data.currency} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <Card
              title="Revenue and costs by month"
              actions={
                <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
                  {showTable ? 'Show chart' : 'Show table'}
                </Button>
              }
            >
              {showTable ? (
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Revenue</th>
                      <th className="num">Cost of sales</th>
                      <th className="num">Expenses</th>
                      <th className="num">Net profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{formatAmount(m.revenue)}</td>
                        <td className="num">{formatAmount(m.costOfSales)}</td>
                        <td className="num">{formatAmount(m.expenses)}</td>
                        <td className="num">{formatAmount(m.netProfit, 2, { parens: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <MonthlyChart
                  currency={data.currency}
                  data={data.months.map((m) => ({ month: m.month, revenue: m.revenue, costs: addAll([m.costOfSales, m.expenses]), netProfit: m.netProfit }))}
                />
              )}
            </Card>

            <div className="space-y-5">
              <Card title="Workflow">
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between">
                    <Link href="/finance/journals?status=SUBMITTED" className="text-brand-700 hover:underline">Awaiting approval</Link>
                    <span className="font-semibold tabular-nums">{data.workflow.pendingApproval}</span>
                  </li>
                  <li className="flex justify-between">
                    <Link href="/finance/journals?status=APPROVED" className="text-brand-700 hover:underline">Approved, not posted</Link>
                    <span className="font-semibold tabular-nums">{data.workflow.awaitingPosting}</span>
                  </li>
                  <li className="flex justify-between">
                    <Link href="/finance/journals?status=DRAFT" className="text-brand-700 hover:underline">Drafts & rejected</Link>
                    <span className="font-semibold tabular-nums">{data.workflow.drafts}</span>
                  </li>
                  {(
                    [
                      ['/sales/invoices?filter=SUBMITTED', 'Invoices awaiting approval', data.workflow.invoicesAwaiting, 'ar.view'],
                      ['/purchases/bills?filter=SUBMITTED', 'Bills awaiting approval', data.workflow.billsAwaiting, 'ap.view'],
                      ['/purchases/payments', 'Payments awaiting release', data.workflow.paymentsAwaiting, 'ap.view'],
                    ] as const
                  ).map(([href, label, count, permission]) =>
                    can(permission) ? (
                      <li key={href} className="flex justify-between">
                        <Link href={href} className="text-brand-700 hover:underline">{label}</Link>
                        <span className="font-semibold tabular-nums">{count}</span>
                      </li>
                    ) : null,
                  )}
                </ul>
              </Card>
              <Card title="Balances">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted">Receivables</dt>
                    <dd className="num">{formatAmount(data.kpis.receivables)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Payables</dt>
                    <dd className="num">{formatAmount(data.kpis.payables)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Overdue receivables</dt>
                    <dd className="num text-red-700">{formatAmount(data.overdue.receivables)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Overdue payables</dt>
                    <dd className="num">{formatAmount(data.overdue.payables)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Operating expenses (YTD)</dt>
                    <dd className="num">{formatAmount(data.kpis.expensesYtd)}</dd>
                  </div>
                </dl>
              </Card>
              <Card title="Current period">
                {data.currentPeriod ? (
                  <div className="flex items-center justify-between text-sm">
                    <Link href="/finance/periods" className="font-medium hover:underline">{data.currentPeriod.name}</Link>
                    <StatusBadge status={data.currentPeriod.status} />
                  </div>
                ) : (
                  <p className="text-sm text-muted">
                    No period covers today. <Link href="/finance/periods" className="text-brand-700 hover:underline">Create a fiscal year</Link>
                  </p>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
