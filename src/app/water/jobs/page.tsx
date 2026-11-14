'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Empty, ErrorBox, Loading } from '@/components/ui';
import { fmtDateTime, label } from '@/lib/format';
import { api } from '@/modules/water/ui/api';
import { JobComplete } from '@/modules/water/ui/job-complete';
import { Page } from '@/modules/water/ui/types';
import { WorkOrder } from '@/modules/water/ui/works';

/** The field crew's phone view: today's jobs, with directions, start and "done" reporting. */
export default function MyJobsPage() {
  const qc = useQueryClient();
  const [completing, setCompleting] = useState<WorkOrder | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['work-orders', 'mine'], queryFn: () => api.get<Page<WorkOrder>>('/work-orders', { mine: true, active: true, pageSize: 100 }), refetchInterval: 60_000 });
  const start = useMutation({ mutationFn: (id: string) => api.post(`/work-orders/${id}/start`), onSuccess: () => qc.invalidateQueries({ queryKey: ['work-orders'] }) });
  return (
    <main className="mx-auto max-w-lg space-y-3 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">My jobs</h1>
        <Link href="/water" className="text-sm text-brand-700">Back to the office</Link>
      </header>
      <ErrorBox error={error || start.error} />
      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty>No jobs assigned to you.</Empty>
      ) : (
        data.items.map((j) => (
          <article key={j.id} className={`rounded-lg border bg-white p-3 ${j.overdue ? 'border-red-300' : 'border-line'}`}>
            <div className="flex items-center justify-between gap-2">
              <b>{j.number}</b>
              <div className="flex gap-1">
                {j.priority !== 'NORMAL' && <Badge tone="red">{label(j.priority)}</Badge>}
                <Badge value={j.status} />
              </div>
            </div>
            <div className="mt-1 font-medium">{j.title}</div>
            <div className="text-sm text-muted">{label(j.type)} · due {fmtDateTime(j.dueAt)}</div>
            {j.location && <div className="mt-1 text-sm">{j.location}</div>}
            {j.description && <p className="mt-1 text-sm">{j.description}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {j.gps?.lat && (
                <a className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm" href={`https://www.google.com/maps/dir/?api=1&destination=${j.gps.lat},${j.gps.lng}`} target="_blank" rel="noreferrer">
                  Directions
                </a>
              )}
              {j.status !== 'IN_PROGRESS' && <Button variant="secondary" onClick={() => start.mutate(j.id)} disabled={start.isPending}>Start</Button>}
              <Button onClick={() => setCompleting(j)}>Done</Button>
            </div>
          </article>
        ))
      )}
      {completing && <JobComplete job={completing} onClose={() => setCompleting(null)} />}
    </main>
  );
}
