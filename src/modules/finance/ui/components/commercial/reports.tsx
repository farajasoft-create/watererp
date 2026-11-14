'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { PURCHASES, SALES, SideConfig } from '@/modules/finance/ui/lib/commercial';
import { formatAmount, formatDate, isZero, startOfMonth, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { downloadCsv, ReportTitle } from '../report-filters';
import { Badge, Button, Card, cx, Empty, ErrorBanner, Field, Input, Loading, Notice, TableWrap, Tabs } from '../ui';

const BUCKETS = [
  ['current', 'Current'],
  ['days1to30', '1–30'],
  ['days31to60', '31–60'],
  ['days61to90', '61–90'],
  ['over90', '90+'],
] as const;
type Bucket = (typeof BUCKETS)[number][0];

interface Aging {
  currency: string;
  asOf: string;
  rows: {
    partyId: string;
    partyName: string;
    currency: string;
    buckets: Record<Bucket, string>;
    bucketsFunctional: Record<Bucket, string>;
    credits: string;
    total: string;
    totalFunctional: string;
    documents: { id: string; number: string; date: string; dueDate: string; daysOverdue: number; open: string; reference: string }[];
  }[];
  totals: Record<Bucket | 'credits' | 'total', string>;
}

/** Aged receivables or payables, by days past due, in functional currency with party-currency detail. */
export function AgingReport({ side }: { side: SideConfig }) {
  const { entity } = useSession();
  const precision = usePrecision();
  const [asOf, setAsOf] = useState(today());
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['aging', side.partyType, entity?.id, asOf],
    queryFn: () => api.get<Aging>('/reports/aging', { entityId: entity!.id, partyType: side.partyType, asOf }),
  });
  const fp = precision(data?.currency);
  const title = side === SALES ? 'Aged receivables' : 'Aged payables';

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="As at">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        {data && (
          <Button
            onClick={() =>
              downloadCsv(
                `${side === SALES ? 'ar' : 'ap'}-aging-${asOf}.csv`,
                [side.party, 'Currency', ...BUCKETS.map(([, l]) => l), 'Unapplied credits', 'Balance', `Balance (${data.currency})`],
                data.rows.map((r) => [r.partyName, r.currency, ...BUCKETS.map(([k]) => r.buckets[k]), r.credits, r.total, r.totalFunctional]),
              )
            }
          >
            Export CSV
          </Button>
        )}
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <ReportTitle title={title} subtitle={`As at ${formatDate(asOf)} · by days past due · totals in ${data?.currency ?? ''} at carrying value`} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty title="Nothing outstanding" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>{side.party}</th>
                {BUCKETS.map(([k, l]) => (
                  <th key={k} className="num">{l}</th>
                ))}
                <th className="num">Credits</th>
                <th className="num">Balance</th>
                <th className="num">{data.currency}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const dp = precision(r.currency);
                return (
                  <Fragment key={r.partyId}>
                    <tr className="cursor-pointer" onClick={() => setExpanded(expanded === r.partyId ? null : r.partyId)}>
                      <td>
                        <Link className="font-medium text-brand-700 hover:underline" href={`${side.partiesPath}/${r.partyId}`} onClick={(e) => e.stopPropagation()}>
                          {r.partyName}
                        </Link>
                        {r.currency !== data.currency && <span className="ml-1 text-xs text-muted">{r.currency}</span>}
                      </td>
                      {BUCKETS.map(([k]) => (
                        <td key={k} className={cx('num', k !== 'current' && !isZero(r.buckets[k]) && 'text-red-700')}>
                          {formatAmount(r.buckets[k], dp, { blankZero: true })}
                        </td>
                      ))}
                      <td className="num text-muted">{formatAmount(r.credits, dp, { blankZero: true })}</td>
                      <td className="num font-medium">{formatAmount(r.total, dp, { parens: true })}</td>
                      <td className="num">{formatAmount(r.totalFunctional, fp, { parens: true })}</td>
                    </tr>
                    {expanded === r.partyId &&
                      r.documents.map((d) => (
                        <tr key={d.id} className="bg-gray-50 text-xs">
                          <td className="pl-8">
                            <Link className="font-mono text-brand-700 hover:underline" href={`${side.documentsPath}/${d.id}`}>{d.number}</Link>
                            <span className="ml-2 text-muted">due {formatDate(d.dueDate)}{d.reference ? ` · ${d.reference}` : ''}</span>
                          </td>
                          <td colSpan={5} className="text-muted">{d.daysOverdue ? `${d.daysOverdue} days overdue` : 'Not yet due'}</td>
                          <td />
                          <td className="num">{formatAmount(d.open, dp)}</td>
                          <td />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total {data.currency}</td>
                {BUCKETS.map(([k]) => (
                  <td key={k} className="num">{formatAmount(data.totals[k], fp)}</td>
                ))}
                <td className="num">{formatAmount(data.totals.credits, fp)}</td>
                <td />
                <td className="num">{formatAmount(data.totals.total, fp, { parens: true })}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
    </>
  );
}

interface TaxReport {
  currency: string;
  entity: { taxId: string };
  summary: { direction: string; taxCode: string; rate: string; taxable: string; tax: string; count: number }[];
  totals: { outputTax: string; inputTax: string; netVatPayable: string; withholdingTax: string; withheldByCustomers?: string; vatWithheldByCustomers?: string };
  transactions: { id: string; date: string; direction: string; documentNumber: string; sourceType: string; sourceId: string; partyName: string; partyTaxId: string; taxCode: string; rate: string; taxableAmount: string; taxAmount: string }[];
  truncated: boolean;
}

const DIRECTION: Record<string, string> = { OUTPUT: 'Output tax (sales)', INPUT: 'Input tax (purchases)', WITHHOLDING: 'Withholding tax deducted', WITHHELD: 'Withheld by customers' };

export function TaxReportView() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [range, setRange] = useState({ from: startOfMonth(), to: today() });
  const [tab, setTab] = useState<'summary' | 'detail'>('summary');
  const { data, isLoading, error } = useQuery({ queryKey: ['tax-report', entity?.id, range], queryFn: () => api.get<TaxReport>('/reports/tax', { entityId: entity!.id, ...range }) });
  const fp = precision(data?.currency);
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
        {data && (
          <Button
            onClick={() =>
              downloadCsv(
                `tax-${range.from}-${range.to}.csv`,
                ['Date', 'Type', 'Document', 'Party', 'Party tax ID', 'Tax code', 'Rate %', 'Taxable', 'Tax'],
                data.transactions.map((t) => [t.date.slice(0, 10), t.direction, t.documentNumber, t.partyName, t.partyTaxId, t.taxCode, t.rate, t.taxableAmount, t.taxAmount]),
              )
            }
          >
            Export transactions
          </Button>
        )}
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <ReportTitle title="Tax return support" subtitle={`${formatDate(range.from)} – ${formatDate(range.to)} · ${data?.currency ?? ''}${data?.entity.taxId ? ` · Tax ID ${data.entity.taxId}` : ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Output VAT', data.totals.outputTax],
              ['Input VAT', data.totals.inputTax],
              ['Net VAT payable', data.totals.netVatPayable],
              ['Withholding tax deducted', data.totals.withholdingTax],
              ...(data.totals.withheldByCustomers && data.totals.withheldByCustomers !== '0' ? [['Withheld by customers (recoverable)', data.totals.withheldByCustomers]] : []),
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-white p-3 shadow-xs">
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatAmount(value, fp, { parens: true })}</p>
              </div>
            ))}
          </div>
          {data.truncated && <Notice tone="amber">Showing the first 5,000 transactions; narrow the period for full detail.</Notice>}
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'By tax code' }, { id: 'detail', label: `Transactions (${data.transactions.length})` }]} />
          {tab === 'summary' ? (
            <TableWrap>
              {!data.summary.length ? (
                <Empty title="No taxable transactions in this period" />
              ) : (
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Tax code</th>
                      <th className="num">Rate</th>
                      <th className="num">Transactions</th>
                      <th className="num">Taxable value</th>
                      <th className="num">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.map((r) => (
                      <tr key={`${r.direction}${r.taxCode}${r.rate}`}>
                        <td>{DIRECTION[r.direction]}</td>
                        <td className="whitespace-nowrap font-mono text-xs">{r.taxCode}</td>
                        <td className="num">{r.rate}%</td>
                        <td className="num">{r.count}</td>
                        <td className="num">{formatAmount(r.taxable, fp, { parens: true })}</td>
                        <td className="num">{formatAmount(r.tax, fp, { parens: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TableWrap>
          ) : (
            <TableWrap>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Document</th>
                    <th>Party</th>
                    <th>Tax ID</th>
                    <th>Code</th>
                    <th className="num">Taxable</th>
                    <th className="num">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transactions.map((t) => (
                    <tr key={t.id}>
                      <td>{formatDate(t.date)}</td>
                      <td><Badge tone={t.direction === 'OUTPUT' ? 'blue' : t.direction === 'INPUT' ? 'green' : t.direction === 'WITHHELD' ? 'amber' : 'violet'}>{t.direction.toLowerCase()}</Badge></td>
                      <td className="whitespace-nowrap font-mono text-xs">
                        <Link
                          className="text-brand-700 hover:underline"
                          href={t.sourceType === 'Payment' ? `${t.direction === 'WITHHELD' ? SALES.paymentsPath : PURCHASES.paymentsPath}/${t.sourceId}` : `${t.direction === 'OUTPUT' ? SALES.documentsPath : PURCHASES.documentsPath}/${t.sourceId}`}
                        >
                          {t.documentNumber}
                        </Link>
                      </td>
                      <td>{t.partyName}</td>
                      <td className="text-xs text-muted">{t.partyTaxId}</td>
                      <td className="text-xs">{t.taxCode} {t.rate}%</td>
                      <td className="num">{formatAmount(t.taxableAmount, fp, { parens: true })}</td>
                      <td className="num">{formatAmount(t.taxAmount, fp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      )}
    </>
  );
}

interface ControlCheck {
  currency: string;
  checks: {
    partyType: 'CUSTOMER' | 'SUPPLIER';
    account: { id: string; code: string; name: string } | null;
    subledger: string;
    ledger: string;
    difference: string;
    reconciled: boolean;
    differences: { partyId: string | null; name: string; subledger: string; ledger: string; difference: string }[];
  }[];
}

/** Month-end control: subledger open items agree with the GL control accounts. */
export function SubledgerControlView() {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data, isLoading, error } = useQuery({ queryKey: ['subledger-control', entity?.id], queryFn: () => api.get<ControlCheck>('/reports/subledger-control', { entityId: entity!.id }) });
  const fp = precision(data?.currency);
  return (
    <>
      <ReportTitle title="Subledger to ledger reconciliation" subtitle={`Receivables and payables open items against their control accounts · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {data.checks.map((c) => {
            const side = c.partyType === 'CUSTOMER' ? SALES : PURCHASES;
            return (
              <Card
                key={c.partyType}
                title={`${c.partyType === 'CUSTOMER' ? 'Accounts receivable' : 'Accounts payable'} · ${c.account?.code} ${c.account?.name}`}
                actions={<Badge tone={c.reconciled ? 'green' : 'red'}>{c.reconciled ? 'Reconciled' : 'Difference'}</Badge>}
              >
                <dl className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Subledger (open items)</dt>
                    <dd className="text-lg font-semibold tabular-nums">{formatAmount(c.subledger, fp, { parens: true })}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">General ledger</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {c.account ? <Link className="hover:underline" href={`/finance/reports/account-activity?accountId=${c.account.id}`}>{formatAmount(c.ledger, fp, { parens: true })}</Link> : formatAmount(c.ledger, fp)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Difference</dt>
                    <dd className={cx('text-lg font-semibold tabular-nums', !c.reconciled && 'text-red-700')}>{formatAmount(c.difference, fp, { parens: true })}</dd>
                  </div>
                </dl>
                {c.differences.length > 0 && (
                  <table className="table-base mt-3">
                    <thead>
                      <tr>
                        <th>{side.party}</th>
                        <th className="num">Subledger</th>
                        <th className="num">Ledger</th>
                        <th className="num">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.differences.map((d) => (
                        <tr key={d.partyId ?? 'none'}>
                          <td>{d.partyId ? <Link className="text-brand-700 hover:underline" href={`${side.partiesPath}/${d.partyId}`}>{d.name}</Link> : d.name}</td>
                          <td className="num">{formatAmount(d.subledger, fp, { parens: true })}</td>
                          <td className="num">{formatAmount(d.ledger, fp, { parens: true })}</td>
                          <td className="num text-red-700">{formatAmount(d.difference, fp, { parens: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
          {!data.checks.length && <Notice tone="amber">Set the receivables and payables control accounts in organisation settings.</Notice>}
        </div>
      )}
    </>
  );
}
