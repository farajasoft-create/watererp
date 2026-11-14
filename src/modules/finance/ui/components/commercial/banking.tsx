'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import type { BankAccount } from '@/modules/finance/ui/lib/commercial';
import { useBankAccounts } from '@/modules/finance/ui/lib/commercial-hooks';
import { addAll, compare, formatAmount, formatDate, formatDateTime, fromUnits, isZero, today, toUnits } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from '../ui';
import { AccountOptions } from './shared';
import { useDirectory } from '../workflow';
import { AttachmentsCard } from '../attachments';
import { MpesaSettingsCard } from '../getting-paid';
import { ConnectionsCard } from '../money';
import { BankSuggestions } from '../automation';

const amountPattern = /^-?\d*(\.\d*)?$/;
const TYPE_LABEL: Record<BankAccount['type'], string> = { BANK: 'Bank', CASH: 'Cash', MOBILE_MONEY: 'Mobile money', PETTY_CASH: 'Petty cash' };

// ---------------------------------------------------------------------------------------------
// Accounts & transfers
// ---------------------------------------------------------------------------------------------

export function BankingHome() {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const { data: banks = [], isLoading, error } = useBankAccounts(entity?.id);
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [transferring, setTransferring] = useState(false);
  const transfers = useQuery({
    queryKey: ['bank-transfers', entity?.id],
    queryFn: () => api.get<{ id: string; number: string; date: string; fromBankAccountId: string; toBankAccountId: string; fromAmount: string; toAmount: string; journalId: string; reference: string }[]>('/bank-transfers', { entityId: entity!.id }),
  });
  const name = (id: string) => banks.find((b) => b.id === id);

  return (
    <>
      <PageHeader
        title="Cash & banking"
        description="Bank, cash and mobile-money accounts with their ledger balances. Import statements to reconcile."
        actions={
          <>
            {can('banking.manage') && banks.length > 1 && <Button onClick={() => setTransferring(true)}>Transfer</Button>}
            {can('banking.manage') && <Button variant="primary" onClick={() => setEditing('new')}>Add account</Button>}
          </>
        }
      />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading ? (
        <Loading />
      ) : !banks.length ? (
        <Card><Empty title="No bank accounts yet">Add an account and link it to a Bank or Cash ledger account.</Empty></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {banks.map((b) => (
            <div key={b.id} className={cx('rounded-lg border border-line bg-white p-4 shadow-xs', !b.isActive && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/finance/banking/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link>
                  <p className="truncate text-xs text-muted">
                    {TYPE_LABEL[b.type]} · {[b.bankName, b.accountNumber].filter(Boolean).join(' ')} · GL {b.glAccountCode}
                  </p>
                </div>
                {can('banking.manage') && (
                  <button className="text-xs text-muted hover:text-ink" onClick={() => setEditing(b)}>Edit</button>
                )}
              </div>
              <p className="mt-3 text-2xl font-semibold tabular-nums">
                {formatAmount(b.balance, precision(b.currency), { parens: true })} <span className="text-xs font-normal text-muted">{b.currency}</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                <span>{b.lastReconciledDate ? `Reconciled to ${formatDate(b.lastReconciledDate)}` : 'Not yet reconciled'}</span>
                {b.unmatchedStatementLines > 0 && <Badge tone="amber">{b.unmatchedStatementLines} unmatched</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!!transfers.data?.length && (
        <Card title="Recent transfers" padded={false} className="mt-5">
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Amount</th>
                <th>Journal</th>
              </tr>
            </thead>
            <tbody>
              {transfers.data.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap font-mono text-xs">{t.number}</td>
                  <td>{formatDate(t.date)}</td>
                  <td>{name(t.fromBankAccountId)?.name}</td>
                  <td>{name(t.toBankAccountId)?.name}</td>
                  <td className="num">
                    {formatAmount(t.fromAmount, precision(name(t.fromBankAccountId)?.currency))} {name(t.fromBankAccountId)?.currency}
                    {name(t.fromBankAccountId)?.currency !== name(t.toBankAccountId)?.currency && (
                      <span className="text-muted"> → {formatAmount(t.toAmount, precision(name(t.toBankAccountId)?.currency))} {name(t.toBankAccountId)?.currency}</span>
                    )}
                  </td>
                  <td><Link className="text-xs text-brand-700 hover:underline" href={`/finance/journals/${t.journalId}`}>View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {editing && <BankAccountEditor bank={editing} onClose={() => setEditing(null)} />}
      {transferring && <TransferDialog banks={banks.filter((b) => b.isActive)} onClose={() => setTransferring(false)} />}
    </>
  );
}

function BankAccountEditor({ bank, onClose }: { bank: BankAccount | 'new'; onClose: () => void }) {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const existing = bank === 'new' ? null : bank;
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    type: existing?.type ?? 'BANK',
    bankName: existing?.bankName ?? '',
    accountNumber: existing?.accountNumber ?? '',
    glAccountId: existing?.glAccountId ?? '',
    branchId: existing?.branchId ?? '',
    reconcileFrom: existing?.reconcileFrom?.slice(0, 10) ?? '',
    isActive: existing?.isActive ?? true,
    signatories: (existing as { chequeSignatories?: string[] } | null)?.chequeSignatories ?? [],
    required: String((existing as { chequeSignaturesRequired?: number } | null)?.chequeSignaturesRequired ?? 0),
  });
  const { data: directory } = useDirectory();
  const [error, setError] = useState<string | null>(null);
  const glAccounts = accounts.filter((a) => a.isPostable && ['BANK', 'CASH'].includes(a.accountType));
  const save = useMutation({
    mutationFn: async () => {
      const { signatories, required, ...rest } = form;
      const body = { ...rest, entityId: entity!.id, branchId: form.branchId || branches[0]?.id, reconcileFrom: form.reconcileFrom || null };
      const saved = existing ? await api.patch<{ id: string }>(`/bank-accounts/${existing.id}`, body) : await api.post<{ id: string }>('/bank-accounts', body);
      if (form.type === 'BANK') await api.patch(`/bank-accounts/${saved.id}/cheque-signatories`, { userIds: signatories, required: Number(required) || 0 });
      return saved;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : 'Add bank or cash account'}
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
          <Field label="Name" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Equity Bank – Operating" />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as BankAccount['type'] })}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={form.branchId || branches[0]?.id || ''} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Bank">
            <Input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
          </Field>
          {form.type === 'BANK' && (
            <Field label="Cheque signatories (sign electronically)" className="sm:col-span-2" hint="Cheques print once this many have signed; 0 means no electronic signing">
              <div className="flex flex-wrap gap-3">
                {directory?.users.map((u) => <label key={u.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.signatories.includes(u.id)} onChange={(e) => setForm({ ...form, signatories: e.target.checked ? [...form.signatories, u.id] : form.signatories.filter((x) => x !== u.id) })} /> {u.name}</label>)}
                <span className="flex items-center gap-1 text-sm">Signatures needed <Input className="w-16" inputMode="numeric" value={form.required} onChange={(e) => setForm({ ...form, required: e.target.value })} /></span>
              </div>
            </Field>
          )}
          <Field label="Account number">
            <Input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
          </Field>
          <Field label="Ledger account" hint="Its currency sets the account currency" className="sm:col-span-2">
            <Select value={form.glAccountId} onChange={(e) => setForm({ ...form, glAccountId: e.target.value })}>
              <option value="">Select a Bank or Cash account…</option>
              {glAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name} ({a.currency ?? entity!.functionalCurrency})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reconcile from" hint="Earlier ledger entries count as already cleared">
            <Input type="date" value={form.reconcileFrom} onChange={(e) => setForm({ ...form, reconcileFrom: e.target.value })} />
          </Field>
        </div>
        {existing && <Checkbox label="Active" checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />}
      </div>
    </Modal>
  );
}

function TransferDialog({ banks, onClose }: { banks: BankAccount[]; onClose: () => void }) {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ from: banks[0]?.id ?? '', to: banks[1]?.id ?? '', date: today(), amount: '', toAmount: '', reference: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const from = banks.find((b) => b.id === form.from);
  const to = banks.find((b) => b.id === form.to);
  const cross = from && to && from.currency !== to.currency;
  const save = useMutation({
    mutationFn: () =>
      api.post('/bank-transfers', {
        entityId: entity!.id,
        fromBankAccountId: form.from,
        toBankAccountId: form.to,
        date: form.date,
        amount: form.amount,
        toAmount: cross ? form.toAmount : null,
        reference: form.reference || undefined,
        description: form.description || undefined,
      }),
    onSuccess: () => {
      for (const key of [['bank-accounts'], ['bank-transfers'], ['dashboard']]) queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Transfer between accounts"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Post transfer</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>
              ))}
            </Select>
          </Field>
          <Field label={`Amount sent${from ? ` (${from.currency})` : ''}`}>
            <Input inputMode="decimal" value={form.amount} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, amount: e.target.value })} />
          </Field>
          {cross ? (
            <Field label={`Amount received (${to!.currency})`} hint="Any difference at the approved rate is booked as realised FX">
              <Input inputMode="decimal" value={form.toAmount} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, toAmount: e.target.value })} />
            </Field>
          ) : (
            <Field label="Date">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
          )}
          {cross && (
            <Field label="Date">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
          )}
          <Field label="Reference">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Reconciliation workspace
// ---------------------------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  date: string;
  journalId: string;
  journalNumber: string;
  description: string;
  amount: string;
}
interface StatementRow {
  id: string;
  date: string;
  description: string;
  reference: string;
  amount: string;
}
interface Workspace {
  bankAccount: { id: string; name: string; currency: string; reconcileFrom: string | null; lastReconciledDate: string | null };
  bookBalance: string;
  statementBalance: string | null;
  statementBalanceSource: 'entered' | 'imported' | null;
  unpresentedTotal: string;
  unrecordedTotal: string;
  difference: string | null;
  canComplete: boolean;
  statementLines: StatementRow[];
  ledgerEntries: LedgerRow[];
  recentMatches: { id: string; kind: string; reconciliationId: string | null; createdAt: string; lines: StatementRow[]; entries: LedgerRow[] }[];
  suggestions: { statementLineId: string; ledgerEntryId: string }[];
}

export function BankAccountPage({ id }: { id: string }) {
  const [tab, setTab] = useState<'reconcile' | 'import' | 'history' | 'mpesa' | 'connections'>('reconcile');
  const { data: banks = [] } = useBankAccounts();
  const { can } = useSession();
  const bank = banks.find((b) => b.id === id);
  const precision = usePrecision();
  return (
    <>
      <PageHeader
        title={bank?.name ?? 'Bank account'}
        description={bank ? `Ledger balance ${formatAmount(bank.balance, precision(bank.currency), { parens: true })} ${bank.currency}${bank.lastReconciledDate ? ` · reconciled to ${formatDate(bank.lastReconciledDate)}` : ''}` : undefined}
        actions={<Link href="/finance/banking" className="text-sm text-brand-700 hover:underline">All accounts</Link>}
      />
      <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'reconcile', label: 'Reconcile' },
          { id: 'import', label: 'Import statement' },
          { id: 'history', label: 'Reconciliations' },
          ...(bank?.type === 'MOBILE_MONEY' && bank.currency === 'KES' ? [{ id: 'mpesa' as const, label: 'M-Pesa' }] : []),
          ...(can('banking.manage') ? [{ id: 'connections' as const, label: 'Feed & cards' }] : []),
        ]}
      />
      {tab === 'mpesa' && <MpesaSettingsCard bankId={id} />}
      {tab === 'connections' && <ConnectionsCard bankId={id} />}
      {tab === 'reconcile' && <Reconcile id={id} />}
      {tab === 'import' && bank && <ImportStatement bank={bank} onDone={() => setTab('reconcile')} />}
      {tab === 'history' && <History id={id} currency={bank?.currency} />}
      {tab === 'history' && <AttachmentsCard recordType="BankAccount" recordId={id} />}
    </>
  );
}

