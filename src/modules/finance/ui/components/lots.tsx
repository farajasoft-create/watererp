'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { addAll, formatDate } from '@/modules/finance/ui/lib/format';
import { Item, useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, cx, Empty, Field, Input, Loading, Modal, Notice, Select, TableWrap, Textarea } from './ui';

/** A batch or serial number on a stock line (quantities positive). */
export interface Lot {
  number: string;
  expiryDate: string | null;
  quantity: string;
}

interface LotRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  tracking: 'BATCH' | 'SERIAL';
  warehouseId: string;
  warehouseCode: string;
  number: string;
  expiryDate: string | null;
  daysToExpiry: number | null;
  expired: boolean;
  quantity: string;
  receivedDate: string;
}

const qty = /^\d*(\.\d*)?$/;
export const lotsBody = (lots: Lot[]) => lots.filter((l) => l.number.trim() && l.quantity && Number(l.quantity) > 0).map((l) => ({ number: l.number.trim(), expiryDate: l.expiryDate || null, quantity: l.quantity }));
const isTracked = (item?: Item) => !!item && item.type === 'STOCK' && !!item.tracking && item.tracking !== 'NONE';

/**
 * The batches or serial numbers on a stock line. Receipts must name them; serial issues must name them; batch
 * issues may be left empty to take the batch that expires first. Renders nothing for untracked items.
 */
export function LotsButton({ item, warehouseId, quantity, inward, value, onChange, disabled }: { item?: Item; warehouseId: string; quantity: string; inward: boolean; value: Lot[]; onChange: (lots: Lot[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!isTracked(item)) return null;
  const serial = item!.tracking === 'SERIAL';
  const total = Number(addAll(lotsBody(value).map((l) => l.quantity)));
  const needed = Number(quantity || 0);
  const optional = !inward && !serial;
  const ok = (optional && !value.length) || total === needed;
  const label = serial ? 'Serials' : 'Batches';
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cx('rounded border px-1.5 py-0.5 text-[11px]', ok ? 'border-line text-muted hover:border-brand-400' : 'border-amber-400 bg-amber-50 text-amber-800')}
        aria-label={`${label} for ${item!.code}`}
      >
        {value.length ? `${label}: ${lotsBody(value).map((l) => l.number).slice(0, 3).join(', ')}${value.length > 3 ? '…' : ''}` : optional ? 'First to expire' : `Enter ${label.toLowerCase()}`}
      </button>
      {open && <LotsDialog item={item!} warehouseId={warehouseId} quantity={quantity} inward={inward} value={value} onClose={() => setOpen(false)} onSave={(v) => (onChange(v), setOpen(false))} />}
    </>
  );
}

