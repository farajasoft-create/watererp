'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useBankAccounts } from '@/modules/finance/ui/lib/commercial-hooks';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { AccountOptions } from './commercial/shared';
import { downloadCsv, ReportTitle } from './report-filters';
import { Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from './ui';

const TYPES = [
  ['FIXED_DEPOSIT', 'Fixed deposit'],
  ['CALL_DEPOSIT', 'Call deposit'],
  ['TREASURY_BILL', 'Treasury bill'],
  ['TREASURY_BOND', 'Treasury bond'],
  ['MONEY_MARKET', 'Money market fund'],
  ['OTHER', 'Other'],
] as const;
const typeLabel = (t: string) => TYPES.find(([k]) => k === t)?.[1] ?? t;
const decimal = /^\d*(\.\d*)?$/;

interface Investment {
  id: string;
  number: string;
  type: string;
  institution: string;
  reference: string;
  description: string;
  principal: string;
  ratePercent: string;
  dayCount: 'ACT_365' | 'ACT_360';
  startDate: string;
  maturityDate: string;
  withholdingPercent: string;
  bankAccountId: string;
  investmentAccountId: string;
  interestIncomeAccountId: string;
  interestReceivableAccountId: string;
  withholdingAccountId: string | null;
  status: string;
  accruedInterest: string;
  accruedTo: string | null;
  rejectionReason?: string;
  settlement?: { date: string; interest: string; withholding: string; net: string; rolledOverToId: string | null } | null;
  createdBy: string;
  submittedBy?: string | null;
  termInterest?: string;
  interestToDate?: string | null;
}
interface Report {
  currency: string;
  banks: { id: string; name: string; opening: string; receipts: string; payments: string; closing: string }[];
  totals: { opening: string; receipts: string; payments: string; cash: string; invested: string; liquidity: string };
  holdings: { id: string; number: string; type: string; institution: string; principal: string; ratePercent: string; maturityDate: string; daysToMaturity: number; interestToDate: string; termInterest: string }[];
  maturing: { id: string; number: string; institution: string; principal: string; maturityDate: string; daysToMaturity: number; termInterest: string }[];
  placed: { id: string; number: string; institution: string; principal: string; startDate: string }[];
  settled: { id: string; number: string; institution: string; date: string; interest: string; withholding: string; net: string }[];
  interestEarned: string;
}
type Form = Omit<Investment, 'id' | 'number' | 'status' | 'accruedInterest' | 'accruedTo' | 'createdBy' | 'settlement'> & { id?: string };

export function TreasuryPage({ openId }: { openId?: string }) {
  const [tab, setTab] = useState<'portfolio' | 'report'>('portfolio');
  return (
    <>
      <PageHeader title="Investments & treasury" description="Fixed and call deposits, treasury bills and bonds and money market funds: placed with approval, interest accrued monthly, settled net of withholding tax, and the daily, weekly or monthly treasury report." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'portfolio', label: 'Portfolio' }, { id: 'report', label: 'Treasury report' }]} />
      {tab === 'portfolio' ? <Portfolio openId={openId} /> : <TreasuryReport />}
    </>
  );
}

