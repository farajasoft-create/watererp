'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDate, today } from '@/modules/finance/ui/lib/format';
import { useItems, useWarehouses } from '@/modules/finance/ui/lib/operations-hooks';
import { useAccounts, useDimensions, useSession } from '@/modules/finance/ui/lib/session';
import { AccountOptions } from './commercial/shared';
import { Badge, Button, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from './ui';

const decimal = /^\d*(\.\d*)?$/;

interface Line { lineNo: number; itemId: string; accountId: string | null; requested: string; approved: string | null; issued: string | null; received: string | null; value: string | null }
interface StoreRequisition {
  id: string;
  number: string;
  kind: 'ISSUE' | 'BRANCH';
  counter: boolean;
  date: string;
  purpose: string;
  warehouseId: string;
  toWarehouseId: string | null;
  departmentId: string | null;
  lines: Line[];
  status: string;
  collectedBy: string;
  reference: string;
  rejectionReason?: string;
  createdBy: string;
  submittedBy?: string | null;
}
type Action = { kind: 'approve' | 'issue' | 'receive' | 'reject'; r: StoreRequisition };

/** Store requisitions (S11), counter issues and branch dispatches with receipt acknowledgement. */
export function StoreRequisitionsPage() {
  const { entity, me, can } = useSession();
  const qc = useQueryClient();
  const { data: items = [] } = useItems();
  const { data: warehouses = [] } = useWarehouses();
  const { data: dimensions = [] } = useDimensions();
  const { data: accounts = [] } = useAccounts(entity?.id);
  const departments = dimensions.filter((d) => d.type === 'DEPARTMENT' && d.isActive);
  const stock = items.filter((i) => i.type === 'STOCK');
  const [tab, setTab] = useState<'ISSUE' | 'BRANCH'>('ISSUE');
  const list = useQuery({ queryKey: ['store-requisitions', entity?.id, tab], queryFn: () => api.get<StoreRequisition[]>('/store-requisitions', { entityId: entity!.id, kind: tab }), enabled: !!entity });
  const [form, setForm] = useState<null | { counter: boolean; date: string; purpose: string; warehouseId: string; toWarehouseId: string; departmentId: string; collectedBy: string; lines: { itemId: string; quantity: string; accountId: string }[] }>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [extra, setExtra] = useState({ date: today(), collectedBy: '', reference: '', notes: '', lossAccountId: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['store-requisitions'] });
  const itemName = (id: string) => { const i = items.find((x) => x.id === id); return i ? `${i.code} · ${i.name}` : ''; };
  const whName = (id: string | null) => warehouses.find((w) => w.id === id)?.name ?? '';

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const f = form!;
      const body = { entityId: entity!.id, kind: tab, date: f.date, purpose: f.purpose, warehouseId: f.warehouseId, toWarehouseId: tab === 'BRANCH' ? f.toWarehouseId || null : null, departmentId: tab === 'ISSUE' ? f.departmentId || null : null, lines: f.lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, quantity: l.quantity || '0', accountId: tab === 'ISSUE' ? l.accountId || null : null })) };
      if (f.counter) return api.post('/store-requisitions/counter-issue', { ...body, collectedBy: f.collectedBy });
      const saved = await api.post<StoreRequisition>('/store-requisitions', body);
      if (submit) await api.post(`/store-requisitions/${saved.id}/submit`);
    },
    onSuccess: () => (setForm(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const act = useMutation({
    mutationFn: () => {
      const a = action!;
      const lines = a.r.lines.map((l) => ({ lineNo: l.lineNo, quantity: qty[l.lineNo] ?? '0' }));
      if (a.kind === 'approve') return api.post(`/store-requisitions/${a.r.id}/approve`, { approved: lines });
      if (a.kind === 'reject') return api.post(`/store-requisitions/${a.r.id}/reject`, { reason: extra.reason });
      if (a.kind === 'issue') return api.post(`/store-requisitions/${a.r.id}/issue`, { date: extra.date, collectedBy: extra.collectedBy || undefined, reference: extra.reference || undefined, lines });
      return api.post(`/store-requisitions/${a.r.id}/receive`, { date: extra.date, notes: extra.notes || undefined, lossAccountId: extra.lossAccountId || null, lines });
    },
    onSuccess: () => (setAction(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const simple = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'submit' | 'cancel' }) => api.post(`/store-requisitions/${id}/${kind}`),
    onSuccess: () => (setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const open = (kind: Action['kind'], r: StoreRequisition) => {
    setError(null);
    const base = kind === 'approve' ? (l: Line) => l.requested : kind === 'issue' ? (l: Line) => l.approved ?? '0' : (l: Line) => l.issued ?? '0';
    setQty(Object.fromEntries(r.lines.map((l) => [l.lineNo, base(l)])));
    setExtra({ date: today(), collectedBy: '', reference: '', notes: '', lossAccountId: '', reason: '' });
    setAction({ kind, r });
  };
  const newForm = (counter: boolean) => {
    setError(null);
    setForm({ counter, date: today(), purpose: '', warehouseId: warehouses[0]?.id ?? '', toWarehouseId: '', departmentId: '', collectedBy: '', lines: [{ itemId: '', quantity: '', accountId: '' }] });
  };

  return (
    <>
      <PageHeader
        title="Store requisitions"
        description="Departments requisition items from a store; their head approves and the storekeeper issues, charging the department. Branch stores requisition from another store, which dispatches; the branch confirms what arrived."
        actions={
          <>
            {tab === 'ISSUE' && can('inventory.manage') && <Button onClick={() => newForm(true)}>Counter issue</Button>}
            {can('procurement.request') && <Button variant="primary" onClick={() => newForm(false)}>New requisition</Button>}
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'ISSUE', label: 'Issues to departments' }, { id: 'BRANCH', label: 'Branch requisitions' }]} />
      <ErrorBanner error={!form && !action ? error : null} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="No requisitions yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Number</th><th>Date</th><th>{tab === 'ISSUE' ? 'Department' : 'From → to'}</th><th>Purpose</th><th>Items</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((r) => {
                const mine = r.createdBy === me.id || r.submittedBy === me.id;
                return (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.number}{r.counter && <Badge tone="gray">Counter</Badge>}</td>
                    <td>{formatDate(r.date)}</td>
                    <td>{tab === 'ISSUE' ? dimensions.find((d) => d.id === r.departmentId)?.name ?? '' : `${whName(r.warehouseId)} → ${whName(r.toWarehouseId)}`}</td>
                    <td>{r.purpose}{r.collectedBy && <div className="text-xs text-muted">Collected by {r.collectedBy}</div>}</td>
                    <td className="text-xs">{r.lines.map((l) => `${itemName(l.itemId)} × ${l.issued ?? l.approved ?? l.requested}`).join('; ')}</td>
                    <td><StatusBadge status={r.status === 'REJECTED' ? 'RETURNED' : r.status} /></td>
                    <td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => window.open(`/api/v1/finance/store-requisitions/${r.id}/voucher`, '_blank', 'noopener')}>Voucher</Button>
                      {['DRAFT', 'REJECTED'].includes(r.status) && can('procurement.request') && <Button size="sm" variant="ghost" onClick={() => simple.mutate({ id: r.id, kind: 'submit' })}>Submit</Button>}
                      {r.status === 'SUBMITTED' && can('inventory.approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => open('reject', r)}>Return</Button>
                          <Button size="sm" variant="primary" disabled={mine} title={mine ? 'You raised this requisition' : undefined} onClick={() => open('approve', r)}>Approve</Button>
                        </>
                      )}
                      {r.status === 'APPROVED' && can('inventory.manage') && <Button size="sm" variant="primary" onClick={() => open('issue', r)}>{r.kind === 'ISSUE' ? 'Issue' : 'Dispatch'}</Button>}
                      {r.status === 'DISPATCHED' && can('inventory.manage') && <Button size="sm" variant="primary" onClick={() => open('receive', r)}>Confirm receipt</Button>}
                      {['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'].includes(r.status) && can('procurement.request') && <Button size="sm" variant="ghost" onClick={() => simple.mutate({ id: r.id, kind: 'cancel' })}>Cancel</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={action ? `${{ approve: 'Approve', issue: action.r.kind === 'ISSUE' ? 'Issue' : 'Dispatch', receive: 'Confirm receipt of', reject: 'Return' }[action.kind]} ${action.r.number}` : ''}
        footer={<><Button onClick={() => setAction(null)}>Back</Button><Button variant="primary" loading={act.isPending} onClick={() => act.mutate()}>Confirm</Button></>}
      >
        {action && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            {action.kind === 'reject' ? (
              <Field label="Reason"><Textarea rows={3} value={extra.reason} onChange={(e) => setExtra({ ...extra, reason: e.target.value })} /></Field>
            ) : (
              <>
                <table className="table-base">
                  <thead><tr><th>Item</th><th className="num">Requested</th>{action.kind !== 'approve' && <th className="num">{action.kind === 'issue' ? 'Approved' : 'Dispatched'}</th>}<th className="num">{action.kind === 'approve' ? 'Approve' : action.kind === 'issue' ? 'Issue' : 'Received'}</th></tr></thead>
                  <tbody>
                    {action.r.lines.map((l) => (
                      <tr key={l.lineNo}>
                        <td>{itemName(l.itemId)}</td>
                        <td className="num">{l.requested}</td>
                        {action.kind !== 'approve' && <td className="num">{action.kind === 'issue' ? l.approved : l.issued}</td>}
                        <td><Input className="h-8 w-24 text-right" value={qty[l.lineNo] ?? ''} onChange={(e) => decimal.test(e.target.value) && setQty({ ...qty, [l.lineNo]: e.target.value })} aria-label="Quantity" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {action.kind !== 'approve' && <Field label="Date"><Input type="date" value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></Field>}
                {action.kind === 'issue' && action.r.kind === 'ISSUE' && <Field label="Collected by"><Input value={extra.collectedBy} onChange={(e) => setExtra({ ...extra, collectedBy: e.target.value })} /></Field>}
                {action.kind === 'issue' && action.r.kind === 'BRANCH' && <Field label="Vehicle / delivery reference"><Input value={extra.reference} onChange={(e) => setExtra({ ...extra, reference: e.target.value })} /></Field>}
                {action.kind === 'issue' && (
                  <Field label="Scan" hint="Scan each item's barcode (or type its code and press Enter); every scan adds one to its line">
                    <Input
                      placeholder="Barcode"
                      onKeyDown={async (e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const input = e.currentTarget;
                        const code = input.value.trim();
                        input.value = '';
                        if (!code) return;
                        try {
                          const item = await api.get<{ id: string; code: string }>(`/items/by-code/${encodeURIComponent(code)}`);
                          const line = action.r.lines.find((l) => l.itemId === item.id);
                          if (!line) return setError(`${item.code} is not on this requisition`);
                          setError(null);
                          setQty((q) => ({ ...q, [line.lineNo]: String(Number(q[line.lineNo] ?? '0') + 1) }));
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    />
                  </Field>
                )}
                {action.kind === 'receive' && (
                  <>
                    <Field label="Charge any shortfall to" hint="Needed only if less arrived than was dispatched"><Select value={extra.lossAccountId} onChange={(e) => setExtra({ ...extra, lossAccountId: e.target.value })}><AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES']} placeholder="—" /></Select></Field>
                    <Field label="Notes"><Textarea rows={2} value={extra.notes} onChange={(e) => setExtra({ ...extra, notes: e.target.value })} /></Field>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.counter ? 'Counter issue' : tab === 'ISSUE' ? 'Store requisition' : 'Branch requisition'}
        footer={
          form?.counter ? (
            <><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>Issue now</Button></>
          ) : (
            <><Button onClick={() => setForm(null)}>Cancel</Button><Button loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button></>
          )
        }
      >
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            {form.counter && <Notice tone="blue">Issued on the spot: you approve and issue in one step, and the stock leaves the store now.</Notice>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
              <Field label={tab === 'BRANCH' ? 'Supplying store' : 'Store'}>
                <Select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>{warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} · {w.name}</option>))}</Select>
              </Field>
              {tab === 'BRANCH' ? (
                <Field label="Store being supplied">
                  <Select value={form.toWarehouseId} onChange={(e) => setForm({ ...form, toWarehouseId: e.target.value })}>
                    <option value="">Choose…</option>
                    {warehouses.filter((w) => w.id !== form.warehouseId).map((w) => (<option key={w.id} value={w.id}>{w.code} · {w.name}</option>))}
                  </Select>
                </Field>
              ) : (
                <Field label="Department">
                  <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                    <option value="">—</option>
                    {departments.map((d) => (<option key={d.id} value={d.id}>{d.code} · {d.name}</option>))}
                  </Select>
                </Field>
              )}
              <Field label="Purpose" className="sm:col-span-3"><Input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
              {form.counter && <Field label="Collected by" className="sm:col-span-3"><Input value={form.collectedBy} onChange={(e) => setForm({ ...form, collectedBy: e.target.value })} /></Field>}
            </div>
            <table className="table-base">
              <thead><tr><th className="min-w-56">Item</th><th className="num">Quantity</th>{tab === 'ISSUE' && <th className="min-w-52">Charge to</th>}<th /></tr></thead>
              <tbody>
                {form.lines.map((l, i) => {
                  const set = (p: Partial<typeof l>) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  return (
                    <tr key={i}>
                      <td><Select className="h-8 text-xs" value={l.itemId} onChange={(e) => set({ itemId: e.target.value })} aria-label="Item"><option value="">Select…</option>{stock.map((it) => (<option key={it.id} value={it.id}>{it.code} · {it.name}</option>))}</Select></td>
                      <td><Input className="h-8 w-24 text-right text-xs" value={l.quantity} onChange={(e) => decimal.test(e.target.value) && set({ quantity: e.target.value })} aria-label="Quantity" /></td>
                      {tab === 'ISSUE' && <td><Select className="h-8 text-xs" value={l.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account"><AccountOptions accounts={accounts} classes={['EXPENSE', 'COST_OF_SALES']} placeholder="Item's cost account" /></Select></td>}
                      <td><Button size="sm" variant="ghost" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })} aria-label="Remove">×</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button size="sm" onClick={() => setForm({ ...form, lines: [...form.lines, { itemId: '', quantity: '', accountId: '' }] })}>Add item</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

interface Receipt {
  id: string;
  number: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  date: string;
  reference: string;
  status: string;
  createdBy: string;
  lines: { poLineNo: number; description: string; quantity: string }[];
  inspection: null | { committee: { userId: string; name: string }[]; decisions: { userId: string; name: string; decision: 'ACCEPT' | 'REJECT'; remarks: string; at: string }[]; status: 'PENDING' | 'ACCEPTED' | 'REJECTED' };
}

/** Inspection and acceptance of deliveries. */
export function InspectionsPage() {
  const { entity, me, can } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'PENDING' | 'UNASSIGNED' | 'ACCEPTED' | 'REJECTED'>('PENDING');
  const list = useQuery({ queryKey: ['inspections', entity?.id, status], queryFn: () => api.get<Receipt[]>('/inspections', { entityId: entity!.id, status }), enabled: !!entity });
  const directory = useQuery({ queryKey: ['directory-users'], queryFn: () => api.get<{ users: { id: string; name: string }[] }>('/directory').then((d) => d.users) });
  const [appointing, setAppointing] = useState<Receipt | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [deciding, setDeciding] = useState<Receipt | null>(null);
  const [decision, setDecision] = useState<{ decision: 'ACCEPT' | 'REJECT'; remarks: string }>({ decision: 'ACCEPT', remarks: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['inspections'] });
  const appoint = useMutation({
    mutationFn: () => api.post(`/goods-receipts/${appointing!.id}/inspection-committee`, { memberIds: members }),
    onSuccess: () => (setAppointing(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: () => api.post(`/goods-receipts/${deciding!.id}/inspection`, { decision: decision.decision, remarks: decision.remarks || undefined }),
    onSuccess: () => (setDeciding(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Inspection and acceptance" description="A committee of at least three, not including whoever received the goods, inspects each delivery. The majority decides: accepted deliveries can be billed; rejected ones are reversed out of stock and the order reopened." />
      <Tabs value={status} onChange={setStatus} tabs={[{ id: 'PENDING', label: 'Awaiting decisions' }, { id: 'UNASSIGNED', label: 'No committee yet' }, { id: 'ACCEPTED', label: 'Accepted' }, { id: 'REJECTED', label: 'Rejected' }]} />
      <ErrorBanner error={!appointing && !deciding ? error : null} className="mb-3" />
      <TableWrap>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty title="Nothing here" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Receipt</th><th>Order</th><th>Delivered</th><th>Goods</th><th>Committee</th><th /></tr></thead>
            <tbody>
              {list.data.map((g) => {
                const member = g.inspection?.committee.some((m) => m.userId === me.id);
                const decided = g.inspection?.decisions.some((d) => d.userId === me.id);
                return (
                  <tr key={g.id}>
                    <td className="font-mono text-xs">{g.number}</td>
                    <td className="font-mono text-xs">{g.purchaseOrderNumber}</td>
                    <td>{formatDate(g.date)}{g.reference && <div className="text-xs text-muted">{g.reference}</div>}</td>
                    <td className="text-xs">{g.lines.map((l) => `${l.description} × ${l.quantity}`).join('; ')}</td>
                    <td className="text-xs">
                      {g.inspection ? g.inspection.committee.map((m) => { const d = g.inspection!.decisions.find((x) => x.userId === m.userId); return `${m.name}: ${d ? (d.decision === 'ACCEPT' ? 'accepted' : `rejected (${d.remarks})`) : 'pending'}`; }).join('; ') : '—'}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {g.inspection && <Button size="sm" variant="ghost" onClick={() => window.open(`/api/v1/finance/goods-receipts/${g.id}/inspection-certificate`, '_blank', 'noopener')}>Certificate</Button>}
                      {!g.inspection?.decisions.length && g.status === 'POSTED' && can('procurement.approve') && <Button size="sm" onClick={() => (setError(null), setMembers(g.inspection?.committee.map((m) => m.userId) ?? []), setAppointing(g))}>{g.inspection ? 'Change committee' : 'Appoint committee'}</Button>}
                      {member && !decided && g.inspection?.status === 'PENDING' && <Button size="sm" variant="primary" onClick={() => (setError(null), setDecision({ decision: 'ACCEPT', remarks: '' }), setDeciding(g))}>Record decision</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal open={!!appointing} onClose={() => setAppointing(null)} title={`Inspection committee for ${appointing?.number ?? ''}`} footer={<><Button onClick={() => setAppointing(null)}>Cancel</Button><Button variant="primary" loading={appoint.isPending} onClick={() => appoint.mutate()}>Appoint</Button></>}>
        <ErrorBanner error={appointing ? error : null} />
        <div className="max-h-72 space-y-1 overflow-auto text-sm">
          {directory.data?.filter((u) => u.id !== appointing?.createdBy).map((u) => (
            <Checkbox key={u.id} label={u.name} checked={members.includes(u.id)} onChange={(v) => setMembers(v ? [...members, u.id] : members.filter((m) => m !== u.id))} />
          ))}
        </div>
      </Modal>

      <Modal open={!!deciding} onClose={() => setDeciding(null)} title={`Inspect ${deciding?.number ?? ''}`} footer={<><Button onClick={() => setDeciding(null)}>Cancel</Button><Button variant="primary" loading={decide.isPending} onClick={() => decide.mutate()}>Record</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={deciding ? error : null} />
          <Field label="Decision">
            <Select value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value as 'ACCEPT' | 'REJECT' })}>
              <option value="ACCEPT">Accept: the goods meet the specification</option>
              <option value="REJECT">Reject</option>
            </Select>
          </Field>
          <Field label="Remarks"><Textarea rows={3} value={decision.remarks} onChange={(e) => setDecision({ ...decision, remarks: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

