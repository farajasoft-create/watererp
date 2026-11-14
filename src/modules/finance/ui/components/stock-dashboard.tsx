'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, today } from '@/modules/finance/ui/lib/format';
import { useBranches, useSession } from '@/modules/finance/ui/lib/session';
import { Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap } from './ui';

interface Row { itemId: string; code: string; name: string; unit: string; category: string; quantity: string; value: string; reorderLevel: string | null; light: 'RED' | 'AMBER' | 'GREEN' | 'NONE'; autoRequisition: { number: string } | null }
interface Board { currency: string; summary: { items: number; red: number; amber: number; green: number; unset: number; value: string }; rows: Row[] }
interface Category { id: string; code: string; name: string; parentId: string | null; path: string; depth: number; items: number; itemsBelow: number }

const DOT: Record<Row['light'], string> = { RED: 'bg-red-500', AMBER: 'bg-amber-400', GREEN: 'bg-green-500', NONE: 'bg-gray-300' };
const WORD: Record<Row['light'], string> = { RED: 'Out or critical', AMBER: 'Below re-order level', GREEN: 'Enough', NONE: 'No re-order level' };

function Categories({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['item-categories'], queryFn: () => api.get<Category[]>('/item-categories') });
  const [f, setF] = useState({ code: '', name: '', parentId: '' });
  const save = useMutation({ mutationFn: () => api.post('/item-categories', { ...f, parentId: f.parentId || null }), onSuccess: () => { setF({ code: '', name: '', parentId: '' }); qc.invalidateQueries({ queryKey: ['item-categories'] }); } });
  return (
    <Modal open title="Item categories" onClose={onClose}>
      <ErrorBanner error={save.error || list.error} />
      {!list.data ? <Loading /> : (
        <ul className="mb-3 text-sm">{list.data.map((c) => <li key={c.id} style={{ paddingLeft: c.depth * 16 }}>{c.name} <span className="text-xs text-gray-500">{c.code} · {c.itemsBelow} item(s)</span></li>)}</ul>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Under"><Select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">(top level)</option>{list.data?.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}</Select></Field>
      </div>
      <Button className="mt-2" onClick={() => save.mutate()} disabled={!f.code || !f.name || save.isPending}>Add category</Button>
    </Modal>
  );
}

/** The stock dashboard: every stock item as a traffic light against its re-order level, by category, with automatic re-order requisitions. */
export function StockDashboardPage() {
  const { entity, can } = useSession();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches(entity?.id);
  const [category, setCategory] = useState('');
  const [light, setLight] = useState('');
  const [editing, setEditing] = useState(false);
  const board = useQuery({ queryKey: ['stock-dashboard', entity?.id], queryFn: () => api.get<Board>('/inventory/dashboard', { entityId: entity!.id }), enabled: !!entity });
  const categories = useQuery({ queryKey: ['item-categories'], queryFn: () => api.get<Category[]>('/item-categories') });
  const inCategory = useQuery({ queryKey: ['items', category], queryFn: () => api.get<{ id: string }[]>('/items', { categoryId: category }), enabled: !!category });
  const auto = useMutation({ mutationFn: () => api.post<{ created: { number: string } | null; items: number }>('/inventory/auto-requisition', { entityId: entity!.id, branchId: branches[0]?.id, date: today() }), onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-dashboard'] }) });
  const ids = category ? new Set(inCategory.data?.map((i) => i.id)) : null;
  const rows = board.data?.rows.filter((r) => (!ids || ids.has(r.itemId)) && (!light || r.light === light)) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock dashboard"
        description="Every stock item against its re-order level. Raising re-order requisitions drafts one purchase requisition for everything below its level that is not already being ordered."
        actions={<>{can('inventory.manage') && <Button onClick={() => setEditing(true)}>Categories</Button>}{can('inventory.manage') && <Button onClick={() => auto.mutate()} loading={auto.isPending} disabled={!branches.length}>Raise re-order requisitions</Button>}</>}
      />
      <ErrorBanner error={board.error || auto.error} />
      {auto.data && <Notice tone="green">{auto.data.created ? `Drafted ${auto.data.created.number} for ${auto.data.items} item(s); submit it from Purchase requisitions.` : 'Nothing new to re-order.'}</Notice>}
      {board.data && (
        <div className="grid gap-3 sm:grid-cols-4">
          {(['RED', 'AMBER', 'GREEN', 'NONE'] as const).map((l) => (
            <button key={l} type="button" onClick={() => setLight(light === l ? '' : l)} className={`rounded-lg border p-3 text-left ${light === l ? 'ring-2 ring-brand-500' : ''}`}>
              <div className="flex items-center gap-2 text-xs text-gray-500"><span className={`inline-block h-3 w-3 rounded-full ${DOT[l]}`} />{WORD[l]}</div>
              <div className="text-xl font-semibold">{board.data.summary[l === 'NONE' ? 'unset' : (l.toLowerCase() as 'red' | 'amber' | 'green')]}</div>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth)}{c.name}</option>)}</Select></Field>
        {board.data && <span className="pb-2 text-sm text-gray-500">Stock value {formatAmount(board.data.summary.value)} {board.data.currency}</span>}
      </div>
      {board.isLoading ? <Loading /> : !rows.length ? <Empty title="No stock items here" /> : (
        <Card padded={false}>
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="p-2" /><th>Item</th><th>Category</th><th className="text-right">On hand</th><th className="text-right">Re-order level</th><th className="text-right">Value</th><th>Re-order</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId} className="border-t">
                    <td className="p-2"><span title={WORD[r.light]} className={`inline-block h-3 w-3 rounded-full ${DOT[r.light]}`} /></td>
                    <td>{r.code} · {r.name}</td>
                    <td className="text-xs text-gray-500">{r.category}</td>
                    <td className="text-right">{formatAmount(r.quantity)} {r.unit}</td>
                    <td className="text-right">{r.reorderLevel ? formatAmount(r.reorderLevel) : '—'}</td>
                    <td className="text-right">{formatAmount(r.value)}</td>
                    <td className="text-xs">{r.autoRequisition?.number ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
      {editing && <Categories onClose={() => setEditing(false)} />}
    </div>
  );
}