function Portfolio({ openId }: { openId?: string }) {
  const { entity, me, can } = useSession();
  const precision = usePrecision();
  const qc = useQueryClient();
  const fp = precision(entity?.functionalCurrency);
  const { data: accounts = [] } = useAccounts(entity?.id);
  const { data: banks = [] } = useBankAccounts(entity?.id);
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['investments', entity?.id, status], queryFn: () => api.get<Investment[]>('/investments', { entityId: entity!.id, status: status || undefined }), enabled: !!entity });
  const [form, setForm] = useState<Form | null>(null);
  const [settling, setSettling] = useState<Investment | null>(null);
  const [viewing, setViewing] = useState<Investment | null>(null);
  const [rejecting, setRejecting] = useState<Investment | null>(null);
  const [reason, setReason] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const refresh = () => ['investments', 'treasury-report'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const bankName = (id: string) => banks.find((b) => b.id === id)?.name ?? '';

  const view = async (id: string) => {
    setError(null);
    setViewing(await api.get<Investment>(`/investments/${id}`));
  };
  if (openId && !opened && list.data) {
    setOpened(true);
    void view(openId);
  }

  const blank = (): Form => {
    const prev = list.data?.[0];
    return {
      type: 'FIXED_DEPOSIT',
      institution: '',
      reference: '',
      description: '',
      principal: '',
      ratePercent: '',
      dayCount: 'ACT_365',
      startDate: today(),
      maturityDate: '',
      withholdingPercent: '15',
      bankAccountId: banks.find((b) => b.currency === entity?.functionalCurrency)?.id ?? '',
      investmentAccountId: prev?.investmentAccountId ?? '',
      interestIncomeAccountId: prev?.interestIncomeAccountId ?? '',
      interestReceivableAccountId: prev?.interestReceivableAccountId ?? '',
      withholdingAccountId: prev?.withholdingAccountId ?? null,
    };
  };
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const { id, ...rest } = form!;
      const body = { ...rest, entityId: entity!.id, withholdingAccountId: rest.withholdingAccountId || null };
      const saved = id ? await api.patch<Investment>(`/investments/${id}`, body) : await api.post<Investment>('/investments', body);
      setForm({ ...form!, id: saved.id });
      if (submit) await api.post(`/investments/${saved.id}/submit`);
    },
    onSuccess: () => (setForm(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action, reason: r }: { id: string; action: string; reason?: string }) => api.post(`/investments/${id}/${action}`, r ? { reason: r } : {}),
    onSuccess: () => (setError(null), setRejecting(null), setViewing(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const accrue = useMutation({
    mutationFn: () => api.post<{ accrued: number; total: string }>('/investments/accrue', { entityId: entity!.id, asOf }),
    onSuccess: (r) => (setError(null), setNote(r.accrued ? `Accrued ${formatAmount(r.total, fp)} of interest on ${r.accrued} investment${r.accrued === 1 ? '' : 's'}.` : 'Interest is already accrued to that date.'), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const set = (p: Partial<Form>) => setForm({ ...form!, ...p });

  return (
    <>
      <div className="no-print mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {['ACTIVE', 'SUBMITTED', 'DRAFT', 'MATURED', 'REJECTED', 'CANCELLED'].map((s) => (<option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>))}
            </Select>
          </Field>
          {can('banking.manage') && (
            <>
              <Field label="Accrue interest to"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
              <Button loading={accrue.isPending} onClick={() => accrue.mutate()}>Accrue interest</Button>
            </>
          )}
        </div>
        {can('banking.manage') && <Button variant="primary" onClick={() => (setError(null), setForm(blank()))}>New investment</Button>}
      </div>
      {note && <div className="mb-3"><Notice tone="green">{note}</Notice></div>}
      <ErrorBanner error={!form && !settling && !rejecting ? error : null} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No investments yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Number</th><th>Type</th><th>Institution</th><th className="num">Principal</th><th className="num">Rate</th><th>Start</th><th>Maturity</th><th className="num">Accrued</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((i) => {
                const mine = i.createdBy === me.id || i.submittedBy === me.id;
                return (
                  <tr key={i.id}>
                    <td><button className="font-mono text-xs text-accent hover:underline" onClick={() => view(i.id)}>{i.number}</button></td>
                    <td>{typeLabel(i.type)}</td>
                    <td>{i.institution}{i.reference && <span className="ml-1 text-xs text-muted">{i.reference}</span>}</td>
                    <td className="num">{formatAmount(i.principal, fp)}</td>
                    <td className="num">{i.ratePercent}%</td>
                    <td>{formatDate(i.startDate)}</td>
                    <td>{formatDate(i.maturityDate)}</td>
                    <td className="num">{i.status === 'ACTIVE' ? formatAmount(i.accruedInterest, fp) : ''}</td>
                    <td><StatusBadge status={i.status} /></td>
                    <td className="whitespace-nowrap text-right">
                      {['DRAFT', 'REJECTED'].includes(i.status) && can('banking.manage') && <Button size="sm" variant="ghost" onClick={() => (setError(null), setForm({ ...i, withholdingAccountId: i.withholdingAccountId ?? null, startDate: i.startDate.slice(0, 10), maturityDate: i.maturityDate.slice(0, 10) }))}>Edit</Button>}
                      {i.status === 'SUBMITTED' && can('payments.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => (setReason(''), setRejecting(i))}>Return</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'You prepared or submitted this' : undefined} loading={act.isPending && act.variables?.id === i.id} onClick={() => act.mutate({ id: i.id, action: 'approve' })}>Approve</Button>
                        </>
                      )}
                      {i.status === 'ACTIVE' && can('banking.manage') && <Button size="sm" onClick={() => (setError(null), setSettling(i))}>Settle</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Return the investment" footer={<><Button onClick={() => setRejecting(null)}>Back</Button><Button variant="primary" disabled={!reason.trim()} loading={act.isPending} onClick={() => act.mutate({ id: rejecting!.id, action: 'reject', reason: reason.trim() })}>Return</Button></>}>
        <ErrorBanner error={rejecting ? error : null} />
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `${viewing.number} · ${viewing.institution}` : ''} footer={viewing && ['DRAFT', 'REJECTED', 'SUBMITTED'].includes(viewing.status) && can('banking.manage') ? <Button onClick={() => act.mutate({ id: viewing.id, action: 'cancel' })}>Cancel investment</Button> : undefined}>
        {viewing && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {[
              ['Type', typeLabel(viewing.type)],
              ['Status', <StatusBadge key="s" status={viewing.status} />],
              ['Principal', formatAmount(viewing.principal, fp)],
              ['Rate', `${viewing.ratePercent}% a year (${viewing.dayCount === 'ACT_360' ? 'actual/360' : 'actual/365'})`],
              ['Term', `${formatDate(viewing.startDate)} – ${formatDate(viewing.maturityDate)}`],
              ['Interest for the term', formatAmount(viewing.termInterest ?? '0', fp)],
              ['Interest to date', viewing.interestToDate ? formatAmount(viewing.interestToDate, fp) : '—'],
              ['Accrued in the ledger', `${formatAmount(viewing.accruedInterest, fp)}${viewing.accruedTo ? ` to ${formatDate(viewing.accruedTo)}` : ''}`],
              ['Withholding tax', `${viewing.withholdingPercent}%`],
              ['Bank account', bankName(viewing.bankAccountId)],
              ...(viewing.settlement
                ? [
                    ['Settled', formatDate(viewing.settlement.date)],
                    ['Interest received', formatAmount(viewing.settlement.interest, fp)],
                    ['Withholding deducted', formatAmount(viewing.settlement.withholding, fp)],
                    ['Net proceeds', formatAmount(viewing.settlement.net, fp)],
                  ]
                : []),
              ...(viewing.rejectionReason && viewing.status === 'REJECTED' ? [['Returned because', viewing.rejectionReason]] : []),
            ].map(([k, v], n) => (
              <div key={n}><dt className="text-xs text-muted">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}
      </Modal>

      {settling && <SettleModal investment={settling} fp={fp} banks={banks.filter((b) => b.currency === entity?.functionalCurrency)} onClose={() => setSettling(null)} onDone={() => (setSettling(null), refresh())} />}

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit investment' : 'New investment'}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>}
      >
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Type">
                <Select value={form.type} onChange={(e) => set({ type: e.target.value })}>
                  {TYPES.map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
                </Select>
              </Field>
              <Field label="Institution"><Input value={form.institution} onChange={(e) => set({ institution: e.target.value })} /></Field>
              <Field label="Certificate / reference"><Input value={form.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
              <Field label="Amount invested"><Input inputMode="decimal" value={form.principal} onChange={(e) => decimal.test(e.target.value) && set({ principal: e.target.value })} /></Field>
              <Field label="Annual rate %"><Input inputMode="decimal" value={form.ratePercent} onChange={(e) => decimal.test(e.target.value) && set({ ratePercent: e.target.value })} /></Field>
              <Field label="Day count">
                <Select value={form.dayCount} onChange={(e) => set({ dayCount: e.target.value as Form['dayCount'] })}>
                  <option value="ACT_365">Actual / 365</option>
                  <option value="ACT_360">Actual / 360</option>
                </Select>
              </Field>
              <Field label="Start date"><Input type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
              <Field label="Maturity date"><Input type="date" value={form.maturityDate} onChange={(e) => set({ maturityDate: e.target.value })} /></Field>
              <Field label="Withholding tax on interest %"><Input inputMode="decimal" value={form.withholdingPercent} onChange={(e) => decimal.test(e.target.value) && set({ withholdingPercent: e.target.value })} /></Field>
              <Field label="Paid from" className="sm:col-span-3">
                <Select value={form.bankAccountId} onChange={(e) => set({ bankAccountId: e.target.value })}>
                  <option value="">Select bank account…</option>
                  {banks.filter((b) => b.currency === entity?.functionalCurrency).map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
                </Select>
              </Field>
            </div>
            <Card title="Ledger accounts">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Investment (asset)"><Select value={form.investmentAccountId} onChange={(e) => set({ investmentAccountId: e.target.value })}><AccountOptions accounts={accounts} classes={['ASSET']} /></Select></Field>
                <Field label="Interest receivable (asset)"><Select value={form.interestReceivableAccountId} onChange={(e) => set({ interestReceivableAccountId: e.target.value })}><AccountOptions accounts={accounts} classes={['ASSET']} /></Select></Field>
                <Field label="Interest income"><Select value={form.interestIncomeAccountId} onChange={(e) => set({ interestIncomeAccountId: e.target.value })}><AccountOptions accounts={accounts} classes={['REVENUE']} /></Select></Field>
                <Field label="Withholding tax recoverable"><Select value={form.withholdingAccountId ?? ''} onChange={(e) => set({ withholdingAccountId: e.target.value || null })}><AccountOptions accounts={accounts} classes={['ASSET', 'EXPENSE']} placeholder="None" /></Select></Field>
              </div>
            </Card>
            <Field label="Notes"><Textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

function SettleModal({ investment, fp, banks, onClose, onDone }: { investment: Investment; fp: number; banks: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ date: investment.maturityDate.slice(0, 10), bankAccountId: investment.bankAccountId, interest: '', rollover: false, maturityDate: '', ratePercent: '', reinvestInterest: false });
  const [error, setError] = useState<string | null>(null);
  const early = form.date < investment.maturityDate.slice(0, 10);
  const settle = useMutation({
    mutationFn: () =>
      api.post(`/investments/${investment.id}/settle`, {
        date: form.date,
        bankAccountId: form.bankAccountId,
        ...(form.interest && { interest: form.interest }),
        rollover: form.rollover ? { maturityDate: form.maturityDate, reinvestInterest: form.reinvestInterest, ...(form.ratePercent && { ratePercent: form.ratePercent }) } : null,
      }),
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal open onClose={onClose} title={`Settle ${investment.number}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={settle.isPending} onClick={() => settle.mutate()}>{form.rollover ? 'Settle & roll over' : 'Settle'}</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <p className="text-sm text-muted">{formatAmount(investment.principal, fp)} with {investment.institution} at {investment.ratePercent}%, maturing {formatDate(investment.maturityDate)}. Withholding tax of {investment.withholdingPercent}% is deducted from the interest.</p>
        {early && <Notice tone="amber">This is before maturity: an early withdrawal. Enter the interest the institution actually paid if it differs.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date received"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Into">
            <Select value={form.bankAccountId} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}>
              {banks.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </Select>
          </Field>
          <Field label="Interest paid (gross)" hint="Leave blank to use the interest calculated to the date"><Input inputMode="decimal" value={form.interest} onChange={(e) => decimal.test(e.target.value) && setForm({ ...form, interest: e.target.value })} /></Field>
        </div>
        <Checkbox label="Roll over into a new placement with the same institution" checked={form.rollover} onChange={(v) => setForm({ ...form, rollover: v })} />
        {form.rollover && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New maturity date"><Input type="date" value={form.maturityDate} onChange={(e) => setForm({ ...form, maturityDate: e.target.value })} /></Field>
            <Field label="New rate %" hint={`Leave blank to keep ${investment.ratePercent}%`}><Input inputMode="decimal" value={form.ratePercent} onChange={(e) => decimal.test(e.target.value) && setForm({ ...form, ratePercent: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Checkbox label="Reinvest the net interest too" checked={form.reinvestInterest} onChange={(v) => setForm({ ...form, reinvestInterest: v })} /></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TreasuryReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const [period, setPeriod] = useState<'DAY' | 'WEEK' | 'MONTH'>('DAY');
  const [date, setDate] = useState(today());
  const range = (() => {
    const d = new Date(`${date}T00:00:00Z`);
    if (period === 'DAY') return { from: date, to: date };
    if (period === 'WEEK') {
      const start = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
      return { from: start.toISOString().slice(0, 10), to: new Date(start.getTime() + 6 * 86_400_000).toISOString().slice(0, 10) };
    }
    return { from: `${date.slice(0, 7)}-01`, to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) };
  })();
  const data = useQuery({ queryKey: ['treasury-report', entity?.id, range.from, range.to], queryFn: () => api.get<Report>('/treasury/report', { entityId: entity!.id, ...range, horizonDays: 30 }), enabled: !!entity });
  const r = data.data;
  const amt = (v: string) => formatAmount(v, fp, { parens: true });
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end gap-2">
        <Field label="Report">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
            <option value="DAY">Daily</option>
            <option value="WEEK">Weekly</option>
            <option value="MONTH">Monthly</option>
          </Select>
        </Field>
        <Field label={period === 'DAY' ? 'Date' : 'Any date in the period'}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Button onClick={() => window.print()}>Print</Button>
        {r && (
          <Button onClick={() => downloadCsv(`treasury-${range.from}-${range.to}.csv`, ['Section', 'Item', 'Opening', 'In', 'Out', 'Closing / principal'], [...r.banks.map((b) => ['Bank', b.name, b.opening, b.receipts, b.payments, b.closing]), ...r.holdings.map((h) => ['Investment', `${h.number} ${h.institution}`, '', '', '', h.principal])])}>
            Export CSV
          </Button>
        )}
      </div>
      <ReportTitle title={`${period === 'DAY' ? 'Daily' : period === 'WEEK' ? 'Weekly' : 'Monthly'} treasury report`} subtitle={`${formatDate(range.from)}${range.from === range.to ? '' : ` – ${formatDate(range.to)}`} · ${r?.currency ?? ''}`} />
      <ErrorBanner error={data.error} />
      {!r ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Cash at bank', r.totals.cash],
              ['Invested', r.totals.invested],
              ['Total liquidity', r.totals.liquidity],
              ['Interest earned in the period', r.interestEarned],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line bg-white p-3 shadow-xs">
                <p className="text-xs text-muted">{k}</p>
                <p className={cx('mt-0.5 text-lg font-semibold tabular-nums', v.startsWith('-') && 'text-red-700')}>{amt(v)}</p>
              </div>
            ))}
          </div>
          <Card title="Cash position">
            <TableWrap>
              <table className="table-base">
                <thead><tr><th>Bank account</th><th className="num">Opening</th><th className="num">Money in</th><th className="num">Money out</th><th className="num">Closing</th></tr></thead>
                <tbody>
                  {r.banks.map((b) => (
                    <tr key={b.id}><td>{b.name}</td><td className="num">{amt(b.opening)}</td><td className="num">{amt(b.receipts)}</td><td className="num">{amt(b.payments)}</td><td className="num font-medium">{amt(b.closing)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Total</td><td className="num">{amt(r.totals.opening)}</td><td className="num">{amt(r.totals.receipts)}</td><td className="num">{amt(r.totals.payments)}</td><td className="num">{amt(r.totals.cash)}</td></tr></tfoot>
              </table>
            </TableWrap>
          </Card>
          <Card title="Investments held">
            {!r.holdings.length ? (
              <p className="text-sm text-muted">None at the end of the period.</p>
            ) : (
              <TableWrap>
                <table className="table-base">
                  <thead><tr><th>Number</th><th>Type</th><th>Institution</th><th className="num">Principal</th><th className="num">Rate</th><th>Matures</th><th className="num">Days left</th><th className="num">Interest to date</th><th className="num">Interest for term</th></tr></thead>
                  <tbody>
                    {r.holdings.map((h) => (
                      <tr key={h.id}><td className="font-mono text-xs">{h.number}</td><td>{typeLabel(h.type)}</td><td>{h.institution}</td><td className="num">{amt(h.principal)}</td><td className="num">{h.ratePercent}%</td><td>{formatDate(h.maturityDate)}</td><td className="num">{h.daysToMaturity}</td><td className="num">{amt(h.interestToDate)}</td><td className="num">{amt(h.termInterest)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Maturing in the next 30 days">
              {!r.maturing.length ? <p className="text-sm text-muted">Nothing matures.</p> : (
                <ul className="space-y-1 text-sm">{r.maturing.map((m) => (<li key={m.id}>{formatDate(m.maturityDate)} · {m.institution} · {amt(m.principal)} + {amt(m.termInterest)} interest</li>))}</ul>
              )}
            </Card>
            <Card title="Placed and settled in the period">
              {!r.placed.length && !r.settled.length ? <p className="text-sm text-muted">No movements.</p> : (
                <ul className="space-y-1 text-sm">
                  {r.placed.map((p) => (<li key={`p${p.id}`}>Placed {formatDate(p.startDate)} · {p.institution} · {amt(p.principal)}</li>))}
                  {r.settled.map((s) => (<li key={`s${s.id}`}>Settled {formatDate(s.date)} · {s.institution} · net {amt(s.net)} (interest {amt(s.interest)}, withholding {amt(s.withholding)})</li>))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
