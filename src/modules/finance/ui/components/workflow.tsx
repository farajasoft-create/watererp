'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, formatDateTime, today } from '@/modules/finance/ui/lib/format';
import { useBranches, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs } from './ui';

export const DOCUMENT_TYPES: { id: string; label: string }[] = [
  { id: 'JOURNAL', label: 'Journals' },
  { id: 'SALES_INVOICE', label: 'Sales invoices' },
  { id: 'SALES_CREDIT', label: 'Credit notes' },
  { id: 'PURCHASE_BILL', label: 'Supplier bills' },
  { id: 'PURCHASE_CREDIT', label: 'Supplier credits' },
  { id: 'SUPPLIER_PAYMENT', label: 'Supplier payments' },
  { id: 'PURCHASE_REQUISITION', label: 'Requisitions' },
  { id: 'PURCHASE_ORDER', label: 'Purchase orders' },
  { id: 'EXPENSE_CLAIM', label: 'Expense claims' },
  { id: 'IMPREST', label: 'Imprest requests' },
  { id: 'IMPREST_SURRENDER', label: 'Imprest surrenders' },
  { id: 'BUDGET', label: 'Budgets' },
  { id: 'BUDGET_SUBMISSION', label: 'Department budgets' },
  { id: 'BUDGET_REALLOCATION', label: 'Budget changes' },
  { id: 'STOCK_DOCUMENT', label: 'Stock adjustments & transfers' },
  { id: 'CONSOLIDATION_ADJUSTMENT', label: 'Group adjustments' },
];
const typeLabel = (id: string) => DOCUMENT_TYPES.find((t) => t.id === id)?.label ?? id;

export interface ApprovalView {
  id: string;
  documentType: string;
  documentLabel: string;
  documentId: string;
  documentNumber: string;
  description: string;
  link: string;
  amount: string | null;
  currency: string | null;
  ruleName: string;
  stepName: string;
  stepNumber: number;
  stepCount: number;
  approvalsOnStep: number;
  requiredOnStep: number;
  submittedByName: string;
  submittedAt: string;
  waitingHours: number | null;
  dueAt: string | null;
  overdue: boolean;
  escalated: boolean;
  status: string;
  onBehalfOf: string | null;
}

export function useDirectory() {
  return useQuery({ queryKey: ['directory'], queryFn: () => api.get<{ users: { id: string; name: string }[]; roles: { id: string; name: string }[] }>('/directory'), staleTime: 60_000 });
}

