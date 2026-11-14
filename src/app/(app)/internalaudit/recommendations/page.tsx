'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, Select } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { api } from '@/modules/internalaudit/ui/api';
import { Finding, RatingBadge, RATINGS } from '@/modules/internalaudit/ui/shared';

const STATUSES = ['AGREED', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'NOT_ACCEPTED'];

function Register() {
  const params = useSearchParams();
  const [q, setQ] = useState({ status: '', rating: '', overdue: params.get('overdue') === 'true' });
  const query = { ...(q.status && { status: q.status }), ...(q.rating && { rating: q.rating }), ...(q.overdue && { overdue: true }) };
  const { data, error, isLoading } = useQuery({ queryKey: ['ia-register', q], queryFn: () => api.get<Finding[]>('/recommendations', query) });
  const csv = `/api/v1/internalaudit/recommendations?${new URLSearchParams({ ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), format: 'csv' })}`;
  return (
    <>
      <PageHeader title="Recommendations" subtitle="Every agreed action from issued audit reports, tracked to verification" actions={<a href={csv} className="text-sm text-brand-700 hover:underline">CSV</a>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <Select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })} className="max-w-44"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase().replace('_', ' ')}</option>)}</Select>
          <Select value={q.rating} onChange={(e) => setQ({ ...q, rating: e.target.value })} className="max-w-40"><option value="">Any rating</option>{RATINGS.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}</Select>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={q.overdue} onChange={(e) => setQ({ ...q, overdue: e.target.checked })} /> Only overdue</label>
        </div>
        {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing here.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Engagement</th><th>Ref</th><th>Finding</th><th>Rating</th><th>Owner</th><th>Due</th><th>Status</th><th>Ageing</th></tr></thead>
              <tbody>
                {data.map((f) => (
                  <tr key={f.id}>
                    <td>{f.engagement && <Link href={`/internalaudit/engagements/${f.engagement.id}`} className="text-brand-700 hover:underline">{f.engagement.number}</Link>}<div className="text-xs text-muted">{f.engagement?.area}</div></td>
                    <td><Link href={`/internalaudit/findings/${f.id}`} className="font-medium text-brand-700 hover:underline">{f.ref}</Link></td>
                    <td>{f.title}</td>
                    <td><RatingBadge r={f.rating} /></td>
                    <td>{f.ownerName ?? '—'}</td>
                    <td>{f.dueDate ? fmtDate(f.dueDate) : '—'}{f.originalDueDate && f.originalDueDate !== f.dueDate && <div className="text-xs text-muted">was {fmtDate(f.originalDueDate)}</div>}</td>
                    <td><Badge value={f.status} /></td>
                    <td className={f.daysOverdue ? 'text-red-700' : 'text-muted'}>{f.daysOverdue ? `${f.daysOverdue} days late` : f.band}</td>
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

export default function RecommendationsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Register />
    </Suspense>
  );
}
