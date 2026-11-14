'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useBankAccounts, useParties, useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { Item, useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { addAll, formatAmount, formatDate, isZero, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useCurrencies, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { FiscalYear } from '@/modules/finance/ui/lib/types';
import { AccountOptions } from './commercial/shared';
import { downloadCsv, ReportTitle } from './report-filters';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from './ui';
import { ApprovalHistory } from './workflow';
import { AttachmentsCard } from './attachments';
import { AssetCare, AssetCareCards } from './asset-care';
import { Lot, LotsButton, LotsTab, lotsBody } from './lots';

const amountPattern = /^-?\d*(\.\d*)?$/;
const positive = /^\d*(\.\d*)?$/;

function useInvalidate() {
  const queryClient = useQueryClient();
  return (...keys: string[]) => keys.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
}

// ---------------------------------------------------------------------------------------------
// Items & warehouses
// ---------------------------------------------------------------------------------------------

function ItemEditor({ item, onClose }: { item: Item | 'new'; onClose: () => void }) {
  const invalidate = useInvalidate();
  const { data: accounts = [] } = useAccounts();
  const { data: taxCodes = [] } = useTaxCodes();
  const existing = item === 'new' ? null : item;
  const byCode = (code: string) => accounts.find((a) => a.code === code)?.id ?? '';
  const [f, setF] = useState(() => ({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    type: existing?.type ?? ('STOCK' as Item['type']),
    category: existing?.category ?? '',
    unit: existing?.unit ?? 'each',
    inventoryAccountId: existing?.inventoryAccountId ?? byCode('1300'),
    cogsAccountId: existing?.cogsAccountId ?? byCode('5100'),
    salesAccountId: existing?.salesAccountId ?? byCode('4100'),
    purchaseAccountId: existing?.purchaseAccountId ?? '',
    salesTaxCodeId: existing?.salesTaxCodeId ?? '',
    etimsClassCode: existing?.etimsClassCode ?? '',
    purchaseTaxCodeId: existing?.purchaseTaxCodeId ?? '',
    salesPrice: existing?.salesPrice ?? '',
    reorderLevel: existing?.reorderLevel ?? '',
    reorderQty: existing?.reorderQty ?? '',
    valuation: existing?.valuation ?? 'AVERAGE',
    categoryId: existing?.categoryId ?? '',
    barcode: existing?.barcode ?? '',
    tracking: existing?.tracking ?? 'NONE',
    trackExpiry: existing?.trackExpiry ?? false,
    prices: existing?.prices ?? ([] as { currency: string; price: string }[]),
    isActive: existing?.isActive ?? true,
  }));
  const { data: currencies = [] } = useCurrencies();
  const { data: categories = [] } = useQuery({ queryKey: ['item-categories'], queryFn: () => api.get<{ id: string; path: string }[]>('/item-categories') });
  const { entity } = useSession();
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const stock = f.type === 'STOCK';
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        inventoryAccountId: stock ? f.inventoryAccountId || null : null,
        cogsAccountId: stock ? f.cogsAccountId || null : null,
        salesAccountId: f.salesAccountId || null,
        purchaseAccountId: !stock ? f.purchaseAccountId || null : null,
        salesTaxCodeId: f.salesTaxCodeId || null,
        etimsClassCode: f.etimsClassCode,
        purchaseTaxCodeId: f.purchaseTaxCodeId || null,
        salesPrice: f.salesPrice || null,
        reorderLevel: stock ? f.reorderLevel || null : null,
        reorderQty: stock ? f.reorderQty || null : null,
        valuation: stock ? f.valuation : undefined,
        categoryId: f.categoryId || null,
        category: f.categoryId ? undefined : f.category,
        barcode: f.barcode || null,
        tracking: stock ? f.tracking : 'NONE',
        trackExpiry: stock && f.tracking === 'BATCH' && f.trackExpiry,
        prices: f.prices.filter((p) => p.currency && p.price),
      };
      return existing ? api.patch(`/items/${existing.id}`, body) : api.post('/items', body);
    },
    onSuccess: () => (invalidate('items', 'stock'), onClose()),
    onError: (err) => setError(errorMessage(err)),
  });
  const vat = taxCodes.filter((t) => t.kind === 'VAT');
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.code}` : 'New item'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code">
            <Input value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Name" className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Type" hint={stock ? 'Tracked in warehouses at weighted average cost' : 'Not tracked in stock'}>
            <Select value={f.type} disabled={!!existing} onChange={(e) => set({ type: e.target.value as Item['type'] })}>
              <option value="STOCK">Stock item</option>
              <option value="NON_STOCK">Non-stock item</option>
              <option value="SERVICE">Service</option>
            </Select>
          </Field>
          <Field label="Category" hint={categories.length ? undefined : 'Set up the category tree on the stock dashboard'}>
            {categories.length ? (
              <Select value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </Select>
            ) : (
              <Input value={f.category} onChange={(e) => set({ category: e.target.value })} />
            )}
          </Field>
          <Field label="Barcode">
            <Input value={f.barcode} onChange={(e) => set({ barcode: e.target.value })} placeholder="Scan or type" />
          </Field>
          <Field label="Unit">
            <Input value={f.unit} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
          {stock ? (
            <>
              <Field label="Inventory account">
                <Select value={f.inventoryAccountId} onChange={(e) => set({ inventoryAccountId: e.target.value })}>
                  <AccountOptions accounts={accounts.filter((a) => a.accountClass === 'ASSET')} />
                </Select>
              </Field>
              <Field label="Cost of sales account">
                <Select value={f.cogsAccountId} onChange={(e) => set({ cogsAccountId: e.target.value })}>
                  <AccountOptions accounts={accounts.filter((a) => ['COST_OF_SALES', 'EXPENSE'].includes(a.accountClass))} />
                </Select>
              </Field>
              <Field label="Reorder level">
                <Input inputMode="decimal" value={f.reorderLevel} onChange={(e) => positive.test(e.target.value) && set({ reorderLevel: e.target.value })} />
              </Field>
              <Field label="Costing" hint="Change only with no stock on hand">
                <Select value={f.valuation} onChange={(e) => set({ valuation: e.target.value as 'AVERAGE' | 'FIFO' | 'LIFO' })}>
                  <option value="AVERAGE">Weighted average</option>
                  <option value="FIFO">First in, first out (FIFO)</option>
                  <option value="LIFO">Last in, first out (LIFO)</option>
                </Select>
              </Field>
              <Field label="Re-order quantity" hint="Blank: back up to twice the level">
                <Input inputMode="decimal" value={f.reorderQty} onChange={(e) => positive.test(e.target.value) && set({ reorderQty: e.target.value })} />
              </Field>
              <Field label="Tracking" hint="Batches or serial numbers are recorded on every receipt and issue; change only with no stock on hand">
                <Select value={f.tracking} onChange={(e) => set({ tracking: e.target.value as 'NONE' | 'BATCH' | 'SERIAL' })}>
                  <option value="NONE">Quantity only</option>
                  <option value="BATCH">By batch</option>
                  <option value="SERIAL">By serial number</option>
                </Select>
              </Field>
              <div className="flex items-end sm:col-span-2">
                {f.tracking === 'BATCH' && <Checkbox label="Batches have expiry dates (issue the first to expire first)" checked={f.trackExpiry} onChange={(v) => set({ trackExpiry: v })} />}
              </div>
            </>
          ) : (
            <Field label="Purchase account" className="sm:col-span-3">
              <Select value={f.purchaseAccountId} onChange={(e) => set({ purchaseAccountId: e.target.value })}>
                <AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES']} placeholder="None" />
              </Select>
            </Field>
          )}
          <Field label="Sales account">
            <Select value={f.salesAccountId} onChange={(e) => set({ salesAccountId: e.target.value })}>
              <AccountOptions accounts={accounts.filter((a) => a.accountClass === 'REVENUE')} placeholder="None" />
            </Select>
          </Field>
          <Field label="Sales tax">
            <Select value={f.salesTaxCodeId} onChange={(e) => set({ salesTaxCodeId: e.target.value })}>
              <option value="">None</option>
              {vat.map((t) => (
                <option key={t.id} value={t.id}>{t.code}</option>
              ))}
            </Select>
          </Field>
          <Field label="Purchase tax">
            <Select value={f.purchaseTaxCodeId} onChange={(e) => set({ purchaseTaxCodeId: e.target.value })}>
              <option value="">None</option>
              {vat.map((t) => (
                <option key={t.id} value={t.id}>{t.code}</option>
              ))}
            </Select>
          </Field>
          <Field label="Default selling price">
            <Input inputMode="decimal" value={f.salesPrice} onChange={(e) => positive.test(e.target.value) && set({ salesPrice: e.target.value })} />
          </Field>
          <Field label="Prices in other currencies" className="sm:col-span-2" hint="Invoices in these currencies default to these prices">
            <div className="space-y-1">
              {f.prices.map((p, i) => (
                <div key={i} className="flex gap-1">
                  <Select className="h-8 w-28 text-xs" value={p.currency} onChange={(e) => set({ prices: f.prices.map((x, j) => (j === i ? { ...x, currency: e.target.value } : x)) })} aria-label="Price currency">
                    <option value="">Currency…</option>
                    {currencies.filter((c) => c.code !== entity?.functionalCurrency).map((c) => (
                      <option key={c.code} value={c.code}>{c.code}</option>
                    ))}
                  </Select>
                  <Input className="h-8 text-xs" inputMode="decimal" value={p.price} onChange={(e) => positive.test(e.target.value) && set({ prices: f.prices.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} aria-label="Price" />
                  <Button size="sm" variant="ghost" onClick={() => set({ prices: f.prices.filter((_, j) => j !== i) })} aria-label="Remove price">✕</Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => set({ prices: [...f.prices, { currency: '', price: '' }] })}>+ Add currency price</Button>
            </div>
          </Field>
          <Field label="KRA item classification" hint="For eTIMS branches; blank uses the branch default">
            <Input inputMode="numeric" value={f.etimsClassCode} onChange={(e) => set({ etimsClassCode: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
          </Field>
          <Field label="Description" className="sm:col-span-3">
            <Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
        {existing && <Checkbox label="Active" checked={f.isActive} onChange={(v) => set({ isActive: v })} />}
      </div>
    </Modal>
  );
}

interface OnHand {
  currency: string;
  warehouses: { id: string; code: string; name: string }[];
  rows: { itemId: string; code: string; name: string; unit: string; category: string; warehouses: { warehouseId: string; code: string; quantity: string; value: string }[]; quantity: string; value: string; averageCost: string; belowReorder: boolean; lastReceiptDate: string | null }[];
  total: string;
  ledger: string;
  difference: string;
  presentation: { currency: string; rate: string; total: string; rows: { itemId: string; value: string }[] } | null;
}

export function InventoryPage() {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const [tab, setTab] = useState<'stock' | 'lots' | 'items' | 'warehouses'>('stock');
  const [shownIn, setShownIn] = useState('');
  const { data: currencies = [] } = useCurrencies();
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [addingWh, setAddingWh] = useState(false);
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const { data: branches = [] } = useBranches(entity?.id);
  const onHand = useQuery({ queryKey: ['stock', entity?.id, shownIn], queryFn: () => api.get<OnHand>('/stock', { entityId: entity!.id, currency: shownIn || undefined }) });
  const pres = onHand.data?.presentation;
  const pp = precision(pres?.currency);
  const fp = precision(onHand.data?.currency);
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Perpetual stock at weighted average cost. Goods received notes and bills receive stock, invoices issue it and post cost of sales; adjustments and transfers need approval."
        actions={
          <>
            <LinkButton href="/finance/inventory/documents">Adjustments & transfers</LinkButton>
            <LinkButton href="/finance/inventory/landed-costs">Landed costs</LinkButton>
            {can('inventory.manage') && tab === 'items' && <Button variant="primary" onClick={() => setEditing('new')}>New item</Button>}
            {can('inventory.manage') && tab === 'warehouses' && <Button variant="primary" onClick={() => setAddingWh(true)}>New warehouse</Button>}
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stock', label: 'Stock on hand' }, { id: 'lots', label: 'Batches & serials' }, { id: 'items', label: `Items (${items.length})` }, { id: 'warehouses', label: `Warehouses (${warehouses.length})` }]} />
      {tab === 'lots' && <LotsTab />}
      {tab === 'stock' && (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-muted">Also show value in</span>
            <Select className="h-8 w-28 text-xs" value={shownIn} onChange={(e) => setShownIn(e.target.value)} aria-label="Show value in currency">
              <option value="">—</option>
              {currencies.filter((c) => c.code !== entity?.functionalCurrency).map((c) => (
                <option key={c.code} value={c.code}>{c.code}</option>
              ))}
            </Select>
            {pres && <span className="text-xs text-muted">1 {onHand.data?.currency} = {pres.rate} {pres.currency}, latest approved closing (or spot) rate</span>}
          </div>
          {onHand.error && <ErrorBanner error={errorMessage(onHand.error)} />}
          {onHand.data && !isZero(onHand.data.difference) && (
            <div className="mb-3">
              <Notice tone="amber">Stock valuation differs from the inventory accounts in the ledger by {formatAmount(onHand.data.difference, fp, { parens: true })}. Check manual journals to inventory accounts.</Notice>
            </div>
          )}
          <TableWrap>
            {onHand.isLoading || !onHand.data ? (
              <Loading />
            ) : !onHand.data.rows.length ? (
              <Empty title="No stock items yet" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Item</th>
                    {onHand.data.warehouses.map((w) => (
                      <th key={w.id} className="num">{w.code}</th>
                    ))}
                    <th className="num">On hand</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Value ({onHand.data.currency})</th>
                    {pres && <th className="num">Value ({pres.currency})</th>}
                    <th>Last received</th>
                  </tr>
                </thead>
                <tbody>
                  {onHand.data.rows.map((r) => (
                    <tr key={r.itemId}>
                      <td>
                        <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/inventory/movements?itemId=${r.itemId}`}>{r.code}</Link> {r.name}
                        {r.belowReorder && <span className="ml-1"><Badge tone="amber">reorder</Badge></span>}
                      </td>
                      {r.warehouses.map((w) => (
                        <td key={w.warehouseId} className="num">{isZero(w.quantity) ? '' : w.quantity}</td>
                      ))}
                      <td className="num font-medium">{r.quantity} <span className="text-xs text-muted">{r.unit}</span></td>
                      <td className="num">{formatAmount(r.averageCost, 2)}</td>
                      <td className="num">{formatAmount(r.value, fp)}</td>
                      {pres && <td className="num">{formatAmount(pres.rows.find((x) => x.itemId === r.itemId)?.value ?? '0', pp)}</td>}
                      <td className="text-xs text-muted">{formatDate(r.lastReceiptDate)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={onHand.data.warehouses.length + 3}>Total stock value · ledger {formatAmount(onHand.data.ledger, fp)}</td>
                    <td className="num">{formatAmount(onHand.data.total, fp)}</td>
                    {pres && <td className="num">{formatAmount(pres.total, pp)}</td>}
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}
          </TableWrap>
        </>
      )}
      {tab === 'items' && (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th>Last purchase</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className={i.isActive ? '' : 'opacity-50'}>
                  <td className="font-mono text-xs">{i.code}</td>
                  <td>{i.name}</td>
                  <td>
                    <Badge tone={i.type === 'STOCK' ? 'blue' : 'gray'}>{i.type.toLowerCase().replace('_', '-')}</Badge>
                    {i.tracking && i.tracking !== 'NONE' && <span className="ml-1"><Badge tone="violet">{i.tracking === 'SERIAL' ? 'serials' : i.trackExpiry ? 'batches + expiry' : 'batches'}</Badge></span>}
                  </td>
                  <td className="text-muted">{i.category}</td>
                  <td className="num">
                    {i.salesPrice ? formatAmount(i.salesPrice, 2) : ''}
                    {!!i.prices?.length && <div className="text-xs text-muted">{i.prices.map((p) => `${p.currency} ${p.price}`).join(' · ')}</div>}
                  </td>
                  <td className="text-xs text-muted">{i.lastPurchase ? `${i.lastPurchase.currency} ${formatAmount(i.lastPurchase.unitPrice, 2)} · ${formatDate(i.lastPurchase.date)}` : ''}</td>
                  <td className="text-right">{can('inventory.manage') && <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {tab === 'warehouses' && (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Branch</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.filter((w) => w.entityId === entity?.id).map((w) => (
                <tr key={w.id}>
                  <td className="font-mono text-xs">{w.code}</td>
                  <td>{w.name}</td>
                  <td>{branches.find((b) => b.id === w.branchId)?.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing && <ItemEditor item={editing} onClose={() => setEditing(null)} />}
      {addingWh && <WarehouseEditor onClose={() => setAddingWh(false)} />}
    </>
  );
}

function WarehouseEditor({ onClose }: { onClose: () => void }) {
  const { entity } = useSession();
  const { data: branches = [] } = useBranches(entity?.id);
  const invalidate = useInvalidate();
  const [f, setF] = useState({ code: '', name: '', branchId: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post('/warehouses', { ...f, entityId: entity!.id, branchId: f.branchId || branches[0]?.id }),
    onSuccess: () => (invalidate('warehouses', 'stock'), onClose()),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal open onClose={onClose} title="New warehouse" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Branch" className="sm:col-span-3">
            <Select value={f.branchId || branches[0]?.id || ''} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              {branches.map((b) => (<option key={b.id} value={b.id}>{b.code} · {b.name}</option>))}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

interface Movement {
  id: string;
  date: string;
  itemId: string;
  warehouseId: string;
  type: string;
  quantity: string;
  value: string;
  unitCost: string;
  balanceQuantity: string;
  balanceValue: string;
  sourceType: string;
  sourceId: string;
  sourceNumber: string;
}

export function MovementsPage({ itemId }: { itemId?: string }) {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const [item, setItem] = useState(itemId ?? '');
  const { data = [], isLoading } = useQuery({ queryKey: ['stock-movements', entity?.id, item], queryFn: () => api.get<Movement[]>('/stock/movements', { entityId: entity!.id, itemId: item }) });
  const fp = precision(entity?.functionalCurrency);
  const href = (m: Movement) => (m.sourceType === 'Invoice' ? `/sales/invoices/${m.sourceId}` : m.sourceType === 'StockDocument' ? `/inventory/documents` : m.sourceType === 'LandedCost' ? '/inventory/landed-costs' : '#');
  return (
    <>
      <PageHeader title="Stock movements" description="The stock ledger: every receipt and issue with its cost and the running balance." actions={<LinkButton href="/finance/inventory">Stock on hand</LinkButton>} />
      <Select className="mb-3 w-72" value={item} onChange={(e) => setItem(e.target.value)} aria-label="Item">
        <option value="">All items</option>
        {items.filter((i) => i.type === 'STOCK').map((i) => (<option key={i.id} value={i.id}>{i.code} · {i.name}</option>))}
      </Select>
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No movements" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Type</th>
                <th>Source</th>
                <th className="num">Qty</th>
                <th className="num">Unit cost</th>
                <th className="num">Value</th>
                <th className="num">Balance qty</th>
                <th className="num">Balance value</th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{formatDate(m.date)}</td>
                  <td className="font-mono text-xs">{items.find((i) => i.id === m.itemId)?.code}</td>
                  <td>{warehouses.find((w) => w.id === m.warehouseId)?.code}</td>
                  <td className="text-xs">{m.type.toLowerCase().replace('_', ' ')}</td>
                  <td className="whitespace-nowrap font-mono text-xs"><Link className="text-brand-700 hover:underline" href={href(m)}>{m.sourceNumber}</Link></td>
                  <td className={cx('num', m.quantity.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{m.quantity}</td>
                  <td className="num">{formatAmount(m.unitCost, 2)}</td>
                  <td className="num">{formatAmount(m.value, fp, { parens: true })}</td>
                  <td className="num">{m.balanceQuantity}</td>
                  <td className="num">{formatAmount(m.balanceValue, fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}

interface StockDoc {
  id: string;
  kind: 'ADJUSTMENT' | 'TRANSFER';
  number: string;
  date: string;
  reason: string;
  warehouseId: string;
  toWarehouseId: string | null;
  adjustmentAccountId: string | null;
  lines: { itemId: string; quantity: string; unitCost: string | null; value: string | null }[];
  status: string;
  journalId: string | null;
  createdBy: string;
  submittedBy: string | null;
}

export function StockDocumentsPage() {
  const { entity, me, can } = useSession();
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const { data = [], isLoading } = useQuery({ queryKey: ['stock-documents', entity?.id], queryFn: () => api.get<StockDoc[]>('/stock/documents', { entityId: entity!.id }) });
  const ws = warehouses.filter((w) => w.entityId === entity?.id && w.isActive);
  const stockItems = items.filter((i) => i.type === 'STOCK' && i.isActive);
  const [form, setForm] = useState<null | { kind: 'ADJUSTMENT' | 'TRANSFER'; date: string; reason: string; warehouseId: string; toWarehouseId: string; adjustmentAccountId: string; lines: { itemId: string; quantity: string; unitCost: string; lots: Lot[] }[] }>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const f = form!;
      const doc = await api.post<StockDoc>('/stock/documents', {
        entityId: entity!.id,
        kind: f.kind,
        date: f.date,
        reason: f.reason,
        warehouseId: f.warehouseId || ws[0]?.id,
        toWarehouseId: f.kind === 'TRANSFER' ? f.toWarehouseId : null,
        adjustmentAccountId: f.kind === 'ADJUSTMENT' ? f.adjustmentAccountId : null,
        lines: f.lines.filter((l) => l.itemId && l.quantity).map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost || null, lots: lotsBody(l.lots) })),
      });
      await api.post(`/stock/documents/${doc.id}/submit`);
    },
    onSuccess: () => (setForm(null), setError(null), invalidate('stock-documents')),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post(`/stock/documents/${id}/${action}`, action === 'reject' ? { reason: 'Rejected by reviewer' } : {}),
    onSuccess: () => (setError(null), invalidate('stock-documents', 'stock', 'stock-movements')),
    onError: (err) => setError(errorMessage(err)),
  });
  const wh = (id: string | null) => warehouses.find((w) => w.id === id)?.code ?? '';
  const fp = precision(entity?.functionalCurrency);
  return (
    <>
      <PageHeader
        title="Stock adjustments & transfers"
        description="Counts, write-offs and moves between warehouses. A second person approves them before stock and the ledger change."
        actions={
          can('inventory.manage') && (
            <>
              <Button onClick={() => setForm({ kind: 'TRANSFER', date: today(), reason: '', warehouseId: ws[0]?.id ?? '', toWarehouseId: ws[1]?.id ?? '', adjustmentAccountId: '', lines: [{ itemId: '', quantity: '', unitCost: '', lots: [] }] })}>New transfer</Button>
              <Button variant="primary" onClick={() => setForm({ kind: 'ADJUSTMENT', date: today(), reason: '', warehouseId: ws[0]?.id ?? '', toWarehouseId: '', adjustmentAccountId: accounts.find((a) => a.code === '5100')?.id ?? '', lines: [{ itemId: '', quantity: '', unitCost: '', lots: [] }] })}>
                New adjustment
              </Button>
            </>
          )
        }
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No adjustments or transfers" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Type</th>
                <th>Warehouse</th>
                <th>Reason</th>
                <th>Items</th>
                <th className="num">Value</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((d) => {
                const mine = d.createdBy === me.id || d.submittedBy === me.id;
                return (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap font-mono text-xs">{d.journalId ? <Link className="text-brand-700 hover:underline" href={`/finance/journals/${d.journalId}`}>{d.number}</Link> : d.number}</td>
                    <td>{formatDate(d.date)}</td>
                    <td>{d.kind === 'TRANSFER' ? 'Transfer' : 'Adjustment'}</td>
                    <td>{wh(d.warehouseId)}{d.toWarehouseId && ` → ${wh(d.toWarehouseId)}`}</td>
                    <td className="text-muted">{d.reason}</td>
                    <td className="text-xs">{d.lines.map((l) => `${l.quantity} × ${items.find((i) => i.id === l.itemId)?.code}`).join(', ')}</td>
                    <td className="num">{d.status === 'POSTED' ? formatAmount(addAll(d.lines.map((l) => (l.value ?? '0').replace('-', ''))), fp) : ''}</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className="whitespace-nowrap text-right">
                      {d.status === 'SUBMITTED' && can('inventory.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: d.id, action: 'reject' })}>Reject</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'Someone else must approve' : undefined} onClick={() => act.mutate({ id: d.id, action: 'approve' })}>Approve</Button>
                        </>
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
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.kind === 'TRANSFER' ? 'New stock transfer' : 'New stock adjustment'}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Submit for approval</Button></>}
      >
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
              <Field label={form.kind === 'TRANSFER' ? 'From warehouse' : 'Warehouse'}>
                <Select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
                  {ws.map((w) => (<option key={w.id} value={w.id}>{w.code}</option>))}
                </Select>
              </Field>
              {form.kind === 'TRANSFER' ? (
                <Field label="To warehouse">
                  <Select value={form.toWarehouseId} onChange={(e) => setForm({ ...form, toWarehouseId: e.target.value })}>
                    <option value="">Select…</option>
                    {ws.filter((w) => w.id !== form.warehouseId).map((w) => (<option key={w.id} value={w.id}>{w.code}</option>))}
                  </Select>
                </Field>
              ) : (
                <Field label="Charge / credit account">
                  <Select value={form.adjustmentAccountId} onChange={(e) => setForm({ ...form, adjustmentAccountId: e.target.value })}>
                    <AccountOptions accounts={accounts} classes={['COST_OF_SALES', 'EXPENSE']} />
                  </Select>
                </Field>
              )}
              <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
            </div>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num w-36">{form.kind === 'TRANSFER' ? 'Quantity' : 'Change (+/−)'}</th>
                  {form.kind === 'ADJUSTMENT' && <th className="num w-36">Unit cost (stock found)</th>}
                </tr>
              </thead>
              <tbody>
                {form.lines.map((l, i) => {
                  const set = (p: Partial<typeof l>) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  return (
                    <tr key={i}>
                      <td>
                        <Select className="h-8 text-xs" value={l.itemId} onChange={(e) => set({ itemId: e.target.value, lots: [] })} aria-label="Item">
                          <option value="">Select item…</option>
                          {stockItems.map((it) => (<option key={it.id} value={it.id}>{it.code} · {it.name}</option>))}
                        </Select>
                        <div className="mt-1">
                          <LotsButton
                            item={stockItems.find((it) => it.id === l.itemId)}
                            warehouseId={form.warehouseId}
                            quantity={l.quantity.replace('-', '')}
                            inward={form.kind === 'ADJUSTMENT' && !l.quantity.startsWith('-')}
                            value={l.lots}
                            onChange={(lots) => set({ lots })}
                          />
                        </div>
                      </td>
                      <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.quantity} onChange={(e) => (form.kind === 'TRANSFER' ? positive : amountPattern).test(e.target.value) && set({ quantity: e.target.value })} aria-label="Quantity" /></td>
                      {form.kind === 'ADJUSTMENT' && (
                        <td><Input className="h-8 text-right text-xs" inputMode="decimal" placeholder="average" value={l.unitCost} onChange={(e) => positive.test(e.target.value) && set({ unitCost: e.target.value })} aria-label="Unit cost" /></td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: [...form.lines, { itemId: '', quantity: '', unitCost: '', lots: [] }] })}>+ Add item</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------------------------

interface AssetCategory {
  id: string;
  code: string;
  name: string;
  method: string;
  usefulLifeMonths: number;
  annualRatePercent: string | null;
}
interface AssetRow {
  id: string;
  number: string;
  name: string;
  description?: string;
  serialNumber?: string;
  tagNumber?: string;
  makeModel?: string;
  pvNumber?: string;
  deliveryDate?: string | null;
  originalLocation?: string;
  custodian?: string;
  condition?: string;
  acquisitionType?: string;
  donor?: string;
  departmentId?: string | null;
  usefulLifeMonths?: number;
  cost?: string;
  disposal?: { date: string | null; proceeds: string | null };
  categoryName: string;
  branchId: string;
  location: string;
  acquisitionDate: string;
  method: string;
  status: string;
  costAtDate: string;
  accumulatedAtDate: string;
  netBookValue: string;
  depreciatedTo: string | null;
}

export function AssetsPage() {
  const { entity, can } = useSession();
  const { data: dimensions = [] } = useDimensions();
  const { data: branchList = [] } = useBranches();
  /** The asset register in the National Treasury (PSASB) template column order. */
  const treasuryRegister = (rows: AssetRow[], asOf: string) => {
    const day = (d?: string | null) => (d ? d.slice(0, 10) : '');
    const replacement = (r: AssetRow) => {
      if (!r.usefulLifeMonths) return '';
      const d = new Date(`${day(r.acquisitionDate)}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + r.usefulLifeMonths);
      return d.toISOString().slice(0, 10);
    };
    downloadCsv(
      `asset-register-national-treasury-${asOf}.csv`,
      ['Asset description', 'Financed by', 'Serial number', 'Tag number', 'Make and model', 'Date of delivery', 'Date of purchase', 'PV number', 'Original location', 'Current location', 'Replacement date', 'Purchase amount', 'Accumulated depreciation', 'Net book value', 'Asset condition', 'Responsible officer', 'Department', 'Branch', 'Asset category', 'Disposal date', 'Disposal value', 'Status'],
      rows.map((r) => [
        [r.name, r.description].filter(Boolean).join(' - '),
        r.acquisitionType === 'DONATED' ? `Donation${r.donor ? `: ${r.donor}` : ''}` : r.acquisitionType ? r.acquisitionType.charAt(0) + r.acquisitionType.slice(1).toLowerCase().replace(/_/g, ' ') : '',
        r.serialNumber ?? '',
        r.tagNumber || r.number,
        r.makeModel ?? '',
        day(r.deliveryDate),
        day(r.acquisitionDate),
        r.pvNumber ?? '',
        r.originalLocation || r.location,
        r.location,
        replacement(r),
        r.cost ?? r.costAtDate,
        r.accumulatedAtDate,
        r.netBookValue,
        r.condition ? r.condition.charAt(0) + r.condition.slice(1).toLowerCase() : '',
        r.custodian ?? '',
        dimensions.find((x) => x.id === r.departmentId)?.name ?? '',
        branchList.find((b) => b.id === r.branchId)?.name ?? '',
        r.categoryName,
        day(r.disposal?.date),
        r.disposal?.proceeds ?? '',
        r.status,
      ]),
    );
  };
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data: accounts = [] } = useAccounts(entity?.id);
  const [asOf, setAsOf] = useState(today());
  const [dialog, setDialog] = useState<null | { kind: 'new' } | { kind: 'dispose' | 'transfer'; asset: AssetRow }>(null);
  const [error, setError] = useState<string | null>(null);
  const register = useQuery({
    queryKey: ['assets', entity?.id, asOf],
    queryFn: () => api.get<{ currency: string; rows: AssetRow[]; totals: { cost: string; accumulated: string; netBookValue: string }; ledger: { cost: string; accumulated: string } }>('/assets', { entityId: entity!.id, asOf }),
  });
  const categories = useQuery({ queryKey: ['asset-categories'], queryFn: () => api.get<AssetCategory[]>('/asset-categories') });
  const [f, setF] = useState({ categoryId: '', name: '', branchId: '', acquisitionDate: today(), cost: '', residualValue: '', serialNumber: '', location: '', mode: 'POST', contraAccountId: '', openingAccumulated: '' });
  const [d, setD] = useState({ date: today(), proceeds: '', proceedsAccountId: '', reason: '', branchId: '' });
  const fp = precision(register.data?.currency);
  const save = useMutation({
    mutationFn: () => {
      if (dialog?.kind === 'new') {
        return api.post('/assets', {
          entityId: entity!.id,
          branchId: f.branchId || branches[0]?.id,
          categoryId: f.categoryId || categories.data?.[0]?.id,
          name: f.name,
          acquisitionDate: f.acquisitionDate,
          cost: f.cost,
          residualValue: f.residualValue || null,
          serialNumber: f.serialNumber || undefined,
          location: f.location || undefined,
          openingAccumulated: f.mode === 'EXISTING' ? f.openingAccumulated || null : null,
          capitalisation: f.mode === 'POST' ? { mode: 'POST', contraAccountId: f.contraAccountId } : { mode: 'EXISTING' },
        });
      }
      if (dialog?.kind === 'dispose') return api.post(`/assets/${dialog.asset.id}/dispose`, { date: d.date, proceeds: d.proceeds || '0', proceedsAccountId: d.proceedsAccountId || null, reason: d.reason });
      return api.post(`/assets/${(dialog as { asset: AssetRow }).asset.id}/transfer`, { date: d.date, branchId: d.branchId });
    },
    onSuccess: () => (setDialog(null), setError(null), invalidate('assets')),
    onError: (err) => setError(errorMessage(err)),
  });
  const rows = register.data?.rows ?? [];
  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="Asset register with cost, accumulated depreciation and net book value, reconciled to the ledger."
        actions={
          <>
            <LinkButton href="/finance/assets/care">Care, labels &amp; verification</LinkButton>
            <LinkButton href="/finance/assets/depreciation">Depreciation</LinkButton>
            {register.data && <Button onClick={() => treasuryRegister(register.data!.rows, asOf)}>National Treasury register (CSV)</Button>}
            {can('assets.manage') && <Button variant="primary" onClick={() => (setError(null), setDialog({ kind: 'new' }))}>Register asset</Button>}
          </>
        }
      />
      <div className="mb-3 flex items-end gap-2">
        <Field label="As at"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      {register.data && (register.data.ledger.cost !== register.data.totals.cost || register.data.ledger.accumulated !== register.data.totals.accumulated) && (
        <div className="mb-3">
          <Notice tone="amber">
            The register ({formatAmount(register.data.totals.cost, fp)} cost, {formatAmount(register.data.totals.accumulated, fp)} depreciation) differs from the ledger ({formatAmount(register.data.ledger.cost, fp)}, {formatAmount(register.data.ledger.accumulated, fp)}). Assets bought before the register was set up should be registered as &quot;already in the ledger&quot;.
          </Notice>
        </div>
      )}
      <TableWrap>
        {register.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <Empty title="No assets registered" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Asset</th>
                <th>Category</th>
                <th>Branch</th>
                <th>Acquired</th>
                <th>Depreciated to</th>
                <th>Status</th>
                <th className="num">Cost</th>
                <th className="num">Accum. dep.</th>
                <th className="num">Net book value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap font-mono text-xs"><Link className="text-brand-700 hover:underline" href={`/finance/assets/${a.id}`}>{a.number}</Link></td>
                  <td>{a.name} {a.location && <span className="text-xs text-muted">· {a.location}</span>}</td>
                  <td className="text-muted">{a.categoryName}</td>
                  <td>{branches.find((b) => b.id === a.branchId)?.code}</td>
                  <td>{formatDate(a.acquisitionDate)}</td>
                  <td className="text-xs">{formatDate(a.depreciatedTo) || '—'}</td>
                  <td><StatusBadge status={a.status === 'FULLY_DEPRECIATED' ? 'CLOSED' : a.status === 'DISPOSED' ? 'VOID' : 'ACTIVE'} /></td>
                  <td className="num">{formatAmount(a.costAtDate, fp)}</td>
                  <td className="num">{formatAmount(a.accumulatedAtDate, fp)}</td>
                  <td className="num font-medium">{formatAmount(a.netBookValue, fp)}</td>
                  <td className="whitespace-nowrap text-right">
                    {a.status !== 'DISPOSED' && can('assets.manage') && <Button size="sm" variant="ghost" onClick={() => (setError(null), setD({ ...d, branchId: '' }), setDialog({ kind: 'transfer', asset: a }))}>Transfer</Button>}
                    {a.status !== 'DISPOSED' && can('assets.depreciate') && <Button size="sm" variant="ghost" onClick={() => (setError(null), setDialog({ kind: 'dispose', asset: a }))}>Dispose</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>Total</td>
                <td className="num">{formatAmount(register.data!.totals.cost, fp)}</td>
                <td className="num">{formatAmount(register.data!.totals.accumulated, fp)}</td>
                <td className="num">{formatAmount(register.data!.totals.netBookValue, fp)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </TableWrap>
      <Modal
        wide
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'new' ? 'Register asset' : dialog?.kind === 'dispose' ? `Dispose of ${dialog.asset.number}` : dialog?.kind === 'transfer' ? `Transfer ${dialog.asset.number}` : ''}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{dialog?.kind === 'new' ? 'Register' : dialog?.kind === 'dispose' ? 'Post disposal' : 'Post transfer'}</Button></>}
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          {dialog?.kind === 'new' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Category">
                <Select value={f.categoryId || categories.data?.[0]?.id || ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
                  {categories.data?.map((c) => (<option key={c.id} value={c.id}>{c.name} ({c.method === 'STRAIGHT_LINE' ? `${c.usefulLifeMonths} months` : `${c.annualRatePercent}% p.a.`})</option>))}
                </Select>
              </Field>
              <Field label="Branch">
                <Select value={f.branchId || branches[0]?.id || ''} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
                  {branches.map((b) => (<option key={b.id} value={b.id}>{b.code}</option>))}
                </Select>
              </Field>
              <Field label="Acquired on"><Input type="date" value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} /></Field>
              <Field label="Cost"><Input inputMode="decimal" value={f.cost} onChange={(e) => positive.test(e.target.value) && setF({ ...f, cost: e.target.value })} /></Field>
              <Field label="Residual value" hint="Blank uses the category default"><Input inputMode="decimal" value={f.residualValue} onChange={(e) => positive.test(e.target.value) && setF({ ...f, residualValue: e.target.value })} /></Field>
              <Field label="Serial number"><Input value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} /></Field>
              <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
              <Field label="Ledger entry" className="sm:col-span-3">
                <div className="flex flex-wrap gap-4 pt-1 text-sm">
                  <label className="flex items-center gap-2"><input type="radio" checked={f.mode === 'POST'} onChange={() => setF({ ...f, mode: 'POST' })} /> Capitalise now (debit the asset account)</label>
                  <label className="flex items-center gap-2"><input type="radio" checked={f.mode === 'EXISTING'} onChange={() => setF({ ...f, mode: 'EXISTING' })} /> Already in the ledger (bought on a bill or opening balance)</label>
                </div>
              </Field>
              {f.mode === 'POST' ? (
                <Field label="Credit account" className="sm:col-span-3">
                  <Select value={f.contraAccountId} onChange={(e) => setF({ ...f, contraAccountId: e.target.value })}>
                    <AccountOptions accounts={accounts} classes={['ASSET', 'LIABILITY', 'EQUITY']} placeholder="Bank, accruals or opening balance equity…" />
                  </Select>
                </Field>
              ) : (
                <Field label="Depreciation already charged" className="sm:col-span-3"><Input inputMode="decimal" value={f.openingAccumulated} onChange={(e) => positive.test(e.target.value) && setF({ ...f, openingAccumulated: e.target.value })} /></Field>
              )}
            </div>
          )}
          {dialog?.kind === 'dispose' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <p className="text-sm text-muted sm:col-span-2">Net book value {formatAmount(dialog.asset.netBookValue, fp)}. Depreciation must be run to the end of the previous month first; the gain or loss posts to the category&apos;s disposal account.</p>
              <Field label="Disposal date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
              <Field label="Proceeds"><Input inputMode="decimal" value={d.proceeds} onChange={(e) => positive.test(e.target.value) && setD({ ...d, proceeds: e.target.value })} /></Field>
              <Field label="Proceeds received in" className="sm:col-span-2">
                <Select value={d.proceedsAccountId} onChange={(e) => setD({ ...d, proceedsAccountId: e.target.value })}>
                  <AccountOptions accounts={accounts} classes={['ASSET']} placeholder="None (scrapped)" />
                </Select>
              </Field>
              <Field label="Reason" className="sm:col-span-2"><Input value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
            </div>
          )}
          {dialog?.kind === 'transfer' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
              <Field label="To branch">
                <Select value={d.branchId} onChange={(e) => setD({ ...d, branchId: e.target.value })}>
                  <option value="">Select…</option>
                  {branches.filter((b) => b.id !== dialog.asset.branchId).map((b) => (<option key={b.id} value={b.id}>{b.code} · {b.name}</option>))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export function AssetDetail({ id }: { id: string }) {
  const precision = usePrecision();
  const { entity } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['asset', id],
    queryFn: () =>
      api.get<{
        asset: AssetRow & AssetCare & { cost: string; residualValue: string; usefulLifeMonths: number; annualRatePercent: string | null; accumulatedDepreciation: string; serialNumber: string; disposal: { date: string | null; proceeds: string | null; gainLoss: string | null; reason: string } };
        journals: { id: string; number: string; journalDate: string; description: string; totalDebit: string }[];
        depreciation: { periodEnd: string; journalId: string; months: number; amount: string }[];
        forecast: { month: string; amount: string }[];
      }>(`/assets/${id}`),
  });
  if (isLoading || !data) return <Loading />;
  const a = data.asset;
  const fp = precision(entity?.functionalCurrency);
  return (
    <>
      <PageHeader title={`${a.number} · ${a.name}`} description={<span className="inline-flex gap-2"><StatusBadge status={a.status === 'DISPOSED' ? 'VOID' : 'ACTIVE'} /> {a.method === 'STRAIGHT_LINE' ? `Straight line over ${a.usefulLifeMonths} months` : `Reducing balance at ${a.annualRatePercent}% a year`}</span>} actions={<LinkButton href="/finance/assets">Register</LinkButton>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Values">
          <dl className="space-y-1 text-sm">
            {[
              ['Cost', a.cost],
              ['Residual value', a.residualValue],
              ['Accumulated depreciation', a.accumulatedDepreciation],
              ['Net book value', addAll([a.cost, `-${a.accumulatedDepreciation}`])],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{formatAmount(v, fp)}</dd></div>
            ))}
            {a.disposal?.date && (
              <div className="flex justify-between"><dt className="text-muted">Disposed {formatDate(a.disposal.date)}</dt><dd className="tabular-nums">{formatAmount(a.disposal.gainLoss, fp, { parens: true })}</dd></div>
            )}
          </dl>
        </Card>
        <Card title="Postings" className="lg:col-span-2">
          <ul className="space-y-1 text-sm">
            {data.journals.map((j) => (
              <li key={j.id} className="flex justify-between gap-3">
                <span><Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/journals/${j.id}`}>{j.number}</Link> {formatDate(j.journalDate)} · {j.description}</span>
                <span className="tabular-nums">{formatAmount(j.totalDebit, fp)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <AssetCareCards asset={a} currency={entity?.functionalCurrency} />
      <AttachmentsCard recordType="FixedAsset" recordId={a.id} />
      {a.status !== 'DISPOSED' && data.forecast.length > 0 && (
        <Card title="Depreciation schedule (next 24 months)" className="mt-4">
          <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
            {data.forecast.map((m) => (
              <div key={m.month} className="rounded border border-line p-2"><p className="text-muted">{formatDate(m.month).slice(3)}</p><p className="tabular-nums">{formatAmount(m.amount, fp)}</p></div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

export function DepreciationPage() {
  const { entity, can } = useSession();
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const lastMonthEnd = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
  };
  const [periodEnd, setPeriodEnd] = useState(lastMonthEnd());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['depreciation-preview', entity?.id, periodEnd],
    queryFn: () => api.get<{ currency: string; lines: { assetId: string; assetNumber: string; name: string; from: string; to: string; months: number; amount: string; netBookValueAfter: string }[]; total: string }>('/depreciation/preview', { entityId: entity!.id, periodEnd }),
  });
  const runs = useQuery({ queryKey: ['depreciation-runs', entity?.id], queryFn: () => api.get<{ id: string; periodEnd: string; total: string; journalId: string; createdAt: string }[]>('/depreciation/runs', { entityId: entity!.id }) });
  const run = useMutation({
    mutationFn: () => api.post<{ journalNumber: string }>('/depreciation/runs', { entityId: entity!.id, periodEnd }),
    onSuccess: (r) => (setNotice(`Depreciation posted as ${r.journalNumber}.`), setError(null), invalidate('depreciation-preview', 'depreciation-runs', 'assets')),
    onError: (err) => setError(errorMessage(err)),
  });
  const fp = precision(preview.data?.currency);
  return (
    <>
      <PageHeader title="Depreciation" description="Monthly depreciation for every active asset, posted as one journal per period. Each month can be run once." actions={<LinkButton href="/finance/assets">Register</LinkButton>} />
      <div className="mb-3 flex items-end gap-3">
        <Field label="Depreciate to (month end)"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
        {can('assets.depreciate') && <Button variant="primary" disabled={!preview.data?.lines.length} loading={run.isPending} onClick={() => run.mutate()}>Post depreciation {preview.data && formatAmount(preview.data.total, fp)}</Button>}
      </div>
      <ErrorBanner error={error ?? preview.error} className="mb-3" />
      {notice && <div className="mb-3"><Notice tone="green">{notice}</Notice></div>}
      <TableWrap>
        {!preview.data ? (
          <Loading />
        ) : !preview.data.lines.length ? (
          <Empty title="Nothing to depreciate up to this date" />
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Asset</th><th>From</th><th>To</th><th className="num">Months</th><th className="num">Depreciation</th><th className="num">NBV after</th></tr>
            </thead>
            <tbody>
              {preview.data.lines.map((l) => (
                <tr key={l.assetId}>
                  <td><span className="font-mono text-xs">{l.assetNumber}</span> {l.name}</td>
                  <td>{formatDate(l.from)}</td>
                  <td>{formatDate(l.to)}</td>
                  <td className="num">{l.months}</td>
                  <td className="num">{formatAmount(l.amount, fp)}</td>
                  <td className="num">{formatAmount(l.netBookValueAfter, fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {!!runs.data?.length && (
        <Card title="Previous runs" padded={false} className="mt-5">
          <table className="table-base">
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>To {formatDate(r.periodEnd)}</td>
                  <td className="num">{formatAmount(r.total, fp)}</td>
                  <td><Link className="text-xs text-brand-700 hover:underline" href={`/finance/journals/${r.journalId}`}>Journal</Link></td>
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
// Expense claims
// ---------------------------------------------------------------------------------------------

interface Claim {
  id: string;
  number: string;
  claimantId: string;
  claimantName: string;
  title: string;
  currency: string;
  total: string;
  policyBreaches: number;
  status: string;
  createdAt: string;
  submittedBy: string | null;
  journalId: string | null;
  lines?: { lineNo: number; date: string; categoryId: string; description: string; merchant: string; receiptReference: string; amount: string; currency?: string | null; originalAmount?: string | null; exchangeRate?: string | null; taxAmount: string; policyNotes: string[] }[];
  payment?: { currency?: string | null; amount?: string | null; exchangeRate?: string | null } | null;
  rejectionReason: string;
}

export function ExpensesPage() {
  const { entity, me, can } = useSession();
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data: banks = [] } = useBankAccounts(entity?.id);
  const { data: dimensions = [] } = useDimensions();
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<{ id: string; code: string; name: string; limitPerLine: string | null; requiresReceipt: boolean; isActive: boolean }[]>('/expense-categories') });
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const reviewer = can('expenses.approve') || can('expenses.pay');
  const list = useQuery({ queryKey: ['expense-claims', entity?.id, tab], queryFn: () => api.get<Claim[]>('/expense-claims', { entityId: entity!.id, mine: tab === 'mine' ? 'true' : undefined }) });
  const [viewing, setViewing] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['expense-claim', viewing], queryFn: () => api.get<Claim>(`/expense-claims/${viewing}`), enabled: !!viewing });
  const [form, setForm] = useState<null | { title: string; branchId: string; lines: { date: string; categoryId: string; description: string; merchant: string; receiptReference: string; amount: string; projectId: string; currency: string; rate: string }[] }>(null);
  const [comment, setComment] = useState('');
  const [pay, setPay] = useState({ bankAccountId: '', date: today() });
  const [error, setError] = useState<string | null>(null);
  const fp = precision(entity?.functionalCurrency);
  const blankLine = () => ({ date: today(), categoryId: categories.data?.[0]?.id ?? '', description: '', merchant: '', receiptReference: '', amount: '', projectId: '', currency: '', rate: '' });
  const { data: currencies = [] } = useCurrencies();
  const create = useMutation({
    mutationFn: async () => {
      const c = await api.post<Claim>('/expense-claims', {
        entityId: entity!.id,
        branchId: form!.branchId || branches[0]?.id,
        title: form!.title,
        lines: form!.lines
          .filter((l) => l.amount)
          .map(({ currency, rate, amount, ...l }) => ({
            ...l,
            merchant: l.merchant || undefined,
            receiptReference: l.receiptReference || undefined,
            projectId: l.projectId || null,
            // Spent in another currency: the receipt amount, converted at the rate paid or the day's rate.
            ...(currency ? { currency, originalAmount: amount, exchangeRate: rate || null, amount: null } : { amount }),
          })),
      });
      await api.post(`/expense-claims/${c.id}/submit`);
    },
    onSuccess: () => (setForm(null), setError(null), invalidate('expense-claims')),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => api.post(`/expense-claims/${viewing}/${action}`, body ?? {}),
    onSuccess: () => (setError(null), setComment(''), invalidate('expense-claims', 'expense-claim')),
    onError: (err) => setError(errorMessage(err)),
  });
  const c = detail.data;
  const catName = (id: string) => categories.data?.find((x) => x.id === id)?.name ?? '';
  const total = form ? addAll(form.lines.filter((l) => !l.currency || l.rate).map((l) => (l.currency ? String(Number(l.amount || 0) * Number(l.rate)) : l.amount))) : '0';
  return (
    <>
      <PageHeader
        title="Expense claims"
        description="Claim back business expenses. Policy limits and missing receipts are flagged for the approver; approved claims post to the ledger and are reimbursed from a bank account."
        actions={can('expenses.submit') && <Button variant="primary" onClick={() => (setError(null), setForm({ title: '', branchId: '', lines: [blankLine()] }))}>New claim</Button>}
      />
      {reviewer && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'My claims' }, { id: 'team', label: 'All claims' }]} />}
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No claims yet" />
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Number</th><th>Claimant</th><th>Title</th><th>Status</th><th>Policy</th><th className="num">Total</th></tr>
            </thead>
            <tbody>
              {list.data.map((x) => (
                <tr key={x.id} className="cursor-pointer" onClick={() => (setError(null), setViewing(x.id))}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{x.number}</td>
                  <td>{x.claimantName}</td>
                  <td>{x.title}</td>
                  <td><StatusBadge status={x.status} /></td>
                  <td>{x.policyBreaches > 0 ? <Badge tone="amber">{x.policyBreaches} exception(s)</Badge> : <span className="text-xs text-muted">OK</span>}</td>
                  <td className="num">{formatAmount(x.total, fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title="New expense claim"
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Submit claim · {formatAmount(total, fp)}</Button></>}
      >
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Title" className="sm:col-span-2"><Input value={form.title} placeholder="e.g. Client visit to Mombasa" onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Branch">
                <Select value={form.branchId || branches[0]?.id || ''} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  {branches.map((b) => (<option key={b.id} value={b.id}>{b.code}</option>))}
                </Select>
              </Field>
            </div>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr><th>Date</th><th className="min-w-40">Category</th><th className="min-w-40">Description</th><th>Merchant</th><th>Receipt ref</th><th>Project</th><th className="min-w-44">Amount</th></tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => {
                    const set = (p: Partial<typeof l>) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    const cat = categories.data?.find((x) => x.id === l.categoryId);
                    const over = cat?.limitPerLine && l.amount && Number(l.amount) > Number(cat.limitPerLine);
                    return (
                      <tr key={i}>
                        <td><Input type="date" className="h-8 text-xs" value={l.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date" /></td>
                        <td>
                          <Select className="h-8 text-xs" value={l.categoryId} onChange={(e) => set({ categoryId: e.target.value })} aria-label="Category">
                            {categories.data?.filter((x) => x.isActive).map((x) => (<option key={x.id} value={x.id}>{x.name}{x.limitPerLine ? ` (≤ ${formatAmount(x.limitPerLine, 0)})` : ''}</option>))}
                          </Select>
                        </td>
                        <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></td>
                        <td><Input className="h-8 text-xs" value={l.merchant} onChange={(e) => set({ merchant: e.target.value })} aria-label="Merchant" /></td>
                        <td><Input className={cx('h-8 text-xs', cat?.requiresReceipt && !l.receiptReference && 'border-amber-400')} value={l.receiptReference} onChange={(e) => set({ receiptReference: e.target.value })} aria-label="Receipt reference" /></td>
                        <td>
                          <Select className="h-8 text-xs" value={l.projectId} onChange={(e) => set({ projectId: e.target.value })} aria-label="Project">
                            <option value="">—</option>
                            {dimensions.filter((d) => d.type === 'PROJECT' && d.isActive).map((d) => (<option key={d.id} value={d.id}>{d.code}</option>))}
                          </Select>
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <Select className="h-8 w-20 text-xs" value={l.currency || entity!.functionalCurrency} onChange={(e) => set({ currency: e.target.value === entity!.functionalCurrency ? '' : e.target.value, rate: '' })} aria-label="Currency spent">
                              {currencies.filter((x) => x.isActive).map((x) => (<option key={x.code}>{x.code}</option>))}
                            </Select>
                            <Input className={cx('h-8 text-right text-xs', !l.currency && over && 'border-amber-400')} inputMode="decimal" value={l.amount} onChange={(e) => positive.test(e.target.value) && set({ amount: e.target.value })} aria-label="Amount" />
                          </div>
                          {l.currency && (
                            <Input className="mt-1 h-7 text-right text-[11px]" inputMode="decimal" placeholder={`Rate paid (blank: day's ${l.currency} rate)`} value={l.rate} onChange={(e) => positive.test(e.target.value) && set({ rate: e.target.value })} aria-label="Exchange rate" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: [...form.lines, blankLine()] })}>+ Add expense</Button>
            <p className="text-xs text-muted">Amounts include VAT; recoverable input VAT is separated automatically when the claim is approved. Expenses paid in another currency are converted at the rate you enter (e.g. your card statement) or the day&apos;s rate, and reimbursed in {entity!.functionalCurrency}.</p>
          </div>
        )}
      </Modal>

      <Modal wide open={!!viewing} onClose={() => setViewing(null)} title={c ? `${c.number} · ${c.title}` : 'Claim'}>
        {!c ? (
          <Loading />
        ) : (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <p className="text-sm">
              <StatusBadge status={c.status} /> {c.claimantName} · {formatAmount(c.total, fp)} {c.currency}
              {c.payment?.currency && <span className="ml-1 text-xs text-muted">· paid {c.payment.currency} {c.payment.amount} @ {c.payment.exchangeRate}</span>}
              {c.journalId && <Link className="ml-2 text-xs text-brand-700 hover:underline" href={`/finance/journals/${c.journalId}`}>Journal</Link>}
              {c.status !== 'DRAFT' && (
                <button type="button" className="ml-2 text-xs text-brand-700 hover:underline" onClick={() => window.open(`/api/v1/finance/expense-claims/${c.id}/voucher`, '_blank', 'noopener')}>
                  Payment voucher
                </button>
              )}
            </p>
            {c.status === 'REJECTED' && <Notice tone="amber">Rejected: {c.rejectionReason}</Notice>}
            <table className="table-base">
              <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Receipt</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {c.lines?.map((l) => (
                  <tr key={l.lineNo}>
                    <td>{formatDate(l.date)}</td>
                    <td>{catName(l.categoryId)}</td>
                    <td>{l.description}{l.merchant && <span className="text-xs text-muted"> · {l.merchant}</span>}{l.policyNotes.map((n) => (<span key={n} className="ml-1"><Badge tone="amber">{n}</Badge></span>))}</td>
                    <td className="text-xs">{l.receiptReference || '—'}</td>
                    <td className="num">
                      {formatAmount(l.amount, fp)}
                      {l.currency && <div className="text-xs text-muted">{l.currency} {l.originalAmount} @ {l.exchangeRate}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ApprovalHistory documentType="EXPENSE_CLAIM" documentId={c.id} />
            <AttachmentsCard recordType="ExpenseClaim" recordId={c.id} compact />
            {c.status === 'SUBMITTED' && can('expenses.approve') && c.claimantId !== me.id && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={c.policyBreaches ? 'Reason for approving the exceptions (required)' : 'Comment'} className="min-w-72 flex-1"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                <Button onClick={() => act.mutate({ action: 'reject', body: { reason: comment || 'Rejected' } })}>Reject</Button>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'approve', body: { comment: comment || undefined } })}>Approve & post</Button>
              </div>
            )}
            {c.status === 'APPROVED' && can('expenses.pay') && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Pay from">
                  <Select value={pay.bankAccountId || banks[0]?.id || ''} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}>
                    {banks.filter((b) => b.isActive).map((b) => (<option key={b.id} value={b.id}>{b.name}{b.currency !== c.currency ? ` (${b.currency}, at the day's rate)` : ''}</option>))}
                  </Select>
                </Field>
                <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
                <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'pay', body: { date: pay.date, bankAccountId: pay.bankAccountId || banks.find((b) => b.currency === c.currency)?.id } })}>Reimburse</Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

interface BudgetDoc {
  id: string;
  entityId: string;
  fiscalYearId: string;
  name: string;
  kind: 'BUDGET' | 'FORECAST';
  currency: string;
  notes: string;
  lines?: { accountId: string; branchId: string | null; departmentId: string | null; projectId: string | null; amounts: string[] }[];
  total: string;
  status: string;
  createdBy: string;
  submittedBy: string | null;
  createdAt: string;
}

export function BudgetsPage() {
  const { entity, me, can } = useSession();
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const years = useQuery({ queryKey: ['fiscal-years', entity?.id], queryFn: () => api.get<FiscalYear[]>('/fiscal-years', { entityId: entity!.id }) });
  const list = useQuery({ queryKey: ['budgets', entity?.id], queryFn: () => api.get<BudgetDoc[]>('/budgets', { entityId: entity!.id }) });
  const [editing, setEditing] = useState<null | { id?: string; name: string; kind: 'BUDGET' | 'FORECAST'; fiscalYearId: string; lines: { accountId: string; amounts: string[] }[] }>(null);
  const [error, setError] = useState<string | null>(null);
  const [uplift, setUplift] = useState('5');
  const fp = precision(entity?.functionalCurrency);
  const fy = years.data?.find((y) => y.id === editing?.fiscalYearId);
  const months = fy?.periods.map((p) => p.name.slice(0, 3)) ?? [];
  const plAccounts = accounts.filter((a) => a.isPostable && ['REVENUE', 'COST_OF_SALES', 'EXPENSE'].includes(a.accountClass));
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const e = editing!;
      const body = { entityId: entity!.id, fiscalYearId: e.fiscalYearId, name: e.name, kind: e.kind, lines: e.lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, amounts: l.amounts.map((a) => a || '0') })) };
      const saved = e.id ? await api.patch<BudgetDoc>(`/budgets/${e.id}`, body) : await api.post<BudgetDoc>('/budgets', body);
      if (submit) await api.post(`/budgets/${saved.id}/submit`);
    },
    onSuccess: () => (setEditing(null), setError(null), invalidate('budgets')),
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post(`/budgets/${id}/${action}`, action === 'reject' ? { reason: 'Please revise' } : {}),
    onSuccess: () => (setError(null), invalidate('budgets')),
    onError: (err) => setError(errorMessage(err)),
  });
  const seed = async () => {
    if (!editing) return;
    try {
      const rows = await api.get<{ accountId: string; amounts: string[] }[]>('/budgets/from-actuals', { entityId: entity!.id, fiscalYearId: editing.fiscalYearId, upliftPercent: uplift || '0' });
      setEditing({ ...editing, lines: rows.length ? rows : editing.lines });
      if (!rows.length) setError('No actuals in the previous fiscal year to start from.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const open = async (b?: BudgetDoc) => {
    setError(null);
    if (!b) {
      setEditing({ name: '', kind: 'BUDGET', fiscalYearId: years.data?.[0]?.id ?? '', lines: [{ accountId: '', amounts: Array(12).fill('') }] });
      return;
    }
    const full = await api.get<BudgetDoc>(`/budgets/${b.id}`);
    setEditing({ id: b.id, name: full.name, kind: full.kind, fiscalYearId: full.fiscalYearId, lines: (full.lines ?? []).map((l) => ({ accountId: l.accountId, amounts: l.amounts })) });
  };
  return (
    <>
      <PageHeader
        title="Budgets & forecasts"
        description="Monthly budgets by account. Approving a version supersedes the previous one; the approved budget drives budget-vs-actual reporting and spending control on purchases."
        actions={
          <>
            <LinkButton href="/finance/budgets/planning">Department submissions & changes</LinkButton>
            <LinkButton href="/finance/reports/budget-vs-actual">Budget vs actual</LinkButton>
            {can('budgets.manage') && <Button variant="primary" onClick={() => open()}>New budget</Button>}
          </>
        }
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No budgets yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Name</th><th>Type</th><th>Year</th><th>Status</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {list.data.map((b) => {
                const mine = b.createdBy === me.id || b.submittedBy === me.id;
                return (
                  <tr key={b.id}>
                    <td className="font-medium">{b.name}</td>
                    <td>{b.kind === 'BUDGET' ? 'Budget' : 'Forecast'}</td>
                    <td>{years.data?.find((y) => y.id === b.fiscalYearId)?.name}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="num">{formatAmount(b.total, fp)}</td>
                    <td className="whitespace-nowrap text-right">
                      {['DRAFT', 'REJECTED'].includes(b.status) && can('budgets.manage') && <Button size="sm" variant="ghost" onClick={() => open(b)}>Edit</Button>}
                      {b.status === 'SUBMITTED' && can('budgets.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: b.id, action: 'reject' })}>Reject</Button>
                          <Button size="sm" variant="primary" disabled={mine} onClick={() => act.mutate({ id: b.id, action: 'approve' })}>Approve</Button>
                        </>
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
        title={editing?.id ? 'Edit budget' : 'New budget'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>}
      >
        {editing && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name" className="sm:col-span-2"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Type">
                <Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as 'BUDGET' | 'FORECAST' })}>
                  <option value="BUDGET">Budget</option>
                  <option value="FORECAST">Forecast</option>
                </Select>
              </Field>
              <Field label="Fiscal year">
                <Select value={editing.fiscalYearId} onChange={(e) => setEditing({ ...editing, fiscalYearId: e.target.value })}>
                  {years.data?.map((y) => (<option key={y.id} value={y.id}>{y.name}</option>))}
                </Select>
              </Field>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Start from last year's actuals +%"><Input className="w-24" value={uplift} onChange={(e) => amountPattern.test(e.target.value) && setUplift(e.target.value)} /></Field>
              <Button size="sm" onClick={seed}>Fill from actuals</Button>
            </div>
            <div className="max-h-[50vh] overflow-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th className="min-w-52">Account</th>
                    {months.map((m, i) => (<th key={i} className="num">{m}</th>))}
                    <th className="num">Year</th>
                  </tr>
                </thead>
                <tbody>
                  {editing.lines.map((l, i) => {
                    const set = (p: Partial<typeof l>) => setEditing({ ...editing, lines: editing.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    return (
                      <tr key={i}>
                        <td>
                          <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
                            <option value="">Select…</option>
                            {plAccounts.map((a) => (<option key={a.id} value={a.id}>{a.code} · {a.name}</option>))}
                          </Select>
                        </td>
                        {months.map((_, m) => (
                          <td key={m}>
                            <Input className="h-8 w-24 text-right text-xs" inputMode="decimal" value={l.amounts[m] ?? ''} onChange={(e) => amountPattern.test(e.target.value) && set({ amounts: l.amounts.map((x, k) => (k === m ? e.target.value : x)) })} aria-label={`${months[m]} amount`} />
                          </td>
                        ))}
                        <td className="num text-xs">{formatAmount(addAll(l.amounts), fp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, lines: [...editing.lines, { accountId: '', amounts: Array(months.length || 12).fill('') }] })}>+ Add account</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

interface BvA {
  currency: string;
  budget: { id: string; name: string } | null;
  forecast: { id: string; name: string } | null;
  rows: { accountId: string; code: string; name: string; accountClass: string; budget: string; originalBudget?: string | null; forecast: string | null; actual: string; variance: string; variancePercent: string | null; favourable: boolean }[];
  totals: { revenueBudget: string; revenueActual: string; netBudget: string; netActual: string };
}

export function BudgetVsActualReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data: dimensions = [] } = useDimensions();
  // Budgets are monthly, so the default compares whole months: the year to the end of last month.
  const [q, setQ] = useState(() => {
    const now = new Date();
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const to = lastMonthEnd < startOfYear() ? today() : lastMonthEnd;
    return { from: startOfYear(), to, branchId: '', departmentId: '', projectId: '' };
  });
  const { data, isLoading, error } = useQuery({ queryKey: ['bva', entity?.id, q], queryFn: () => api.get<BvA>('/reports/budget-vs-actual', { entityId: entity!.id, ...q }) });
  const fp = precision(data?.currency);
  const revised = !!data?.rows.some((r) => r.originalBudget !== null && r.originalBudget !== undefined);
  const sections = useMemo(() => [['REVENUE', 'Revenue'], ['COST_OF_SALES', 'Cost of sales'], ['EXPENSE', 'Operating expenses']] as const, []);
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="From"><Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
        <Field label="Branch"><Select value={q.branchId} onChange={(e) => setQ({ ...q, branchId: e.target.value })}><option value="">All</option>{branches.map((b) => (<option key={b.id} value={b.id}>{b.code}</option>))}</Select></Field>
        <Field label="Department"><Select value={q.departmentId} onChange={(e) => setQ({ ...q, departmentId: e.target.value })}><option value="">All</option>{dimensions.filter((d) => d.type === 'DEPARTMENT').map((d) => (<option key={d.id} value={d.id}>{d.code}</option>))}</Select></Field>
        <Field label="Project"><Select value={q.projectId} onChange={(e) => setQ({ ...q, projectId: e.target.value })}><option value="">All</option>{dimensions.filter((d) => d.type === 'PROJECT').map((d) => (<option key={d.id} value={d.id}>{d.code}</option>))}</Select></Field>
        {data && <Button onClick={() => downloadCsv(`budget-vs-actual-${q.from}-${q.to}.csv`, ['Code', 'Account', 'Budget', 'Forecast', 'Actual', 'Variance', 'Variance %'], data.rows.map((r) => [r.code, r.name, r.budget, r.forecast, r.actual, r.variance, r.variancePercent]))}>Export CSV</Button>}
      </div>
      <ReportTitle title="Budget vs actual" subtitle={`${formatDate(q.from)} – ${formatDate(q.to)} · ${data?.budget ? data.budget.name : 'no approved budget'}${data?.forecast ? ` · forecast: ${data.forecast.name}` : ''} · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : !data.budget ? (
        <Notice tone="amber">There is no approved budget for this period. Create one under Budgets & forecasts.</Notice>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr><th>Account</th>{revised && <th className="num">Original budget</th>}<th className="num">{revised ? 'Final budget' : 'Budget'}</th>{data.forecast && <th className="num">Forecast</th>}<th className="num">Actual</th><th className="num">Variance</th><th className="num">%</th></tr>
            </thead>
            <tbody>
              {sections.map(([cls, title]) => {
                const rows = data.rows.filter((r) => r.accountClass === cls);
                if (!rows.length) return null;
                return [
                  <tr key={cls} className="bg-gray-50"><td colSpan={5 + (data.forecast ? 1 : 0) + (revised ? 1 : 0)} className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</td></tr>,
                  ...rows.map((r) => (
                    <tr key={r.accountId}>
                      <td><span className="font-mono text-xs">{r.code}</span> {r.name}</td>
                      {revised && <td className="num text-muted">{formatAmount(r.originalBudget ?? '0', fp)}</td>}
                      <td className="num">{formatAmount(r.budget, fp)}</td>
                      {data.forecast && <td className="num text-muted">{r.forecast ? formatAmount(r.forecast, fp) : ''}</td>}
                      <td className="num">{formatAmount(r.actual, fp)}</td>
                      <td className={cx('num', r.favourable ? 'text-emerald-700' : 'text-red-700')}>{formatAmount(r.variance, fp, { parens: true })}</td>
                      <td className={cx('num text-xs', r.favourable ? 'text-emerald-700' : 'text-red-700')}>{r.variancePercent !== null ? `${r.variancePercent}%` : ''}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Net result</td>
                {revised && <td />}
                <td className="num">{formatAmount(data.totals.netBudget, fp, { parens: true })}</td>
                {data.forecast && <td />}
                <td className="num">{formatAmount(data.totals.netActual, fp, { parens: true })}</td>
                <td className="num">{formatAmount(addAll([data.totals.netActual, `-${data.totals.netBudget}`.replace('--', '')]), fp, { parens: true })}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      )}
    </>
  );
}

interface ProjectRow {
  projectId: string;
  code: string;
  name: string;
  status: string;
  customerId: string | null;
  customer: string | null;
  contractValue: string | null;
  budgetCost: string | null;
  revenue: string;
  cost: string;
  margin: string;
  marginPercent: string | null;
  budgetUsedPercent: string | null;
  billedPercent: string | null;
}

export function ProjectsReport() {
  const { entity, can } = useSession();
  const invalidate = useInvalidate();
  const precision = usePrecision();
  const { data: customers = [] } = useParties('CUSTOMER');
  const [asOf, setAsOf] = useState(today());
  const [editing, setEditing] = useState<null | { id: string; contractValue: string; budgetCost: string; customerId: string; status: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['projects-report', entity?.id, asOf], queryFn: () => api.get<{ currency: string; rows: ProjectRow[] }>('/reports/projects', { entityId: entity!.id, asOf }) });
  const save = useMutation({
    mutationFn: () => api.patch(`/dimensions/${editing!.id}`, { project: { contractValue: editing!.contractValue || null, budgetCost: editing!.budgetCost || null, customerId: editing!.customerId || null, status: editing!.status } }),
    onSuccess: () => (setEditing(null), setError(null), invalidate('projects-report', 'dimensions')),
    onError: (err) => setError(errorMessage(err)),
  });
  const fp = precision(data?.currency);
  const pct = (v: string | null) => (v === null ? '' : `${v}%`);
  return (
    <>
      <div className="no-print mb-4 flex items-end gap-2">
        <Field label="As at"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      </div>
      <ReportTitle title="Project profitability" subtitle={`Revenue and costs tagged to each project, against its contract value and cost budget · ${data?.currency ?? ''}`} />
      <TableWrap>
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <Empty title="No projects">Add projects under Entities & branches → dimensions.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Project</th><th>Customer</th><th>Status</th><th className="num">Contract</th><th className="num">Revenue</th><th className="num">Billed</th><th className="num">Cost budget</th><th className="num">Cost</th><th className="num">Budget used</th><th className="num">Margin</th><th /></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.projectId}>
                  <td><span className="font-mono text-xs">{r.code}</span> {r.name}</td>
                  <td className="text-muted">{r.customer}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="num">{r.contractValue ? formatAmount(r.contractValue, fp) : ''}</td>
                  <td className="num">{formatAmount(r.revenue, fp)}</td>
                  <td className="num text-xs">{pct(r.billedPercent)}</td>
                  <td className="num">{r.budgetCost ? formatAmount(r.budgetCost, fp) : ''}</td>
                  <td className="num">{formatAmount(r.cost, fp)}</td>
                  <td className={cx('num text-xs', r.budgetUsedPercent && Number(r.budgetUsedPercent) > 100 && 'text-red-700')}>{pct(r.budgetUsedPercent)}</td>
                  <td className={cx('num font-medium', r.margin.startsWith('-') ? 'text-red-700' : '')}>{formatAmount(r.margin, fp, { parens: true })} <span className="text-xs text-muted">{pct(r.marginPercent)}</span></td>
                  <td className="text-right">{can('structure.manage') && <Button size="sm" variant="ghost" onClick={() => setEditing({ id: r.projectId, contractValue: r.contractValue ?? '', budgetCost: r.budgetCost ?? '', customerId: r.customerId ?? '', status: r.status })}>Details</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Project details" footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBanner error={error} className="sm:col-span-2" />
            <Field label="Contract value"><Input inputMode="decimal" value={editing.contractValue} onChange={(e) => positive.test(e.target.value) && setEditing({ ...editing, contractValue: e.target.value })} /></Field>
            <Field label="Cost budget"><Input inputMode="decimal" value={editing.budgetCost} onChange={(e) => positive.test(e.target.value) && setEditing({ ...editing, budgetCost: e.target.value })} /></Field>
            <Field label="Customer">
              <Select value={editing.customerId} onChange={(e) => setEditing({ ...editing, customerId: e.target.value })}>
                <option value="">None</option>
                {customers.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                {['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED'].map((s) => (<option key={s} value={s}>{s.toLowerCase().replace('_', ' ')}</option>))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}