const waiting = (h: number | null) => (h === null ? '' : h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ unread: number; items: NotificationItem[] }>('/notifications'), refetchInterval: 60_000 });
  const read = useMutation({
    mutationFn: (ids: string[] | 'all') => api.post('/notifications/read', { ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-ink" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M10 2.5a5 5 0 0 0-5 5v3.2L3.5 13.5h13L15 10.7V7.5a5 5 0 0 0-5-5Z" strokeLinejoin="round" />
          <path d="M8 15.5a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 rounded-lg border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button className="text-xs text-brand-700 hover:underline" onClick={() => read.mutate('all')}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!data?.items.length && <li className="px-3 py-6 text-center text-sm text-muted">Nothing new</li>}
            {data?.items.map((n) => (
              <li key={n.id} className={cx('border-b border-line last:border-0', !n.readAt && 'bg-brand-50/50')}>
                <Link
                  href={n.link ?? '/approvals'}
                  onClick={() => {
                    setOpen(false);
                    if (!n.readAt) read.mutate([n.id]);
                  }}
                  className="block px-3 py-2 hover:bg-black/[0.03]"
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && <p className="truncate text-xs text-muted">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(n.createdAt)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Approvals inbox
// ---------------------------------------------------------------------------------------------

function ApprovalRows({ rows, showStatus }: { rows: ApprovalView[]; showStatus?: boolean }) {
  return (
    <table className="table-base">
      <thead>
        <tr>
          <th>Document</th>
          <th>Description</th>
          <th>Step</th>
          <th>Submitted by</th>
          <th>Waiting</th>
          {showStatus && <th>Status</th>}
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="whitespace-nowrap">
              <Link className="font-mono text-xs text-brand-700 hover:underline" href={r.link}>
                {r.documentNumber || '—'}
              </Link>
              <p className="text-[11px] text-muted">{r.documentLabel}</p>
            </td>
            <td>
              {r.description}
              {r.onBehalfOf && <p className="text-[11px] text-muted">on behalf of {r.onBehalfOf}</p>}
            </td>
            <td className="text-xs">
              {r.stepName} <span className="text-muted">({r.stepNumber}/{r.stepCount})</span>
              {r.requiredOnStep > 1 && <p className="text-[11px] text-muted">{r.approvalsOnStep} of {r.requiredOnStep} approvals</p>}
              <p className="text-[11px] text-muted">{r.ruleName}</p>
            </td>
            <td className="text-xs">
              {r.submittedByName}
              <p className="text-[11px] text-muted">{formatDate(r.submittedAt)}</p>
            </td>
            <td className="whitespace-nowrap text-xs">
              {waiting(r.waitingHours)}
              {r.overdue && <span className="ml-1"><Badge tone={r.escalated ? 'red' : 'amber'}>{r.escalated ? 'escalated' : 'overdue'}</Badge></span>}
            </td>
            {showStatus && <td><StatusBadge status={r.status} /></td>}
            <td className="num whitespace-nowrap">{r.amount ? `${formatAmount(r.amount, 2)} ${r.currency ?? ''}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ApprovalsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<'inbox' | 'all' | 'delegations'>('inbox');
  const [status, setStatus] = useState('PENDING');
  const [type, setType] = useState('');
  const inbox = useQuery({ queryKey: ['approvals-inbox'], queryFn: () => api.get<ApprovalView[]>('/approvals/inbox'), refetchInterval: 60_000 });
  const all = useQuery({ queryKey: ['approvals', status, type], queryFn: () => api.get<ApprovalView[]>('/approvals', { status, documentType: type }), enabled: tab === 'all' && can('workflow.manage') });
  const tabs: { id: 'inbox' | 'all' | 'delegations'; label: string }[] = [{ id: 'inbox', label: `Waiting for me${inbox.data ? ` (${inbox.data.length})` : ''}` }];
  if (can('workflow.manage')) tabs.push({ id: 'all', label: 'All requests' });
  tabs.push({ id: 'delegations', label: 'Delegations' });
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Everything waiting for your approval across journals, documents, payments, purchasing, expenses, budgets and stock, including items delegated or escalated to you. Open a document to approve or reject it."
      />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'inbox' && (
        <TableWrap>
          {inbox.isLoading ? <Loading /> : !inbox.data?.length ? <Empty title="Nothing is waiting for you">Approvals assigned to you, delegated to you or escalated to you appear here.</Empty> : <ApprovalRows rows={inbox.data} />}
        </TableWrap>
      )}
      {tab === 'all' && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              {['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => (
                <option key={s} value={s}>{s.toLowerCase()}</option>
              ))}
            </Select>
            <Select className="w-56" value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type">
              <option value="">All document types</option>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </Select>
          </div>
          <TableWrap>{all.isLoading ? <Loading /> : !all.data?.length ? <Empty title="No approval requests" /> : <ApprovalRows rows={all.data} showStatus />}</TableWrap>
        </>
      )}
      {tab === 'delegations' && <Delegations />}
    </>
  );
}

interface DelegationRow {
  id: string;
  fromUserId: string;
  toUserId: string;
  startDate: string;
  endDate: string;
  documentTypes: string[];
  reason: string;
  isActive: boolean;
}

function Delegations() {
  const { me, can } = useSession();
  const queryClient = useQueryClient();
  const { data: directory } = useDirectory();
  const { data = [], isLoading } = useQuery({ queryKey: ['delegations'], queryFn: () => api.get<DelegationRow[]>('/delegations') });
  const [form, setForm] = useState<null | { fromUserId: string; toUserId: string; startDate: string; endDate: string; documentTypes: string[]; reason: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => directory?.users.find((u) => u.id === id)?.name ?? '—';
  const save = useMutation({
    mutationFn: () => api.post('/delegations', { ...form, fromUserId: form!.fromUserId || undefined }),
    onSuccess: () => (setForm(null), setError(null), queryClient.invalidateQueries({ queryKey: ['delegations'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/delegations/${id}/end`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['delegations'] }),
    onError: (err) => setError(errorMessage(err)),
  });
  const now = today();
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">Hand your approvals to a colleague while you are away. They act on your behalf, and the approval history shows both names.</p>
        <Button variant="primary" onClick={() => (setError(null), setForm({ fromUserId: '', toUserId: '', startDate: now, endDate: now, documentTypes: [], reason: '' }))}>
          Delegate approvals
        </Button>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No delegations" />
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>From</th><th>To</th><th>Period</th><th>Covers</th><th>Reason</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {data.map((d) => {
                const live = d.isActive && d.endDate.slice(0, 10) >= now;
                return (
                  <tr key={d.id}>
                    <td>{name(d.fromUserId)}</td>
                    <td>{name(d.toUserId)}</td>
                    <td className="whitespace-nowrap text-xs">{formatDate(d.startDate)} – {formatDate(d.endDate)}</td>
                    <td className="text-xs">{d.documentTypes.length ? d.documentTypes.map(typeLabel).join(', ') : 'Everything'}</td>
                    <td className="text-muted">{d.reason}</td>
                    <td><Badge tone={live ? 'green' : 'gray'}>{live ? 'active' : 'ended'}</Badge></td>
                    <td className="text-right">{live && (d.fromUserId === me.id || can('workflow.manage')) && <Button size="sm" variant="ghost" onClick={() => end.mutate(d.id)}>End</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>
      <Modal open={!!form} onClose={() => setForm(null)} title="Delegate approvals" footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Delegate</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBanner error={error} className="sm:col-span-2" />
            {can('workflow.manage') && (
              <Field label="On behalf of" className="sm:col-span-2">
                <Select value={form.fromUserId} onChange={(e) => setForm({ ...form, fromUserId: e.target.value })}>
                  <option value="">Me</option>
                  {directory?.users.filter((u) => u.id !== me.id).map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                </Select>
              </Field>
            )}
            <Field label="Delegate to" className="sm:col-span-2">
              <Select value={form.toUserId} onChange={(e) => setForm({ ...form, toUserId: e.target.value })}>
                <option value="">Select…</option>
                {directory?.users.filter((u) => u.id !== (form.fromUserId || me.id)).map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
              </Select>
            </Field>
            <Field label="From"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="Until (inclusive)"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
            <Field label="Document types" hint="Leave all unticked to delegate everything" className="sm:col-span-2">
              <div className="grid grid-cols-2 gap-1 pt-1">
                {DOCUMENT_TYPES.map((t) => (
                  <Checkbox key={t.id} label={t.label} checked={form.documentTypes.includes(t.id)} onChange={(v) => setForm({ ...form, documentTypes: v ? [...form.documentTypes, t.id] : form.documentTypes.filter((x) => x !== t.id) })} />
                ))}
              </div>
            </Field>
            <Field label="Reason" className="sm:col-span-2"><Input value={form.reason} placeholder="e.g. Annual leave" onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Approval history (shown on documents)
// ---------------------------------------------------------------------------------------------

interface HistoryEntry extends ApprovalView {
  rejectionReason: string;
  completedAt: string | null;
  steps: { name: string; status: string; assignedTo: string; requiredApprovals: number; approvals: { userName: string; onBehalfOfName: string | null; comment: string; at: string }[]; startedAt: string | null; completedAt: string | null }[];
}

export function ApprovalHistory({ documentType, documentId }: { documentType: string; documentId: string }) {
  const { data } = useQuery({ queryKey: ['approval-history', documentType, documentId], queryFn: () => api.get<HistoryEntry[]>('/approvals/history', { documentType, documentId }) });
  if (!data?.length) return null;
  const [latest, ...older] = data;
  return (
    <Card title={<span>Approval <span className="ml-1 text-xs font-normal text-muted">{latest.ruleName}</span></span>} className="mt-4">
      <ol className="space-y-3">
        {latest.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', s.status === 'APPROVED' ? 'bg-emerald-600 text-white' : s.status === 'ACTIVE' ? 'bg-amber-400 text-white' : s.status === 'REJECTED' ? 'bg-red-600 text-white' : 'bg-gray-200 text-gray-600')}>
              {s.status === 'APPROVED' ? '✓' : i + 1}
            </span>
            <div className="text-sm">
              <p className="font-medium">
                {s.name} <span className="font-normal text-muted">· {s.assignedTo}{s.requiredApprovals > 1 ? ` · ${s.requiredApprovals} approvals` : ''}</span>
              </p>
              {s.approvals.map((a, k) => (
                <p key={k} className="text-xs text-muted">
                  Approved by {a.userName}
                  {a.onBehalfOfName && ` for ${a.onBehalfOfName}`} · {formatDateTime(a.at)}
                  {a.comment && <span className="text-ink"> — {a.comment}</span>}
                </p>
              ))}
              {s.status === 'ACTIVE' && !s.approvals.length && <p className="text-xs text-muted">Waiting since {formatDateTime(s.startedAt)}{latest.overdue ? ' · overdue' : ''}</p>}
            </div>
          </li>
        ))}
      </ol>
      {latest.status === 'REJECTED' && <p className="mt-3 text-sm text-red-700">Rejected: {latest.rejectionReason}</p>}
      {older.length > 0 && <p className="mt-3 text-xs text-muted">Earlier: {older.map((o) => `${o.status.toLowerCase()} ${formatDate(o.completedAt ?? o.submittedAt)}${o.rejectionReason ? ` (${o.rejectionReason})` : ''}`).join(' · ')}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Workflow settings
// ---------------------------------------------------------------------------------------------

interface Step {
  name: string;
  approverType: 'PERMISSION' | 'ROLE' | 'USER';
  roleId: string | null;
  userId: string | null;
  requiredApprovals: number;
}
interface Rule {
  id: string;
  name: string;
  documentType: string;
  priority: number;
  entityId: string | null;
  branchIds: string[];
  minAmount: string | null;
  maxAmount: string | null;
  steps: Step[];
  slaHours: number | null;
  escalateToUserId: string | null;
  escalateToRoleId: string | null;
  isActive: boolean;
}
type RuleForm = Omit<Rule, 'id' | 'minAmount' | 'maxAmount' | 'slaHours'> & { id?: string; minAmount: string; maxAmount: string; slaHours: string };

const blankRule = (): RuleForm => ({ name: '', documentType: 'JOURNAL', priority: 100, entityId: null, branchIds: [], minAmount: '', maxAmount: '', steps: [{ name: 'Approval', approverType: 'ROLE', roleId: null, userId: null, requiredApprovals: 1 }], slaHours: '', escalateToUserId: null, escalateToRoleId: null, isActive: true });

export function WorkflowSettingsPage() {
  const { entities } = useSession();
  const queryClient = useQueryClient();
  const { data: directory } = useDirectory();
  const rules = useQuery({ queryKey: ['approval-rules'], queryFn: () => api.get<Rule[]>('/approval-rules') });
  const stats = useQuery({ queryKey: ['approval-stats'], queryFn: () => api.get<{ documentType: string; label: string; approved: number; averageHours: number | null; longestHours: number | null; multiStep: number; pending: number; overdue: number; oldestPendingHours: number | null }[]>('/approvals/stats') });
  const [form, setForm] = useState<RuleForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: branches = [] } = useBranches(form?.entityId ?? undefined);
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const body = {
        ...f,
        id: undefined,
        minAmount: f.minAmount || null,
        maxAmount: f.maxAmount || null,
        slaHours: f.slaHours ? Number(f.slaHours) : null,
        steps: f.steps.map((s) => ({ ...s, roleId: s.approverType === 'ROLE' ? s.roleId : null, userId: s.approverType === 'USER' ? s.userId : null })),
      };
      return f.id ? api.patch(`/approval-rules/${f.id}`, body) : api.post('/approval-rules', body);
    },
    onSuccess: () => (setForm(null), setError(null), queryClient.invalidateQueries({ queryKey: ['approval-rules'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/approval-rules/${id}`),
    onSuccess: () => (setForm(null), queryClient.invalidateQueries({ queryKey: ['approval-rules'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  const roleName = (id: string | null) => directory?.roles.find((r) => r.id === id)?.name ?? '?';
  const userName = (id: string | null) => directory?.users.find((u) => u.id === id)?.name ?? '?';
  const describe = (s: Step) => `${s.name}: ${s.approverType === 'ROLE' ? roleName(s.roleId) : s.approverType === 'USER' ? userName(s.userId) : 'anyone with approval rights'}${s.requiredApprovals > 1 ? ` ×${s.requiredApprovals}` : ''}`;
  const band = (r: Rule) => (r.minAmount && r.maxAmount ? `${formatAmount(r.minAmount, 0)} – ${formatAmount(r.maxAmount, 0)}` : r.minAmount ? `from ${formatAmount(r.minAmount, 0)}` : r.maxAmount ? `below ${formatAmount(r.maxAmount, 0)}` : 'any amount');
  const edit = (r: Rule) => (setError(null), setForm({ ...r, minAmount: r.minAmount ?? '', maxAmount: r.maxAmount ?? '', slaHours: r.slaHours ? String(r.slaHours) : '' }));
  const setStep = (i: number, p: Partial<Step>) => setForm({ ...form!, steps: form!.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  return (
    <>
      <PageHeader
        title="Approval workflow"
        description="Rules route each document type by entity, branch and amount through one or more approval steps. Documents that match no rule need one approval from anyone with approval rights. Segregation of duties and approval limits always apply, and the final approval is the one that posts."
        actions={<Button variant="primary" onClick={() => (setError(null), setForm(blankRule()))}>New rule</Button>}
      />
      <TableWrap>
        {rules.isLoading ? (
          <Loading />
        ) : !rules.data?.length ? (
          <Empty title="No approval rules yet">Every document currently needs one approval.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Rule</th><th>Documents</th><th>Applies to</th><th>Steps</th><th>SLA</th><th /></tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'opacity-50'}>
                  <td className="font-medium">{r.name}<p className="text-[11px] font-normal text-muted">priority {r.priority}</p></td>
                  <td>{typeLabel(r.documentType)}</td>
                  <td className="text-xs">
                    {band(r)}
                    <p className="text-muted">{r.entityId ? entities.find((e) => e.id === r.entityId)?.code : 'all entities'}{r.branchIds.length ? ` · ${r.branchIds.length} branch(es)` : ''}</p>
                  </td>
                  <td className="text-xs">{r.steps.map((s, i) => (<p key={i}>{i + 1}. {describe(s)}</p>))}</td>
                  <td className="text-xs">{r.slaHours ? `${r.slaHours} h → ${r.escalateToUserId ? userName(r.escalateToUserId) : r.escalateToRoleId ? roleName(r.escalateToRoleId) : 'no escalation'}` : '—'}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => edit(r)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Card title="Approval times (last 90 days)" padded={false} className="mt-5">
        {!stats.data?.length ? (
          <p className="p-4 text-sm text-muted">No approvals yet.</p>
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Documents</th><th className="num">Approved</th><th className="num">Average</th><th className="num">Longest</th><th className="num">Multi-step</th><th className="num">Pending</th><th className="num">Overdue</th><th className="num">Oldest pending</th></tr>
            </thead>
            <tbody>
              {stats.data.map((s) => (
                <tr key={s.documentType}>
                  <td>{s.label}</td>
                  <td className="num">{s.approved}</td>
                  <td className="num">{waiting(s.averageHours)}</td>
                  <td className="num">{waiting(s.longestHours)}</td>
                  <td className="num">{s.multiStep}</td>
                  <td className="num">{s.pending}</td>
                  <td className={cx('num', s.overdue > 0 && 'font-semibold text-red-700')}>{s.overdue}</td>
                  <td className="num">{waiting(s.oldestPendingHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        wide
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit approval rule' : 'New approval rule'}
        footer={
          <>
            {form?.id && <Button variant="ghost" className="mr-auto text-red-700" onClick={() => remove.mutate(form.id!)}>Delete rule</Button>}
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save rule</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Documents">
                <Select value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>
                  {DOCUMENT_TYPES.map((t) => (<option key={t.id} value={t.id}>{t.label}</option>))}
                </Select>
              </Field>
              <Field label="Priority" hint="Lower is checked first"><Input inputMode="numeric" value={form.priority} onChange={(e) => /^\d*$/.test(e.target.value) && setForm({ ...form, priority: Number(e.target.value || 0) })} /></Field>
              <Field label="Entity">
                <Select value={form.entityId ?? ''} onChange={(e) => setForm({ ...form, entityId: e.target.value || null, branchIds: [] })}>
                  <option value="">All entities</option>
                  {entities.map((e) => (<option key={e.id} value={e.id}>{e.code} · {e.name}</option>))}
                </Select>
              </Field>
              <Field label="Minimum amount" hint="Functional currency"><Input inputMode="decimal" value={form.minAmount} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, minAmount: e.target.value })} /></Field>
              <Field label="Below amount"><Input inputMode="decimal" value={form.maxAmount} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, maxAmount: e.target.value })} /></Field>
              <Field label="Status"><Checkbox label="Active" checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} /></Field>
              {form.entityId && (
                <Field label="Branches (none ticked = all)" className="sm:col-span-4">
                  <div className="flex flex-wrap gap-3 pt-1">
                    {branches.map((b) => (
                      <Checkbox key={b.id} label={b.code} checked={form.branchIds.includes(b.id)} onChange={(v) => setForm({ ...form, branchIds: v ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id) })} />
                    ))}
                  </div>
                </Field>
              )}
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">Steps (in order)</p>
              <div className="space-y-2">
                {form.steps.map((s, i) => (
                  <div key={i} className="grid items-end gap-2 rounded-md border border-line p-2 sm:grid-cols-[2rem_1fr_1fr_1fr_6rem_auto]">
                    <span className="pb-2 text-sm font-semibold text-muted">{i + 1}.</span>
                    <Field label="Step name"><Input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} /></Field>
                    <Field label="Approver">
                      <Select value={s.approverType} onChange={(e) => setStep(i, { approverType: e.target.value as Step['approverType'], requiredApprovals: e.target.value === 'USER' ? 1 : s.requiredApprovals })}>
                        <option value="ROLE">Members of a role</option>
                        <option value="USER">A named person</option>
                        <option value="PERMISSION">Anyone with approval rights</option>
                      </Select>
                    </Field>
                    <Field label={s.approverType === 'USER' ? 'Person' : s.approverType === 'ROLE' ? 'Role' : ' '}>
                      {s.approverType === 'ROLE' ? (
                        <Select value={s.roleId ?? ''} onChange={(e) => setStep(i, { roleId: e.target.value || null })}>
                          <option value="">Select…</option>
                          {directory?.roles.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                        </Select>
                      ) : s.approverType === 'USER' ? (
                        <Select value={s.userId ?? ''} onChange={(e) => setStep(i, { userId: e.target.value || null })}>
                          <option value="">Select…</option>
                          {directory?.users.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                        </Select>
                      ) : (
                        <p className="pb-2 text-xs text-muted">The document&apos;s approve permission</p>
                      )}
                    </Field>
                    <Field label="Approvals"><Input inputMode="numeric" disabled={s.approverType === 'USER'} value={s.requiredApprovals} onChange={(e) => /^\d*$/.test(e.target.value) && setStep(i, { requiredApprovals: Math.max(1, Number(e.target.value || 1)) })} /></Field>
                    <Button size="sm" variant="ghost" disabled={form.steps.length === 1} onClick={() => setForm({ ...form, steps: form.steps.filter((_, k) => k !== i) })} aria-label={`Remove step ${i + 1}`}>✕</Button>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setForm({ ...form, steps: [...form.steps, { name: `Step ${form.steps.length + 1}`, approverType: 'ROLE', roleId: null, userId: null, requiredApprovals: 1 }] })}>
                + Add step
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="SLA per step (hours)" hint="Overdue steps escalate"><Input inputMode="numeric" value={form.slaHours} onChange={(e) => /^\d*$/.test(e.target.value) && setForm({ ...form, slaHours: e.target.value })} /></Field>
              <Field label="Escalate to person">
                <Select value={form.escalateToUserId ?? ''} onChange={(e) => setForm({ ...form, escalateToUserId: e.target.value || null })}>
                  <option value="">—</option>
                  {directory?.users.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                </Select>
              </Field>
              <Field label="or role">
                <Select value={form.escalateToRoleId ?? ''} onChange={(e) => setForm({ ...form, escalateToRoleId: e.target.value || null })}>
                  <option value="">—</option>
                  {directory?.roles.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                </Select>
              </Field>
            </div>
            <Notice>Changes apply to documents submitted from now on; requests already in progress keep their steps.</Notice>
          </div>
        )}
      </Modal>
    </>
  );
}
