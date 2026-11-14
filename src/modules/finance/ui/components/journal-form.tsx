'use client';

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, compare, formatAmount, fromUnits, isZero, multiply, roundTo, today, toUnits } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useCurrencies, useDimensions, useEntities, useSession } from '@/modules/finance/ui/lib/session';
import type { Account, AccountClass, Journal } from '@/modules/finance/ui/lib/types';
import { Button, Card, Checkbox, cx, ErrorBanner, Field, Input, Notice, Select } from './ui';

interface LineState {
  key: number;
  accountId: string;
  description: string;
  branchId: string;
  departmentId: string;
  costCentreId: string;
  projectId: string;
  intercompanyEntityId: string;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
}

const CLASS_LABELS: Record<AccountClass, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  COST_OF_SALES: 'Cost of sales',
  EXPENSE: 'Expenses',
};

let nextKey = 1;
const emptyLine = (): LineState => ({
  key: nextKey++,
  accountId: '',
  description: '',
  branchId: '',
  departmentId: '',
  costCentreId: '',
  projectId: '',
  intercompanyEntityId: '',
  currency: '',
  exchangeRate: '',
  debit: '',
  credit: '',
});

const amountPattern = /^\d*(\.\d*)?$/;

export function JournalForm({ journal }: { journal?: Journal }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const functional = entity!.functionalCurrency;
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const { data: dimensions = [] } = useDimensions();
  const { data: currencies = [] } = useCurrencies();

  const [header, setHeader] = useState({
    journalDate: journal?.journalDate.slice(0, 10) ?? today(),
    branchId: journal?.branchId ?? '',
    description: journal?.description ?? '',
    reference: journal?.reference ?? '',
    type: (journal?.type === 'REVERSAL' ? 'STANDARD' : journal?.type) ?? 'STANDARD',
    autoReverseDate: journal?.autoReverseDate?.slice(0, 10) ?? '',
  });
  const [lines, setLines] = useState<LineState[]>(
    journal
      ? journal.lines.filter((l) => !l.autoInterBranch).map((l) => ({
          key: nextKey++,
          accountId: l.accountId,
          description: l.description,
          branchId: l.branchId === journal.branchId ? '' : l.branchId,
          departmentId: l.departmentId ?? '',
          costCentreId: l.costCentreId ?? '',
          projectId: l.projectId ?? '',
          intercompanyEntityId: l.intercompanyEntityId ?? '',
          currency: l.currency === functional ? '' : l.currency,
          exchangeRate: l.currency === functional ? '' : l.exchangeRate,
          debit: isZero(l.debitTx) ? '' : l.debitTx,
          credit: isZero(l.creditTx) ? '' : l.creditTx,
        }))
      : [emptyLine(), emptyLine()],
  );
  const [showDimensions, setShowDimensions] = useState(
    () => !!journal?.lines.some((l) => l.departmentId || l.costCentreId || l.projectId || l.intercompanyEntityId || l.branchId !== journal.branchId),
  );
  const [error, setError] = useState<string | null>(null);

  const branchId = header.branchId || branches[0]?.id || '';
  const { data: allEntities = [] } = useEntities();
  const otherEntities = allEntities.filter((e) => e.isActive && e.id !== entity!.id);
  const postable = useMemo(() => accounts.filter((a) => a.isPostable && a.isActive), [accounts]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const activeCurrencies = currencies.filter((c) => c.isActive);
  const precisionOf = (code: string) => currencies.find((c) => c.code === code)?.precision ?? 2;
  const fp = precisionOf(functional);

  const lineCurrency = (l: LineState) => l.currency || accountById.get(l.accountId)?.currency || functional;

  // Look up approved rates for any foreign currency without a manual rate, to preview translation.
  const foreign = [...new Set(lines.map(lineCurrency).filter((c) => c !== functional))];
  const rateQueries = useQueries({
    queries: foreign.map((code) => ({
      queryKey: ['rate', code, functional, header.journalDate],
      queryFn: () => api.get<{ rate: string }>('/exchange-rates/lookup', { from: code, to: functional, date: header.journalDate }),
      enabled: /^\d{4}-\d{2}-\d{2}$/.test(header.journalDate),
      retry: false,
    })),
  });
  const marketRate = (code: string) => rateQueries[foreign.indexOf(code)]?.data?.rate ?? null;

  const translated = lines.map((l) => {
    const cur = lineCurrency(l);
    const rate = cur === functional ? '1' : l.exchangeRate || marketRate(cur);
    return {
      cur,
      rate,
      debit: rate && l.debit ? roundTo(multiply(l.debit, rate), fp) : '0',
      credit: rate && l.credit ? roundTo(multiply(l.credit, rate), fp) : '0',
    };
  });
  const totalDebit = addAll(translated.map((t) => t.debit));
  const totalCredit = addAll(translated.map((t) => t.credit));
  const difference = fromUnits(toUnits(totalDebit) - toUnits(totalCredit));
  const balanced = compare(totalDebit, totalCredit) === 0 && !isZero(totalDebit);
  const missingRates = translated.filter((t) => !t.rate).map((t) => t.cur);

  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = {
        entityId: entity!.id,
        branchId,
        journalDate: header.journalDate,
        description: header.description,
        reference: header.reference || undefined,
        type: header.type,
        autoReverseDate: header.type === 'ACCRUAL' && header.autoReverseDate ? header.autoReverseDate : null,
        lines: lines
          .filter((l) => l.accountId || l.debit || l.credit)
          .map((l) => ({
            accountId: l.accountId,
            description: l.description || undefined,
            branchId: l.branchId || null,
            departmentId: l.departmentId || null,
            costCentreId: l.costCentreId || null,
            projectId: l.projectId || null,
            intercompanyEntityId: l.intercompanyEntityId || null,
            currency: l.currency || undefined,
            exchangeRate: l.currency && l.currency !== functional && l.exchangeRate ? l.exchangeRate : null,
            debit: l.debit || null,
            credit: l.credit || null,
          })),
      };
      const saved = journal ? await api.patch<Journal>(`/journals/${journal.id}`, body) : await api.post<Journal>('/journals', body);
      if (submit) await api.post(`/journals/${saved.id}/submit`);
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['journals'] });
      queryClient.invalidateQueries({ queryKey: ['journal', saved.id] });
      router.push(`/finance/journals/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function onSubmit(e: FormEvent, submit: boolean) {
    e.preventDefault();
    setError(null);
    save.mutate(submit);
  }

  const groups = (Object.keys(CLASS_LABELS) as AccountClass[]).map((cls) => ({ cls, items: postable.filter((a) => a.accountClass === cls) }));
  const dims = (type: string) => dimensions.filter((d) => d.type === type && d.isActive && (!d.entityId || d.entityId === entity!.id));
  const needs = (a: Account | undefined, key: 'requiresDepartment' | 'requiresCostCentre' | 'requiresProject') => !!a?.[key];

  return (
    <form onSubmit={(e) => onSubmit(e, false)} className="space-y-4">
      <ErrorBanner error={error} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Date">
            <Input type="date" required value={header.journalDate} onChange={(e) => setHeader({ ...header, journalDate: e.target.value })} />
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              {branches.filter((b) => b.isActive).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={header.type} onChange={(e) => setHeader({ ...header, type: e.target.value as typeof header.type })}>
              <option value="STANDARD">Standard</option>
              <option value="ACCRUAL">Accrual (auto-reverse)</option>
              <option value="OPENING">Opening balance</option>
            </Select>
          </Field>
          {header.type === 'ACCRUAL' ? (
            <Field label="Reverse on">
              <Input type="date" required value={header.autoReverseDate} onChange={(e) => setHeader({ ...header, autoReverseDate: e.target.value })} />
            </Field>
          ) : (
            <Field label="Reference">
              <Input value={header.reference} maxLength={100} onChange={(e) => setHeader({ ...header, reference: e.target.value })} />
            </Field>
          )}
          <Field label="Description" className="md:col-span-4">
            <Input required maxLength={500} value={header.description} onChange={(e) => setHeader({ ...header, description: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card
        padded={false}
        title="Lines"
        actions={<Checkbox label="Branch & dimensions per line" checked={showDimensions} onChange={setShowDimensions} />}
      >
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th className="min-w-64">Account</th>
                <th className="min-w-40">Description</th>
                {showDimensions && (
                  <>
                    <th>Branch</th>
                    <th>Department</th>
                    <th>Cost centre</th>
                    <th>Project</th>
                    {otherEntities.length > 0 && <th title="Loans, interest and recharges with another group entity are eliminated on consolidation">Intercompany</th>}
                  </>
                )}
                <th className="min-w-24">Currency</th>
                <th className="min-w-28">Rate</th>
                <th className="num min-w-32">Debit</th>
                <th className="num min-w-32">Credit</th>
                <th className="num w-36">{functional}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const account = accountById.get(l.accountId);
                const t = translated[i];
                const cur = t.cur;
                const isForeign = cur !== functional;
                return (
                  <tr key={l.key}>
                    <td className="text-xs text-muted">{i + 1}</td>
                    <td>
                      <Select
                        className="h-8 text-xs"
                        value={l.accountId}
                        onChange={(e) => {
                          const a = accountById.get(e.target.value);
                          update(l.key, { accountId: e.target.value, currency: a?.currency && a.currency !== functional ? a.currency : l.currency });
                        }}
                        aria-label={`Line ${i + 1} account`}
                      >
                        <option value="">Select account…</option>
                        {groups.map((g) =>
                          g.items.length ? (
                            <optgroup key={g.cls} label={CLASS_LABELS[g.cls]}>
                              {g.items.map((a) => (
                                <option key={a.id} value={a.id} disabled={!a.allowManualPosting}>
                                  {a.code} · {a.name}
                                  {a.currency ? ` [${a.currency}]` : ''}
                                  {!a.allowManualPosting ? ' (control)' : ''}
                                </option>
                              ))}
                            </optgroup>
                          ) : null,
                        )}
                      </Select>
                    </td>
                    <td>
                      <Input className="h-8 text-xs" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Line ${i + 1} description`} />
                    </td>
                    {showDimensions && (
                      <>
                        <td>
                          <Select className="h-8 text-xs" value={l.branchId} onChange={(e) => update(l.key, { branchId: e.target.value })} aria-label="Branch">
                            <option value="">Header</option>
                            {branches.filter((b) => b.isActive).map((b) => (
                              <option key={b.id} value={b.id}>{b.code}</option>
                            ))}
                          </Select>
                        </td>
                        {(
                          [
                            ['departmentId', 'DEPARTMENT', 'requiresDepartment'],
                            ['costCentreId', 'COST_CENTRE', 'requiresCostCentre'],
                            ['projectId', 'PROJECT', 'requiresProject'],
                          ] as const
                        ).map(([field, type, req]) => (
                          <td key={field}>
                            <Select
                              className={cx('h-8 text-xs', needs(account, req) && !l[field] && 'border-amber-400')}
                              value={l[field]}
                              onChange={(e) => update(l.key, { [field]: e.target.value })}
                              aria-label={type}
                            >
                              <option value="">{needs(account, req) ? 'Required…' : '—'}</option>
                              {dims(type).map((d) => (
                                <option key={d.id} value={d.id}>{d.code}</option>
                              ))}
                            </Select>
                          </td>
                        ))}
                        {otherEntities.length > 0 && (
                          <td>
                            <Select className="h-8 text-xs" value={l.intercompanyEntityId} onChange={(e) => update(l.key, { intercompanyEntityId: e.target.value })} aria-label="Intercompany entity">
                              <option value="">—</option>
                              {otherEntities.map((e) => (
                                <option key={e.id} value={e.id}>{e.code}</option>
                              ))}
                            </Select>
                          </td>
                        )}
                      </>
                    )}
                    <td>
                      <Select
                        className="h-8 min-w-20 text-xs"
                        value={cur}
                        disabled={!!account?.currency}
                        onChange={(e) => update(l.key, { currency: e.target.value === functional ? '' : e.target.value, exchangeRate: '' })}
                        aria-label="Currency"
                      >
                        {activeCurrencies.map((c) => (
                          <option key={c.code}>{c.code}</option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      {isForeign ? (
                        <Input
                          className="h-8 min-w-24 text-xs"
                          inputMode="decimal"
                          placeholder={marketRate(cur) ?? 'No rate'}
                          value={l.exchangeRate}
                          onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { exchangeRate: e.target.value })}
                          aria-label="Exchange rate"
                        />
                      ) : (
                        <span className="px-2 text-xs text-muted">1</span>
                      )}
                    </td>
                    <td>
                      <Input
                        className="h-8 text-right text-xs tabular-nums"
                        inputMode="decimal"
                        value={l.debit}
                        onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
                        aria-label={`Line ${i + 1} debit`}
                      />
                    </td>
                    <td>
                      <Input
                        className="h-8 text-right text-xs tabular-nums"
                        inputMode="decimal"
                        value={l.credit}
                        onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
                        aria-label={`Line ${i + 1} credit`}
                      />
                    </td>
                    <td className="num text-xs text-muted">
                      {isForeign && t.rate ? formatAmount(isZero(t.debit) ? `-${t.credit}` : t.debit, fp, { parens: true, blankZero: true }) : ''}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="rounded p-1 text-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                        disabled={lines.length <= 2}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        aria-label={`Remove line ${i + 1}`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={showDimensions ? 9 : 5}>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                    + Add line
                  </Button>
                </td>
                <td className="num">{formatAmount(totalDebit, fp)}</td>
                <td className="num">{formatAmount(totalCredit, fp)}</td>
                <td colSpan={2} className={cx('text-xs', balanced ? 'text-emerald-700' : 'text-amber-700')}>
                  {balanced ? 'Balanced' : isZero(difference) ? '' : `Out by ${formatAmount(difference.replace('-', ''), fp)}`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          Totals are shown in the functional currency ({functional}). Foreign-currency lines use the latest approved rate on the journal date unless you enter one.
        </p>
      </Card>

      {missingRates.length > 0 && (
        <Notice tone="amber">
          No approved rate for {[...new Set(missingRates)].join(', ')} → {functional} on this date. Enter a rate on the line or capture one under Currencies & FX rates.
        </Notice>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending && !save.variables}>
          Save draft
        </Button>
        <Button type="button" variant="primary" loading={save.isPending && !!save.variables} disabled={!balanced} onClick={(e) => onSubmit(e, true)}>
          Save & submit for approval
        </Button>
      </div>
    </form>
  );
}
