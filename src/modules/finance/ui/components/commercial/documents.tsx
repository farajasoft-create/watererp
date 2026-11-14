'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import {
  CommercialDocument,
  DocumentDetail,
  DocumentKind,
  KIND_LABEL,
  rateOn,
  SALES,
  SideConfig,
  sideOf,
} from '@/modules/finance/ui/lib/commercial';
import { useParties, useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { Item, useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { Lot, LotsButton, lotsBody } from '../lots';
import { EtimsBadge } from '../compliance';
import { BillEtimsNotice } from '../etims-purchases';
import { SalesDocumentActions } from '../getting-paid';
import { addAll, divide, formatAmount, formatDate, isZero, multiply, roundTo, today, toUnits, fromUnits } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { Paged } from '@/modules/finance/ui/lib/types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  Empty,
  ErrorBanner,
  Field,
  Input,
  LinkButton,
  Loading,
  Notice,
  PageHeader,
  Pager,
  Select,
  StatusBadge,
  TableWrap,
  Textarea,
} from '../ui';
import { AccountOptions, ApprovalTrail, Facts, ReasonDialog, useActions } from './shared';
import { ApprovalHistory } from '../workflow';
import { AttachmentsCard } from '../attachments';
import { AccountHint } from '../automation';
import { useApplyOnce, useResetPage } from '@/modules/finance/ui/lib/hooks';


const amountPattern = /^\d*(\.\d*)?$/;

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

const FILTERS = [
  ['', 'All'],
  ['DRAFT', 'Drafts'],
  ['SUBMITTED', 'Awaiting approval'],
  ['open', 'Open'],
  ['overdue', 'Overdue'],
  ['VOID', 'Void'],
] as const;

export function DocumentList({ side }: { side: SideConfig }) {
  const router = useRouter();
  const params = useSearchParams();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const filter = params.get('filter') ?? '';
  const kinds = params.get('kind') ?? `${side.documentKind},${side.creditKind}`;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useResetPage([filter, kinds, debounced, entity?.id], setPage);

  const { data, isLoading, error } = useQuery({
    queryKey: ['documents', side.partyType, entity?.id, filter, kinds, debounced, page],
    queryFn: () =>
      api.get<Paged<CommercialDocument>>('/invoices', {
        kind: kinds,
        entityId: entity!.id,
        status: ['DRAFT', 'SUBMITTED', 'VOID'].includes(filter) ? filter : undefined,
        open: filter === 'open' || undefined,
        overdue: filter === 'overdue' || undefined,
        search: debounced,
        page,
        pageSize: 25,
      }),
    placeholderData: keepPreviousData,
  });

  const nav = (patch: Record<string, string>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    router.replace(`${side.documentsPath}?${q.toString()}`);
  };
  const title = side === SALES ? 'Invoices & credit notes' : 'Bills & supplier credits';

  return (
    <>
      <PageHeader
        title={title}
        description={side === SALES ? 'Customer invoices are approved by a second person before they post to receivables.' : 'Supplier bills are matched to purchase orders and approved before they post to payables.'}
        actions={
          can(side.perms.manage) && (
            <>
              {side !== SALES && can('ai.use') && <LinkButton href={`${side.documentsPath}/capture`}>Capture with AI</LinkButton>}
              <LinkButton href={`${side.documentsPath}/new?kind=${side.creditKind}`}>New {KIND_LABEL[side.creditKind].toLowerCase()}</LinkButton>
              <LinkButton variant="primary" href={`${side.documentsPath}/new`}>
                New {KIND_LABEL[side.documentKind].toLowerCase()}
              </LinkButton>
            </>
          )
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {FILTERS.map(([value, label]) => (
          <button
            key={value || 'all'}
            onClick={() => nav({ filter: value })}
            className={cx(
              'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
              filter === value ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-muted ring-line hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
        <Select className="ml-auto h-8 w-48 text-xs" value={kinds} onChange={(e) => nav({ kind: e.target.value })} aria-label="Document type">
          <option value={`${side.documentKind},${side.creditKind}`}>All types</option>
          <option value={side.documentKind}>{KIND_LABEL[side.documentKind]}s</option>
          <option value={side.creditKind}>{KIND_LABEL[side.creditKind]}s</option>
        </Select>
      </div>
      <Input className="mb-3" placeholder={`Search number, ${side.party.toLowerCase()} or reference`} value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="Nothing here yet">Adjust the filters or create a new document.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>{side.party}</th>
                <th>Reference</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Due</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d) => {
                const p = precision(d.currency);
                const overdue = d.status === 'POSTED' && d.paymentStatus !== 'PAID' && d.dueDate.slice(0, 10) < today();
                const credit = d.kind === side.creditKind;
                return (
                  <tr key={d.id} className="cursor-pointer" onClick={() => router.push(`${side.documentsPath}/${d.id}`)}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      <Link href={`${side.documentsPath}/${d.id}`} className="text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>
                        {d.number}
                      </Link>
                      {credit && <span className="ml-1.5"><Badge tone="violet">Credit</Badge></span>}
                    </td>
                    <td className="whitespace-nowrap">{formatDate(d.date)}</td>
                    <td className="max-w-xs truncate">{d.partyName}</td>
                    <td className="text-muted">{d.supplierInvoiceNumber || d.reference}</td>
                    <td className={cx('whitespace-nowrap', overdue && 'font-medium text-red-700')}>{credit ? '' : formatDate(d.dueDate)}</td>
                    <td className="space-x-1 whitespace-nowrap">
                      <StatusBadge status={d.status} />
                      {d.status === 'POSTED' && <StatusBadge status={overdue ? 'OVERDUE' : d.paymentStatus} />}
                    </td>
                    <td className="num">
                      {formatAmount(d.total, p)} <span className="text-xs text-muted">{d.currency}</span>
                    </td>
                    <td className="num">{d.status === 'POSTED' ? formatAmount(d.amountDue, p, { blankZero: true }) : ''}</td>
                  </tr>
                );
              })}
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

interface LineState {
  key: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
  departmentId: string;
  costCentreId: string;
  projectId: string;
  poLineNo: number | null;
  itemId: string;
  warehouseId: string;
  lots: Lot[];
}

let nextKey = 1;
const blankLine = (patch: Partial<LineState> = {}): LineState => ({
  key: nextKey++,
  description: '',
  accountId: '',
  quantity: '1',
  unitPrice: '',
  discountPercent: '',
  taxCodeId: '',
  departmentId: '',
  costCentreId: '',
  projectId: '',
  poLineNo: null,
  itemId: '',
  warehouseId: '',
  lots: [],
  ...patch,
});

interface BillDraft {
  purchaseOrderId: string;
  number: string;
  supplierId: string;
  branchId: string;
  priceIncludesTax: boolean;
  lines: { poLineNo: number; description: string; accountId: string; quantity: string; unitPrice: string; taxCodeId: string | null; itemId?: string | null; warehouseId?: string | null; departmentId: string | null; costCentreId: string | null; projectId: string | null }[];
}

/** Line amounts as the server computes them (rounded to the currency's precision). */
function lineAmounts(l: LineState, rate: string, inclusive: boolean, places: number) {
  const gross = roundTo(divide(multiply(multiply(l.quantity || '0', l.unitPrice || '0'), fromUnits(toUnits('100') - toUnits(l.discountPercent || '0'))), '100'), places);
  if (inclusive) {
    const net = roundTo(divide(multiply(gross, '100'), addAll(['100', rate])), places);
    return { net, tax: fromUnits(toUnits(gross) - toUnits(net)) };
  }
  return { net: gross, tax: roundTo(divide(multiply(gross, rate), '100'), places) };
}

export function DocumentForm({ kind, existing }: { kind: DocumentKind; existing?: DocumentDetail }) {
  const side = sideOf(kind);
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: parties = [] } = useParties(side.partyType);
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const { data: dimensions = [] } = useDimensions();
  const { data: taxCodes = [] } = useTaxCodes();
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const credit = kind === side.creditKind;
  const poId = params.get('po');

  const [header, setHeader] = useState({
    partyId: existing?.partyId ?? params.get('party') ?? '',
    branchId: existing?.branchId ?? '',
    date: existing?.date.slice(0, 10) ?? today(),
    dueDate: existing?.dueDate.slice(0, 10) ?? '',
    reference: existing?.reference ?? '',
    supplierInvoiceNumber: existing?.supplierInvoiceNumber ?? '',
    exchangeRate: existing && existing.currency !== existing.functionalCurrency ? existing.exchangeRate : '',
    priceIncludesTax: existing?.priceIncludesTax ?? false,
    appliesToId: existing?.appliesToId ?? params.get('appliesTo') ?? '',
    purchaseOrderId: existing?.purchaseOrderId ?? '',
    notes: existing?.notes ?? '',
  });
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((l) =>
          blankLine({
            description: l.description,
            accountId: l.accountId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPercent: l.discountPercent ?? '',
            taxCodeId: l.taxCodeId ?? '',
            departmentId: l.departmentId ?? '',
            costCentreId: l.costCentreId ?? '',
            projectId: l.projectId ?? '',
            poLineNo: l.poLineNo,
            itemId: l.itemId ?? '',
            warehouseId: l.warehouseId ?? '',
            lots: l.lots ?? [],
          }),
        )
      : [blankLine()],
  );
  const [showDims, setShowDims] = useState(() => !!existing?.lines.some((l) => l.departmentId || l.costCentreId || l.projectId));
  const [error, setError] = useState<string | null>(null);

  // A bill raised from a purchase order starts with everything received but not yet billed.
  const draft = useQuery({ queryKey: ['bill-draft', poId], queryFn: () => api.get<BillDraft>(`/purchase-orders/${poId}/bill-draft`), enabled: !!poId && !existing });
  useApplyOnce(draft.data, (d) => {
    setHeader((h) => ({ ...h, partyId: d.supplierId, branchId: d.branchId, priceIncludesTax: d.priceIncludesTax, purchaseOrderId: d.purchaseOrderId }));
    setLines(
      d.lines.map((l) =>
        blankLine({
          description: l.description,
          accountId: l.accountId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxCodeId: l.taxCodeId ?? '',
          departmentId: l.departmentId ?? '',
          costCentreId: l.costCentreId ?? '',
          projectId: l.projectId ?? '',
          poLineNo: l.poLineNo,
          itemId: l.itemId ?? '',
          warehouseId: l.warehouseId ?? '',
        }),
      ),
    );
  });

  const party = parties.find((p) => p.id === header.partyId);
  const currency = party?.currency ?? entity!.functionalCurrency;
  const foreign = currency !== entity!.functionalCurrency;
  const tp = precision(currency);
  const branchId = header.branchId || branches[0]?.id || '';
  const vatCodes = taxCodes.filter((t) => t.kind === 'VAT' && t.isActive && (!t.country || !entity!.country || t.country.toLowerCase() === entity!.country.toLowerCase()));

  const rateQuery = useQuery({
    queryKey: ['rate', currency, entity!.functionalCurrency, header.date],
    queryFn: () => api.get<{ rate: string }>('/exchange-rates/lookup', { from: currency, to: entity!.functionalCurrency, date: header.date }),
    enabled: foreign && /^\d{4}-\d{2}-\d{2}$/.test(header.date),
    retry: false,
  });

  const appliesToOptions = useQuery({
    queryKey: ['open-documents', side.partyType, header.partyId],
    queryFn: () => api.get<Paged<CommercialDocument>>('/invoices', { kind: side.documentKind, partyId: header.partyId, status: 'POSTED', pageSize: 100 }),
    enabled: credit && !!header.partyId,
  });

  const computed = useMemo(
    () => lines.map((l) => lineAmounts(l, rateOn(taxCodes.find((t) => t.id === l.taxCodeId), header.date), header.priceIncludesTax, tp)),
    [lines, taxCodes, header.date, header.priceIncludesTax, tp],
  );
  const subtotal = addAll(computed.map((c) => c.net));
  const taxTotal = addAll(computed.map((c) => c.tax));
  const total = addAll([subtotal, taxTotal]);

  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const entityWarehouses = warehouses.filter((w) => w.entityId === entity!.id && w.isActive);
  const activeItems = items.filter((i) => i.isActive);
  /** The item's selling price in the document currency: its price list, or the default price in functional currency. */
  const priceIn = (item: Item) => {
    const docCurrency = parties.find((p) => p.id === header.partyId)?.currency ?? entity!.functionalCurrency;
    return item.prices?.find((p) => p.currency === docCurrency)?.price ?? (docCurrency === entity!.functionalCurrency ? item.salesPrice : null);
  };
  /** Picking an item fills in its description, accounts, tax and (on sales) price; stock items need a warehouse. */
  function pickItem(l: LineState, itemId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return update(l.key, { itemId: '', warehouseId: '', lots: [] });
    const purchase = side !== SALES;
    const account = purchase ? (item.type === 'STOCK' ? item.inventoryAccountId : item.purchaseAccountId) : item.salesAccountId;
    const taxCode = purchase ? item.purchaseTaxCodeId : item.salesTaxCodeId;
    const branchWarehouse = entityWarehouses.find((w) => w.branchId === header.branchId) ?? entityWarehouses[0];
    update(l.key, {
      itemId,
      description: l.description || item.name,
      accountId: account ?? l.accountId,
      taxCodeId: taxCode ?? l.taxCodeId,
      unitPrice: !purchase && !l.unitPrice ? (priceIn(item) ?? l.unitPrice) : l.unitPrice,
      warehouseId: item.type === 'STOCK' ? l.warehouseId || branchWarehouse?.id || '' : '',
      lots: [],
    });
  }

  function pickParty(id: string) {
    const p = parties.find((x) => x.id === id);
    setHeader((h) => ({ ...h, partyId: id, appliesToId: '', exchangeRate: '' }));
    if (p) {
      setLines((ls) =>
        ls.map((l) => ({ ...l, accountId: l.accountId || p.defaultAccountId || '', taxCodeId: l.taxCodeId || p.defaultTaxCodeId || '' })),
      );
    }
  }

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = {
        entityId: entity!.id,
        branchId,
        kind,
        partyId: header.partyId,
        date: header.date,
        dueDate: header.dueDate || null,
        reference: header.reference || undefined,
        supplierInvoiceNumber: header.supplierInvoiceNumber || undefined,
        purchaseOrderId: header.purchaseOrderId || null,
        appliesToId: header.appliesToId || null,
        exchangeRate: foreign && header.exchangeRate ? header.exchangeRate : null,
        priceIncludesTax: header.priceIncludesTax,
        notes: header.notes || undefined,
        lines: lines
          .filter((l) => l.description || l.unitPrice)
          .map((l) => ({
            description: l.description,
            accountId: l.accountId || null,
            quantity: l.quantity || '0',
            unitPrice: l.unitPrice || '0',
            discountPercent: l.discountPercent || null,
            taxCodeId: l.taxCodeId || null,
            departmentId: l.departmentId || null,
            costCentreId: l.costCentreId || null,
            projectId: l.projectId || null,
            poLineNo: l.poLineNo,
            itemId: l.itemId || null,
            warehouseId: l.itemId ? l.warehouseId || null : null,
            lots: l.itemId ? lotsBody(l.lots) : [],
          })),
      };
      const saved = existing ? await api.patch<CommercialDocument>(`/invoices/${existing.id}`, body) : await api.post<CommercialDocument>('/invoices', body);
      if (submit) await api.post(`/invoices/${saved.id}/submit`);
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['document', saved.id] });
      router.push(`${side.documentsPath}/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function onSubmit(e: FormEvent, submit: boolean) {
    e.preventDefault();
    setError(null);
    save.mutate(submit);
  }

  const dims = (type: string) => dimensions.filter((d) => d.type === type && d.isActive && (!d.entityId || d.entityId === entity!.id));
  const label = KIND_LABEL[kind].toLowerCase();

  return (
    <form onSubmit={(e) => onSubmit(e, false)} className="space-y-4">
      <ErrorBanner error={error} />
      {header.purchaseOrderId && (
        <Notice>
          Matched to purchase order {draft.data?.number ?? existing?.purchaseOrder?.number}. Quantities are checked against goods received and prices against the order when the bill is approved.
        </Notice>
      )}
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={side.party} className="md:col-span-2">
            <Select required value={header.partyId} onChange={(e) => pickParty(e.target.value)} disabled={!!header.purchaseOrderId}>
              <option value="">Select {side.party.toLowerCase()}…</option>
              {parties.filter((p) => p.isActive || p.id === header.partyId).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code}) · {p.currency}
                </option>
              ))}
            </Select>
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
          <Field label="Currency" hint={party ? `${party.name} trades in ${currency}` : undefined}>
            <Input disabled value={currency} />
          </Field>
          <Field label="Date">
            <Input type="date" required value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} />
          </Field>
          {!credit && (
            <Field label="Due date" hint={party ? `Default: ${party.paymentTermsDays} days` : undefined}>
              <Input type="date" value={header.dueDate} min={header.date} onChange={(e) => setHeader({ ...header, dueDate: e.target.value })} />
            </Field>
          )}
          {kind === 'PURCHASE_BILL' ? (
            <Field label="Supplier invoice number">
              <Input required maxLength={100} value={header.supplierInvoiceNumber} onChange={(e) => setHeader({ ...header, supplierInvoiceNumber: e.target.value })} />
            </Field>
          ) : (
            <Field label={side === SALES ? 'Customer reference / PO' : 'Reference'}>
              <Input maxLength={100} value={header.reference} onChange={(e) => setHeader({ ...header, reference: e.target.value })} />
            </Field>
          )}
          {foreign && (
            <Field label={`Rate (${currency}→${entity!.functionalCurrency})`} hint={rateQuery.data ? `Approved rate: ${rateQuery.data.rate}` : 'No approved rate; enter one'}>
              <Input inputMode="decimal" placeholder={rateQuery.data?.rate} value={header.exchangeRate} onChange={(e) => amountPattern.test(e.target.value) && setHeader({ ...header, exchangeRate: e.target.value })} />
            </Field>
          )}
          {credit && (
            <Field label={`Apply to ${side === SALES ? 'invoice' : 'bill'}`} className="md:col-span-2" hint="Optional: the credit settles this document when it is approved">
              <Select value={header.appliesToId} onChange={(e) => setHeader({ ...header, appliesToId: e.target.value })}>
                <option value="">Leave on account</option>
                {appliesToOptions.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.number} · {formatDate(d.date)} · due {formatAmount(d.amountDue, tp)} {d.currency}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex items-end md:col-span-2">
            <Checkbox label="Prices include tax" checked={header.priceIncludesTax} onChange={(v) => setHeader({ ...header, priceIncludesTax: v })} />
          </div>
        </div>
      </Card>

      <Card padded={false} title="Lines" actions={<Checkbox label="Dimensions" checked={showDims} onChange={setShowDims} />}>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="min-w-56">Description</th>
                <th className="min-w-56">Account</th>
                {showDims && (
                  <>
                    <th>Department</th>
                    <th>Cost centre</th>
                    <th>Project</th>
                  </>
                )}
                <th className="num min-w-20">Qty</th>
                <th className="num min-w-28">Unit price</th>
                <th className="num min-w-16">Disc %</th>
                <th className="min-w-32">Tax</th>
                <th className="num min-w-28">Net</th>
                <th className="num min-w-24">Tax</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>
                    {activeItems.length > 0 && (
                      <div className="mb-1 flex gap-1">
                        <Select className="h-7 text-[11px]" value={l.itemId} onChange={(e) => pickItem(l, e.target.value)} aria-label={`Line ${i + 1} item`}>
                          <option value="">No item</option>
                          {activeItems.map((it) => (
                            <option key={it.id} value={it.id}>{it.code} · {it.name}</option>
                          ))}
                        </Select>
                        {items.find((it) => it.id === l.itemId)?.type === 'STOCK' && (
                          <Select className="h-7 w-28 text-[11px]" value={l.warehouseId} onChange={(e) => update(l.key, { warehouseId: e.target.value, lots: [] })} aria-label={`Line ${i + 1} warehouse`}>
                            <option value="">Warehouse…</option>
                            {entityWarehouses.map((w) => (
                              <option key={w.id} value={w.id}>{w.code}</option>
                            ))}
                          </Select>
                        )}
                      </div>
                    )}
                    {!(kind === 'PURCHASE_BILL' && l.poLineNo != null) && (
                      <div className="mb-1">
                        <LotsButton
                          item={items.find((it) => it.id === l.itemId)}
                          warehouseId={l.warehouseId}
                          quantity={l.quantity}
                          inward={kind === 'PURCHASE_BILL' || kind === 'SALES_CREDIT'}
                          value={l.lots}
                          onChange={(lots) => update(l.key, { lots })}
                        />
                      </div>
                    )}
                    <Input className="h-8 text-xs" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Line ${i + 1} description`} />
                    {l.poLineNo && <span className="text-[11px] text-muted">PO line {l.poLineNo}</span>}
                  </td>
                  <td>
                    <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
                      <AccountOptions accounts={accounts} classes={side.accountClasses} placeholder={party?.defaultAccountId ? 'Default account' : 'Select account…'} />
                    </Select>
                    {!l.accountId && (header.partyId || l.description) && (
                      <AccountHint side={side === SALES ? 'sales' : 'purchase'} partyId={header.partyId} description={l.description} onPick={(accountId) => update(l.key, { accountId })} />
                    )}
                  </td>
                  {showDims &&
                    (
                      [
                        ['departmentId', 'DEPARTMENT'],
                        ['costCentreId', 'COST_CENTRE'],
                        ['projectId', 'PROJECT'],
                      ] as const
                    ).map(([field, type]) => (
                      <td key={field}>
                        <Select className="h-8 text-xs" value={l[field]} onChange={(e) => update(l.key, { [field]: e.target.value })} aria-label={type}>
                          <option value="">—</option>
                          {dims(type).map((d) => (
                            <option key={d.id} value={d.id}>{d.code}</option>
                          ))}
                        </Select>
                      </td>
                    ))}
                  <td>
                    <Input className="h-8 text-right text-xs tabular-nums" inputMode="decimal" value={l.quantity} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { quantity: e.target.value })} aria-label="Quantity" />
                  </td>
                  <td>
                    <Input className="h-8 text-right text-xs tabular-nums" inputMode="decimal" value={l.unitPrice} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { unitPrice: e.target.value })} aria-label="Unit price" />
                  </td>
                  <td>
                    <Input className="h-8 text-right text-xs tabular-nums" inputMode="decimal" value={l.discountPercent} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { discountPercent: e.target.value })} aria-label="Discount percent" />
                  </td>
                  <td>
                    <Select className="h-8 text-xs" value={l.taxCodeId} onChange={(e) => update(l.key, { taxCodeId: e.target.value })} aria-label="Tax code">
                      <option value="">No tax</option>
                      {vatCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.code} ({rateOn(t, header.date)}%)
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="num text-xs">{formatAmount(computed[i].net, tp)}</td>
                  <td className="num text-xs text-muted">{formatAmount(computed[i].tax, tp, { blankZero: true })}</td>
                  <td>
                    <button
                      type="button"
                      className="rounded p-1 text-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                      disabled={lines.length <= 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      aria-label={`Remove line ${i + 1}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4 border-t border-line px-4 py-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setLines((ls) => [...ls, blankLine({ accountId: party?.defaultAccountId ?? '', taxCodeId: party?.defaultTaxCodeId ?? '' })])}
          >
            + Add line
          </Button>
          <dl className="min-w-64 space-y-1 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular-nums">{formatAmount(subtotal, tp)}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Tax</dt>
              <dd className="tabular-nums">{formatAmount(taxTotal, tp)}</dd>
            </div>
            <div className="flex justify-between gap-6 border-t border-line pt-1 font-semibold">
              <dt>Total {currency}</dt>
              <dd className="tabular-nums">{formatAmount(total, tp)}</dd>
            </div>
            {foreign && (header.exchangeRate || rateQuery.data) && (
              <div className="flex justify-between gap-6 text-xs text-muted">
                <dt>≈ {entity!.functionalCurrency}</dt>
                <dd className="tabular-nums">{formatAmount(multiply(total, header.exchangeRate || rateQuery.data!.rate), precision(entity!.functionalCurrency))}</dd>
              </div>
            )}
          </dl>
        </div>
      </Card>

      <Card>
        <Field label={side === SALES ? 'Notes shown on the document' : 'Internal notes'}>
          <Textarea rows={2} maxLength={2000} value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
        </Field>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending && !save.variables}>
          Save draft
        </Button>
        <Button type="button" variant="primary" loading={save.isPending && save.variables === true} onClick={(e) => onSubmit(e, true)}>
          Save & submit
        </Button>
      </div>
      <p className="text-right text-xs text-muted">Totals are a preview; the server recalculates every line when the {label} is saved.</p>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