function Reconcile({ id }: { id: string }) {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useAccounts(entity!.id);
  const [asOf, setAsOf] = useState(today());
  const [balance, setBalance] = useState('');
  const [lines, setLines] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Set<string>>(new Set());
  const [adjustAccount, setAdjustAccount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ws = useQuery({
    queryKey: ['reconciliation', id, asOf, balance],
    queryFn: () => api.get<Workspace>(`/bank-accounts/${id}/reconciliation`, { asOf, statementBalance: balance || undefined }),
  });
  const refresh = () => {
    setLines(new Set());
    setEntries(new Set());
    for (const key of [['reconciliation', id], ['bank-accounts'], ['bank-reconciliations', id]]) queryClient.invalidateQueries({ queryKey: key });
  };
  const call = useMutation({
    mutationFn: ({ path, body, method = 'POST' }: { path: string; body?: object; method?: 'POST' | 'DELETE' }) => (method === 'DELETE' ? api.delete(path) : api.post(path, body ?? {})),
    onSuccess: (res, vars) => {
      setError(null);
      if (vars.path.endsWith('auto-match')) setNotice(`Matched ${(res as { matched: number }).matched} item(s) automatically.`);
      else if (vars.path.endsWith('reconciliations')) setNotice('Reconciliation completed and locked.');
      else setNotice(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const w = ws.data;
  const dp = precision(w?.bankAccount.currency);
  const lineTotal = addAll(w?.statementLines.filter((l) => lines.has(l.id)).map((l) => l.amount) ?? []);
  const entryTotal = addAll(w?.ledgerEntries.filter((e) => entries.has(e.id)).map((e) => e.amount) ?? []);
  const balanced = lines.size > 0 && entries.size > 0 && compare(lineTotal, entryTotal) === 0;
  const suggested = useMemo(() => new Set(w?.suggestions.flatMap((s) => [s.statementLineId, s.ledgerEntryId]) ?? []), [w]);
  const toggle = (set: Set<string>, value: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };
  const reconcile = can('banking.reconcile');

  if (!w) return ws.error ? <ErrorBanner error={ws.error} /> : <Loading />;
  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />
      {notice && <Notice tone="green">{notice}</Notice>}
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Statement date">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <Field label={`Statement closing balance (${w.bankAccount.currency})`} hint={w.statementBalanceSource === 'imported' && !balance ? 'From the latest imported statement' : undefined}>
            <Input className="w-48" inputMode="decimal" placeholder={w.statementBalance ?? ''} value={balance} onChange={(e) => amountPattern.test(e.target.value) && setBalance(e.target.value)} />
          </Field>
          <dl className="ml-auto grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Ledger balance</dt>
              <dd className="font-medium tabular-nums">{formatAmount(w.bookBalance, dp, { parens: true })}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Unpresented in books</dt>
              <dd className="font-medium tabular-nums">{formatAmount(w.unpresentedTotal, dp, { parens: true })}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Not yet in books</dt>
              <dd className="font-medium tabular-nums">{formatAmount(w.unrecordedTotal, dp, { parens: true })}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Difference</dt>
              <dd className={cx('font-semibold tabular-nums', w.difference === null ? 'text-muted' : isZero(w.difference) ? 'text-emerald-700' : 'text-red-700')}>
                {w.difference === null ? 'Enter balance' : formatAmount(w.difference, dp, { parens: true })}
              </dd>
            </div>
          </dl>
        </div>
        {reconcile && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
            {w.suggestions.length > 0 && (
              <Button loading={call.isPending && call.variables?.path.endsWith('auto-match')} onClick={() => call.mutate({ path: `/bank-accounts/${id}/auto-match` })}>
                Auto-match {w.suggestions.length} suggestion{w.suggestions.length === 1 ? '' : 's'}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!w.canComplete}
              title={w.canComplete ? undefined : 'Match or adjust all statement lines up to the statement date and agree the balance first'}
              loading={call.isPending && call.variables?.path.endsWith('reconciliations')}
              onClick={() => call.mutate({ path: `/bank-accounts/${id}/reconciliations`, body: { statementDate: asOf, statementBalance: balance || w.statementBalance } })}
            >
              Complete reconciliation
            </Button>
          </div>
        )}
      </Card>
      {reconcile && (
        <BankSuggestions
          bankId={id}
          onChange={refresh}
          describeLine={(lid) => {
            const l = w.statementLines.find((x) => x.id === lid);
            return l ? `${formatDate(l.date)} ${l.description || l.reference} ${formatAmount(l.amount, dp, { parens: true })}` : 'statement line';
          }}
          describeEntry={(eid) => {
            const e = w.ledgerEntries.find((x) => x.id === eid);
            return e ? `${e.journalNumber} ${formatDate(e.date)} ${formatAmount(e.amount, dp, { parens: true })}` : 'ledger entry';
          }}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Statement lines not matched (${w.statementLines.length})`} padded={false}>
          {!w.statementLines.length ? (
            <p className="px-4 py-6 text-sm text-muted">Everything on the statement is matched. Import a new statement to continue.</p>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="table-base">
                <tbody>
                  {w.statementLines.map((l) => (
                    <tr key={l.id} className={cx('cursor-pointer', lines.has(l.id) && 'bg-brand-50', l.date.slice(0, 10) > asOf && 'opacity-50')} onClick={() => reconcile && toggle(lines, l.id, setLines)}>
                      <td className="w-6"><input type="checkbox" readOnly checked={lines.has(l.id)} className="accent-brand-600" aria-label="Select statement line" /></td>
                      <td className="whitespace-nowrap text-xs">{formatDate(l.date)}</td>
                      <td className="text-xs">
                        {l.description} {l.reference && <span className="text-muted">· {l.reference}</span>}
                        {suggested.has(l.id) && <span className="ml-1"><Badge tone="blue">match found</Badge></span>}
                      </td>
                      <td className={cx('num text-xs', l.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(l.amount, dp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={`Ledger entries not on a statement (${w.ledgerEntries.length})`} padded={false}>
          {!w.ledgerEntries.length ? (
            <p className="px-4 py-6 text-sm text-muted">No unmatched ledger entries up to the statement date.</p>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="table-base">
                <tbody>
                  {w.ledgerEntries.map((e) => (
                    <tr key={e.id} className={cx('cursor-pointer', entries.has(e.id) && 'bg-brand-50')} onClick={() => reconcile && toggle(entries, e.id, setEntries)}>
                      <td className="w-6"><input type="checkbox" readOnly checked={entries.has(e.id)} className="accent-brand-600" aria-label="Select ledger entry" /></td>
                      <td className="whitespace-nowrap text-xs">{formatDate(e.date)}</td>
                      <td className="text-xs">
                        <Link className="font-mono text-brand-700 hover:underline" href={`/finance/journals/${e.journalId}`} onClick={(ev) => ev.stopPropagation()}>{e.journalNumber}</Link> {e.description}
                      </td>
                      <td className={cx('num text-xs', e.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{formatAmount(e.amount, dp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {reconcile && (lines.size > 0 || entries.size > 0) && (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <p className="text-sm">
              Statement {formatAmount(lineTotal, dp, { parens: true })} · Ledger {formatAmount(entryTotal, dp, { parens: true })}
              {!balanced && entries.size > 0 && lines.size > 0 && <span className="ml-2 text-red-700">Difference {formatAmount(fromUnits(toUnits(lineTotal) - toUnits(entryTotal)), dp, { parens: true })}</span>}
            </p>
            <Button
              variant="primary"
              disabled={!balanced}
              loading={call.isPending && call.variables?.path.endsWith('matches')}
              onClick={() => call.mutate({ path: `/bank-accounts/${id}/matches`, body: { statementLineIds: [...lines], ledgerEntryIds: [...entries] } })}
            >
              Match selected
            </Button>
            {lines.size === 1 && entries.size === 0 && (
              <>
                <Field label="Or record the statement line against" className="ml-auto">
                  <Select className="w-72" value={adjustAccount} onChange={(e) => setAdjustAccount(e.target.value)}>
                    <AccountOptions accounts={accounts} classes={['EXPENSE', 'REVENUE']} placeholder="Account (e.g. bank charges)…" />
                  </Select>
                </Field>
                <Button
                  disabled={!adjustAccount}
                  loading={call.isPending && call.variables?.path.endsWith('adjustments')}
                  onClick={() => call.mutate({ path: `/bank-accounts/${id}/adjustments`, body: { statementLineId: [...lines][0], accountId: adjustAccount } })}
                >
                  Post & match
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      {!!w.recentMatches.length && (
        <Card title="Recent matches" padded={false}>
          <table className="table-base">
            <tbody>
              {w.recentMatches.map((m) => (
                <tr key={m.id}>
                  <td className="w-40 text-xs text-muted">{formatDateTime(m.createdAt)}</td>
                  <td className="text-xs">{m.lines.map((l) => `${formatDate(l.date)} ${l.description || l.reference}`).join('; ')}</td>
                  <td className="text-xs">{m.entries.map((e) => e.journalNumber).join(', ')}</td>
                  <td className="num text-xs">{formatAmount(addAll(m.lines.map((l) => l.amount)), dp, { parens: true })}</td>
                  <td><Badge tone={m.kind === 'AUTO' ? 'blue' : m.kind === 'ADJUSTMENT' ? 'violet' : 'gray'}>{m.kind.toLowerCase()}</Badge></td>
                  <td className="text-right">
                    {m.reconciliationId ? (
                      <Badge tone="green">Locked</Badge>
                    ) : (
                      reconcile && (
                        <Button size="sm" variant="ghost" onClick={() => call.mutate({ path: `/bank-matches/${m.id}`, method: 'DELETE' })}>
                          Unmatch
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Statement import (CSV)
// ---------------------------------------------------------------------------------------------

function parseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function parseAmount(v: string | undefined): string {
  if (!v) return '';
  let s = v.trim().replace(/[,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  if (!/^-?\d*(\.\d+)?$/.test(s) || !s) return '';
  return neg ? `-${s}` : s;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Reads a bank CSV with a header row. Recognises date, description/narration, reference, and
 * either a signed amount column or separate debit (money out) and credit (money in) columns.
 */
export function parseStatementCsv(text: string) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
  if (rows.length < 2) return { lines: [], errors: ['The file needs a header row and at least one transaction'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const col = {
    date: find('date'),
    description: find('description', 'narration', 'details', 'particulars'),
    reference: find('reference', 'ref', 'cheque'),
    amount: header.findIndex((h) => h === 'amount' || h.startsWith('amount')),
    debit: find('debit', 'withdrawal', 'money out', 'paid out'),
    credit: find('credit', 'deposit', 'money in', 'paid in'),
  };
  const errors: string[] = [];
  if (col.date < 0) errors.push('No date column found');
  if (col.amount < 0 && (col.debit < 0 || col.credit < 0)) errors.push('Need an amount column, or debit and credit columns');
  if (errors.length) return { lines: [], errors };
  const lines: { date: string; description: string; reference: string; amount: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const date = parseDate(r[col.date] ?? '');
    let amount = col.amount >= 0 ? parseAmount(r[col.amount]) : '';
    if (col.amount < 0) {
      const out = parseAmount(r[col.debit]);
      const inn = parseAmount(r[col.credit]);
      amount = inn && !isZero(inn) ? inn.replace('-', '') : out && !isZero(out) ? `-${out.replace('-', '')}` : '';
    }
    if (!date || !amount || isZero(amount)) {
      errors.push(`Row ${i + 2} skipped: ${!date ? 'unreadable date' : 'no amount'}`);
      return;
    }
    lines.push({ date, description: col.description >= 0 ? (r[col.description] ?? '').trim() : '', reference: col.reference >= 0 ? (r[col.reference] ?? '').trim() : '', amount });
  });
  return { lines, errors };
}

function ImportStatement({ bank, onDone }: { bank: BankAccount; onDone: () => void }) {
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [text, setText] = useState('');
  const [closing, setClosing] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseStatementCsv(text) : null), [text]);
  const dp = precision(bank.currency);
  const save = useMutation({
    mutationFn: () => api.post<{ imported: number; duplicates: number }>(`/bank-accounts/${bank.id}/statements`, { closingBalance: closing || null, lines: parsed!.lines }),
    onSuccess: (r) => {
      setResult(`Imported ${r.imported} line(s)${r.duplicates ? `; skipped ${r.duplicates} already imported` : ''}.`);
      setText('');
      for (const key of [['reconciliation', bank.id], ['bank-accounts']]) queryClient.invalidateQueries({ queryKey: key });
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  if (!can('banking.manage')) return <Notice>You need banking.manage to import statements.</Notice>;
  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />
      {result && <Notice tone="green">{result}</Notice>}
      <Card title={`Import a ${bank.currency} statement`}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Upload or paste a CSV export from your bank. A header row is required with a date column, a description, and either a signed amount or separate debit/credit columns.
            Dates may be YYYY-MM-DD or DD/MM/YYYY. Lines already imported are skipped.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setText(await file.text());
            }}
          />
          <Textarea rows={6} className="font-mono text-xs" placeholder={'Date,Description,Reference,Amount\n2026-10-01,Customer EFT,INV-123,15000.00\n2026-10-02,Bank charges,,-350.00'} value={text} onChange={(e) => setText(e.target.value)} />
          <Field label={`Statement closing balance (${bank.currency}, optional)`}>
            <Input className="w-56" inputMode="decimal" value={closing} onChange={(e) => amountPattern.test(e.target.value) && setClosing(e.target.value)} />
          </Field>
        </div>
      </Card>
      {parsed && (
        <Card title={`Preview: ${parsed.lines.length} transaction(s)`} padded={false}>
          {parsed.errors.length > 0 && (
            <div className="m-3">
              <Notice tone="amber">{parsed.errors.slice(0, 5).join('. ')}{parsed.errors.length > 5 ? ` (+${parsed.errors.length - 5} more)` : ''}</Notice>
            </div>
          )}
          {parsed.lines.length > 0 && (
            <>
              <div className="max-h-80 overflow-y-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Reference</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{formatDate(l.date)}</td>
                        <td>{l.description}</td>
                        <td className="text-muted">{l.reference}</td>
                        <td className="num">{formatAmount(l.amount, dp, { parens: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3 text-sm">
                <span className="text-muted">Net movement {formatAmount(addAll(parsed.lines.map((l) => l.amount)), dp, { parens: true })}</span>
                <Button variant="primary" loading={save.isPending} onClick={() => (setError(null), save.mutate())}>
                  Import {parsed.lines.length} line(s)
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function History({ id, currency }: { id: string; currency?: string }) {
  const precision = usePrecision();
  const dp = precision(currency);
  const { data = [], isLoading } = useQuery({
    queryKey: ['bank-reconciliations', id],
    queryFn: () =>
      api.get<{ id: string; statementDate: string; statementBalance: string; bookBalance: string; unpresentedTotal: string; outstanding: { journalNumber: string; date: string; description: string; amount: string }[]; matchedCount: number; completedAt: string }[]>(
        `/bank-accounts/${id}/reconciliations`,
      ),
  });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <Loading />;
  if (!data.length) return <Card><Empty title="No completed reconciliations yet" /></Card>;
  return (
    <TableWrap>
      <table className="table-base">
        <thead>
          <tr>
            <th>Statement date</th>
            <th className="num">Statement balance</th>
            <th className="num">Unpresented</th>
            <th className="num">Ledger balance</th>
            <th className="num">Items matched</th>
            <th>Completed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{formatDate(r.statementDate)}</td>
                <td className="num">{formatAmount(r.statementBalance, dp, { parens: true })}</td>
                <td className="num">{formatAmount(r.unpresentedTotal, dp, { parens: true })}</td>
                <td className="num">{formatAmount(r.bookBalance, dp, { parens: true })}</td>
                <td className="num">{r.matchedCount}</td>
                <td className="text-xs text-muted">{formatDateTime(r.completedAt)} <StatusBadge status="CLOSED" /></td>
                <td className="text-right">
                  {r.outstanding.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {r.outstanding.length} outstanding
                    </Button>
                  )}
                </td>
              </tr>
              {open === r.id &&
                r.outstanding.map((o, i) => (
                  <tr key={`${r.id}-${i}`} className="bg-gray-50 text-xs">
                    <td>{formatDate(o.date)}</td>
                    <td colSpan={4}>
                      <span className="font-mono">{o.journalNumber}</span> {o.description}
                    </td>
                    <td className="num" colSpan={2}>{formatAmount(o.amount, dp, { parens: true })}</td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
