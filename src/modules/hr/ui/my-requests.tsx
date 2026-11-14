'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card } from '@/components/ui';
import { api as platform } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useMe } from '@/lib/session';

interface Approval { id: string; module: string; docType: string; title: string; amount?: string | null; requestedByName?: string; stepName?: string; createdAt: string; link?: string }
interface Task { id: string; number: string; title: string; status: string; dueAt?: string | null }

/**
 * The staff portal's requests and approvals: what is waiting for the employee's decision, their tasks,
 * and a way into every kind of request (requisitions, claims and imprest, IT help, transport, audit
 * actions), shown only for the modules switched on.
 */
export function MyRequests() {
  const { data: me } = useMe();
  const has = (m: string) => Boolean(me?.modules?.includes(m));
  const approvals = useQuery({ queryKey: ['me-approvals'], queryFn: () => platform.get<Approval[]>('/approvals/inbox') });
  const tasks = useQuery({ queryKey: ['me-tasks'], queryFn: () => platform.get<Task[] | { items: Task[] }>('/tasks', { view: 'mine' }) });
  const myTasks = (Array.isArray(tasks.data) ? tasks.data : (tasks.data?.items ?? [])).filter((t) => ['OPEN', 'IN_PROGRESS'].includes(t.status));
  const finance = has('finance') && (me?.isAdmin || me?.permissions.includes('finance.access'));
  const links = [
    finance && { href: '/finance/purchases/requisitions', label: 'Purchase requisitions' },
    finance && { href: '/finance/inventory/requisitions', label: 'Store requisitions (S11)' },
    finance && { href: '/finance/expenses', label: 'Expense claims' },
    finance && { href: '/finance/imprest', label: 'Imprest' },
    has('ict') && { href: '/ict/help', label: 'IT help desk' },
    has('internalaudit') && { href: '/internalaudit/actions', label: 'My audit actions' },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <Card title="Requests and approvals">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="mb-1 text-sm font-medium">Waiting for my approval {approvals.data && <Badge tone={approvals.data.length ? 'amber' : 'gray'}>{approvals.data.length}</Badge>}</div>
          {!approvals.data?.length ? <p className="text-sm text-muted">Nothing waiting.</p> : (
            <ul className="space-y-1 text-sm">
              {approvals.data.slice(0, 6).map((a) => <li key={a.id}><Link href="/approvals" className="text-brand-700 hover:underline">{a.title}</Link> <span className="text-xs text-muted">from {a.requestedByName}{a.stepName && ` · ${a.stepName}`}</span></li>)}
              {approvals.data.length > 6 && <li><Link href="/approvals" className="text-xs text-brand-700 hover:underline">All {approvals.data.length}</Link></li>}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">My tasks {myTasks.length > 0 && <Badge tone="blue">{myTasks.length}</Badge>}</div>
          {!myTasks.length ? <p className="text-sm text-muted">No open tasks.</p> : (
            <ul className="space-y-1 text-sm">{myTasks.slice(0, 6).map((t) => <li key={t.id}><Link href="/tasks" className="text-brand-700 hover:underline">{t.title}</Link>{t.dueAt && <span className="text-xs text-muted"> · due {fmtDate(t.dueAt)}</span>}</li>)}</ul>
          )}
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Make a request</div>
          {!links.length ? <p className="text-sm text-muted">Ask HR for access to requisitions and claims.</p> : (
            <ul className="space-y-1 text-sm">{links.map((l) => <li key={l.href}><Link href={l.href} className="text-brand-700 hover:underline">{l.label}</Link></li>)}</ul>
          )}
          {has('finance') && !finance && <p className="mt-2 text-xs text-muted">Requisitions, claims and imprest need the Finance &quot;Staff&quot; role; ask your administrator.</p>}
        </div>
      </div>
    </Card>
  );
}