function LotsDialog({ item, warehouseId, quantity, inward, value, onClose, onSave }: { item: Item; warehouseId: string; quantity: string; inward: boolean; value: Lot[]; onClose: () => void; onSave: (lots: Lot[]) => void }) {
  const { entity } = useSession();
  const serial = item.tracking === 'SERIAL';
  const [rows, setRows] = useState<Lot[]>(() => (value.length ? value : inward && !serial ? [{ number: '', expiryDate: null, quantity: quantity || '' }] : []));
  const [bulk, setBulk] = useState(() => (serial && inward ? value.map((l) => l.number).join('\n') : ''));
  const available = useQuery({
    queryKey: ['stock-lots', entity?.id, item.id, warehouseId],
    queryFn: () => api.get<LotRow[]>('/stock/lots', { entityId: entity!.id, itemId: item.id, warehouseId }),
    enabled: !inward && !!warehouseId,
  });
  const picked = (n: string) => rows.find((r) => r.number === n);
  const setPick = (lot: LotRow, q: string) =>
    setRows((rs) => {
      const rest = rs.filter((r) => r.number !== lot.number);
      return q && Number(q) > 0 ? [...rest, { number: lot.number, expiryDate: lot.expiryDate, quantity: q }] : rest;
    });
  const result = serial && inward ? bulk.split(/[\s,;]+/).filter(Boolean).map((n) => ({ number: n, expiryDate: null, quantity: '1' })) : rows;
  const total = Number(addAll(lotsBody(result).map((l) => l.quantity)));
  const needed = Number(quantity || 0);
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={`${serial ? 'Serial numbers' : 'Batches'} · ${item.code} ${item.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(result)}>Done</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className={cx('text-xs', total === needed || (!inward && !serial && !result.length) ? 'text-muted' : 'text-amber-700')}>
          {total} of {needed} {item.unit} {inward ? 'received' : 'issued'}
          {!inward && !serial && ' · leave empty to take the batch that expires first'}
        </p>
        {inward ? (
          serial ? (
            <Field label="Serial numbers received" hint="One per line, or separated by spaces or commas">
              <Textarea rows={6} value={bulk} onChange={(e) => setBulk(e.target.value)} className="font-mono text-xs" />
            </Field>
          ) : (
            <>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Expiry{item.trackExpiry && ' *'}</th>
                    <th className="num w-28">Quantity</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const set = (p: Partial<Lot>) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));
                    return (
                      <tr key={i}>
                        <td><Input className="h-8 font-mono text-xs" value={r.number} onChange={(e) => set({ number: e.target.value.toUpperCase() })} aria-label="Batch number" /></td>
                        <td><Input className="h-8 text-xs" type="date" value={r.expiryDate?.slice(0, 10) ?? ''} onChange={(e) => set({ expiryDate: e.target.value || null })} aria-label="Expiry date" /></td>
                        <td><Input className="h-8 text-right text-xs" inputMode="decimal" value={r.quantity} onChange={(e) => qty.test(e.target.value) && set({ quantity: e.target.value })} aria-label="Batch quantity" /></td>
                        <td>
                          <button type="button" className="rounded p-1 text-muted hover:text-red-700" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove batch">✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, { number: '', expiryDate: null, quantity: '' }])}>+ Add batch</Button>
            </>
          )
        ) : !warehouseId ? (
          <Notice tone="amber">Choose the warehouse first.</Notice>
        ) : available.isLoading ? (
          <Loading />
        ) : !available.data?.length ? (
          <Notice tone="amber">Nothing of {item.code} in stock in this warehouse.</Notice>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{serial ? 'Serial number' : 'Batch'}</th>
                  <th>Expiry</th>
                  <th className="num">On hand</th>
                  <th className="num w-28">{serial ? 'Issue' : 'Quantity'}</th>
                </tr>
              </thead>
              <tbody>
                {available.data.map((lot) => (
                  <tr key={lot.id}>
                    <td className="font-mono text-xs">{lot.number}</td>
                    <td className={cx('text-xs', lot.expired && 'text-red-700')}>{lot.expiryDate ? formatDate(lot.expiryDate) : '—'}</td>
                    <td className="num">{lot.quantity}</td>
                    <td className="num">
                      {serial ? (
                        <input type="checkbox" checked={!!picked(lot.number)} onChange={(e) => setPick(lot, e.target.checked ? '1' : '')} aria-label={`Issue ${lot.number}`} />
                      ) : (
                        <Input className="h-8 text-right text-xs" inputMode="decimal" value={picked(lot.number)?.quantity ?? ''} onChange={(e) => qty.test(e.target.value) && setPick(lot, e.target.value)} aria-label={`Quantity from ${lot.number}`} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

interface Trace {
  number: string;
  onHand: { itemCode: string; warehouseCode: string; quantity: string; expiryDate: string | null }[];
  movements: { id: string; date: string; type: string; itemCode: string; warehouseCode: string; quantity: string; sourceType: string; sourceId: string; sourceNumber: string }[];
}

const sourceHref = (t: string, id: string) => (t === 'Invoice' ? `/sales/invoices/${id}` : t === 'StockDocument' ? '/inventory/documents' : t === 'LandedCost' ? '/inventory/landed-costs' : null);

/** Batches and serial numbers on hand, what expires soon, and the history of any one number. */
export function LotsTab() {
  const { entity } = useSession();
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [within, setWithin] = useState('');
  const [search, setSearch] = useState('');
  const [traced, setTraced] = useState('');
  const tracked = items.filter((i) => isTracked(i));
  const { data = [], isLoading } = useQuery({
    queryKey: ['stock-lots', entity?.id, itemId, warehouseId, within],
    queryFn: () => api.get<LotRow[]>('/stock/lots', { entityId: entity!.id, itemId: itemId || undefined, warehouseId: warehouseId || undefined, expiringWithinDays: within || undefined }),
  });
  const trace = useQuery({ queryKey: ['stock-trace', entity?.id, traced], queryFn: () => api.get<Trace>('/stock/trace', { entityId: entity!.id, number: traced }), enabled: !!traced });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Select className="w-56" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Item">
          <option value="">All tracked items</option>
          {tracked.map((i) => (
            <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
          ))}
        </Select>
        <Select className="w-44" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses</option>
          {warehouses.filter((w) => w.entityId === entity?.id).map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </Select>
        <Select className="w-48" value={within} onChange={(e) => setWithin(e.target.value)} aria-label="Expiry">
          <option value="">Any expiry</option>
          <option value="0">Expired</option>
          <option value="30">Expiring within 30 days</option>
          <option value="90">Expiring within 90 days</option>
          <option value="180">Expiring within 180 days</option>
        </Select>
        <form
          className="ml-auto flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setTraced(search.trim().toUpperCase());
          }}
        >
          <Input className="w-48 font-mono text-xs" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Batch or serial number" aria-label="Trace number" />
          <Button type="submit" disabled={!search.trim()}>Trace</Button>
        </form>
      </div>
      {traced && (
        <div className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-sm font-semibold">{traced}</span>
            {trace.data && (trace.data.onHand.length ? trace.data.onHand.map((o) => <Badge key={o.warehouseCode + o.itemCode} tone="green">{o.quantity} {o.itemCode} in {o.warehouseCode}</Badge>) : <Badge tone="gray">Not in stock</Badge>)}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setTraced('')}>Close</Button>
          </div>
          {trace.isLoading ? (
            <Loading />
          ) : !trace.data?.movements.length ? (
            <p className="text-sm text-muted">No movements for this number.</p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th>Movement</th>
                  <th>Document</th>
                  <th className="num">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {trace.data.movements.map((m) => {
                  const href = sourceHref(m.sourceType, m.sourceId);
                  return (
                    <tr key={m.id}>
                      <td>{formatDate(m.date)}</td>
                      <td className="font-mono text-xs">{m.itemCode}</td>
                      <td>{m.warehouseCode}</td>
                      <td className="text-xs">{m.type.toLowerCase().replace('_', ' ')}</td>
                      <td className="font-mono text-xs">{href ? <Link className="text-brand-700 hover:underline" href={href}>{m.sourceNumber}</Link> : m.sourceNumber}</td>
                      <td className={cx('num', m.quantity.startsWith('-') ? 'text-red-700' : 'text-emerald-700')}>{m.quantity}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No batches or serial numbers in stock">Set an item to be tracked by batch or serial number; receipts then record them.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Batch / serial</th>
                <th>Received</th>
                <th>Expiry</th>
                <th className="num">On hand</th>
              </tr>
            </thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id}>
                  <td><span className="font-mono text-xs">{l.itemCode}</span> {l.itemName}</td>
                  <td>{l.warehouseCode}</td>
                  <td>
                    <button type="button" className="font-mono text-xs text-brand-700 hover:underline" onClick={() => (setSearch(l.number), setTraced(l.number))}>{l.number}</button>
                  </td>
                  <td className="text-xs text-muted">{formatDate(l.receivedDate)}</td>
                  <td>
                    {l.expiryDate ? (
                      <span className="inline-flex items-center gap-1">
                        {formatDate(l.expiryDate)}
                        {l.expired ? <Badge tone="red">expired</Badge> : l.daysToExpiry != null && l.daysToExpiry <= 30 ? <Badge tone="amber">{l.daysToExpiry} days</Badge> : null}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{l.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </div>
  );
}
