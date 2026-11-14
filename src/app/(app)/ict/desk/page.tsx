'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, PageHeader, Pager, Select, Stat } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { api } from '@/modules/ict/ui/api';
import { NewTicket, PRIORITIES, PriorityBadge, Ticket } from '@/modules/ict/ui/shared';

type View = 'open' | 'mine' | 'unassigned' | 'overdue' | 'all';
interface Queue { items: Ticket[]; total: number; page: number; pageSize: number; counts: Record<string, number> }

const VIEWS: { id: View; label: string }[] = [
  { id: 'open', label: 'All open' },
  { id: 'mine', label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'all', label: 'Everything' },
];

function due(t: Ticket) {
  if (!['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'].includes(t.status)) return null;
  const ms = new Date(t.resolveBy).getTime() - Date.now();
  const h = Math.round(Math.abs(ms) / 3_600_000);
  const text = h < 1 ? 'under an hour' : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
  return ms < 0 ? <span className="font-medium text-red-700">{text} late</span> : <span className="text-muted">in {text}</span>;
}

export default function ServiceDeskPage() {
  const [view, setView] = useState<View>('open');
  const [q, setQ] = useState({ search: '', priority: '', page: 1 });
  const [logging, setLogging] = useState(false);
  const params = { ...(view !== 'all' && { [view === 'open' ? 'open' : view]: true }), ...(q.search && { search: q.search }), ...(q.priority && { priority: q.priority }), page: q.page, pageSize: 50 };
  const { data, error, isLoading } = useQuery({ queryKey: ['ict-desk', view, q], queryFn: () => api.get<Queue>('/helpdesk/tickets', params), refetchInterval: 60_000 });
  const c = data?.counts ?? {};
  const openCount = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'].reduce((n, s) => n + (c[s] ?? 0), 0);
  return (
    <>
      <PageHeader title="Service desk" subtitle="Every IT request, by deadline" actions={<Button onClick={() => setLogging(true)}>Log a call</Button>} />
      <ErrorBox error={error} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Open" value={openCount} />
        <Stat label="Unassigned" value={c.unassigned ?? 0} tone={c.unassigned ? 'warn' : undefined} />
        <Stat label="Overdue" value={c.overdue ?? 0} tone={c.overdue ? 'bad' : undefined} />
        <Stat label="On hold" value={c.ON_HOLD ?? 0} />
        <Stat label="Reopened" value={c.REOPENED ?? 0} />
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          {VIEWS.map((v) => (
            <Button key={v.id} variant={view === v.id ? 'primary' : 'secondary'} onClick={() => { setView(v.id); setQ({ ...q, page: 1 }); }}>{v.label}</Button>
          ))}
          <Input placeholder="Number, subject, person, asset" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} className="max-w-xs" />
          <Select value={q.priority} onChange={(e) => setQ({ ...q, priority: e.target.value, page: 1 })} className="max-w-40">
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
          </Select>
        </div>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Ticket</th><th>Subject</th><th>Requester</th><th>Priority</th><th>Status</th><th>Officer</th><th>Due</th><th>Raised</th></tr>
              </thead>
              <tbody>
                {data.items.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/ict/tickets/${t.id}`} className="font-medium text-brand-700 hover:underline">{t.number}</Link></td>
                    <td>{t.subject}<div className="text-xs text-muted">{t.category}{t.assetTag && ` · ${t.assetTag}`}</div></td>
                    <td>{t.requesterName}<div className="text-xs text-muted">{t.department}</div></td>
                    <td><PriorityBadge p={t.priority} /></td>
                    <td><Badge value={t.status} />{t.escalationLevel > 0 && <> <Badge tone="red">esc {t.escalationLevel}</Badge></>}</td>
                    <td>{t.assignedName ?? <span className="text-muted">—</span>}</td>
                    <td>{due(t)}</td>
                    <td>{fmtDateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ({ ...q, page })} />}
      </Card>
      {logging && <NewTicket forOthers onClose={() => setLogging(false)} />}
    </>
  );
}
