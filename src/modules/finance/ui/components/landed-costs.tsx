'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { useAccounts, useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { AccountOptions, ReasonDialog } from './commercial/shared';
import { Button, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap } from './ui';

interface LandedCost {
  id: string;
  number: string;
  date: string;
  description: string;
  amount: string;
  method: 'VALUE' | 'QUANTITY';
  clearingAccountId: string;
  branchId: string;
  status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED';
  receipts: { type: 'GoodsReceipt' | 'Invoice'; id: string; number: string }[];
  allocations: { itemId: string; warehouseId: string; quantity: string; basisValue: string; amount: string; capitalised: string; expensed: string }[];
  reversalReason: string;
}
interface Receipt {
  id: string;
  type: 'GoodsReceipt' | 'Invoice';
  number: string;
  date: string;
  quantity: string;
  value: string;
}

/** Landed costs: freight, duty and clearing charges spread over the stock they brought in. */
export function LandedCostsPage() {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const [editing, setEditing] = useState<LandedCost | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const { data = [], isLoading, error } = useQuery({ queryKey: ['landed-costs', entity?.id], queryFn: () => api.get<LandedCost[]>('/landed-costs', { entityId: entity!.id }) });
  return (
    <>
      <PageHeader
        title="Landed costs"
        description="Freight, duty and clearing charges are billed to the Landed Costs Clearing account, then spread over the stock they brought in by value or quantity. The share of goods already sold goes to cost of sales."
        actions={can('inventory.manage') && <Button variant="primary" onClick={() => setEditing('new')}>New landed cost</Button>}
      />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No landed costs">Bill the forwarder or customs to Landed Costs Clearing, then allocate it here.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Description</th>
                <th>Receipts</th>
                <th>Method</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id} className="cursor-pointer" onClick={() => setViewing(l.id)}>
                  <td className="whitespace-nowrap font-mono text-xs text-brand-700">{l.number}</td>
                  <td>{formatDate(l.date)}</td>
                  <td>{l.description}</td>
                  <td className="text-xs">{l.receipts.map((r) => r.number).join(', ')}</td>
                  <td className="text-xs">By {l.method.toLowerCase()}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td className="num">{formatAmount(l.amount, fp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {editing && <LandedCostForm existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {viewing && (
        <LandedCostDetail
          id={viewing}
          onClose={() => setViewing(null)}
          onEdit={(l) => {
            setViewing(null);
            setEditing(l);
          }}
        />
      )}
    </>
  );
}

function LandedCostForm({ existing, onClose }: { existing?: LandedCost; onClose: () => void }) {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const { data: accounts = [] } = useAccounts(entity!.id);
  const { data: branches = [] } = useBranches(entity!.id);
  const receipts = useQuery({ queryKey: ['landed-cost-receipts', entity?.id], queryFn: () => api.get<Receipt[]>('/landed-costs/receipts', { entityId: entity!.id }) });
  const [form, setForm] = useState({
    date: existing?.date.slice(0, 10) ?? today(),
    description: existing?.description ?? '',
    amount: existing?.amount ?? '',
    method: existing?.method ?? 'VALUE',
    clearingAccountId: existing?.clearingAccountId ?? '',
    branchId: existing?.branchId ?? '',
  });
  const [chosen, setChosen] = useState<string[]>(existing?.receipts.map((r) => r.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        entityId: entity!.id,
        branchId: form.branchId || branches[0]?.id,
        date: form.date,
        description: form.description,
        amount: form.amount || '0',
        method: form.method,
        clearingAccountId: form.clearingAccountId || null,
        receipts: (receipts.data ?? []).filter((r) => chosen.includes(r.id)).map((r) => ({ type: r.type, id: r.id })),
      };
      return existing ? api.patch(`/landed-costs/${existing.id}`, body) : api.post('/landed-costs', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['landed-costs'] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.number}` : 'New landed cost'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.length || !form.description} loading={save.isPending} onClick={() => save.mutate()}>Save draft</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description" className="sm:col-span-2">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Sea freight and duty, shipment 14" />
          </Field>
          <Field label={`Amount (${entity!.functionalCurrency})`}>
            <Input inputMode="decimal" value={form.amount} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Date">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Spread by">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as 'VALUE' | 'QUANTITY' })}>
              <option value="VALUE">Value received</option>
              <option value="QUANTITY">Quantity received</option>
            </Select>
          </Field>
          <Field label="Charges booked to" hint="Defaults to Landed Costs Clearing">
            <Select value={form.clearingAccountId} onChange={(e) => setForm({ ...form, clearingAccountId: e.target.value })}>
              <option value="">Landed Costs Clearing</option>
              <AccountOptions accounts={accounts} classes={['ASSET', 'LIABILITY', 'EXPENSE']} />
            </Select>
          </Field>
        </div>
        <Field label="Stock receipts the charges relate to">
          {receipts.isLoading ? (
            <Loading />
          ) : !receipts.data?.length ? (
            <Notice tone="amber">No goods received notes or bills have brought stock in yet.</Notice>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded border border-line">
              <table className="table-base">
                <tbody>
                  {receipts.data.map((r) => {
                    const on = chosen.includes(r.id);
                    return (
                      <tr key={r.id} className={cx('cursor-pointer', on && 'bg-brand-50')} onClick={() => setChosen((c) => (on ? c.filter((x) => x !== r.id) : [...c, r.id]))}>
                        <td className="w-8"><input type="checkbox" readOnly checked={on} aria-label={`Include ${r.number}`} /></td>
                        <td className="font-mono text-xs">{r.number}</td>
                        <td className="text-xs text-muted">{r.type === 'GoodsReceipt' ? 'Goods received' : 'Bill'}</td>
                        <td>{formatDate(r.date)}</td>
                        <td className="num">{r.quantity}</td>
                        <td className="num">{formatAmount(r.value, fp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function LandedCostDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (l: LandedCost) => void }) {
  const { entity, can } = useSession();
  const queryClient = useQueryClient();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const { data: l } = useQuery({ queryKey: ['landed-cost', id], queryFn: () => api.get<LandedCost>(`/landed-costs/${id}`) });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: 'post' | 'cancel' | 'reverse'; body?: object }) => api.post(`/landed-costs/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      setError(null);
      setReversing(false);
      queryClient.invalidateQueries({ queryKey: ['landed-costs'] });
      queryClient.invalidateQueries({ queryKey: ['landed-cost', id] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      wide
      open
      onClose={onClose}
      title={l ? `${l.number} · ${l.description}` : 'Landed cost'}
      footer={
        l && (
          <>
            <Button onClick={onClose}>Close</Button>
            {l.status === 'DRAFT' && can('inventory.manage') && (
              <>
                <Button variant="ghost" loading={act.isPending && act.variables?.action === 'cancel'} onClick={() => act.mutate({ action: 'cancel' })}>Cancel draft</Button>
                <Button onClick={() => onEdit(l)}>Edit</Button>
              </>
            )}
            {l.status === 'DRAFT' && can('inventory.approve') && (
              <Button variant="primary" loading={act.isPending && act.variables?.action === 'post'} onClick={() => act.mutate({ action: 'post' })}>Post</Button>
            )}
            {l.status === 'POSTED' && can('inventory.approve') && <Button onClick={() => setReversing(true)}>Reverse</Button>}
          </>
        )
      }
    >
      {!l ? (
        <Loading />
      ) : (
        <div className="space-y-3 text-sm">
          <ErrorBanner error={error} />
          <p className="flex flex-wrap items-center gap-2">
            <StatusBadge status={l.status} /> {formatAmount(l.amount, fp)} {entity!.functionalCurrency} by {l.method.toLowerCase()} · {formatDate(l.date)} · {l.receipts.map((r) => r.number).join(', ')}
          </p>
          {l.reversalReason && <Notice tone="amber">Reversed: {l.reversalReason}</Notice>}
          {l.allocations.length > 0 ? (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th className="num">Received</th>
                  <th className="num">Share</th>
                  <th className="num">Into stock</th>
                  <th className="num">To cost of sales</th>
                </tr>
              </thead>
              <tbody>
                {l.allocations.map((a) => {
                  const item = items.find((i) => i.id === a.itemId);
                  return (
                    <tr key={`${a.itemId}-${a.warehouseId}`}>
                      <td>{item ? `${item.code} · ${item.name}` : '—'}</td>
                      <td>{warehouses.find((w) => w.id === a.warehouseId)?.code}</td>
                      <td className="num">{a.quantity}</td>
                      <td className="num">{formatAmount(a.amount, fp)}</td>
                      <td className="num">{formatAmount(a.capitalised, fp)}</td>
                      <td className="num">{formatAmount(a.expensed, fp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-muted">Posting spreads the amount over the stock the receipts brought in and moves it out of the clearing account.</p>
          )}
        </div>
      )}
      <ReasonDialog
        open={reversing}
        withDate
        minDate={l?.date.slice(0, 10)}
        title={`Reverse ${l?.number ?? ''}`}
        description="The charges go back to the clearing account. The share added to stock comes back out of what is still on hand; any of it sold since stays in cost of sales."
        confirmLabel="Reverse"
        busy={act.isPending}
        onClose={() => setReversing(false)}
        onConfirm={({ reason, date }) => act.mutate({ action: 'reverse', body: { reason, date } })}
      />
    </Modal>
  );
}
