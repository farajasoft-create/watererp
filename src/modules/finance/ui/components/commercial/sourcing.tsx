'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useParties } from '@/modules/finance/ui/lib/commercial-hooks';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { useAccounts, useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap } from '../ui';
import { AccountOptions, Facts, ReasonDialog, useActions } from './shared';
import { EvaluationPanel } from './evaluation-panel';

const amountPattern = /^\d*(\.\d*)?$/;

interface RfqSupplier {
  supplierId: string;
  supplierName: string;
  email: string;
  currency: string;
  sentAt: string | null;
  respondedAt: string | null;
  validUntil: string | null;
  reference: string;
  declined: boolean;
  quotes: { lineNo: number; unitPrice: string; leadTimeDays: number | null; notes: string }[];
}
interface RfqLine {
  lineNo: number;
  description: string;
  quantity: string;
  accountId: string | null;
  itemId: string | null;
  warehouseId: string | null;
}
interface Rfq {
  id: string;
  number: string;
  title: string;
  date: string;
  dueDate: string;
  notes: string;
  deliveryAddress: string;
  branchId: string;
  status: 'DRAFT' | 'SENT' | 'CLOSED' | 'AWARDED' | 'CANCELLED';
  lines: RfqLine[];
  suppliers: RfqSupplier[];
  awards: { lineNo: number; supplierId: string; unitPrice: string; reason: string; purchaseOrderId: string | null }[];
}
interface Comparison {
  functionalCurrency: string;
  missingRates: string[];
  lines: {
    lineNo: number;
    description: string;
    quantity: string;
    cheapestSupplierId: string | null;
    quotes: { supplierId: string; supplierName: string; currency: string; unitPrice: string; leadTimeDays: number | null; notes: string; functionalUnitPrice: string | null; functionalTotal: string | null }[];
  }[];
}
interface RfqDetail extends Rfq {
  comparison: Comparison;
  orders: { id: string; number: string; status: string; supplierName: string }[];
}

export function RfqList() {
  const router = useRouter();
  const { entity, can } = useSession();
  const [status, setStatus] = useState('');
  const { data = [], isLoading, error } = useQuery({ queryKey: ['rfqs', entity?.id, status], queryFn: () => api.get<Rfq[]>('/rfqs', { entityId: entity!.id, status: status || undefined }) });
  return (
    <>
      <PageHeader
        title="Requests for quotes"
        description="Ask several suppliers to price the same goods, compare their quotes side by side and award each line; the winners get draft purchase orders."
        actions={can('procurement.manage') && <LinkButton variant="primary" href="/finance/purchases/rfqs/new">New request</LinkButton>}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {[['', 'All'], ['DRAFT', 'Drafts'], ['SENT', 'Out for quotes'], ['CLOSED', 'Closed'], ['AWARDED', 'Awarded']].map(([v, label]) => (
          <Button key={v} size="sm" variant={status === v ? 'primary' : 'secondary'} onClick={() => setStatus(v)}>{label}</Button>
        ))}
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No requests for quotes" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Date</th>
                <th>Quotes due</th>
                <th className="num">Suppliers</th>
                <th className="num">Quoted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => router.push(`/finance/purchases/rfqs/${r.id}`)}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{r.number}</td>
                  <td>{r.title}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{formatDate(r.dueDate)}</td>
                  <td className="num">{r.suppliers.length}</td>
                  <td className="num">{r.suppliers.filter((s) => s.respondedAt && !s.declined).length}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}

interface FormLine {
  key: number;
  description: string;
  quantity: string;
  accountId: string;
  itemId: string;
  warehouseId: string;
}
let lineKey = 1;
const blank = (p: Partial<FormLine> = {}): FormLine => ({ key: lineKey++, description: '', quantity: '1', accountId: '', itemId: '', warehouseId: '', ...p });

