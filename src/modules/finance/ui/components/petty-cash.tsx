'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, TableWrap, Tabs } from './ui';

interface Box { id: string; name: string; currency: string }
interface Category { id: string; code: string; name: string; isActive: boolean }
interface Voucher { id: string; number: string; bankAccountId: string; categoryName: string; amount: string; currency: string; purpose: string; payee?: string; status: string; requesterName: string; rejectionReason?: string; receiptReference?: string; createdAt: string; paidAt?: string }
interface Book { balance: string; float: string | null; replenish: string; pending: string; categories: { categoryId: string; name: string; perVoucher: string | null; perMonth: string | null; usedThisMonth: string; left: string | null }[] }
interface Limits { float: string | null; categories: { categoryId: string; perVoucher: string | null; perMonth: string | null }[] }

function LimitsModal({ box, categories, onClose }: { box: Box; categories: Category[]; onClose: () => void }) {
  const qc = useQueryClient();
  const limits = useQuery({ queryKey: ['petty-limits', box.id], queryFn: () => api.get<Limits>(`/petty-cash/boxes/${box.id}/limits`) });
  const [edit, setEdit] = useState<{ float: string; rows: Record<string, { on: boolean; perVoucher: string; perMonth: string }> } | null>(null);
  const state = edit ?? (limits.data ? { float: limits.data.float ?? '', rows: Object.fromEntries(categories.map((c) => { const l = limits.data!.categories.find((x) => x.categoryId === c.id); return [c.id, { on: !!l, perVoucher: l?.perVoucher ?? '', perMonth: l?.perMonth ?? '' }]; })) } : null);
  const save = useMutation({
    mutationFn: () => api.patch(`/petty-cash/boxes/${box.id}/limits`, { float: state!.float || null, categories: Object.entries(state!.rows).filter(([, r]) => r.on).map(([categoryId, r]) => ({ categoryId, perVoucher: r.perVoucher || null, perMonth: r.perMonth || null })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['petty-book'] }); qc.invalidateQueries({ queryKey: ['petty-limits'] }); onClose(); },
  });
  return (
    <Modal open title={`Limits: ${box.name}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!state || save.isPending}>Save</Button></>}>
      <ErrorBanner error={save.error} />
      {!state ? <Loading /> : (
        <div className="space-y-3">
          <Field label={`Float (${box.currency})`}><Input inputMode="decimal" value={state.float} onChange={(e) => setEdit({ ...state, float: e.target.value })} /></Field>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th>Category paid from this box</th><th>Most per voucher</th><th>Most per month</th></tr></thead>
            <tbody>
              {categories.filter((c) => c.isActive).map((c) => {
                const r = state.rows[c.id];
                const set = (x: Partial<typeof r>) => setEdit({ ...state, rows: { ...state.rows, [c.id]: { ...r, ...x } } });
                return (
                  <tr key={c.id}>
                    <td><label className="flex items-center gap-1.5"><input type="checkbox" checked={r.on} onChange={(e) => set({ on: e.target.checked })} /> {c.name}</label></td>
                    <td><Input inputMode="decimal" disabled={!r.on} value={r.perVoucher} onChange={(e) => set({ perVoucher: e.target.value })} /></td>
                    <td><Input inputMode="decimal" disabled={!r.on} value={r.perMonth} onChange={(e) => set({ perMonth: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function RequestModal({ boxes, categories, onClose }: { boxes: Box[]; categories: Category[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ bankAccountId: boxes[0]?.id ?? '', categoryId: '', amount: '', purpose: '', payee: '' });
  const save = useMutation({ mutationFn: () => api.post('/petty-cash', { ...f, payee: f.payee || undefined }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['petty'] }); onClose(); } });
  return (
    <Modal open title="Request petty cash" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.bankAccountId || !f.categoryId || !f.amount || f.purpose.length < 3}>Submit</Button></>}>
      <ErrorBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Petty cash box"><Select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>{boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Category"><Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Choose</option>{categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Amount"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Paid to (optional)"><Input value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></Field>
        <Field label="Purpose" className="sm:col-span-2"><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Petty cash: online requests, approval, payment from the box, limits per category and the petty cash book. */
export function PettyCashPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const reviewer = can('expenses.approve') || can('expenses.pay');
  const [tab, setTab] = useState<'mine' | 'all' | 'book'>('mine');
  const [requesting, setRequesting] = useState(false);
  const [limitsFor, setLimitsFor] = useState<Box | null>(null);
  const [bookBox, setBookBox] = useState('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const boxes = useQuery({ queryKey: ['petty-boxes'], queryFn: () => api.get<Box[]>('/petty-cash/boxes') });
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<Category[]>('/expense-categories') });
  const list = useQuery({ queryKey: ['petty', tab], queryFn: () => api.get<Voucher[]>('/petty-cash', tab === 'mine' ? { mine: 'true' } : {}), enabled: tab !== 'book' });
  const boxId = bookBox || boxes.data?.[0]?.id || '';
  const book = useQuery({ queryKey: ['petty-book', boxId], queryFn: () => api.get<Book>(`/petty-cash/boxes/${boxId}/book`), enabled: tab === 'book' && !!boxId && can('expenses.pay') });
  const act = useMutation({
    mutationFn: (x: { id: string; action: string; body?: object }) => api.post(`/petty-cash/${x.id}/${x.action}`, x.body),
    onSuccess: () => ['petty', 'petty-book'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Petty cash"
        description="Requests are checked against each category's limits; an approver other than the requester approves and the custodian pays from the box."
        actions={can('expenses.submit') && !!boxes.data?.length && <Button onClick={() => setRequesting(true)}>Request petty cash</Button>}
      />
      <ErrorBanner error={list.error || act.error || book.error} />
      <Tabs tabs={[{ id: 'mine', label: 'My requests' }, ...(reviewer ? [{ id: 'all' as const, label: 'All requests' }] : []), ...(can('expenses.pay') ? [{ id: 'book' as const, label: 'Petty cash book' }] : [])]} value={tab} onChange={setTab} />
      {tab !== 'book' && (
        list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="No petty cash requests" /> : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="p-2">Voucher</th><th>Purpose</th><th>Category</th><th className="text-right">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.data.map((v) => (
                  <tr key={v.id} className="border-t">
                    <td className="p-2">{v.number}<div className="text-xs text-gray-500">{v.requesterName} · {formatDate(v.createdAt)}</div></td>
                    <td>{v.purpose}{v.payee && <div className="text-xs text-gray-500">to {v.payee}</div>}{v.rejectionReason && <div className="text-xs text-red-600">{v.rejectionReason}</div>}</td>
                    <td>{v.categoryName}</td>
                    <td className="text-right">{formatAmount(v.amount)} {v.currency}</td>
                    <td><StatusBadge status={v.status} /></td>
                    <td className="space-x-1 whitespace-nowrap">
                      {v.status === 'SUBMITTED' && can('expenses.approve') && <Button onClick={() => act.mutate({ id: v.id, action: 'approve' })}>Approve</Button>}
                      {['SUBMITTED', 'APPROVED'].includes(v.status) && can('expenses.approve') && <><Input className="inline-block w-28" placeholder="Reason" value={reason[v.id] ?? ''} onChange={(e) => setReason({ ...reason, [v.id]: e.target.value })} /><Button variant="secondary" disabled={!reason[v.id]} onClick={() => act.mutate({ id: v.id, action: 'reject', body: { reason: reason[v.id] } })}>Reject</Button></>}
                      {v.status === 'APPROVED' && can('expenses.pay') && <Button onClick={() => act.mutate({ id: v.id, action: 'pay', body: { date: today(), receiptReference: reason[v.id] || undefined } })}>Pay out</Button>}
                      {v.status === 'SUBMITTED' && tab === 'mine' && <Button variant="secondary" onClick={() => act.mutate({ id: v.id, action: 'cancel' })}>Cancel</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )
      )}
      {tab === 'book' && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Box"><Select value={boxId} onChange={(e) => setBookBox(e.target.value)}>{boxes.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            {boxId && <Button variant="secondary" onClick={() => setLimitsFor(boxes.data!.find((b) => b.id === boxId)!)}>Float and limits</Button>}
          </div>
          {!book.data ? (boxes.data?.length ? <Loading /> : <Empty title="No petty cash account">Add a bank account of type Petty cash under Banking.</Empty>) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                {[['Balance', book.data.balance], ['Float', book.data.float ?? '—'], ['To restore the float', book.data.replenish], ['Approved, not yet paid', book.data.pending]].map(([k, v]) => <Card key={k}><div className="text-xs text-gray-500">{k}</div><div className="text-lg font-semibold">{v === '—' ? v : formatAmount(v)}</div></Card>)}
              </div>
              <Card title="Use this month by category" padded={false}>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-gray-500"><th className="p-2">Category</th><th className="text-right">Per voucher</th><th className="text-right">Per month</th><th className="text-right">Used</th><th className="text-right">Left</th></tr></thead>
                  <tbody>{book.data.categories.map((c) => <tr key={c.categoryId} className="border-t"><td className="p-2">{c.name}</td><td className="text-right">{c.perVoucher ? formatAmount(c.perVoucher) : '—'}</td><td className="text-right">{c.perMonth ? formatAmount(c.perMonth) : '—'}</td><td className="text-right">{formatAmount(c.usedThisMonth)}</td><td className="text-right">{c.left ? formatAmount(c.left) : '—'}</td></tr>)}</tbody>
                </table>
              </Card>
            </>
          )}
        </>
      )}
      {requesting && boxes.data && categories.data && <RequestModal boxes={boxes.data} categories={categories.data} onClose={() => setRequesting(false)} />}
      {limitsFor && categories.data && <LimitsModal box={limitsFor} categories={categories.data} onClose={() => setLimitsFor(null)} />}
    </div>
  );
}