type Dialog = null | 'reject' | 'void' | 'delete' | 'override';

export function DocumentView({ id }: { id: string }) {
  const router = useRouter();
  const { me, can } = useSession();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts();
  const { data: branches = [] } = useBranches();
  const { data: taxCodes = [] } = useTaxCodes();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: d, isLoading, error: loadError } = useQuery({ queryKey: ['document', id], queryFn: () => api.get<DocumentDetail>(`/invoices/${id}`) });
  const actions = useActions(`/invoices/${id}`, [['document', id], ['documents'], ['parties'], ['dashboard']], setError);

  if (isLoading) return <Loading />;
  if (!d) return <ErrorBanner error={loadError ?? 'Not found'} />;

  const side = sideOf(d.kind);
  const p = precision(d.currency);
  const fp = precision(d.functionalCurrency);
  const credit = d.kind === side.creditKind;
  const label = KIND_LABEL[d.kind];
  const editable = (d.status === 'DRAFT' || d.status === 'REJECTED') && can(side.perms.manage);
  const preparedByMe = d.createdBy === me.id || d.submittedBy === me.id;
  const open = d.status === 'POSTED' && d.paymentStatus !== 'PAID';
  const branch = branches.find((b) => b.id === d.branchId);
  const account = (aid: string) => accounts.find((a) => a.id === aid);
  const tax = (tid: string | null) => taxCodes.find((t) => t.id === tid);
  const run = async (action: string, body?: object) => {
    await actions.run(action, body);
    setDialog(null);
  };
  const matchIssues = d.matchPreview ?? (d.matchStatus === 'OVERRIDDEN' ? d.matchNotes : []);

  return (
    <>
      <PageHeader
        title={`${label} ${d.number}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {d.status === 'POSTED' && <StatusBadge status={d.paymentStatus} />}
            {d.etims && <EtimsBadge status={d.etims.status} />}
            {d.matchStatus !== 'NOT_REQUIRED' && <StatusBadge status={d.matchStatus} />}
            <span>{d.partyName}</span>
          </span>
        }
        actions={
          <>
            {side === SALES ? (
              <SalesDocumentActions d={d} onChanged={() => queryClient.invalidateQueries({ queryKey: ['document', id] })} />
            ) : (
              <Button onClick={() => window.print()}>Print</Button>
            )}
            {editable && (
              <>
                <Button variant="danger" onClick={() => setDialog('delete')}>Delete</Button>
                <LinkButton href={`${side.documentsPath}/${d.id}/edit`}>Edit</LinkButton>
                <Button variant="primary" loading={actions.busy('submit')} onClick={() => run('submit')}>Submit for approval</Button>
              </>
            )}
            {d.status === 'SUBMITTED' && can(side.perms.approve) && (
              <>
                <Button onClick={() => setDialog('reject')}>Reject</Button>
                <Button variant="primary" disabled={preparedByMe} loading={actions.busy('approve')} onClick={() => run('approve', {})}>
                  Approve & post
                </Button>
                {d.purchaseOrderId && !!matchIssues.length && can('ap.match_override') && (
                  <Button disabled={preparedByMe} onClick={() => setDialog('override')}>Approve with override</Button>
                )}
              </>
            )}
            {open && !credit && can(side.perms.manage) && (
              <LinkButton variant="primary" href={`${side.paymentsPath}/new?party=${d.partyId}&doc=${d.id}`}>
                Record {side.payment.toLowerCase()}
              </LinkButton>
            )}
            {d.status === 'POSTED' && !credit && can(side.perms.manage) && (
              <LinkButton href={`${side.documentsPath}/new?kind=${side.creditKind}&party=${d.partyId}&appliesTo=${d.id}`}>Credit note</LinkButton>
            )}
            {d.status === 'POSTED' && can(side.perms.approve) && <Button onClick={() => setDialog('void')}>Void</Button>}
          </>
        }
      />

      <div className="space-y-4">
        <ErrorBanner error={error} />
        {d.status === 'SUBMITTED' && preparedByMe && can(side.perms.approve) && (
          <Notice tone="amber">You prepared or submitted this {label.toLowerCase()}, so another user must approve it (segregation of duties).</Notice>
        )}
        {d.status === 'REJECTED' && <Notice tone="amber">Rejected: {d.rejectionReason}</Notice>}
        {!!matchIssues.length && (
          <Notice tone="amber">
            <p className="font-medium">{d.matchStatus === 'OVERRIDDEN' ? 'Approved with a match override:' : `Purchase-order match issues (${d.purchaseOrder?.number}):`}</p>
            <ul className="mt-1 list-disc pl-5">
              {matchIssues.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Notice>
        )}
        {d.party?.onHold && side === SALES && <Notice tone="amber">{d.party.name} is on credit hold.</Notice>}
        {d.kind === 'PURCHASE_BILL' && can('ap.view') && <BillEtimsNotice billId={d.id} />}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <Facts
              items={[
                [side.party, d.party ? <Link key="p" className="text-brand-700 hover:underline" href={`${side.partiesPath}/${d.partyId}`}>{d.partyName}</Link> : d.partyName],
                ['Date', formatDate(d.date)],
                [credit ? 'Applies to' : 'Due', credit ? (d.appliesToNumber ? <Link key="a" className="text-brand-700 hover:underline" href={`${side.documentsPath}/${d.appliesToId}`}>{d.appliesToNumber}</Link> : 'On account') : formatDate(d.dueDate)],
                ['Branch', branch ? `${branch.code} · ${branch.name}` : ''],
                [d.kind === 'PURCHASE_BILL' ? 'Supplier invoice' : 'Reference', d.supplierInvoiceNumber || d.reference],
                ['Currency', d.currency === d.functionalCurrency ? d.currency : `${d.currency} @ ${d.exchangeRate}`],
                ['Purchase order', d.purchaseOrder ? <Link key="po" className="text-brand-700 hover:underline" href={`/finance/purchases/orders/${d.purchaseOrder.id}`}>{d.purchaseOrder.number}</Link> : ''],
                ['Journal', d.journalId ? <Link key="j" className="text-brand-700 hover:underline" href={`/finance/journals/${d.journalId}`}>{d.journalNumber}</Link> : 'Not posted'],
              ]}
            />
          </Card>
          <ApprovalTrail record={d} />
        </div>

        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>Description</th>
                <th>Account</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Disc</th>
                <th>Tax</th>
                <th className="num">Net</th>
                <th className="num">Tax</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="text-xs text-muted">{l.lineNo}</td>
                  <td>
                    {l.description}
                    {l.poLineNo && <span className="ml-1 text-xs text-muted">(PO line {l.poLineNo})</span>}
                    {l.costOfSales && <span className="ml-1 text-xs text-muted">· cost of sales {formatAmount(l.costOfSales, p)}</span>}
                    {!!l.lots?.length && <div className="font-mono text-[11px] text-muted">{l.lots.map((x) => (x.quantity === '1' ? x.number : `${x.number} × ${x.quantity}`)).join(', ')}</div>}
                  </td>
                  <td className="text-xs">
                    <span className="font-mono">{account(l.accountId)?.code}</span> {account(l.accountId)?.name}
                  </td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{formatAmount(l.unitPrice, Math.max(p, (l.unitPrice.split('.')[1] ?? '').length))}</td>
                  <td className="num text-muted">{l.discountPercent ? `${l.discountPercent}%` : ''}</td>
                  <td className="text-xs text-muted">{l.taxCodeId ? `${tax(l.taxCodeId)?.code ?? ''} ${l.taxRate}%` : '—'}</td>
                  <td className="num">{formatAmount(l.netAmount, p)}</td>
                  <td className="num">{formatAmount(l.taxAmount, p, { blankZero: true })}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="text-right">Subtotal / tax</td>
                <td className="num">{formatAmount(d.subtotal, p)}</td>
                <td className="num">{formatAmount(d.taxTotal, p)}</td>
              </tr>
              <tr>
                <td colSpan={7} className="text-right">Total {d.currency}</td>
                <td colSpan={2} className="num text-base">{formatAmount(d.total, p)}</td>
              </tr>
              {d.status === 'POSTED' && (
                <tr>
                  <td colSpan={7} className="text-right">Amount due {d.currency !== d.functionalCurrency && <span className="font-normal text-muted">(carrying {formatAmount(d.amountDueFunctional, fp)} {d.functionalCurrency})</span>}</td>
                  <td colSpan={2} className="num text-base">{formatAmount(d.amountDue, p)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </TableWrap>

        {d.notes && <Card title="Notes"><p className="whitespace-pre-wrap text-sm">{d.notes}</p></Card>}
        <ApprovalHistory documentType={d.kind} documentId={d.id} />
        <AttachmentsCard recordType="Invoice" recordId={d.id} />
        <AllocationsCard allocations={d.allocations} documentId={d.id} side={side} precision={p} invalidate={[['document', id], ['documents']]} />
        {!!d.creditNotes.length && (
          <Card title="Credit notes raised against this document">
            <ul className="space-y-1 text-sm">
              {d.creditNotes.map((c) => (
                <li key={c.id}>
                  <Link className="text-brand-700 hover:underline" href={`${side.documentsPath}/${c.id}`}>{c.number}</Link> <StatusBadge status={c.status} /> {formatAmount(c.total, p)}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <ReasonDialog open={dialog === 'reject'} title={`Reject ${d.number}`} confirmLabel="Reject" busy={actions.busy('reject')} onClose={() => setDialog(null)} onConfirm={({ reason }) => run('reject', { reason })} />
      <ReasonDialog
        open={dialog === 'void'}
        title={`Void ${d.number}`}
        description="The posting is reversed with a new journal and tax is reversed on the void date. Allocations must be reversed first."
        confirmLabel="Void"
        withDate
        minDate={d.date.slice(0, 10)}
        busy={actions.busy('void')}
        onClose={() => setDialog(null)}
        onConfirm={(v) => run('void', v)}
      />
      <ReasonDialog
        open={dialog === 'override'}
        title={`Approve ${d.number} with override`}
        description="The bill does not match the purchase order or goods received. Your reason is recorded in the audit trail."
        confirmLabel="Approve & post"
        busy={actions.busy('approve')}
        onClose={() => setDialog(null)}
        onConfirm={({ reason }) => run('approve', { overrideMatch: true, comment: reason })}
      />
      <ReasonDialog
        open={dialog === 'delete'}
        title={`Delete ${d.number}?`}
        description="The draft is removed; the deletion is recorded in the audit trail."
        confirmLabel="Delete draft"
        required={false}
        busy={actions.pending}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          try {
            await actions.remove();
            router.replace(side.documentsPath);
          } catch {
            setDialog(null);
          }
        }}
      />
    </>
  );
}

/** Settlements of a document or by a payment/credit, with reversal. */
export function AllocationsCard({
  allocations,
  side,
  precision,
  invalidate,
  documentId,
}: {
  allocations: DocumentDetail['allocations'];
  side: SideConfig;
  precision: number;
  invalidate: unknown[][];
  documentId?: string;
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const reverse = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) => api.post(`/allocations/${id}/reverse`, { date }),
    onSuccess: () => {
      setReversing(null);
      setError(null);
      for (const key of [...invalidate, ['parties'], ['payment'], ['document']]) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  if (!allocations.length) return null;
  return (
    <Card title="Settlements" padded={false}>
      <ErrorBanner error={error} className="m-3" />
      <table className="table-base">
        <thead>
          <tr>
            <th>Date</th>
            <th>{documentId ? 'Settled by' : 'Settles'}</th>
            <th>Status</th>
            <th className="num">Amount</th>
            <th className="num">Realised FX</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {allocations.map((a) => {
            const otherIsDoc = !documentId || a.documentId !== documentId;
            const href = otherIsDoc ? `${side.documentsPath}/${a.documentId}` : a.sourceType === 'PAYMENT' ? `${side.paymentsPath}/${a.sourceId}` : `${side.documentsPath}/${a.sourceId}`;
            return (
              <tr key={a.id} className={a.status === 'REVERSED' ? 'opacity-50' : ''}>
                <td className="whitespace-nowrap">{formatDate(a.date)}</td>
                <td className="whitespace-nowrap font-mono text-xs">
                  <Link className="text-brand-700 hover:underline" href={href}>{otherIsDoc ? a.documentNumber : a.sourceNumber}</Link>
                </td>
                <td><StatusBadge status={a.status} /></td>
                <td className="num">{formatAmount(a.amount, precision)} <span className="text-xs text-muted">{a.currency}</span></td>
                <td className={cx('num', !isZero(a.fxAmount) && (a.fxAmount.startsWith('-') ? 'text-red-700' : 'text-emerald-700'))}>
                  {isZero(a.fxAmount) ? '' : formatAmount(a.fxAmount, 2, { parens: true })}
                </td>
                <td className="text-right">
                  {a.status === 'ACTIVE' && can(side.perms.manage) && (
                    <Button size="sm" variant="ghost" loading={reverse.isPending && reversing === a.id} onClick={() => (setReversing(a.id), reverse.mutate({ id: a.id, date: today() }))}>
                      Reverse
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