export function RfqForm({ existing }: { existing?: Rfq }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const { data: suppliers = [] } = useParties('SUPPLIER');
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const { data: items = [] } = useItems();
  const { data: allWarehouses = [] } = useWarehouses();
  const warehouses = allWarehouses.filter((w) => w.entityId === entity!.id && w.isActive);
  const [header, setHeader] = useState({
    title: existing?.title ?? '',
    branchId: existing?.branchId ?? '',
    date: existing?.date.slice(0, 10) ?? today(),
    dueDate: existing?.dueDate.slice(0, 10) ?? today(),
    deliveryAddress: existing?.deliveryAddress ?? '',
    notes: existing?.notes ?? '',
  });
  const [chosen, setChosen] = useState<string[]>(existing?.suppliers.map((s) => s.supplierId) ?? []);
  const [lines, setLines] = useState<FormLine[]>(existing?.lines.map((l) => blank({ description: l.description, quantity: l.quantity, accountId: l.accountId ?? '', itemId: l.itemId ?? '', warehouseId: l.warehouseId ?? '' })) ?? [blank()]);
  const [error, setError] = useState<string | null>(null);
  const update = (key: number, patch: Partial<FormLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const branchId = header.branchId || branches[0]?.id || '';
  const save = useMutation({
    mutationFn: () => {
      const body = {
        entityId: entity!.id,
        ...header,
        branchId,
        deliveryAddress: header.deliveryAddress || undefined,
        notes: header.notes || undefined,
        supplierIds: chosen,
        lines: lines
          .filter((l) => l.description)
          .map((l) => ({ description: l.description, quantity: l.quantity || '0', accountId: l.accountId || null, itemId: l.itemId || null, warehouseId: l.itemId ? l.warehouseId || null : null })),
      };
      return existing ? api.patch<Rfq>(`/rfqs/${existing.id}`, body) : api.post<Rfq>('/rfqs', body);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['rfqs'] });
      queryClient.invalidateQueries({ queryKey: ['rfq', saved.id] });
      router.push(`/finance/purchases/rfqs/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorBanner error={error} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Title" className="md:col-span-2">
            <Input required value={header.title} onChange={(e) => setHeader({ ...header, title: e.target.value })} placeholder="What you are buying" />
          </Field>
          <Field label="Request date">
            <Input type="date" value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} />
          </Field>
          <Field label="Quotes due">
            <Input type="date" value={header.dueDate} min={header.date} onChange={(e) => setHeader({ ...header, dueDate: e.target.value })} />
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              {branches.filter((b) => b.isActive).map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Deliver to" className="md:col-span-3">
            <Input value={header.deliveryAddress} onChange={(e) => setHeader({ ...header, deliveryAddress: e.target.value })} />
          </Field>
          <Field label="Notes to suppliers" className="md:col-span-4">
            <Input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} placeholder="Specifications, delivery terms, payment terms…" />
          </Field>
        </div>
      </Card>
      <Card title="Suppliers to ask">
        <div className="flex flex-wrap gap-2">
          {suppliers.filter((s) => s.isActive).map((s) => {
            const on = chosen.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                aria-pressed={on}
                onClick={() => setChosen((c) => (on ? c.filter((x) => x !== s.id) : [...c, s.id]))}
                className={cx('rounded-full border px-3 py-1 text-xs', on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-muted hover:border-brand-400')}
              >
                {s.name} · {s.currency}
                {!s.email && <span className="ml-1 text-amber-700">(no email)</span>}
              </button>
            );
          })}
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
                        const item = items.find((x) => x.id === e.target.value);
                        update(l.key, item ? { itemId: item.id, description: l.description || item.name, warehouseId: item.type === 'STOCK' ? l.warehouseId || warehouses[0]?.id || '' : '' } : { itemId: '', warehouseId: '' });
                      }}
                      aria-label="Item"
                    >
                      <option value="">None</option>
                      {items.filter((x) => x.isActive && x.type !== 'SERVICE').map((x) => (
                        <option key={x.id} value={x.id}>{x.code} · {x.name}</option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    {l.itemId && items.find((x) => x.id === l.itemId)?.type === 'STOCK' ? (
                      <Select className="h-8 text-xs" required value={l.warehouseId} onChange={(e) => update(l.key, { warehouseId: e.target.value })} aria-label="Warehouse">
                        <option value="">Receive into…</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                        ))}
                      </Select>
                    ) : (
                      <Select className="h-8 text-xs" value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} aria-label="Account">
                        <AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES', 'ASSET']} />
                      </Select>
                    )}
                  </td>
                  <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={l.quantity} onChange={(e) => amountPattern.test(e.target.value) && update(l.key, { quantity: e.target.value })} aria-label="Quantity" /></td>
                  <td>
                    <button type="button" className="rounded p-1 text-muted hover:text-red-700 disabled:opacity-30" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-3">
          <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blank()])}>+ Add line</Button>
        </div>
      </Card>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!chosen.length} loading={save.isPending}>Save draft</Button>
      </div>
    </form>
  );
}

export function RfqView({ id }: { id: string }) {
  const { can } = useSession();
  const precision = usePrecision();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quoting, setQuoting] = useState<RfqSupplier | null>(null);
  const [awarding, setAwarding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { data: r, isLoading } = useQuery({ queryKey: ['rfq', id], queryFn: () => api.get<RfqDetail>(`/rfqs/${id}`) });
  const actions = useActions(`/rfqs/${id}`, [['rfq', id], ['rfqs']], setError);
  if (isLoading || !r) return <Loading />;
  const manage = can('procurement.manage');
  const open = ['SENT', 'CLOSED'].includes(r.status);
  const fc = r.comparison.functionalCurrency;
  const fp = precision(fc);
  return (
    <>
      <PageHeader
        title={`${r.number} · ${r.title}`}
        description={<span className="inline-flex items-center gap-2"><StatusBadge status={r.status} /> Quotes due {formatDate(r.dueDate)}</span>}
        actions={
          <>
            {r.status === 'DRAFT' && manage && <LinkButton href={`/finance/purchases/rfqs/${r.id}/edit`}>Edit</LinkButton>}
            {['DRAFT', 'SENT'].includes(r.status) && manage && (
              <Button
                variant={r.status === 'DRAFT' ? 'primary' : 'secondary'}
                loading={actions.busy('send')}
                onClick={async () => {
                  const res = (await actions.run('send')) as { emailed?: number } | undefined;
                  if (res) setNotice(`Sent. ${res.emailed ?? 0} supplier${res.emailed === 1 ? '' : 's'} emailed; follow up the others yourself.`);
                }}
              >
                {r.status === 'DRAFT' ? 'Send to suppliers' : 'Send to new suppliers'}
              </Button>
            )}
            {r.status === 'SENT' && manage && <Button loading={actions.busy('close')} onClick={() => actions.run('close')}>Close to quotes</Button>}
            {open && can('procurement.approve') && <Button variant="primary" onClick={() => setAwarding(true)}>Award</Button>}
            {['DRAFT', 'SENT', 'CLOSED'].includes(r.status) && manage && <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel</Button>}
          </>
        }
      />
      <div className="space-y-4">
        <ErrorBanner error={error} />
        {notice && <Notice tone="green">{notice}</Notice>}
        {r.comparison.missingRates.length > 0 && <Notice tone="amber">No approved exchange rate to {fc} for {r.comparison.missingRates.join(', ')} on {formatDate(r.date)}; those quotes cannot be ranked.</Notice>}
        <EvaluationPanel rfqId={r.id} status={r.status} bidders={r.suppliers.map((x) => ({ supplierId: x.supplierId, supplierName: x.supplierName }))} />
        <Card>
          <Facts
            items={[
              ['Request date', formatDate(r.date)],
              ['Quotes due', formatDate(r.dueDate)],
              ['Deliver to', r.deliveryAddress],
              ['Notes', r.notes],
            ]}
          />
        </Card>
        <Card padded={false} title="Suppliers">
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Sent</th>
                  <th>Response</th>
                  <th>Valid until</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {r.suppliers.map((s) => (
                  <tr key={s.supplierId}>
                    <td>
                      {s.supplierName} <span className="text-xs text-muted">{s.currency}</span>
                      <div className="text-xs text-muted">{s.email || 'No email address'}</div>
                    </td>
                    <td>{s.sentAt ? formatDate(s.sentAt) : '—'}</td>
                    <td>{s.declined ? <Badge tone="gray">Declined</Badge> : s.respondedAt ? <Badge tone="green">{s.quotes.length} line{s.quotes.length === 1 ? '' : 's'} quoted</Badge> : <Badge tone="amber">Waiting</Badge>}{s.reference && <span className="ml-1 text-xs text-muted">{s.reference}</span>}</td>
                    <td>{s.validUntil ? formatDate(s.validUntil) : '—'}</td>
                    <td className="text-right">{open && manage && <Button size="sm" onClick={() => setQuoting(s)}>{s.respondedAt ? 'Update quote' : 'Record quote'}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
        <Card padded={false} title={`Comparison (unit prices, in ${fc})`}>
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  {r.suppliers.map((s) => (
                    <th key={s.supplierId} className="num">{s.supplierName}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.comparison.lines.map((l) => {
                  const award = r.awards.find((a) => a.lineNo === l.lineNo);
                  return (
                    <tr key={l.lineNo}>
                      <td className="text-xs text-muted">{l.lineNo}</td>
                      <td>{l.description}</td>
                      <td className="num">{l.quantity}</td>
                      {r.suppliers.map((s) => {
                        const q = l.quotes.find((x) => x.supplierId === s.supplierId);
                        const cheapest = l.cheapestSupplierId === s.supplierId;
                        const won = award?.supplierId === s.supplierId;
                        return (
                          <td key={s.supplierId} className={cx('num', cheapest && 'font-semibold text-emerald-700', won && 'bg-brand-50')}>
                            {!q ? (
                              <span className="text-muted">—</span>
                            ) : (
                              <>
                                {q.functionalUnitPrice ? formatAmount(q.functionalUnitPrice, fp) : '?'}
                                {s.currency !== fc && <div className="text-xs font-normal text-muted">{formatAmount(q.unitPrice, precision(s.currency))} {s.currency}</div>}
                                {q.leadTimeDays != null && <div className="text-xs font-normal text-muted">{q.leadTimeDays} days</div>}
                                {won && <div className="text-xs font-normal text-brand-700">Awarded{award?.reason ? `: ${award.reason}` : ''}</div>}
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
        {r.orders.length > 0 && (
          <Card title="Purchase orders raised">
            <ul className="space-y-1 text-sm">
              {r.orders.map((o) => (
                <li key={o.id} className="flex items-center gap-2">
                  <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/purchases/orders/${o.id}`}>{o.number}</Link>
                  {o.supplierName}
                  <StatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {quoting && <QuoteDialog rfq={r} supplier={quoting} onClose={() => setQuoting(null)} />}
      {awarding && <AwardDialog rfq={r} onClose={() => setAwarding(false)} />}
      <ReasonDialog open={cancelling} required={false} title={`Cancel ${r.number}`} confirmLabel="Cancel request" busy={actions.busy('cancel')} onClose={() => setCancelling(false)} onConfirm={async ({ reason }) => (await actions.run('cancel', { reason }), setCancelling(false))} />
    </>
  );
}

function QuoteDialog({ rfq, supplier, onClose }: { rfq: RfqDetail; supplier: RfqSupplier; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [prices, setPrices] = useState<Record<number, { unitPrice: string; leadTimeDays: string }>>(() =>
    Object.fromEntries(rfq.lines.map((l) => {
      const q = supplier.quotes.find((x) => x.lineNo === l.lineNo);
      return [l.lineNo, { unitPrice: q?.unitPrice ?? '', leadTimeDays: q?.leadTimeDays != null ? String(q.leadTimeDays) : '' }];
    })),
  );
  const [reference, setReference] = useState(supplier.reference);
  const [validUntil, setValidUntil] = useState(supplier.validUntil?.slice(0, 10) ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (declined: boolean) =>
      api.post(`/rfqs/${rfq.id}/quotes`, {
        supplierId: supplier.supplierId,
        reference: reference || undefined,
        validUntil: validUntil || null,
        declined,
        lines: declined
          ? []
          : Object.entries(prices)
              .filter(([, p]) => p.unitPrice !== '')
              .map(([lineNo, p]) => ({ lineNo: Number(lineNo), unitPrice: p.unitPrice, leadTimeDays: p.leadTimeDays === '' ? null : Number(p.leadTimeDays) })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rfq', rfq.id] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={`Quote from ${supplier.supplierName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="ghost" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Supplier declined</Button>
          <Button variant="primary" loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save quote</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier quote reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Valid until">
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Qty</th>
              <th className="num w-36">Unit price ({supplier.currency}, excl. tax)</th>
              <th className="num w-28">Lead time (days)</th>
            </tr>
          </thead>
          <tbody>
            {rfq.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.description}</td>
                <td className="num">{l.quantity}</td>
                <td>
                  <Input className="h-8 text-right text-xs" inputMode="decimal" value={prices[l.lineNo]?.unitPrice ?? ''} onChange={(e) => amountPattern.test(e.target.value) && setPrices((p) => ({ ...p, [l.lineNo]: { ...p[l.lineNo], unitPrice: e.target.value } }))} aria-label={`Price for ${l.description}`} />
                </td>
                <td>
                  <Input className="h-8 text-right text-xs" inputMode="numeric" value={prices[l.lineNo]?.leadTimeDays ?? ''} onChange={(e) => /^\d*$/.test(e.target.value) && setPrices((p) => ({ ...p, [l.lineNo]: { ...p[l.lineNo], leadTimeDays: e.target.value } }))} aria-label={`Lead time for ${l.description}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted">Leave a price blank for lines the supplier did not quote.</p>
      </div>
    </Modal>
  );
}

function AwardDialog({ rfq, onClose }: { rfq: RfqDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const [date, setDate] = useState(today());
  const [choice, setChoice] = useState<Record<number, { supplierId: string; reason: string }>>(() =>
    Object.fromEntries(rfq.comparison.lines.filter((l) => l.quotes.length).map((l) => [l.lineNo, { supplierId: l.cheapestSupplierId ?? l.quotes[0].supplierId, reason: '' }])),
  );
  const [error, setError] = useState<string | null>(null);
  const award = useMutation({
    mutationFn: () =>
      api.post(`/rfqs/${rfq.id}/award`, {
        date,
        lines: Object.entries(choice)
          .filter(([, c]) => c.supplierId)
          .map(([lineNo, c]) => ({ lineNo: Number(lineNo), supplierId: c.supplierId, reason: c.reason || undefined })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rfq', rfq.id] });
      queryClient.invalidateQueries({ queryKey: ['rfqs'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const fc = rfq.comparison.functionalCurrency;
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={`Award ${rfq.number}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={award.isPending} onClick={() => award.mutate()}>Award and raise orders</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <Field label="Order date" className="max-w-48">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <table className="table-base">
          <thead>
            <tr>
              <th>Line</th>
              <th className="min-w-56">Award to</th>
              <th className="min-w-56">Reason (if not the cheapest)</th>
            </tr>
          </thead>
          <tbody>
            {rfq.comparison.lines.map((l) => {
              const c = choice[l.lineNo];
              const notCheapest = c && l.cheapestSupplierId && c.supplierId !== l.cheapestSupplierId;
              return (
                <tr key={l.lineNo}>
                  <td>{l.description} <span className="text-xs text-muted">× {l.quantity}</span></td>
                  <td>
                    {!l.quotes.length ? (
                      <span className="text-xs text-muted">No quotes</span>
                    ) : (
                      <Select className="h-8 text-xs" value={c?.supplierId ?? ''} onChange={(e) => setChoice((x) => ({ ...x, [l.lineNo]: { supplierId: e.target.value, reason: x[l.lineNo]?.reason ?? '' } }))} aria-label={`Award ${l.description}`}>
                        <option value="">Do not award</option>
                        {l.quotes.map((q) => (
                          <option key={q.supplierId} value={q.supplierId}>
                            {q.supplierName} · {q.functionalUnitPrice ? `${formatAmount(q.functionalUnitPrice, precision(fc))} ${fc}` : `${q.unitPrice} ${q.currency}`}
                            {q.supplierId === l.cheapestSupplierId ? ' (cheapest)' : ''}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td>
                    {notCheapest && (
                      <Input className="h-8 text-xs" required value={c.reason} onChange={(e) => setChoice((x) => ({ ...x, [l.lineNo]: { ...x[l.lineNo], reason: e.target.value } }))} placeholder="Quality, lead time, warranty…" aria-label={`Reason for ${l.description}`} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-xs text-muted">A draft purchase order is raised for each winning supplier at the quoted price, ready for approval.</p>
      </div>
    </Modal>
  );
}

interface GrniReport {
  rows: { purchaseOrderId: string; number: string; supplierName: string; date: string; lineNo: number; description: string; quantity: string; value: string }[];
  total: string;
  ledger: string;
  difference: string;
}

/** Goods received not invoiced: stock received and not yet billed, reconciled to the GRNI account. */
export function ReceivedNotInvoiced() {
  const { entity } = useSession();
  const precision = usePrecision();
  const fp = precision(entity!.functionalCurrency);
  const { data, isLoading, error } = useQuery({ queryKey: ['grni', entity?.id], queryFn: () => api.get<GrniReport>('/reports/received-not-invoiced', { entityId: entity!.id }) });
  return (
    <>
      <PageHeader title="Received not invoiced" description="Stock received on goods received notes and not yet billed, at the value it was received. The total should equal the Goods Received Not Invoiced account." />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {data.difference !== '0' && <Notice tone="amber">The account balance differs from the open receipts by {formatAmount(data.difference, fp)} {entity!.functionalCurrency}.</Notice>}
          <TableWrap>
            {!data.rows.length ? (
              <Empty title="Nothing waiting for a bill" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Supplier</th>
                    <th>Line</th>
                    <th className="num">Quantity</th>
                    <th className="num">Value ({entity!.functionalCurrency})</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={`${r.purchaseOrderId}-${r.lineNo}`}>
                      <td><Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/purchases/orders/${r.purchaseOrderId}`}>{r.number}</Link></td>
                      <td>{r.supplierName}</td>
                      <td>{r.description}</td>
                      <td className="num">{r.quantity}</td>
                      <td className="num">{formatAmount(r.value, fp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
          <Card>
            <Facts
              items={[
                ['Open receipts', formatAmount(data.total, fp)],
                ['Account balance', formatAmount(data.ledger, fp)],
                ['Difference', formatAmount(data.difference, fp)],
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}
