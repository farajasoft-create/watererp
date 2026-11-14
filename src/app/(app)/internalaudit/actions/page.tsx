'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { api } from '@/modules/internalaudit/ui/api';
import { Finding, RatingBadge } from '@/modules/internalaudit/ui/shared';

/** For managers who own audit actions: what to respond to and what is due. */
export default function MyActionsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['ia-my-actions'], queryFn: () => api.get<Finding[]>('/actions/mine') });
  const respond = data?.filter((f) => f.status === 'DRAFT') ?? [];
  return (
    <>
      <PageHeader title="My audit actions" subtitle="Audit findings you are responsible for: respond, act, and show the evidence" />
      <ErrorBox error={error} />
      {respond.length > 0 && <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{respond.length} finding{respond.length === 1 ? ' needs' : 's need'} management&apos;s response before the report is issued.</div>}
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No audit actions for you.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Audit</th><th>Ref</th><th>Finding</th><th>Rating</th><th>Your action</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>
                {data.map((f) => (
                  <tr key={f.id}>
                    <td>{f.engagement?.number}<div className="text-xs text-muted">{f.engagement?.title}</div></td>
                    <td><Link href={`/internalaudit/findings/${f.id}`} className="font-medium text-brand-700 hover:underline">{f.ref}</Link></td>
                    <td>{f.title}</td>
                    <td><RatingBadge r={f.rating} /></td>
                    <td className="max-w-xs text-sm">{f.action ?? (f.status === 'DRAFT' ? <span className="text-amber-800">Response needed</span> : '—')}</td>
                    <td className={f.daysOverdue ? 'text-red-700' : ''}>{f.dueDate ? fmtDate(f.dueDate) : '—'}{f.daysOverdue ? <div className="text-xs">{f.daysOverdue} days late</div> : null}</td>
                    <td><Badge value={f.status === 'DRAFT' ? 'PENDING' : f.status}>{f.status === 'DRAFT' ? 'awaiting response' : undefined}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
