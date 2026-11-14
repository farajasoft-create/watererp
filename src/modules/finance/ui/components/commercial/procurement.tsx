'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { PurchaseOrder, Requisition, rateOn } from '@/modules/finance/ui/lib/commercial';
import { useBankAccounts, useParties, useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { Lot, LotsButton, lotsBody } from '../lots';
import { addAll, divide, formatAmount, formatDate, fromUnits, isZero, multiply, roundTo, today, toUnits } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { Paged } from '@/modules/finance/ui/lib/types';
import { Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Pager, Select, StatusBadge, TableWrap } from '../ui';
import { AccountOptions, ApprovalTrail, Facts, ReasonDialog, useActions } from './shared';
import { ApprovalHistory } from '../workflow';
import { AttachmentsCard } from '../attachments';
import { useApplyOnce } from '@/modules/finance/ui/lib/hooks';
import { LpoPanel, type LpoOrder } from './lpo-panel';

const amountPattern = /^\d*(\.\d*)?$/;

function StatusFilter({ value, onChange, statuses }: { value: string; onChange: (v: string) => void; statuses: [string, string][] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {statuses.map(([v, label]) => (
        <button
          key={v || 'all'}
          onClick={() => onChange(v)}
          className={cx('rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset', value === v ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-muted ring-line hover:text-ink')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------------------------

export function RequisitionList() {
  const router = useRouter();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['requisitions', entity?.id, status, page],
    queryFn: () => api.get<Paged<Requisition>>('/requisitions', { entityId: entity!.id, status, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Purchase requisitions"
        description="Requests to buy, approved within delegated limits before a purchase order is raised."
        actions={can('procurement.request') && <LinkButton variant="primary" href="/finance/purchases/requisitions/new">New requisition</LinkButton>}
      />
      <StatusFilter
        value={status}
        onChange={(v) => (setStatus(v), setPage(1))}
        statuses={[['', 'All'], ['DRAFT', 'Drafts'], ['SUBMITTED', 'Awaiting approval'], ['APPROVED', 'Approved'], ['ORDERED', 'Ordered'], ['REJECTED', 'Rejected']]}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No requisitions" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Description</th>
                <th>Requested by</th>
                <th>Needed by</th>
                <th>Status</th>
                <th className="num">Estimate</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => router.push(`/finance/purchases/requisitions/${r.id}`)}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{r.number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td className="max-w-md truncate">{r.description}</td>
                  <td className="text-muted">{r.createdByName}</td>
                  <td>{formatDate(r.requiredBy)}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="num">{formatAmount(r.estimatedTotal, precision(r.currency))} <span className="text-xs text-muted">{r.currency}</span></td>
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

interface ReqLine {
  key: number;
  description: string;
  accountId: string;
  quantity: string;
  estimatedUnitPrice: string;
  departmentId: string;
  planItemId: string;
}
let reqKey = 1;

interface PlanItemOption { id: string; itemNo: number; description: string; accountId: string; departmentId: string | null; estimatedCost: string; left: string }

export function RequisitionForm({ existing }: { existing?: Requisition }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const { data: dimensions = [] } = useDimensions();
  const [header, setHeader] = useState({
    branchId: existing?.branchId ?? '',
    date: existing?.date.slice(0, 10) ?? today(),
    requiredBy: existing?.requiredBy?.slice(0, 10) ?? '',
    description: existing?.description ?? '',
  });
  const [lines, setLines] = useState<ReqLine[]>(
    existing?.lines.map((l) => ({ key: reqKey++, description: l.description, accountId: l.accountId ?? '', quantity: l.quantity, estimatedUnitPrice: l.estimatedUnitPrice, departmentId: l.departmentId ?? '', planItemId: l.planItemId ?? '' })) ?? [
      { key: reqKey++, description: '', accountId: '', quantity: '1', estimatedUnitPrice: '', departmentId: '', planItemId: '' },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const fp = precision(entity!.functionalCurrency);
  const total = addAll(lines.map((l) => roundTo(multiply(l.quantity || '0', l.estimatedUnitPrice || '0'), fp)));
  const branchId = header.branchId || branches[0]?.id || '';
  const update = (key: number, patch: Partial<ReqLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const plan = useQuery({
    queryKey: ['plan-items', entity!.id, header.date],
    queryFn: () => api.get<{ plan: { number: string; title: string } | null; items: PlanItemOption[] }>('/procurement-plans/items', { entityId: entity!.id, date: header.date }),
    enabled: !!header.date,
  });
  const planItems = plan.data?.items ?? [];
  const pickItem = (key: number, id: string) => {
    const item = planItems.find((i) => i.id === id);
    update(key, item ? { planItemId: id, accountId: item.accountId, departmentId: item.departmentId ?? '' } : { planItemId: '' });
  };

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = {
        entityId: entity!.id,
        branchId,
        date: header.date,
        requiredBy: header.requiredBy || null,
        description: header.description,
        lines: lines
          .filter((l) => l.description)
          .map((l) => ({ description: l.description, accountId: l.accountId || null, quantity: l.quantity || '0', estimatedUnitPrice: l.estimatedUnitPrice || '0', departmentId: l.departmentId || null, planItemId: l.planItemId || null })),
      };
      const saved = existing ? await api.patch<Requisition>(`/requisitions/${existing.id}`, body) : await api.post<Requisition>('/requisitions', body);
      if (submit) await api.post(`/requisitions/${saved.id}/submit`, {});
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['requisitions'] });
      queryClient.invalidateQueries({ queryKey: ['requisition', saved.id] });
      router.push(`/finance/purchases/requisitions/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = (e: FormEvent, s: boolean) => {
    e.preventDefault();
    setError(null);
    save.mutate(s);
  };

  return (
    <form onSubmit={(e) => submit(e, false)} className="space-y-4">
      <ErrorBanner error={error} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="What is needed and why" className="md:col-span-4">
            <Input required maxLength={500} value={header.description} onChange={(e) => setHeader({ ...header, description: e.target.value })} />
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              {branches.filter((b) => b.isActive).map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} />
          </Field>
          <Field label="Needed by">
            <Input type="date" value={header.requiredBy} min={header.date} onChange={(e) => setHeader({ ...header, requiredBy: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card padded={false} title="Items">
        <table className="table-base">
          <thead>
            <tr>
              <th className="min-w-56">Description</th>
              {planItems.length > 0 && <th className="min-w-48">Plan item</th>}
              <th className="min-w-56">Expense account</th>
              <th>Department</th>
              <th className="num w-24">Qty</th>
              <th className="num w-32">Est. unit price</th>
              <th className="num">Estimate</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Item ${i + 1}`} /></td>
                {planItems.length > 0 && (
                  <td>
                    <Select className="h-8 text-xs" value={l.planItemId} onChange={(e) => pickItem(l.key, e.target.value)} aria-label="Procurement plan item">
                      <option value="">Not in the plan</option>
                      {planItems.map((p) => (
                        <option key={p.id} value={p.id}>{p.itemNo}. {p.description} ({formatAmount(p.left, fp)} left)</option>
                      ))}
                    </Select>
                  </td>
                )}
                <td>
                  <Select className="h-8 text-xs" value={l.accountId} disabled={!!l.planItemId} onChange={(e) => update(l.key, { accountId: e.target.value })} aria-label="Account">
                    <AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES', 'ASSET']} placeholder="Not sure" />
                  </Select>
                </td>
                <td>
                  <Select className="h-8 text-xs" value={l.departmentId} onChange={(e) => update(l.key, { departmentId: e.target.value })} aria-label="Department">
                    <option value="">—</option>
                    {dimensions.filter((d) => d.type === 'DEPARTMENT' && d.isActive).map((d) => (
                      <option key={d.id} value={d.id}>{d.code}</option>
                    ))}
                  </Select>
                </td>
                <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.quantity} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { quantity: e.target.value })} aria-label="Quantity" /></td>
                <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.estimatedUnitPrice} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { estimatedUnitPrice: e.target.value })} aria-label="Price" /></td>
                <td className="num text-xs">{formatAmount(multiply(l.quantity || '0', l.estimatedUnitPrice || '0'), fp)}</td>
                <td>
                  <button type="button" className="rounded p-1 text-muted hover:text-red-700 disabled:opacity-30" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove">
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={planItems.length > 0 ? 6 : 5}>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { key: reqKey++, description: '', accountId: '', quantity: '1', estimatedUnitPrice: '', departmentId: '', planItemId: '' }])}>
                  + Add item
                </Button>
              </td>
              <td className="num">{formatAmount(total, fp)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </Card>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={save.isPending && !save.variables}>Save draft</Button>
        <Button type="button" variant="primary" loading={save.isPending && save.variables === true} onClick={(e) => submit(e, true)}>
          Save & submit
        </Button>
      </div>
    </form>
  );
}

export function RequisitionView({ id }: { id: string }) {
  const { me, can } = useSession();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const { data: r, isLoading } = useQuery({
    queryKey: ['requisition', id],
    queryFn: () => api.get<Requisition & { purchaseOrders: { id: string; number: string; status: string; supplierName: string; total: string; currency: string }[] }>(`/requisitions/${id}`),
  });
  const actions = useActions(`/requisitions/${id}`, [['requisition', id], ['requisitions']], setError);
  if (isLoading || !r) return <Loading />;
  const fp = precision(r.currency);
  const mine = r.createdBy === me.id || r.submittedBy === me.id;
  return (
    <>
      <PageHeader
        title={`Requisition ${r.number}`}
        description={<span className="inline-flex items-center gap-2"><StatusBadge status={r.status} /> {r.description}</span>}
        actions={
          <>
            {['DRAFT', 'REJECTED'].includes(r.status) && can('procurement.request') && (
              <>
                <LinkButton href={`/finance/purchases/requisitions/${r.id}/edit`}>Edit</LinkButton>
                <Button variant="primary" loading={actions.busy('submit')} onClick={() => actions.run('submit')}>Submit</Button>
              </>
            )}
            {r.status === 'SUBMITTED' && can('procurement.approve') && (
              <>
                <Button onClick={() => setRejecting(true)}>Reject</Button>
                <Button variant="primary" disabled={mine} loading={actions.busy('approve')} onClick={() => actions.run('approve')}>Approve</Button>
              </>
            )}
            {['APPROVED', 'ORDERED'].includes(r.status) && can('procurement.manage') && (
              <LinkButton variant="primary" href={`/finance/purchases/orders/new?requisition=${r.id}`}>Create purchase order</LinkButton>
            )}
            {['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'].includes(r.status) && can('procurement.request') && (
              <Button variant="ghost" loading={actions.busy('cancel')} onClick={() => actions.run('cancel')}>Cancel requisition</Button>
            )}
          </>
        }
      />
      <div className="space-y-4">
        <ErrorBanner error={error} />
        {r.status === 'SUBMITTED' && mine && can('procurement.approve') && <Notice tone="amber">You raised this requisition, so someone else must approve it.</Notice>}
        {r.status === 'REJECTED' && <Notice tone="amber">Rejected: {r.rejectionReason}</Notice>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <Facts items={[['Date', formatDate(r.date)], ['Needed by', formatDate(r.requiredBy)], ['Estimate', `${formatAmount(r.estimatedTotal, fp)} ${r.currency}`], ['Orders', r.purchaseOrders.map((o) => o.number).join(', ')]]} />
          </Card>
          <ApprovalTrail record={r} approvedLabel="Approved" />
        </div>
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th>Account</th>
                <th className="num">Qty</th>
                <th className="num">Est. unit price</th>
                <th className="num">Estimate</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="text-xs text-muted">{l.lineNo}</td>
                  <td>{l.description}</td>
                  <td className="text-xs">{accounts.find((a) => a.id === l.accountId)?.name ?? '—'}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{formatAmount(l.estimatedUnitPrice, fp)}</td>
                  <td className="num">{formatAmount(multiply(l.quantity, l.estimatedUnitPrice), fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {!!r.purchaseOrders.length && (
          <Card title="Purchase orders">
            <ul className="space-y-1 text-sm">
              {r.purchaseOrders.map((o) => (
                <li key={o.id}>
                  <Link className="text-brand-700 hover:underline" href={`/finance/purchases/orders/${o.id}`}>{o.number}</Link> · {o.supplierName} · <StatusBadge status={o.status} /> {formatAmount(o.total, precision(o.currency))} {o.currency}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <ApprovalHistory documentType="PURCHASE_REQUISITION" documentId={r.id} />
      <AttachmentsCard recordType="PurchaseRequisition" recordId={r.id} />
      <ReasonDialog open={rejecting} title={`Reject ${r.number}`} confirmLabel="Reject" busy={actions.busy('reject')} onClose={() => setRejecting(false)} onConfirm={async ({ reason }) => (await actions.run('reject', { reason }), setRejecting(false))} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------------------------

export function OrderList() {
  const router = useRouter();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['purchase-orders', entity?.id, status, page],
    queryFn: () => api.get<Paged<PurchaseOrder>>('/purchase-orders', { entityId: entity!.id, status, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Approved orders are received with goods-received notes and matched to supplier bills."
        actions={can('procurement.manage') && <LinkButton variant="primary" href="/finance/purchases/orders/new">New purchase order</LinkButton>}
      />
      <StatusFilter
        value={status}
        onChange={(v) => (setStatus(v), setPage(1))}
        statuses={[['', 'All'], ['DRAFT', 'Drafts'], ['SUBMITTED', 'Awaiting approval'], ['OPEN', 'Open for receipt'], ['RECEIVED', 'Received'], ['CLOSED', 'Closed']]}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No purchase orders" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Supplier</th>
                <th>Expected</th>
                <th>Status</th>
                <th className="num">Received</th>
                <th className="num">Billed</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className="cursor-pointer" onClick={() => router.push(`/finance/purchases/orders/${o.id}`)}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{o.number}</td>
                  <td>{formatDate(o.date)}</td>
                  <td>{o.supplierName}</td>
                  <td>{formatDate(o.expectedDate)}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td className="num">{o.receivedPercent}%</td>
                  <td className="num">{o.billedPercent}%</td>
                  <td className="num">{formatAmount(o.total, precision(o.currency))} <span className="text-xs text-muted">{o.currency}</span></td>
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

interface OrderLine {
  key: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
  departmentId: string;
  itemId: string;
  warehouseId: string;
  planItemId: string;
}
let orderKey = 1;
const blankOrderLine = (p: Partial<OrderLine> = {}): OrderLine => ({ key: orderKey++, description: '', accountId: '', quantity: '1', unitPrice: '', taxCodeId: '', departmentId: '', itemId: '', warehouseId: '', planItemId: '', ...p });

export function OrderForm({ existing }: { existing?: PurchaseOrder }) {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: suppliers = [] } = useParties('SUPPLIER');
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const { data: taxCodes = [] } = useTaxCodes();
  const { data: items = [] } = useItems();
  const { data: allWarehouses = [] } = useWarehouses();
  const warehouses = allWarehouses.filter((w) => w.entityId === entity!.id && w.isActive);
  const stockItems = items.filter((i) => i.type === 'STOCK' && i.isActive);
  const requisitionId = existing?.requisitionId ?? params.get('requisition');
  const [header, setHeader] = useState({
    supplierId: existing?.supplierId ?? '',
    branchId: existing?.branchId ?? '',
    date: existing?.date.slice(0, 10) ?? today(),
    expectedDate: existing?.expectedDate?.slice(0, 10) ?? '',
    reference: existing?.reference ?? '',
    deliveryAddress: existing?.deliveryAddress ?? '',
    notes: existing?.notes ?? '',
    priceIncludesTax: existing?.priceIncludesTax ?? false,
  });
  const [lines, setLines] = useState<OrderLine[]>(
    existing?.lines.map((l) => blankOrderLine({ description: l.description, accountId: l.accountId, quantity: l.quantity, unitPrice: l.unitPrice, taxCodeId: l.taxCodeId ?? '', departmentId: l.departmentId ?? '', itemId: l.itemId ?? '', warehouseId: l.warehouseId ?? '', planItemId: l.planItemId ?? '' })) ?? [blankOrderLine()],
  );
  const [error, setError] = useState<string | null>(null);

  const requisition = useQuery({ queryKey: ['requisition', requisitionId], queryFn: () => api.get<Requisition>(`/requisitions/${requisitionId}`), enabled: !!requisitionId && !existing });
  useApplyOnce(requisition.data, (r) => {
    setHeader((h) => ({ ...h, branchId: r.branchId, notes: r.description }));
    setLines(r.lines.map((l) => blankOrderLine({ description: l.description, accountId: l.accountId ?? '', quantity: l.quantity, unitPrice: l.estimatedUnitPrice, departmentId: l.departmentId ?? '', planItemId: l.planItemId ?? '' })));
  });

  const supplier = suppliers.find((s) => s.id === header.supplierId);
  const currency = supplier?.currency ?? entity!.functionalCurrency;
  const tp = precision(currency);
  const branchId = header.branchId || branches[0]?.id || '';
  const amounts = lines.map((l) => {
    const rate = rateOn(taxCodes.find((t) => t.id === l.taxCodeId), header.date);
    const gross = roundTo(multiply(l.quantity || '0', l.unitPrice || '0'), tp);
    if (header.priceIncludesTax) {
      const net = roundTo(divide(multiply(gross, '100'), addAll(['100', rate])), tp);
      return { net, tax: fromUnits(toUnits(gross) - toUnits(net)) };
    }
    return { net: gross, tax: roundTo(divide(multiply(gross, rate), '100'), tp) };
  });
  const total = addAll(amounts.flatMap((a) => [a.net, a.tax]));
  const update = (key: number, patch: Partial<OrderLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = {
        entityId: entity!.id,
        branchId,
        supplierId: header.supplierId,
        date: header.date,
        expectedDate: header.expectedDate || null,
        reference: header.reference || undefined,
        deliveryAddress: header.deliveryAddress || undefined,
        notes: header.notes || undefined,
        requisitionId: requisitionId || null,
        priceIncludesTax: header.priceIncludesTax,
        lines: lines
          .filter((l) => l.description)
          .map((l) => ({ description: l.description, accountId: l.accountId, quantity: l.quantity || '0', unitPrice: l.unitPrice || '0', taxCodeId: l.taxCodeId || null, departmentId: l.departmentId || null, itemId: l.itemId || null, warehouseId: l.itemId ? l.warehouseId || null : null, planItemId: l.planItemId || null })),
      };
      const saved = existing ? await api.patch<PurchaseOrder>(`/purchase-orders/${existing.id}`, body) : await api.post<PurchaseOrder>('/purchase-orders', body);
      if (submit) await api.post(`/purchase-orders/${saved.id}/submit`, {});
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-order', saved.id] });
      router.push(`/finance/purchases/orders/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = (e: FormEvent, s: boolean) => {
    e.preventDefault();
    setError(null);
    save.mutate(s);
  };

  return (
    <form onSubmit={(e) => submit(e, false)} className="space-y-4">
      <ErrorBanner error={error} />
      {requisition.data && <Notice>Raised from requisition {requisition.data.number}. Adjust prices to the supplier&apos;s quote.</Notice>}
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Supplier" className="md:col-span-2">
            <Select required value={header.supplierId} onChange={(e) => setHeader({ ...header, supplierId: e.target.value })}>
              <option value="">Select supplier…</option>
              {suppliers.filter((s) => s.isActive).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.code}) · {s.currency}</option>
              ))}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              {branches.filter((b) => b.isActive).map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Input disabled value={currency} />
          </Field>
          <Field label="Order date">
            <Input type="date" value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} />
          </Field>
          <Field label="Expected delivery">
            <Input type="date" value={header.expectedDate} min={header.date} onChange={(e) => setHeader({ ...header, expectedDate: e.target.value })} />
          </Field>
          <Field label="Supplier quote / reference">
            <Input value={header.reference} onChange={(e) => setHeader({ ...header, reference: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Checkbox label="Prices include tax" checked={header.priceIncludesTax} onChange={(v) => setHeader({ ...header, priceIncludesTax: v })} />
          </div>
          <Field label="Deliver to" className="md:col-span-2">
            <Input value={header.deliveryAddress} onChange={(e) => setHeader({ ...header, deliveryAddress: e.target.value })} />
          </Field>
          <Field label="Notes" className="md:col-span-2">
            <Input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card padded={false} title="Lines">
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="min-w-56">Description</th>
                <th className="min-w-44">Stock item</th>
                <th className="min-w-56">Account / warehouse</th>
                <th className="num w-24">Qty</th>
                <th className="num w-32">Unit price</th>
                <th className="min-w-32">Tax</th>
                <th className="num">Net</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Line ${i + 1}`} /></td>
                  <td>
                    <Select
                      className="h-8 text-xs"
                      value={l.itemId}
                      onChange={(e) => {
                        const item = stockItems.find((x) => x.id === e.target.value);
                        update(l.key, item ? { itemId: item.id, accountId: item.inventoryAccountId ?? l.accountId, description: l.description || item.name, warehouseId: l.warehouseId || warehouses[0]?.id || '' } : { itemId: '', warehouseId: '' });
                      }}
                      aria-label="Stock item"
                    >
                      <option value="">Not stock</option>
                      {stockItems.map((i) => (
                        <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    {l.itemId ? (
                      <Select className="h-8 text-xs" required value={l.warehouseId} onChange={(e) => update(l.key, { warehouseId: e.target.value })} aria-label="Warehouse">
                        <option value="">Receive into…</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                        ))}
                      </Select>
                    ) : (
                      <Select className="h-8 text-xs" required value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} aria-label="Account">
                        <AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES', 'ASSET']} />
                      </Select>
                    )}
                  </td>
                  <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.quantity} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { quantity: e.target.value })} aria-label="Quantity" /></td>
                  <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.unitPrice} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { unitPrice: e.target.value })} aria-label="Unit price" /></td>
                  <td>
                    <Select className="h-8 text-xs" value={l.taxCodeId} onChange={(e) => update(l.key, { taxCodeId: e.target.value })} aria-label="Tax">
                      <option value="">No tax</option>
                      {taxCodes.filter((t) => t.kind === 'VAT' && t.isActive).map((t) => (
                        <option key={t.id} value={t.id}>{t.code} ({rateOn(t, header.date)}%)</option>
                      ))}
                    </Select>
                  </td>
                  <td className="num text-xs">{formatAmount(amounts[i].net, tp)}</td>
                  <td>
                    <button type="button" className="rounded p-1 text-muted hover:text-red-700 disabled:opacity-30" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blankOrderLine()])}>+ Add line</Button>
                </td>
                <td className="num">{formatAmount(total, tp)} <span className="text-xs font-normal text-muted">incl. tax</span></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={save.isPending && !save.variables}>Save draft</Button>
        <Button type="button" variant="primary" loading={save.isPending && save.variables === true} onClick={(e) => submit(e, true)}>Save & submit</Button>
      </div>
    </form>
  );
}

interface OrderDetail extends PurchaseOrder {
  receipts: {
    id: string;
    number: string;
    date: string;
    reference: string;
    status: 'POSTED' | 'REVERSED';
    journalId: string | null;
    reversalReason: string;
    lines: { poLineNo: number; description: string; quantity: string; value: string | null }[];
  }[];
  bills: { id: string; number: string; status: string; date: string; total: string; supplierInvoiceNumber: string; matchStatus: string }[];
  requisitionNumber: string | null;
}

export function OrderView({ id }: { id: string }) {
  const { me, can } = useSession();
  const precision = usePrecision();
  const { data: accounts = [] } = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [reversing, setReversing] = useState<OrderDetail['receipts'][number] | null>(null);
  const { data: warehouses = [] } = useWarehouses();
  const queryClient = useQueryClient();
  const { data: o, isLoading } = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api.get<OrderDetail>(`/purchase-orders/${id}`) });
  const reverse = useMutation({
    mutationFn: (v: { id: string; reason: string; date: string }) => api.post(`/goods-receipts/${v.id}/reverse`, { reason: v.reason, date: v.date }),
    onSuccess: () => {
      setError(null);
      setReversing(null);
      queryClient.invalidateQueries({ queryKey: ['purchase-order', id] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const actions = useActions(`/purchase-orders/${id}`, [['purchase-order', id], ['purchase-orders']], setError);
  if (isLoading || !o) return <Loading />;
  const tp = precision(o.currency);
  const mine = o.createdBy === me.id || o.submittedBy === me.id;
  const openForReceipt = ['APPROVED', 'PARTIALLY_RECEIVED'].includes(o.status);
  const unbilled = o.lines.some((l) => toUnits(l.quantityReceived) > toUnits(l.quantityBilled));
  return (
    <>
      <PageHeader
        title={`Purchase order ${o.number}`}
        description={<span className="inline-flex items-center gap-2"><StatusBadge status={o.status} /> {o.supplierName}</span>}
        actions={
          <>
            <Button onClick={() => window.print()}>Print</Button>
            {['DRAFT', 'REJECTED'].includes(o.status) && can('procurement.manage') && (
              <>
                <LinkButton href={`/finance/purchases/orders/${o.id}/edit`}>Edit</LinkButton>
                <Button variant="primary" loading={actions.busy('submit')} onClick={() => actions.run('submit')}>Submit</Button>
              </>
            )}
            {o.status === 'SUBMITTED' && can('procurement.approve') && (
              <>
                <Button onClick={() => setRejecting(true)}>Reject</Button>
                <Button variant="primary" disabled={mine} loading={actions.busy('approve')} onClick={() => actions.run('approve')}>Approve</Button>
              </>
            )}
            {openForReceipt && can('procurement.manage') && <Button variant="primary" onClick={() => setReceiving(true)}>Receive goods</Button>}
            {unbilled && can('ap.manage') && <LinkButton href={`/finance/purchases/bills/new?po=${o.id}`}>Create bill</LinkButton>}
            {['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(o.status) && can('procurement.manage') && (
              <Button variant="ghost" loading={actions.busy('close')} onClick={() => actions.run('close')}>Close</Button>
            )}
            {['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'].includes(o.status) && can('procurement.manage') && (
              <Button variant="ghost" loading={actions.busy('cancel')} onClick={() => actions.run('cancel')}>Cancel order</Button>
            )}
          </>
        }
      />
      <div className="space-y-4">
        <ErrorBanner error={error} />
        {o.status === 'SUBMITTED' && mine && can('procurement.approve') && <Notice tone="amber">You raised this order, so someone else must approve it.</Notice>}
        {o.status === 'REJECTED' && <Notice tone="amber">Rejected: {o.rejectionReason}</Notice>}
        <LpoPanel order={o as unknown as LpoOrder} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <Facts
              items={[
                ['Supplier', <Link key="s" className="text-brand-700 hover:underline" href={`/finance/purchases/suppliers/${o.supplierId}`}>{o.supplierName}</Link>],
                ['Order date', formatDate(o.date)],
                ['Expected', formatDate(o.expectedDate)],
                ['Reference', o.reference],
                ['Requisition', o.requisitionId ? <Link key="r" className="text-brand-700 hover:underline" href={`/finance/purchases/requisitions/${o.requisitionId}`}>{o.requisitionNumber}</Link> : ''],
                ['Total', `${formatAmount(o.total, tp)} ${o.currency}`],
                ['Received', `${o.receivedPercent}%`],
                ['Billed', `${o.billedPercent}%`],
              ]}
            />
          </Card>
          <ApprovalTrail record={o} approvedLabel="Approved" />
        </div>
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>Description</th>
                <th>Account</th>
                <th className="num">Ordered</th>
                <th className="num">Received</th>
                <th className="num">Billed</th>
                <th className="num">Unit price</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="text-xs text-muted">{l.lineNo}</td>
                  <td>{l.description}</td>
                  <td className="text-xs">
                    {accounts.find((a) => a.id === l.accountId)?.name}
                    {l.warehouseId && <div className="text-muted">Stock → {warehouses.find((w) => w.id === l.warehouseId)?.code ?? 'warehouse'}</div>}
                  </td>
                  <td className="num">{l.quantity}</td>
                  <td className={cx('num', toUnits(l.quantityReceived) >= toUnits(l.quantity) && 'text-emerald-700')}>{l.quantityReceived}</td>
                  <td className="num">{l.quantityBilled}</td>
                  <td className="num">{formatAmount(l.unitPrice, tp)}</td>
                  <td className="num">{formatAmount(l.netAmount, tp)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="text-right">Total incl. tax ({o.currency})</td>
                <td className="num">{formatAmount(o.total, tp)}</td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Goods received">
            {!o.receipts.length ? (
              <p className="text-sm text-muted">Nothing received yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {o.receipts.map((g) => (
                  <li key={g.id} className={cx(g.status === 'REVERSED' && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{g.number}</span> · {formatDate(g.date)} {g.reference && <span className="text-muted">({g.reference})</span>}
                      {g.status === 'REVERSED' && <StatusBadge status="REVERSED" />}
                      {g.journalId && g.status === 'POSTED' && <span className="text-xs text-muted">stock posted</span>}
                      {g.status === 'POSTED' && can('procurement.manage') && (
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setReversing(g)}>Reverse</Button>
                      )}
                    </div>
                    <div className="text-xs text-muted">{g.lines.map((l) => `${l.quantity} × ${l.description}`).join('; ')}</div>
                    {g.reversalReason && <div className="text-xs text-muted">Reversed: {g.reversalReason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Bills">
            {!o.bills.length ? (
              <p className="text-sm text-muted">No bills yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {o.bills.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2">
                    <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/purchases/bills/${b.id}`}>{b.number}</Link>
                    <span className="text-muted">{b.supplierInvoiceNumber}</span>
                    <StatusBadge status={b.status} />
                    {b.matchStatus !== 'NOT_REQUIRED' && <StatusBadge status={b.matchStatus} />}
                    <span className="ml-auto tabular-nums">{formatAmount(b.total, tp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <ApprovalHistory documentType="PURCHASE_ORDER" documentId={o.id} />
      <AttachmentsCard recordType="PurchaseOrder" recordId={o.id} />
      <ReasonDialog open={rejecting} title={`Reject ${o.number}`} confirmLabel="Reject" busy={actions.busy('reject')} onClose={() => setRejecting(false)} onConfirm={async ({ reason }) => (await actions.run('reject', { reason }), setRejecting(false))} />
      {receiving && <ReceiveDialog order={o} onClose={() => setReceiving(false)} />}
      <ReasonDialog
        open={!!reversing}
        withDate
        minDate={reversing?.date.slice(0, 10)}
        title={`Reverse ${reversing?.number ?? ''}`}
        description="The goods come back off the order. Stock received is taken out of stock at the value it came in, and the received-not-invoiced entry is reversed. Billed goods cannot be reversed; credit the bill instead."
        confirmLabel="Reverse receipt"
        busy={reverse.isPending}
        onClose={() => setReversing(null)}
        onConfirm={({ reason, date }) => reversing && reverse.mutate({ id: reversing.id, reason, date })}
      />
    </>
  );
}

function ReceiveDialog({ order, onClose }: { order: PurchaseOrder; onClose: () => void }) {
  const queryClient = useQueryClient();
  const outstanding = (l: PurchaseOrder['lines'][number]) => fromUnits(toUnits(l.quantity) - toUnits(l.quantityReceived));
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(order.lines.map((l) => [l.lineNo, outstanding(l)])));
  const [lots, setLots] = useState<Record<number, Lot[]>>({});
  const { data: items = [] } = useItems();
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const receive = useMutation({
    mutationFn: () =>
      api.post(`/purchase-orders/${order.id}/receipts`, {
        date,
        reference: reference || undefined,
        lines: Object.entries(qty)
          .filter(([, q]) => q && !isZero(q))
          .map(([poLineNo, quantity]) => ({ poLineNo: Number(poLineNo), quantity, lots: lotsBody(lots[Number(poLineNo)] ?? []) })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase-order', order.id] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={`Receive against ${order.number}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={receive.isPending} onClick={() => receive.mutate()}>Record goods received</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date received">
            <Input type="date" value={date} min={order.date.slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Delivery note">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Outstanding</th>
              <th className="num w-32">Received now</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>
                  {l.description}
                  {l.itemId && (
                    <div className="mt-1">
                      <LotsButton item={items.find((i) => i.id === l.itemId)} warehouseId={l.warehouseId ?? ''} quantity={qty[l.lineNo] ?? ''} inward value={lots[l.lineNo] ?? []} onChange={(v) => setLots((x) => ({ ...x, [l.lineNo]: v }))} />
                    </div>
                  )}
                </td>
                <td className="num">{outstanding(l)}</td>
                <td>
                  <Input className="h-8 text-right text-xs" inputMode="decimal" value={qty[l.lineNo] ?? ''} onChange={(e) => amountPattern.test(e.target.value) && setQty((q) => ({ ...q, [l.lineNo]: e.target.value }))} aria-label={`Received ${l.description}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted">
          {order.lines.some((l) => l.itemId)
            ? 'Stock lines go into stock now, at the order price (Dr inventory, Cr goods received not invoiced); the supplier bill clears that and any price difference adjusts the stock. Other lines are not posted until billed.'
            : 'Goods received are not posted to the ledger; the supplier bill records the liability and is matched against these quantities.'}
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Payment run
// ---------------------------------------------------------------------------------------------

interface ProposalBill {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  date: string;
  dueDate: string;
  supplierInvoiceNumber: string;
  currency: string;
  amountDue: string;
  pendingPaymentNumber: string | null;
  withholdingTaxCodeId: string | null;
  supplierBank: string;
}

export function PaymentRun() {
  const router = useRouter();
  const { entity } = useSession();
  const precision = usePrecision();
  const { data: banks = [] } = useBankAccounts(entity!.id);
  const [bankId, setBankId] = useState('');
  const [dueBy, setDueBy] = useState(today());
  const [date, setDate] = useState(today());
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const bank = banks.find((b) => b.id === bankId) ?? banks.find((b) => b.isActive);
  const proposal = useQuery({
    queryKey: ['payment-proposal', entity?.id, bank?.id, dueBy],
    queryFn: () => api.get<{ bills: ProposalBill[] }>('/payments/proposal', { entityId: entity!.id, bankAccountId: bank!.id, dueBy }),
    enabled: !!bank,
  });
  const tp = precision(bank?.currency);
  const bills = proposal.data?.bills ?? [];
  const total = addAll(Object.values(selected));
  const suppliers = new Set(bills.filter((b) => selected[b.id]).map((b) => b.partyId)).size;

  const run = useMutation({
    mutationFn: () =>
      api.post<{ payments: { id: string; number: string }[] }>('/payments/runs', {
        entityId: entity!.id,
        bankAccountId: bank!.id,
        date,
        submit: true,
        items: Object.entries(selected)
          .filter(([, a]) => a && !isZero(a))
          .map(([documentId, amount]) => ({ documentId, amount })),
      }),
    onSuccess: () => router.push('/finance/purchases/payments'),
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <>
      <PageHeader title="Payment run" description="Select due bills; one payment per supplier is created and submitted for approval. Withholding tax is deducted per the supplier's settings." />
      <ErrorBanner error={error} className="mb-3" />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Pay from">
          <Select className="w-64" value={bank?.id ?? ''} onChange={(e) => (setBankId(e.target.value), setSelected({}))}>
            {banks.filter((b) => b.isActive).map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>
            ))}
          </Select>
        </Field>
        <Field label="Bills due by">
          <Input type="date" value={dueBy} onChange={(e) => setDueBy(e.target.value)} />
        </Field>
        <Field label="Payment date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Button size="sm" variant="ghost" onClick={() => setSelected(Object.fromEntries(bills.filter((b) => !b.pendingPaymentNumber).map((b) => [b.id, b.amountDue])))}>Select all</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected({})}>Clear</Button>
      </div>
      <TableWrap>
        {proposal.isLoading ? (
          <Loading />
        ) : !bills.length ? (
          <Empty title="No bills due">Only {bank?.currency} bills due by the selected date are shown.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Supplier</th>
                <th>Bill</th>
                <th>Supplier invoice</th>
                <th>Due</th>
                <th>Pay to</th>
                <th className="num">Outstanding</th>
                <th className="num w-36">Pay</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className={b.pendingPaymentNumber ? 'opacity-50' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      disabled={!!b.pendingPaymentNumber}
                      checked={!!selected[b.id]}
                      onChange={(e) => setSelected((s) => ({ ...s, [b.id]: e.target.checked ? b.amountDue : '' }))}
                      aria-label={`Pay ${b.number}`}
                    />
                  </td>
                  <td>{b.partyName}</td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    <Link className="text-brand-700 hover:underline" href={`/finance/purchases/bills/${b.id}`}>{b.number}</Link>
                    {b.pendingPaymentNumber && <span className="ml-1 font-sans text-muted">on {b.pendingPaymentNumber}</span>}
                  </td>
                  <td className="text-muted">{b.supplierInvoiceNumber}</td>
                  <td className={cx(b.dueDate.slice(0, 10) < today() && 'text-red-700')}>{formatDate(b.dueDate)}</td>
                  <td className="text-xs text-muted">{b.supplierBank}</td>
                  <td className="num">{formatAmount(b.amountDue, tp)}</td>
                  <td>
                    <Input
                      className="h-8 text-right text-xs"
                      inputMode="decimal"
                      disabled={!!b.pendingPaymentNumber}
                      value={selected[b.id] ?? ''}
                      onChange={(e) => amountPattern.test(e.target.value) && setSelected((s) => ({ ...s, [b.id]: e.target.value }))}
                      aria-label={`Amount for ${b.number}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <div className="mt-3 flex items-center justify-end gap-4">
        <span className="text-sm text-muted">
          {suppliers} supplier{suppliers === 1 ? '' : 's'} · settling {formatAmount(total, tp)} {bank?.currency} (before withholding)
        </span>
        <Button variant="primary" disabled={isZero(total)} loading={run.isPending} onClick={() => run.mutate()}>
          Create payments for approval
        </Button>
      </div>
    </>
  );
}

