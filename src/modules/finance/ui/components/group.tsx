'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, compare, formatAmount, formatDate, formatDateTime, isZero, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useCurrencies, useEntities, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { AccountClass } from '@/modules/finance/ui/lib/types';
import { AccountOptions, ApprovalTrail } from './commercial/shared';
import { downloadCsv, ReportTitle } from './report-filters';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Textarea } from './ui';

const amountPattern = /^\d*(\.\d*)?$/;
const endOfLastMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------------------------
// Exchange-rate tools
// ---------------------------------------------------------------------------------------------

/** Bulk rate import (CSV) and deriving monthly AVERAGE / CLOSING rates, for the currencies page. */
export function RateTools() {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const { data: currencies = [] } = useCurrencies();
  const [dialog, setDialog] = useState<null | 'import' | 'derive'>(null);
  const [text, setText] = useState('');
  const [source, setSource] = useState('Central bank');
  const [derive, setDerive] = useState({ month: endOfLastMonth().slice(0, 7), fromCurrency: 'USD', toCurrency: entity?.functionalCurrency ?? 'KES' });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const parsed = useMemo(() => {
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out: { fromCurrency: string; toCurrency: string; rateType: string; rate: string; effectiveDate: string }[] = [];
    const errors: string[] = [];
    rows.forEach((row, i) => {
      const cols = row.split(',').map((c) => c.trim());
      if (i === 0 && /date/i.test(row)) return; // header
      const [date, from, to, rate, type = 'SPOT'] = cols;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^[A-Za-z]{3}$/.test(from ?? '') || !/^[A-Za-z]{3}$/.test(to ?? '') || !/^\d+(\.\d+)?$/.test(rate ?? '')) {
        errors.push(`Line ${i + 1} skipped`);
        return;
      }
      out.push({ effectiveDate: date, fromCurrency: from.toUpperCase(), toCurrency: to.toUpperCase(), rate, rateType: type.toUpperCase() });
    });
    return { rates: out, errors };
  }, [text]);
  const done = (message: string) => {
    setResult(message);
    setError(null);
    setDialog(null);
    queryClient.invalidateQueries({ queryKey: ['rates'] });
    queryClient.invalidateQueries({ queryKey: ['exchange-rates'] });
  };
  const importRates = useMutation({
    mutationFn: () => api.post<{ imported: number; skipped: number; status: string }>('/exchange-rates/import', { source, rates: parsed.rates }),
    onSuccess: (r) => done(`Imported ${r.imported} rate(s) (${r.status.toLowerCase()}); skipped ${r.skipped} already captured.`),
    onError: (err) => setError(errorMessage(err)),
  });
  const deriveRates = useMutation({
    mutationFn: () => api.post<{ average: string; closing: string; basedOn: number; status: string }>('/exchange-rates/derive', derive),
    onSuccess: (r) => done(`${derive.fromCurrency}/${derive.toCurrency} ${derive.month}: average ${r.average} (from ${r.basedOn} spot rates), closing ${r.closing} — ${r.status.toLowerCase()}.`),
    onError: (err) => setError(errorMessage(err)),
  });
  const active = currencies.filter((c) => c.isActive);
  return (
    <>
      <Button onClick={() => (setError(null), setDialog('import'))}>Import rates</Button>
      <Button onClick={() => (setError(null), setDialog('derive'))}>Month-end rates</Button>
      {result && (
        <span className="basis-full text-right text-xs text-emerald-700" role="status">
          {result}
        </span>
      )}
      <Modal
        wide
        open={dialog === 'import'}
        onClose={() => setDialog(null)}
        title="Import exchange rates"
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!parsed.rates.length} loading={importRates.isPending} onClick={() => importRates.mutate()}>
              Import {parsed.rates.length} rate(s)
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <p className="text-sm text-muted">
            One rate per line as <span className="font-mono">date,from,to,rate[,type]</span>, e.g. <span className="font-mono">2026-09-30,USD,KES,129.45,CLOSING</span>. Type defaults to SPOT. Rates already captured for the same pair, type and date are skipped.
          </p>
          <Field label="Source">
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <input type="file" accept=".csv,text/csv,text/plain" className="text-sm" onChange={async (e) => e.target.files?.[0] && setText(await e.target.files[0].text())} />
          <Textarea rows={8} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'date,from,to,rate,type\n2026-09-30,USD,KES,129.45,CLOSING'} />
          {parsed.errors.length > 0 && <Notice tone="amber">{parsed.errors.slice(0, 5).join(', ')}</Notice>}
        </div>
      </Modal>
      <Modal
        open={dialog === 'derive'}
        onClose={() => setDialog(null)}
        title="Month-end rates"
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" loading={deriveRates.isPending} onClick={() => deriveRates.mutate()}>
              Create AVERAGE & CLOSING
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <p className="text-sm text-muted">
            The AVERAGE rate is the mean of the month&apos;s approved SPOT rates (used to translate income and expenses); the CLOSING rate is the last SPOT rate of the month (used for revaluation and balance sheets).
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Month">
              <Input type="month" value={derive.month} onChange={(e) => setDerive({ ...derive, month: e.target.value })} />
            </Field>
            <Field label="From">
              <Select value={derive.fromCurrency} onChange={(e) => setDerive({ ...derive, fromCurrency: e.target.value })}>
                {active.map((c) => (
                  <option key={c.code}>{c.code}</option>
                ))}
              </Select>
            </Field>
            <Field label="To">
              <Select value={derive.toCurrency} onChange={(e) => setDerive({ ...derive, toCurrency: e.target.value })}>
                {active.map((c) => (
                  <option key={c.code}>{c.code}</option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// FX revaluation
// ---------------------------------------------------------------------------------------------

interface RevaluationLine {
  kind: 'ACCOUNT' | 'OPEN_ITEM';
  accountId: string;
  accountCode: string;
  branchId: string;
  currency: string;
  partyType: string | null;
  partyName: string;
  documentId: string | null;
  documentNumber: string;
  balanceTx: string;
  carrying: string;
  revalued: string;
  difference: string;
}
interface Preview {
  currency: string;
  rates: { currency: string; rate: string; rateType: string; effectiveDate: string }[];
  lines: RevaluationLine[];
  unchanged: number;
  totalGain: string;
  totalLoss: string;
}
interface Run {
  id: string;
  number: string;
  date: string;
  reverseOn: string;
  rateType: string;
  totalGain: string;
  totalLoss: string;
  journalId: string;
  journalNumber: string;
  createdByName: string;
  createdAt: string;
}

export function RevaluationPage() {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const { data: branches = [] } = useBranches(entity?.id);
  const [date, setDate] = useState(endOfLastMonth());
  const [rateType, setRateType] = useState('CLOSING');
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['revaluation-preview', entity?.id, date, rateType],
    queryFn: () => api.get<Preview>('/fx/revaluations/preview', { entityId: entity!.id, date, rateType }),
    retry: false,
  });
  const runs = useQuery({ queryKey: ['revaluations', entity?.id], queryFn: () => api.get<Run[]>('/fx/revaluations', { entityId: entity!.id }) });
  const post = useMutation({
    mutationFn: () => api.post<{ number: string; journalNumber: string }>('/fx/revaluations', { entityId: entity!.id, date, rateType }),
    onSuccess: (r) => {
      setPosted(`${r.number} posted as ${r.journalNumber}; it reverses automatically the next day.`);
      setError(null);
      for (const key of [['revaluations'], ['revaluation-preview'], ['dashboard']]) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const p = preview.data;
  const fp = precision(p?.currency);
  const branch = (id: string) => branches.find((b) => b.id === id)?.code ?? '';
  const already = runs.data?.some((r) => r.date.slice(0, 10) === date);

  return (
    <>
      <PageHeader
        title="FX revaluation"
        description="Revalue foreign-currency monetary balances at period-end rates. Open invoices and bills are revalued item by item; the journal reverses the next day so settlements still realise FX against the original rate."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Revaluation date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Rates">
          <Select value={rateType} onChange={(e) => setRateType(e.target.value)}>
            <option value="CLOSING">Closing (falls back to spot)</option>
            <option value="SPOT">Spot</option>
          </Select>
        </Field>
        {can('fx.revalue') && (
          <Button variant="primary" disabled={!p?.lines.length || already} loading={post.isPending} onClick={() => post.mutate()}>
            Post revaluation
          </Button>
        )}
        {already && <span className="text-sm text-muted">Already revalued at this date.</span>}
      </div>
      <ErrorBanner error={error ?? preview.error} className="mb-3" />
      {posted && (
        <div className="mb-3">
          <Notice tone="green">{posted}</Notice>
        </div>
      )}
      {p && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-line bg-white p-3 shadow-xs">
              <p className="text-xs text-muted">Unrealised gain</p>
              <p className="text-lg font-semibold tabular-nums text-emerald-700">{formatAmount(p.totalGain, fp)}</p>
            </div>
            <div className="rounded-lg border border-line bg-white p-3 shadow-xs">
              <p className="text-xs text-muted">Unrealised loss</p>
              <p className="text-lg font-semibold tabular-nums text-red-700">{formatAmount(p.totalLoss, fp)}</p>
            </div>
            <div className="rounded-lg border border-line bg-white p-3 shadow-xs sm:col-span-2">
              <p className="text-xs text-muted">Rates used</p>
              <p className="mt-1 text-sm">
                {p.rates.length
                  ? p.rates.map((r) => (
                      <span key={r.currency} className="mr-3 inline-block">
                        {r.currency} {r.rate} <Badge tone={r.rateType === 'CLOSING' ? 'blue' : 'amber'}>{r.rateType.toLowerCase()}</Badge>
                      </span>
                    ))
                  : 'No foreign-currency balances'}
              </p>
            </div>
          </div>
          <TableWrap>
            {!p.lines.length ? (
              <Empty title="Nothing to revalue">{p.unchanged ? `${p.unchanged} balance(s) already reflect the rate.` : 'There are no foreign-currency balances at this date.'}</Empty>
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Balance</th>
                    <th>Account</th>
                    <th>Branch</th>
                    <th className="num">Foreign amount</th>
                    <th className="num">Carrying ({p.currency})</th>
                    <th className="num">At rate</th>
                    <th className="num">Gain / (loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {l.kind === 'OPEN_ITEM' ? (
                          <>
                            <span className="font-mono text-xs">{l.documentNumber}</span> <span className="text-muted">{l.partyName}</span>
                          </>
                        ) : (
                          l.partyName
                        )}
                      </td>
                      <td className="font-mono text-xs">{l.accountCode}</td>
                      <td>{branch(l.branchId)}</td>
                      <td className="num">
                        {formatAmount(l.balanceTx, precision(l.currency), { parens: true })} <span className="text-xs text-muted">{l.currency}</span>
                      </td>
                      <td className="num">{formatAmount(l.carrying, fp, { parens: true })}</td>
                      <td className="num">{formatAmount(l.revalued, fp, { parens: true })}</td>
                      <td className={cx('num font-medium', l.difference.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(l.difference, fp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
        </div>
      )}
      {!!runs.data?.length && (
        <Card title="Revaluation history" padded={false} className="mt-5">
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Reverses</th>
                <th>Rates</th>
                <th className="num">Gain</th>
                <th className="num">Loss</th>
                <th>Journal</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap font-mono text-xs">{r.number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{formatDate(r.reverseOn)}</td>
                  <td className="text-xs">{r.rateType.toLowerCase()}</td>
                  <td className="num">{formatAmount(r.totalGain, fp)}</td>
                  <td className="num">{formatAmount(r.totalLoss, fp)}</td>
                  <td>
                    <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/journals/${r.journalId}`}>{r.journalNumber}</Link>
                  </td>
                  <td className="text-xs text-muted">{r.createdByName} · {formatDateTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// FX exposure & gains, inter-branch
// ---------------------------------------------------------------------------------------------

interface Exposure {
  currency: string;
  rows: { currency: string; rate: string | null; rateDate: string | null; cash: string; receivables: string; payables: string; other: string; net: string; carrying: string; atRate: string; unrealised: string; sensitivity1: string; sensitivity10: string }[];
  totals: { carrying: string; atRate: string; unrealised: string };
}

export function FxExposureReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [asOf, setAsOf] = useState(today());
  const { data, isLoading, error } = useQuery({ queryKey: ['fx-exposure', entity?.id, asOf], queryFn: () => api.get<Exposure>('/reports/fx-exposure', { entityId: entity!.id, asOf }) });
  const fp = precision(data?.currency);
  return (
    <>
      <div className="no-print mb-4 flex items-end gap-2">
        <Field label="As at">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <ReportTitle title="Foreign currency exposure" subtitle={`As at ${formatDate(asOf)} · net monetary position per currency, valued at the latest spot rate in ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty title="No foreign-currency exposure" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Cash & bank</th>
                <th className="num">Receivables</th>
                <th className="num">Payables</th>
                <th className="num">Other</th>
                <th className="num">Net exposure</th>
                <th className="num">Rate</th>
                <th className="num">Carrying</th>
                <th className="num">At rate</th>
                <th className="num">Unrealised</th>
                <th className="num">±1% move</th>
                <th className="num">±10% move</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const dp = precision(r.currency);
                return (
                  <tr key={r.currency}>
                    <td className="font-medium">{r.currency}</td>
                    <td className="num">{formatAmount(r.cash, dp, { parens: true, blankZero: true })}</td>
                    <td className="num">{formatAmount(r.receivables, dp, { parens: true, blankZero: true })}</td>
                    <td className="num">{formatAmount(r.payables, dp, { parens: true, blankZero: true })}</td>
                    <td className="num">{formatAmount(r.other, dp, { parens: true, blankZero: true })}</td>
                    <td className="num font-medium">{formatAmount(r.net, dp, { parens: true })}</td>
                    <td className="num text-xs text-muted">{r.rate}</td>
                    <td className="num">{formatAmount(r.carrying, fp, { parens: true })}</td>
                    <td className="num">{formatAmount(r.atRate, fp, { parens: true })}</td>
                    <td className={cx('num', r.unrealised.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(r.unrealised, fp, { parens: true })}</td>
                    <td className="num text-muted">{formatAmount(r.sensitivity1, fp, { parens: true })}</td>
                    <td className="num text-muted">{formatAmount(r.sensitivity10, fp, { parens: true })}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>Total {data.currency}</td>
                <td className="num">{formatAmount(data.totals.carrying, fp, { parens: true })}</td>
                <td className="num">{formatAmount(data.totals.atRate, fp, { parens: true })}</td>
                <td className="num">{formatAmount(data.totals.unrealised, fp, { parens: true })}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
      <p className="mt-2 text-xs text-muted">Positive amounts are assets (money owed to you or held); negative amounts are liabilities. Sensitivity shows the change in value for a 1% and 10% rate move.</p>
    </>
  );
}

interface Gains {
  currency: string;
  rows: { type: string; source: string; currency: string; branch: string; amount: string; count: number }[];
  totals: { realised: string; unrealised: string; total: string };
  ledger: { accountId: string; code: string; name: string; net: string }[];
}

export function FxGainsReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [range, setRange] = useState({ from: startOfYear(), to: today() });
  const { data, isLoading, error } = useQuery({ queryKey: ['fx-gains', entity?.id, range], queryFn: () => api.get<Gains>('/reports/fx-gains', { entityId: entity!.id, ...range }) });
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
          <Button onClick={() => downloadCsv(`fx-gains-${range.from}-${range.to}.csv`, ['Type', 'Source', 'Currency', 'Branch', 'Items', 'Gain/(loss)'], data.rows.map((r) => [r.type, r.source, r.currency, r.branch, r.count, r.amount]))}>
            Export CSV
          </Button>
        )}
      </div>
      <ReportTitle title="FX gains and losses" subtitle={`${formatDate(range.from)} – ${formatDate(range.to)} · realised on settlement and conversion, unrealised on revaluation · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['Realised', data.totals.realised],
                ['Unrealised', data.totals.unrealised],
                ['Total', data.totals.total],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="rounded-lg border border-line bg-white p-3 shadow-xs">
                <p className="text-xs text-muted">{label}</p>
                <p className={cx('text-lg font-semibold tabular-nums', v.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(v, fp, { parens: true })}</p>
              </div>
            ))}
          </div>
          <TableWrap>
            {!data.rows.length ? (
              <Empty title="No FX gains or losses in this period" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Currency</th>
                    <th>Branch</th>
                    <th className="num">Items</th>
                    <th className="num">Gain / (loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <Badge tone={r.type === 'REALISED' ? 'green' : 'blue'}>{r.type.toLowerCase()}</Badge>
                      </td>
                      <td>{r.source}</td>
                      <td>{r.currency}</td>
                      <td>{r.branch}</td>
                      <td className="num">{r.count}</td>
                      <td className={cx('num', r.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(r.amount, fp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
          {!!data.ledger.length && (
            <Card title="Ledger FX accounts for the period">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {data.ledger.map((l) => (
                  <div key={l.accountId} className="flex justify-between gap-4">
                    <dt>
                      <Link className="text-brand-700 hover:underline" href={`/finance/reports/account-activity?accountId=${l.accountId}&from=${range.from}&to=${range.to}`}>
                        {l.code} · {l.name}
                      </Link>
                    </dt>
                    <dd className="tabular-nums">{formatAmount(l.net, fp, { parens: true })}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted">Unrealised postings reverse the day after each revaluation, so the ledger shows them net.</p>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

interface InterBranch {
  currency: string;
  account: { id: string; code: string; name: string } | null;
  rows: { branchId: string; code: string; name: string; position: string; entries: number; balanced: boolean }[];
  net: string;
  recent: { _id?: string; id: string; journalId: string; journalNumber: string; date: string; branchCode: string; description: string; amount: string }[];
}

export function InterBranchReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [asOf, setAsOf] = useState(today());
  const { data, isLoading, error } = useQuery({ queryKey: ['inter-branch', entity?.id, asOf], queryFn: () => api.get<InterBranch>('/reports/inter-branch', { entityId: entity!.id, asOf }) });
  const fp = precision(data?.currency);
  return (
    <>
      <div className="no-print mb-4 flex items-end gap-2">
        <Field label="As at">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>
      <ReportTitle title="Inter-branch position" subtitle={`As at ${formatDate(asOf)} · ${data?.account ? `${data.account.code} ${data.account.name}` : 'no clearing account configured'} · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {!data.account && <Notice tone="amber">Set the inter-branch clearing account in organisation settings so journals across branches balance per branch.</Notice>}
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th className="num">Due from other branches</th>
                  <th className="num">Due to other branches</th>
                  <th className="num">Entries</th>
                  <th>Branch ledger</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.branchId}>
                    <td>
                      <span className="font-mono text-xs">{r.code}</span> {r.name}
                    </td>
                    <td className="num">{compare(r.position, '0') > 0 ? formatAmount(r.position, fp) : ''}</td>
                    <td className="num">{compare(r.position, '0') < 0 ? formatAmount(r.position.replace('-', ''), fp) : ''}</td>
                    <td className="num text-muted">{r.entries}</td>
                    <td>{r.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="red">Out of balance</Badge>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Net across branches (must be zero)</td>
                  <td colSpan={2} className={cx('num', !isZero(data.net) && 'text-red-700')}>
                    {formatAmount(data.net, fp, { parens: true })}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
          {!!data.recent.length && (
            <Card title="Recent inter-branch entries" padded={false}>
              <table className="table-base">
                <tbody>
                  {data.recent.map((e, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap text-xs">{formatDate(e.date)}</td>
                      <td>
                        <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/journals/${e.journalId}`}>{e.journalNumber}</Link>
                      </td>
                      <td>{e.branchCode}</td>
                      <td className="text-xs text-muted">{e.description}</td>
                      <td className="num">{formatAmount(e.amount, fp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------------------------

interface Consolidation {
  reportingCurrency: string;
  from: string;
  asOf: string;
  entities: { id: string; code: string; name: string; functionalCurrency: string; closingRate: string; netProfit: string; translationReserve: string; ownershipPercent: string; nonControllingProfit: string; nonControllingNetAssets: string }[];
  rows: { accountId: string | null; code: string; name: string; accountClass: AccountClass; entities: string[]; eliminations: string; acquisitions: string; adjustments: string; consolidated: string }[];
  acquisitions: { parentCode: string; subsidiaryCode: string; acquisitionDate: string; ownershipPercent: string; cost: string; netAssets: string; goodwill: string; nonControllingInterest: string }[];
  totals: Record<'revenue' | 'costOfSales' | 'grossProfit' | 'expenses' | 'netProfit' | 'assets' | 'liabilities' | 'equityAccounts' | 'translationReserve' | 'intercompanyDifference' | 'intercompanyTranslation' | 'equity' | 'profitToOwners' | 'profitToNonControlling' | 'equityToOwners' | 'nonControllingInterest', string> & { balanced: boolean };
  intercompany: { entityCode: string; partyName: string; accountCode: string; accountName: string; amount: string }[];
  adjustmentsCount: number;
  rates: { from: string; to: string; requested: string; date: string; rate: string; rateType: string }[];
  missingRates: string[];
}

const SECTIONS: { title: string; classes: AccountClass[] }[] = [
  { title: 'Revenue', classes: ['REVENUE'] },
  { title: 'Cost of sales', classes: ['COST_OF_SALES'] },
  { title: 'Operating expenses', classes: ['EXPENSE'] },
  { title: 'Assets', classes: ['ASSET'] },
  { title: 'Liabilities', classes: ['LIABILITY'] },
  { title: 'Equity', classes: ['EQUITY'] },
];

export function ConsolidationReport() {
  const { me } = useSession();
  const { data: allEntities = [] } = useEntities();
  const precision = usePrecision();
  const [q, setQ] = useState({ from: startOfYear(), asOf: today() });
  const [excluded, setExcluded] = useState<string[]>([]);
  const [showIc, setShowIc] = useState(false);
  const entityIds = allEntities.filter((e) => e.isActive && !excluded.includes(e.id)).map((e) => e.id);
  const { data, isLoading, error } = useQuery({
    queryKey: ['consolidation', q, entityIds.join(',')],
    queryFn: () => api.get<Consolidation>('/consolidation', { ...q, entityIds }),
    enabled: entityIds.length > 0,
  });
  const rp = precision(data?.reportingCurrency);
  const acq = !!data?.acquisitions.length;
  const fmt = (v: string) => formatAmount(v, rp, { parens: true, blankZero: true });
  const sumOf = (rows: Consolidation['rows'], pick: (r: Consolidation['rows'][number]) => string) => addAll(rows.map(pick));

  return (
    <>
      <PageHeader
        title="Group consolidation"
        description={`All entities translated into the group reporting currency (${me.organisation.reportingCurrency}), with intercompany balances eliminated and approved group adjustments applied.`}
        actions={<Link href="/finance/consolidation/adjustments" className="text-sm text-brand-700 hover:underline">Group adjustments</Link>}
      />
      <div className="no-print mb-4 flex flex-wrap items-end gap-3">
        <Field label="Results from">
          <Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        </Field>
        <Field label="Reporting date">
          <Input type="date" value={q.asOf} onChange={(e) => setQ({ ...q, asOf: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-3 pb-2">
          {allEntities.filter((e) => e.isActive).map((e) => (
            <Checkbox key={e.id} label={`${e.code} (${e.functionalCurrency})`} checked={!excluded.includes(e.id)} onChange={(v) => setExcluded((x) => (v ? x.filter((id) => id !== e.id) : [...x, e.id]))} />
          ))}
        </div>
        {data && (
          <Button
            onClick={() =>
              downloadCsv(
                `consolidation-${q.asOf}.csv`,
                ['Code', 'Account', ...data.entities.map((e) => e.code), 'Eliminations', 'Acquisitions', 'Adjustments', `Consolidated (${data.reportingCurrency})`],
                data.rows.map((r) => [r.code, r.name, ...r.entities, r.eliminations, r.acquisitions, r.adjustments, r.consolidated]),
              )
            }
          >
            Export CSV
          </Button>
        )}
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {data.missingRates.length > 0 && <Notice tone="amber">Missing translation rates (treated as zero): {data.missingRates.join('; ')}. Capture or import them on the currencies page.</Notice>}
          {!isZero(data.totals.intercompanyDifference) && (
            <Notice tone="amber">
              Intercompany balances do not fully eliminate (difference {formatAmount(data.totals.intercompanyDifference, rp, { parens: true })}). Check that both sides of each intercompany transaction are recorded, and that foreign-currency intercompany balances are revalued at the reporting date (FX revaluation).
            </Notice>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            {(
              [
                ['Revenue', data.totals.revenue],
                ['Net profit', data.totals.netProfit],
                ['Total assets', data.totals.assets],
                ['Translation reserve', data.totals.translationReserve],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="rounded-lg border border-line bg-white p-3 shadow-xs">
                <p className="text-xs text-muted">{label}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {formatAmount(v, rp, { parens: true })} <span className="text-xs font-normal text-muted">{data.reportingCurrency}</span>
                </p>
              </div>
            ))}
          </div>
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Account</th>
                  {data.entities.map((e) => (
                    <th key={e.id} className="num">
                      {e.code}
                      <span className="block font-normal normal-case text-muted">{e.functionalCurrency === data.reportingCurrency ? 'no translation' : `${e.functionalCurrency} @ ${Number(e.closingRate).toPrecision(5)}`}</span>
                    </th>
                  ))}
                  <th className="num">Eliminations</th>
                  {acq && <th className="num">Acquisitions</th>}
                  <th className="num">Adjustments</th>
                  <th className="num">Group</th>
                </tr>
              </thead>
              <tbody>
                {SECTIONS.map((section) => {
                  const rows = data.rows.filter((r) => section.classes.includes(r.accountClass));
                  if (!rows.length && section.title !== 'Equity') return null;
                  return (
                    <Fragment key={section.title}>
                      <tr className="bg-gray-50">
                        <td colSpan={data.entities.length + (acq ? 5 : 4)} className="text-xs font-semibold uppercase tracking-wider text-muted">
                          {section.title}
                        </td>
                      </tr>
                      {rows.map((r) => (
                        <tr key={`${r.accountId}${r.code}`}>
                          <td>
                            <span className="font-mono text-xs">{r.code}</span> {r.name}
                          </td>
                          {r.entities.map((v, i) => (
                            <td key={i} className="num">{fmt(v)}</td>
                          ))}
                          <td className="num text-violet-700">{fmt(r.eliminations)}</td>
                          {acq && <td className="num text-amber-700">{fmt(r.acquisitions)}</td>}
                          <td className="num text-sky-700">{fmt(r.adjustments)}</td>
                          <td className="num font-medium">{fmt(r.consolidated)}</td>
                        </tr>
                      ))}
                      {section.title === 'Equity' && (
                        <>
                          <tr>
                            <td>Current period result</td>
                            {data.entities.map((e) => (
                              <td key={e.id} className="num">{fmt(e.netProfit)}</td>
                            ))}
                            <td colSpan={acq ? 3 : 2} />
                            <td className="num font-medium">{fmt(data.totals.netProfit)}</td>
                          </tr>
                          <tr>
                            <td>
                              Foreign currency translation reserve
                              {!isZero(data.totals.intercompanyTranslation) && (
                                <span className="block text-xs text-muted">incl. {formatAmount(data.totals.intercompanyTranslation, rp, { parens: true })} FX on intercompany eliminations</span>
                              )}
                            </td>
                            {data.entities.map((e) => (
                              <td key={e.id} className="num">{fmt(e.translationReserve)}</td>
                            ))}
                            <td colSpan={acq ? 3 : 2} />
                            <td className="num font-medium">{fmt(data.totals.translationReserve)}</td>
                          </tr>
                          {!isZero(data.totals.intercompanyDifference) && (
                            <tr>
                              <td>Unmatched intercompany balances</td>
                              {data.entities.map((e) => (
                                <td key={e.id} />
                              ))}
                              <td className="num text-violet-700">{fmt(data.totals.intercompanyDifference)}</td>
                              {acq && <td />}
                              <td />
                              <td className="num font-medium">{fmt(data.totals.intercompanyDifference)}</td>
                            </tr>
                          )}
                        </>
                      )}
                      <tr>
                        <td className="text-right text-xs font-semibold text-muted">Total {section.title.toLowerCase()}</td>
                        {data.entities.map((e, i) => (
                          <td key={i} className="num text-xs font-semibold">
                            {fmt(section.title === 'Equity' ? addAll([sumOf(rows, (r) => r.entities[i]), e.netProfit, e.translationReserve]) : sumOf(rows, (r) => r.entities[i]))}
                          </td>
                        ))}
                        <td className="num text-xs font-semibold">{fmt(sumOf(rows, (r) => r.eliminations))}</td>
                        {acq && <td className="num text-xs font-semibold">{fmt(sumOf(rows, (r) => r.acquisitions))}</td>}
                        <td className="num text-xs font-semibold">{fmt(sumOf(rows, (r) => r.adjustments))}</td>
                        <td className="num text-xs font-semibold">{fmt(section.title === 'Equity' ? data.totals.equity : sumOf(rows, (r) => r.consolidated))}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Assets − liabilities − equity</td>
                  <td colSpan={data.entities.length + (acq ? 3 : 2)} />
                  <td className={cx('num', data.totals.balanced ? 'text-emerald-700' : 'text-red-700')}>{data.totals.balanced ? 'Balanced' : 'Out of balance'}</td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>
          <InvestmentsCard detail={data.acquisitions} rp={rp} />
          {!isZero(data.totals.nonControllingInterest) && (
            <Card title="Non-controlling interests" padded={false}>
              <table className="table-base">
                <thead>
                  <tr><th>Entity</th><th className="num">Group share</th><th className="num">Share of profit</th><th className="num">Share of net assets</th></tr>
                </thead>
                <tbody>
                  {data.entities.filter((e) => !isZero(e.nonControllingNetAssets) || !isZero(e.nonControllingProfit)).map((e) => (
                    <tr key={e.id}>
                      <td><span className="font-mono text-xs">{e.code}</span> {e.name}</td>
                      <td className="num">{e.ownershipPercent}%</td>
                      <td className="num">{formatAmount(e.nonControllingProfit, rp, { parens: true })}</td>
                      <td className="num">{formatAmount(e.nonControllingNetAssets, rp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td>Profit attributable to owners of the group</td><td /><td className="num">{formatAmount(data.totals.profitToOwners, rp, { parens: true })}</td><td /></tr>
                  <tr><td>Profit attributable to non-controlling interests</td><td /><td className="num">{formatAmount(data.totals.profitToNonControlling, rp, { parens: true })}</td><td /></tr>
                  <tr><td>Equity attributable to owners / non-controlling interests</td><td /><td className="num">{formatAmount(data.totals.equityToOwners, rp, { parens: true })}</td><td className="num">{formatAmount(data.totals.nonControllingInterest, rp, { parens: true })}</td></tr>
                </tfoot>
              </table>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Translation rates used">
              <ul className="space-y-1 text-xs">
                {data.rates.map((r, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span>
                      {r.from}/{r.to} · {r.requested.toLowerCase()} at {formatDate(r.date)}
                    </span>
                    <span className="tabular-nums">
                      {r.rate} {r.rateType !== r.requested && <Badge tone="amber">{r.rateType.toLowerCase()} fallback</Badge>}
                    </span>
                  </li>
                ))}
                {!data.rates.length && <li className="text-muted">All entities report in {data.reportingCurrency}.</li>}
              </ul>
            </Card>
            <Card
              title={`Intercompany eliminations (${data.intercompany.length})`}
              actions={
                data.intercompany.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setShowIc((v) => !v)}>
                    {showIc ? 'Hide' : 'Show'}
                  </Button>
                )
              }
            >
              {!data.intercompany.length ? (
                <p className="text-sm text-muted">No intercompany activity. Link a customer or supplier to a group entity, or tag journal lines (loans, interest, recharges) with the other entity, to eliminate them.</p>
              ) : showIc ? (
                <ul className="space-y-1 text-xs">
                  {data.intercompany.map((d, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span>
                        {d.entityCode} · {d.partyName} · {d.accountCode} {d.accountName}
                      </span>
                      <span className="tabular-nums">{formatAmount(d.amount, rp, { parens: true })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{data.adjustmentsCount} approved group adjustment(s) applied.</p>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

interface Investment {
  id: string;
  parentEntityId: string;
  subsidiaryEntityId: string;
  acquisitionDate: string;
  investmentAccountId: string;
  cost: string;
  ownershipPercent: string;
  goodwillAccountId: string;
  notes: string;
  isActive: boolean;
}

/** Investments in subsidiaries: eliminated against equity at acquisition, giving goodwill and NCI. */
function InvestmentsCard({ detail, rp }: { detail: Consolidation['acquisitions']; rp: number }) {
  const { can } = useSession();
  const { data: entities = [] } = useEntities();
  const { data: accounts = [] } = useAccounts();
  const queryClient = useQueryClient();
  const { data: investments = [] } = useQuery({ queryKey: ['group-investments'], queryFn: () => api.get<Investment[]>('/consolidation/investments') });
  const [editing, setEditing] = useState<Investment | 'new' | null>(null);
  const code = (id: string) => entities.find((e) => e.id === id)?.code ?? '';
  const manage = can('consolidation.approve');
  if (!investments.length && !manage) return null;
  return (
    <Card title="Acquisitions" actions={manage && <Button size="sm" onClick={() => setEditing('new')}>Record acquisition</Button>}>
      {!investments.length ? (
        <p className="text-sm text-muted">Record each parent&apos;s investment in a subsidiary to eliminate it against the subsidiary&apos;s equity at acquisition: the difference is goodwill, and outside shareholders&apos; share is non-controlling interest. Results before the acquisition date are left out of the group.</p>
      ) : (
        <table className="table-base">
          <thead>
            <tr>
              <th>Parent → subsidiary</th>
              <th>Acquired</th>
              <th className="num">Owned</th>
              <th className="num">Cost</th>
              <th className="num">Net assets</th>
              <th className="num">Goodwill</th>
              <th className="num">NCI at acquisition</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {investments.map((inv) => {
              const d = detail.find((x) => x.subsidiaryCode === code(inv.subsidiaryEntityId));
              return (
                <tr key={inv.id} className={inv.isActive ? '' : 'opacity-50'}>
                  <td>{code(inv.parentEntityId)} → {code(inv.subsidiaryEntityId)}</td>
                  <td>{formatDate(inv.acquisitionDate)}</td>
                  <td className="num">{inv.ownershipPercent}%</td>
                  <td className="num">{d ? formatAmount(d.cost, rp) : formatAmount(inv.cost, 2)}</td>
                  <td className="num">{d ? formatAmount(d.netAssets, rp) : '—'}</td>
                  <td className="num">{d ? formatAmount(d.goodwill, rp, { parens: true }) : '—'}</td>
                  <td className="num">{d ? formatAmount(d.nonControllingInterest, rp) : '—'}</td>
                  <td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditing(inv)}>Edit</Button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && (
        <InvestmentForm
          existing={editing === 'new' ? undefined : editing}
          entities={entities.filter((e) => e.isActive)}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['group-investments'] });
            queryClient.invalidateQueries({ queryKey: ['consolidation'] });
          }}
        />
      )}
    </Card>
  );
}

function InvestmentForm({ existing, entities, accounts, onClose, onDone }: { existing?: Investment; entities: { id: string; code: string; name: string }[]; accounts: { id: string; code: string; name: string; accountClass: string }[]; onClose: () => void; onDone: () => void }) {
  const byCode = (c: string) => accounts.find((a) => a.code === c)?.id ?? '';
  const [f, setF] = useState({
    parentEntityId: existing?.parentEntityId ?? entities[0]?.id ?? '',
    subsidiaryEntityId: existing?.subsidiaryEntityId ?? entities[1]?.id ?? '',
    acquisitionDate: existing?.acquisitionDate.slice(0, 10) ?? today(),
    investmentAccountId: existing?.investmentAccountId ?? byCode('1640'),
    cost: existing?.cost ?? '',
    ownershipPercent: existing?.ownershipPercent ?? '100',
    goodwillAccountId: existing?.goodwillAccountId ?? byCode('1630'),
    notes: existing?.notes ?? '',
    isActive: existing?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (existing ? api.patch(`/consolidation/investments/${existing.id}`, f) : api.post('/consolidation/investments', (({ isActive: _a, ...rest }) => rest)(f))),
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  const assets = accounts.filter((a) => a.accountClass === 'ASSET');
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={existing ? 'Edit acquisition' : 'Record acquisition'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Parent">
            <Select value={f.parentEntityId} onChange={(e) => setF({ ...f, parentEntityId: e.target.value })}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.code} · {e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Subsidiary">
            <Select value={f.subsidiaryEntityId} onChange={(e) => setF({ ...f, subsidiaryEntityId: e.target.value })}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.code} · {e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Acquisition date" hint="Equity and results up to this date are pre-acquisition">
            <Input type="date" value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} />
          </Field>
          <Field label="Ownership (%)">
            <Input inputMode="decimal" value={f.ownershipPercent} onChange={(e) => setF({ ...f, ownershipPercent: e.target.value })} />
          </Field>
          <Field label="Investment account (parent's books)">
            <Select value={f.investmentAccountId} onChange={(e) => setF({ ...f, investmentAccountId: e.target.value })}>
              <option value="">Select…</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Cost (parent's currency)">
            <Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
          </Field>
          <Field label="Goodwill account">
            <Select value={f.goodwillAccountId} onChange={(e) => setF({ ...f, goodwillAccountId: e.target.value })}>
              <option value="">Select…</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Notes">
            <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
        {existing && <Checkbox label="Consolidate this investment" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
        <p className="text-xs text-muted">Goodwill is measured at the acquisition-date rate, with non-controlling interest at its share of net assets. Impairment is recorded as a group adjustment.</p>
      </div>
    </Modal>
  );
}

interface Adjustment {
  id: string;
  number: string;
  date: string;
  description: string;
  currency: string;
  entityId: string | null;
  lines: { accountId: string; description: string; debit: string; credit: string }[];
  total: string;
  status: string;
  createdBy: string;
  submittedBy: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string;
  createdByName?: string;
  submittedByName?: string;
  approvedByName?: string;
  rejectedByName?: string;
}

export function AdjustmentsPage() {
  const { me, can } = useSession();
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts();
  const { data: entities = [] } = useEntities();
  const { data = [], isLoading } = useQuery({ queryKey: ['consolidation-adjustments'], queryFn: () => api.get<Adjustment[]>('/consolidation/adjustments') });
  const [editing, setEditing] = useState<{ id?: string; date: string; description: string; entityId: string; lines: { accountId: string; description: string; debit: string; credit: string }[] } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rp = precision(me.organisation.reportingCurrency);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['consolidation-adjustments'] });

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const e = editing!;
      const body = {
        date: e.date,
        description: e.description,
        entityId: e.entityId || null,
        lines: e.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, description: l.description || undefined, debit: l.debit || null, credit: l.credit || null })),
      };
      const saved = e.id ? await api.patch<Adjustment>(`/consolidation/adjustments/${e.id}`, body) : await api.post<Adjustment>('/consolidation/adjustments', body);
      if (submit) await api.post(`/consolidation/adjustments/${saved.id}/submit`);
    },
    onSuccess: () => (setEditing(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post(`/consolidation/adjustments/${id}/${action}`, action === 'reject' ? { reason: 'Rejected by reviewer' } : {}),
    onSuccess: () => (setError(null), refresh(), queryClient.invalidateQueries({ queryKey: ['consolidation'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  const current = data.find((a) => a.id === viewing);
  const lines = editing?.lines ?? [];
  const debit = addAll(lines.map((l) => l.debit));
  const credit = addAll(lines.map((l) => l.credit));

  return (
    <>
      <PageHeader
        title="Group adjustments"
        description={`Consolidation-level entries in ${me.organisation.reportingCurrency} (for example group accruals or reclassifications). Entity books are not changed; each adjustment needs a second person's approval.`}
        actions={
          can('consolidation.manage') && (
            <Button
              variant="primary"
              onClick={() => (
                setError(null),
                setEditing({ date: today(), description: '', entityId: '', lines: [{ accountId: '', description: '', debit: '', credit: '' }, { accountId: '', description: '', debit: '', credit: '' }] })
              )}
            >
              New adjustment
            </Button>
          )
        }
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No group adjustments" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Description</th>
                <th>Entity</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => {
                const mine = a.createdBy === me.id || a.submittedBy === me.id;
                return (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      <button className="text-brand-700 hover:underline" onClick={() => setViewing(a.id)}>{a.number}</button>
                    </td>
                    <td>{formatDate(a.date)}</td>
                    <td>{a.description}</td>
                    <td className="text-muted">{entities.find((e) => e.id === a.entityId)?.code ?? 'Group'}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="num">{formatAmount(a.total, rp)}</td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      {['DRAFT', 'REJECTED'].includes(a.status) && can('consolidation.manage') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setEditing({ id: a.id, date: a.date.slice(0, 10), description: a.description, entityId: a.entityId ?? '', lines: a.lines.map((l) => ({ ...l, debit: isZero(l.debit) ? '' : l.debit, credit: isZero(l.credit) ? '' : l.credit })) })}>
                            Edit
                          </Button>
                          <Button size="sm" onClick={() => act.mutate({ id: a.id, action: 'submit' })}>Submit</Button>
                        </>
                      )}
                      {a.status === 'SUBMITTED' && can('consolidation.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: a.id, action: 'reject' })}>Reject</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'Someone else must approve your adjustment' : undefined} onClick={() => act.mutate({ id: a.id, action: 'approve' })}>
                            Approve
                          </Button>
                        </>
                      )}
                      {a.status === 'APPROVED' && can('consolidation.approve') && (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: a.id, action: 'void' })}>Void</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit adjustment' : 'New group adjustment'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button>
            <Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Date">
                <Input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
              </Field>
              <Field label="Relates to">
                <Select value={editing.entityId} onChange={(e) => setEditing({ ...editing, entityId: e.target.value })}>
                  <option value="">Whole group</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>{e.code} · {e.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>
            </div>
            <table className="table-base">
              <thead>
                <tr>
                  <th className="min-w-56">Account</th>
                  <th>Description</th>
                  <th className="num w-32">Debit</th>
                  <th className="num w-32">Credit</th>
                </tr>
              </thead>
              <tbody>
                {editing.lines.map((l, i) => {
                  const set = (patch: Partial<typeof l>) => setEditing({ ...editing, lines: editing.lines.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  return (
                    <tr key={i}>
                      <td>
                        <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
                          <AccountOptions accounts={accounts.map((a) => ({ ...a, allowManualPosting: true }))} />
                        </Select>
                      </td>
                      <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Line description" /></td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.debit} onChange={(e) => amountPattern.test(e.target.value) && set({ debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label="Debit" /></td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.credit} onChange={(e) => amountPattern.test(e.target.value) && set({ credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label="Credit" /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, lines: [...editing.lines, { accountId: '', description: '', debit: '', credit: '' }] })}>+ Add line</Button>
                  </td>
                  <td className="num">{formatAmount(debit, rp)}</td>
                  <td className={cx('num', compare(debit, credit) !== 0 && 'text-amber-700')}>{formatAmount(credit, rp)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Modal>

      <Modal wide open={!!current} onClose={() => setViewing(null)} title={current ? `${current.number} · ${current.description}` : ''}>
        {current && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {current.lines.map((l, i) => {
                  const a = accounts.find((x) => x.id === l.accountId);
                  return (
                    <tr key={i}>
                      <td>
                        <span className="font-mono text-xs">{a?.code}</span> {a?.name} {l.description && <span className="text-xs text-muted">— {l.description}</span>}
                      </td>
                      <td className="num">{formatAmount(l.debit, rp, { blankZero: true })}</td>
                      <td className="num">{formatAmount(l.credit, rp, { blankZero: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ApprovalTrail record={{ ...current, voidedAt: null }} approvedLabel="Approved" />
          </div>
        )}
      </Modal>
    </>
  );
}
