'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { OpenItems, Payment, PaymentDetail, PaymentKind, PAYMENT_METHODS, rateOn, SALES, SideConfig, sideOf } from '@/modules/finance/ui/lib/commercial';
import { useBankAccounts, useParties, useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { addAll, compare, divide, formatAmount, formatDate, fromUnits, isZero, multiply, roundTo, today, toUnits } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { Paged } from '@/modules/finance/ui/lib/types';
import { Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Notice, PageHeader, Pager, Select, StatusBadge, TableWrap } from '../ui';
import { CustomerWithholdingCard } from '../compliance';
import { PayoutCard } from '../getting-paid';
import { AllocationsCard, } from './documents';
import { ApprovalTrail, Facts, ReasonDialog, useActions } from './shared';
import { ApprovalHistory } from '../workflow';
import { AttachmentsCard } from '../attachments';
import { useApplyOnce, useResetPage } from '@/modules/finance/ui/lib/hooks';

const amountPattern = /^\d*(\.\d*)?$/;
const methodLabel = (m: string) => PAYMENT_METHODS.find(([k]) => k === m)?.[1] ?? m;

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function PaymentList({ side }: { side: SideConfig }) {
  const router = useRouter();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useResetPage([status, debounced, entity?.id], setPage);

  const { data, isLoading, error } = useQuery({
    queryKey: ['payments', side.paymentKind, entity?.id, status, debounced, page],
    queryFn: () => api.get<Paged<Payment>>('/payments', { kind: side.paymentKind, entityId: entity!.id, status, search: debounced, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const statuses = side === SALES ? ['', 'POSTED', 'DRAFT', 'VOID'] : ['', 'DRAFT', 'SUBMITTED', 'POSTED', 'REJECTED', 'VOID'];

  return (
    <>
      <PageHeader
        title={side.payments}
        description={side === SALES ? 'Money received from customers, applied to their invoices.' : 'Supplier payments. Each payment is approved by a second person before release.'}
        actions={
          can(side.perms.manage) && (
            <>
              {side !== SALES && <LinkButton href="/finance/purchases/payment-run">Payment run</LinkButton>}
              <LinkButton variant="primary" href={`${side.paymentsPath}/new`}>
                New {side.payment.toLowerCase()}
              </LinkButton>
            </>
          )
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {statuses.map((st) => (
            <option key={st || 'all'} value={st}>
              {st ? st.charAt(0) + st.slice(1).toLowerCase() : 'All statuses'}
            </option>
          ))}
        </Select>
        <Input className="max-w-md" placeholder={`Search number, ${side.party.toLowerCase()} or reference`} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title={`No ${side.payments.toLowerCase()} found`} />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>{side.party}</th>
                <th>Account</th>
                <th>Reference</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">On account</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="cursor-pointer" onClick={() => router.push(`${side.paymentsPath}/${p.id}`)}>
                  <td className="whitespace-nowrap font-mono text-xs">
                    <Link href={`${side.paymentsPath}/${p.id}`} className="text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>
                      {p.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(p.date)}</td>
                  <td>{p.partyName}</td>
                  <td className="text-muted">{p.bankAccountName}</td>
                  <td className="text-muted">{p.reference}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="num">
                    {formatAmount(p.amount, precision(p.currency))} <span className="text-xs text-muted">{p.currency}</span>
                  </td>
                  <td className="num">{p.status === 'POSTED' ? formatAmount(p.unallocated, precision(p.currency), { blankZero: true }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------------------------

export function PaymentForm({ kind, existing }: { kind: PaymentKind; existing?: PaymentDetail }) {
  const side = sideOf(kind);
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: parties = [] } = useParties(side.partyType);
  const { data: banks = [] } = useBankAccounts(entity!.id);
  const { data: taxCodes = [] } = useTaxCodes();
  const receipt = kind === 'RECEIPT';

  const [form, setForm] = useState({
    partyId: existing?.partyId ?? params.get('party') ?? '',
    bankAccountId: existing?.bankAccountId ?? '',
    date: existing?.date.slice(0, 10) ?? today(),
    amount: existing?.amount ?? '',
    method: existing?.method ?? 'BANK_TRANSFER',
    reference: existing?.reference ?? '',
    description: existing?.description ?? '',
    exchangeRate: existing && existing.currency !== existing.functionalCurrency ? existing.exchangeRate : '',
    withholdingTaxCodeId: existing?.withholdingTaxCodeId ?? '',
    /** Receipts: taxes the customer withheld. */
    withholdingTaxCodeIds: existing?.withholdingTaxCodeIds ?? ([] as string[]),
  });
  const [alloc, setAlloc] = useState<Record<string, string>>(() =>
    Object.fromEntries((existing?.plannedAllocations ?? []).map((a) => [a.documentId, a.amount])),
  );
  const [error, setError] = useState<string | null>(null);
  const [touchedAmount, setTouchedAmount] = useState(!!existing);

  const party = parties.find((p) => p.id === form.partyId);
  const currency = party?.currency ?? entity!.functionalCurrency;
  const tp = precision(currency);
  const foreign = currency !== entity!.functionalCurrency;
  const usableBanks = banks.filter((b) => b.isActive && b.currency === currency);

  const openItems = useQuery({
    queryKey: ['open-items', side.partyType, form.partyId, entity!.id],
    queryFn: () => api.get<OpenItems>('/allocations/open-items', { partyType: side.partyType, partyId: form.partyId, entityId: entity!.id }),
    enabled: !!form.partyId,
  });
  const docs = useMemo(() => {
    const open = openItems.data?.documents ?? [];
    // A draft being edited keeps its planned documents visible even if they are now on this payment.
    return open;
  }, [openItems.data]);

  // Pre-select the document we came from, settling it in full.
  const docParam = params.get('doc');
  const preselect = !existing && docParam ? docs.find((x) => x.id === docParam) : undefined;
  useApplyOnce(preselect, (d) => setAlloc((a) => (a[d.id] ? a : { ...a, [d.id]: d.amountDue })));
  // The first usable account until the user picks one.
  if (!form.bankAccountId && usableBanks.length) setForm((f) => ({ ...f, bankAccountId: usableBanks[0].id }));

  const rateQuery = useQuery({
    queryKey: ['rate', currency, entity!.functionalCurrency, form.date],
    queryFn: () => api.get<{ rate: string }>('/exchange-rates/lookup', { from: currency, to: entity!.functionalCurrency, date: form.date }),
    enabled: foreign && /^\d{4}-\d{2}-\d{2}$/.test(form.date),
    retry: false,
  });

  // Only codes for this entity's jurisdiction (codes without a country apply anywhere).
  const whtCodes = taxCodes.filter((t) => t.kind === 'WITHHOLDING' && t.isActive && (!t.country || t.country.toLowerCase() === (entity!.country ?? '').toLowerCase()));
  const whtRate = rateOn(whtCodes.find((t) => t.id === form.withholdingTaxCodeId), form.date);
  const allocated = addAll(Object.values(alloc));
  // Withholding is calculated on the net (pre-VAT) share of each document being settled.
  const withheldAt = (rate: string) =>
    addAll(
      Object.entries(alloc).map(([id, a]) => {
        const d = docs.find((x) => x.id === id);
        if (!d || !a) return '0';
        const base = roundTo(divide(multiply(a, d.subtotal), d.total), tp);
        return roundTo(divide(multiply(base, rate), '100'), tp);
      }),
    );
  const customerWithheld = receipt ? form.withholdingTaxCodeIds.map((id) => ({ code: whtCodes.find((t) => t.id === id), amount: withheldAt(rateOn(whtCodes.find((t) => t.id === id), form.date)) })) : [];
  const withholding = receipt ? addAll(customerWithheld.map((w) => w.amount)) : form.withholdingTaxCodeId ? withheldAt(whtRate) : '0';
  const suggestedCash = fromUnits(toUnits(allocated) - toUnits(withholding));
  const amount = form.amount || (touchedAmount ? '' : suggestedCash);
  const onAccount = fromUnits(toUnits(amount || '0') + toUnits(withholding) - toUnits(allocated));
  const overAllocated = toUnits(onAccount) < BigInt(0);

  function pickParty(id: string) {
    const p = parties.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      partyId: id,
      bankAccountId: '',
      exchangeRate: '',
      withholdingTaxCodeId: !receipt ? (p?.withholdingTaxCodeId ?? '') : '',
      withholdingTaxCodeIds: receipt ? (p?.withholdingTaxCodeIds ?? []) : [],
    }));
    setAlloc({});
  }

  function autoAllocate() {
    let remaining = toUnits(amount || '0') + toUnits(withholding);
    const next: Record<string, string> = {};
    for (const d of docs) {
      if (remaining <= BigInt(0)) break;
      const due = toUnits(d.amountDue);
      const take = due < remaining ? due : remaining;
      next[d.id] = fromUnits(take);
      remaining -= take;
    }
    setAlloc(next);
  }

  const save = useMutation({
    mutationFn: async (mode: 'draft' | 'submit' | 'post') => {
      const body = {
        entityId: entity!.id,
        kind,
        partyId: form.partyId,
        date: form.date,
        bankAccountId: form.bankAccountId,
        method: form.method,
        reference: form.reference || undefined,
        description: form.description || undefined,
        amount: amount || '0',
        exchangeRate: foreign && form.exchangeRate ? form.exchangeRate : null,
        withholdingTaxCodeId: !receipt ? form.withholdingTaxCodeId || null : null,
        ...(receipt && { withholdingTaxCodeIds: form.withholdingTaxCodeIds }),
        allocations: Object.entries(alloc)
          .filter(([, a]) => a && !isZero(a))
          .map(([documentId, a]) => ({ documentId, amount: a })),
      };
      const saved = existing
        ? await api.patch<Payment>(`/payments/${existing.id}`, body)
        : await api.post<Payment>('/payments', { ...body, post: mode === 'post' });
      if (existing && mode === 'post') await api.post(`/payments/${saved.id}/approve`);
      if (mode === 'submit') await api.post(`/payments/${saved.id}/submit`);
      return saved;
    },
    onSuccess: (saved) => {
      for (const key of [['payments'], ['documents'], ['parties'], ['bank-accounts'], ['payment', saved.id]]) queryClient.invalidateQueries({ queryKey: key });
      router.push(`${side.paymentsPath}/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = (e: FormEvent, mode: 'draft' | 'submit' | 'post') => {
    e.preventDefault();
    setError(null);
    save.mutate(mode);
  };

  return (
    <form onSubmit={(e) => submit(e, receipt ? 'post' : 'draft')} className="space-y-4">
      <ErrorBanner error={error} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={side.party} className="md:col-span-2">
            <Select required value={form.partyId} onChange={(e) => pickParty(e.target.value)}>
              <option value="">Select {side.party.toLowerCase()}…</option>
              {parties.filter((p) => p.isActive).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code}) · {p.currency}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={receipt ? 'Received into' : 'Paid from'} hint={party && !usableBanks.length ? `No active ${currency} bank or cash account in this entity` : undefined}>
            <Select required value={form.bankAccountId} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}>
              {!usableBanks.length && <option value="">—</option>}
              {usableBanks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.currency})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label={`Amount ${receipt ? 'received' : 'paid'} (${currency})`} hint={!touchedAmount && !form.amount ? 'Calculated from the allocations below' : undefined}>
            <Input
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => {
                if (!amountPattern.test(e.target.value)) return;
                setTouchedAmount(true);
                setForm({ ...form, amount: e.target.value });
              }}
            />
          </Field>
          <Field label="Method">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {PAYMENT_METHODS.map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" hint="Cheque, transfer or M-Pesa reference">
            <Input maxLength={100} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
          {foreign ? (
            <Field label={`Rate (${currency}→${entity!.functionalCurrency})`} hint={rateQuery.data ? `Approved rate: ${rateQuery.data.rate}` : 'No approved rate; enter one'}>
              <Input inputMode="decimal" placeholder={rateQuery.data?.rate} value={form.exchangeRate} onChange={(e) => amountPattern.test(e.target.value) && setForm({ ...form, exchangeRate: e.target.value })} />
            </Field>
          ) : (
            <Field label="Description">
              <Input maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
          )}
          {receipt && !!whtCodes.length && (
            <Field label="Tax the customer withheld" hint="Government bodies and other withholding agents deduct these; they settle the invoice with the cash and are recovered with their certificate." className="md:col-span-2">
              <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1">
                {whtCodes.map((t) => (
                  <Checkbox
                    key={t.id}
                    label={`${t.code} · ${t.name} (${rateOn(t, form.date)}%)`}
                    checked={form.withholdingTaxCodeIds.includes(t.id)}
                    onChange={(on) => setForm({ ...form, withholdingTaxCodeIds: on ? [...form.withholdingTaxCodeIds, t.id] : form.withholdingTaxCodeIds.filter((x) => x !== t.id) })}
                  />
                ))}
              </div>
            </Field>
          )}
          {!receipt && (
            <Field label="Withholding tax" className="md:col-span-2">
              <Select value={form.withholdingTaxCodeId} onChange={(e) => setForm({ ...form, withholdingTaxCodeId: e.target.value })}>
                <option value="">None</option>
                {whtCodes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} · {t.name} ({rateOn(t, form.date)}%)
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </Card>

      <Card
        padded={false}
        title={`Apply to open ${side === SALES ? 'invoices' : 'bills'}`}
        actions={
          docs.length > 0 && (
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="ghost" onClick={autoAllocate} disabled={!amount}>
                Allocate oldest first
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAlloc({})}>
                Clear
              </Button>
            </div>
          )
        }
      >
        {!form.partyId ? (
          <p className="px-4 py-6 text-sm text-muted">Choose a {side.party.toLowerCase()} to see their open items.</p>
        ) : openItems.isLoading ? (
          <Loading />
        ) : !docs.length ? (
          <p className="px-4 py-6 text-sm text-muted">Nothing outstanding. The full amount is held on account and can be applied later.</p>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Number</th>
                <th>Date</th>
                <th>Due</th>
                <th>Reference</th>
                <th className="num">Outstanding</th>
                <th className="num w-40">Apply</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const value = alloc[d.id] ?? '';
                const over = value && compare(value, d.amountDue) > 0;
                return (
                  <tr key={d.id}>
                    <td>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-600"
                        checked={!!value && !isZero(value)}
                        onChange={(e) => setAlloc((a) => ({ ...a, [d.id]: e.target.checked ? d.amountDue : '' }))}
                        aria-label={`Settle ${d.number}`}
                      />
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">{d.number}</td>
                    <td className="whitespace-nowrap">{formatDate(d.date)}</td>
                    <td className={cx('whitespace-nowrap', d.dueDate.slice(0, 10) < today() && 'text-red-700')}>{formatDate(d.dueDate)}</td>
                    <td className="text-muted">{d.supplierInvoiceNumber || d.reference}</td>
                    <td className="num">{formatAmount(d.amountDue, tp)}</td>
                    <td>
                      <Input
                        className={cx('h-8 text-right text-xs tabular-nums', over && 'border-red-400')}
                        inputMode="decimal"
                        value={value}
                        onChange={(e) => amountPattern.test(e.target.value) && setAlloc((a) => ({ ...a, [d.id]: e.target.value }))}
                        aria-label={`Amount applied to ${d.number}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <dl className="grid gap-x-8 gap-y-1 border-t border-line px-4 py-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Applied</dt>
            <dd className="font-medium tabular-nums">{formatAmount(allocated, tp)}</dd>
          </div>
          {!receipt && (
            <div>
              <dt className="text-xs text-muted">Withholding tax ({whtRate}%)</dt>
              <dd className="font-medium tabular-nums">{formatAmount(withholding, tp)}</dd>
            </div>
          )}
          {receipt && !!customerWithheld.length && (
            <div>
              <dt className="text-xs text-muted">Withheld by customer ({customerWithheld.map((w) => w.code?.code).join(' + ')})</dt>
              <dd className="font-medium tabular-nums">{formatAmount(withholding, tp)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted">{receipt ? 'Received' : 'Cash paid'}</dt>
            <dd className="font-medium tabular-nums">{formatAmount(amount || '0', tp)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Left on account</dt>
            <dd className={cx('font-medium tabular-nums', overAllocated && 'text-red-700')}>{formatAmount(onAccount, tp, { parens: true })}</dd>
          </div>
        </dl>
      </Card>

      {overAllocated && <Notice tone="amber">More is applied than the {side.payment.toLowerCase()} covers. Increase the amount or reduce the allocations.</Notice>}

      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => router.back()}>Cancel</Button>
        {receipt ? (
          <>
            <Button type="button" loading={save.isPending && save.variables === 'draft'} onClick={(e) => submit(e, 'draft')}>
              Save draft
            </Button>
            <Button type="submit" variant="primary" disabled={overAllocated} loading={save.isPending && save.variables === 'post'}>
              Post receipt
            </Button>
          </>
        ) : (
          <>
            <Button type="submit" loading={save.isPending && save.variables === 'draft'}>
              Save draft
            </Button>
            <Button type="button" variant="primary" disabled={overAllocated} loading={save.isPending && save.variables === 'submit'} onClick={(e) => submit(e, 'submit')}>
              Save & submit for approval
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

/** Cheque signatories sign electronically; the cheque prints once enough have signed. */
function ChequeSigning({ paymentId }: { paymentId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['cheque-sign', paymentId], queryFn: () => api.get<{ required: number; signatures: { name: string; at: string }[]; complete: boolean; valid: boolean; canSign: boolean }>(`/payments/${paymentId}/cheque-signatures`) });
  const sign = useMutation({ mutationFn: () => api.post(`/payments/${paymentId}/cheque-sign`), onSuccess: () => qc.invalidateQueries({ queryKey: ['cheque-sign', paymentId] }) });
  if (!data) return null;
  return (
    <>
      {data.required > 0 && <span className="self-center text-xs text-gray-500" title={data.signatures.map((x) => `${x.name} ${formatDate(x.at)}`).join(', ')}>{data.signatures.length}/{data.required} signed{data.valid ? '' : ' (signatures do not match)'}</span>}
      {data.canSign && <Button loading={sign.isPending} onClick={() => sign.mutate()}>Sign cheque</Button>}
      {data.complete && data.valid && <Button onClick={() => window.open(`/api/v1/finance/payments/${paymentId}/cheque`, '_blank', 'noopener')}>Print cheque</Button>}
    </>
  );
}

export function PaymentView({ id }: { id: string }) {
  const router = useRouter();
  const { me, can } = useSession();
  const precision = usePrecision();
  const [dialog, setDialog] = useState<null | 'reject' | 'void' | 'delete'>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: p, isLoading, error: loadError } = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<PaymentDetail>(`/payments/${id}`) });
  const actions = useActions(`/payments/${id}`, [['payment', id], ['payments'], ['documents'], ['document'], ['parties'], ['bank-accounts']], setError);

  if (isLoading) return <Loading />;
  if (!p) return <ErrorBanner error={loadError ?? 'Not found'} />;

  const side = sideOf(p.kind);
  const receipt = p.kind === 'RECEIPT';
  const tp = precision(p.currency);
  const editable = (p.status === 'DRAFT' || p.status === 'REJECTED') && can(side.perms.manage);
  const canApprove = receipt ? can('ar.manage') : can('payments.approve');
  const preparedByMe = p.createdBy === me.id || p.submittedBy === me.id;
  const run = async (action: string, body?: object) => {
    await actions.run(action, body);
    setDialog(null);
  };

  return (
    <>
      <PageHeader
        title={`${side.payment} ${p.number}`}
        description={
          <span className="inline-flex items-center gap-2">
            <StatusBadge status={p.status} /> <span>{p.partyName}</span>
          </span>
        }
        actions={
          <>
            {receipt ? (
              <Button onClick={() => window.print()}>Print</Button>
            ) : (
              <>
                <Button onClick={() => window.open(`/api/v1/finance/payments/${p.id}/voucher`, '_blank', 'noopener')}>Payment voucher</Button>
                {p.status === 'POSTED' && p.method === 'CHEQUE' && <ChequeSigning paymentId={p.id} />}
                {p.status === 'POSTED' && can(side.perms.manage) && (
                  <Button loading={actions.busy('remittance')} onClick={() => run('remittance')} title={p.remittanceSentTo ? `Last sent to ${p.remittanceSentTo}` : 'Email the supplier what this payment settles'}>
                    {p.remittanceSentTo ? 'Resend remittance advice' : 'Send remittance advice'}
                  </Button>
                )}
              </>
            )}
            {editable && (
              <>
                <Button variant="danger" onClick={() => setDialog('delete')}>Delete</Button>
                <LinkButton href={`${side.paymentsPath}/${p.id}/edit`}>Edit</LinkButton>
                {receipt ? (
                  <Button variant="primary" loading={actions.busy('approve')} onClick={() => run('approve')}>Post receipt</Button>
                ) : (
                  <Button variant="primary" loading={actions.busy('submit')} onClick={() => run('submit')}>Submit for approval</Button>
                )}
              </>
            )}
            {p.status === 'SUBMITTED' && canApprove && (
              <>
                <Button onClick={() => setDialog('reject')}>Reject</Button>
                <Button variant="primary" disabled={preparedByMe} loading={actions.busy('approve')} onClick={() => run('approve')}>
                  Approve & release
                </Button>
              </>
            )}
            {p.status === 'POSTED' && canApprove && <Button onClick={() => setDialog('void')}>Void</Button>}
          </>
        }
      />
      <div className="space-y-4">
        <ErrorBanner error={error} />
        {p.status === 'SUBMITTED' && preparedByMe && canApprove && <Notice tone="amber">You prepared or submitted this payment, so another user must approve it.</Notice>}
        {p.status === 'REJECTED' && <Notice tone="amber">Rejected: {p.rejectionReason}</Notice>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <Facts
              items={[
                [side.party, <Link key="p" className="text-brand-700 hover:underline" href={`${side.partiesPath}/${p.partyId}`}>{p.partyName}</Link>],
                ['Date', formatDate(p.date)],
                [receipt ? 'Received into' : 'Paid from', p.bankAccount?.name],
                ['Method', methodLabel(p.method)],
                ['Reference', p.reference],
                [receipt ? 'Amount received' : 'Cash paid', `${formatAmount(p.amount, tp)} ${p.currency}`],
                ...(!isZero(p.withholdingAmount)
                  ? ([[receipt ? 'Withheld by customer' : 'Withholding tax', receipt ? `${formatAmount(p.withholdingAmount, tp)} (${(p.customerWithholdings ?? []).map((w) => w.taxCode).join(' + ')})` : `${formatAmount(p.withholdingAmount, tp)} (${p.withholdingTaxCode?.code ?? ''})`]] as [string, string][])
                  : []),
                ['Rate', p.currency === p.functionalCurrency ? '1' : p.exchangeRate],
                ['On account', p.status === 'POSTED' ? formatAmount(p.unallocated, tp) : '—'],
                ['Journal', p.journalId ? <Link key="j" className="text-brand-700 hover:underline" href={`/finance/journals/${p.journalId}`}>{p.journalNumber}</Link> : 'Not posted'],
              ]}
            />
          </Card>
          <ApprovalTrail record={p} approvedLabel={receipt ? 'Posted' : 'Approved & released'} />
        </div>
        {!receipt && p.status !== 'DRAFT' && p.method === 'MOBILE_MONEY' && <PayoutCard sourceId={p.id} />}
        {receipt && <CustomerWithholdingCard paymentId={p.id} currency={p.currency} withholdings={p.customerWithholdings ?? []} posted={p.status === 'POSTED'} />}
        {p.status !== 'POSTED' && p.status !== 'VOID' && p.plannedDocuments.length > 0 && (
          <Card title="Will settle" padded={false}>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Due</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Applying</th>
                </tr>
              </thead>
              <tbody>
                {p.plannedAllocations.map((a) => {
                  const d = p.plannedDocuments.find((x) => x.id === a.documentId);
                  return (
                    <tr key={a.documentId}>
                      <td className="whitespace-nowrap font-mono text-xs">
                        <Link className="text-brand-700 hover:underline" href={`${side.documentsPath}/${a.documentId}`}>{d?.number}</Link>
                        {d?.supplierInvoiceNumber && <span className="ml-2 font-sans text-muted">{d.supplierInvoiceNumber}</span>}
                      </td>
                      <td>{formatDate(d?.dueDate)}</td>
                      <td className="num">{formatAmount(d?.amountDue, tp)}</td>
                      <td className="num">{formatAmount(a.amount, tp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
        <AllocationsCard allocations={p.allocations} side={side} precision={tp} invalidate={[['payment', id]]} />
      </div>

      <ReasonDialog open={dialog === 'reject'} title={`Reject ${p.number}`} confirmLabel="Reject" busy={actions.busy('reject')} onClose={() => setDialog(null)} onConfirm={({ reason }) => run('reject', { reason })} />
      <ReasonDialog
        open={dialog === 'void'}
        title={`Void ${p.number}`}
        description="Allocations are reversed (reopening the documents), then the bank posting and any withholding tax are reversed on the void date."
        confirmLabel="Void"
        withDate
        minDate={p.date.slice(0, 10)}
        busy={actions.busy('void')}
        onClose={() => setDialog(null)}
        onConfirm={(v) => run('void', v)}
      />
      <ReasonDialog
        open={dialog === 'delete'}
        title={`Delete ${p.number}?`}
        confirmLabel="Delete draft"
        required={false}
        busy={actions.pending}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          try {
            await actions.remove();
            router.replace(side.paymentsPath);
          } catch {
            setDialog(null);
          }
        }}
      />
      {p.kind === 'PAYMENT' && <ApprovalHistory documentType="SUPPLIER_PAYMENT" documentId={p.id} />}
      <AttachmentsCard recordType="Payment" recordId={p.id} />
    </>
  );
}
