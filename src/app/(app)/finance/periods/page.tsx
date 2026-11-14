'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, StatusBadge, Textarea } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDate, formatDateTime } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import type { FiscalYear, Period, PeriodStatus } from '@/modules/finance/ui/lib/types';

export default function PeriodsPage() {
  const { entity, can } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [reopen, setReopen] = useState<{ period: Period; status: PeriodStatus } | null>(null);
  const [reason, setReason] = useState('');
  const [newYear, setNewYear] = useState<string | null>(null);

  const { data: years = [], isLoading } = useQuery({
    queryKey: ['fiscal-years', entity?.id],
    queryFn: () => api.get<FiscalYear[]>('/fiscal-years', { entityId: entity!.id }),
  });

  const mutation = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.post(path, body),
    onSuccess: () => {
      setError(null);
      setReopen(null);
      setNewYear(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const change = (p: Period, status: PeriodStatus) => mutation.mutate({ path: `/periods/${p.id}/status`, body: { status } });

  const nextStart = years[0] ? new Date(new Date(years[0].endDate).getTime() + 86_400_000).toISOString().slice(0, 10) : `${new Date().getFullYear()}-01-01`;

  return (
    <>
      <PageHeader
        title="Fiscal periods"
        description={`${entity!.code} · ${entity!.name}. Soft-closed periods accept postings only from authorised users; closed periods accept none.`}
        actions={can('period.manage') && <Button variant="primary" onClick={() => setNewYear(nextStart)}>New fiscal year</Button>}
      />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading ? (
        <Loading />
      ) : !years.length ? (
        <Card>
          <Empty title="No fiscal years for this entity">Create one to start posting journals.</Empty>
        </Card>
      ) : (
        <div className="space-y-5">
          {years.map((y) => (
            <Card key={y.id} title={`${y.name} · ${formatDate(y.startDate)} – ${formatDate(y.endDate)}`} padded={false}>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Dates</th>
                    <th>Status</th>
                    <th>Last change</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {y.periods.map((p) => (
                    <tr key={p.id}>
                      <td className="font-medium">{p.name}</td>
                      <td className="text-muted">
                        {formatDate(p.startDate)} – {formatDate(p.endDate)}
                      </td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="text-xs text-muted">
                        {p.statusChangedAt ? formatDateTime(p.statusChangedAt) : ''}
                        {p.statusReason && <span className="block text-amber-800">{p.statusReason}</span>}
                      </td>
                      <td className="space-x-1 text-right whitespace-nowrap">
                        {p.status === 'OPEN' && can('period.manage') && (
                          <Button size="sm" onClick={() => change(p, 'SOFT_CLOSED')}>Soft-close</Button>
                        )}
                        {p.status === 'SOFT_CLOSED' && can('period.manage') && (
                          <Button size="sm" variant="ghost" onClick={() => change(p, 'OPEN')}>Reopen</Button>
                        )}
                        {p.status !== 'HARD_CLOSED' && can('period.close') && (
                          <Button size="sm" onClick={() => change(p, 'HARD_CLOSED')}>Close & lock</Button>
                        )}
                        {p.status === 'HARD_CLOSED' && can('period.reopen') && (
                          <Button size="sm" variant="ghost" onClick={() => setReopen({ period: p, status: 'OPEN' })}>Reopen…</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={!!reopen}
        onClose={() => setReopen(null)}
        title={`Reopen ${reopen?.period.name}`}
        footer={
          <>
            <Button onClick={() => setReopen(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              loading={mutation.isPending}
              onClick={() => reopen && mutation.mutate({ path: `/periods/${reopen.period.id}/status`, body: { status: reopen.status, reason } })}
            >
              Reopen period
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Notice tone="amber">Reopening a locked period is a controlled action. The reason is recorded in the audit trail.</Notice>
          <Field label="Reason">
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        </div>
      </Modal>

      <Modal
        open={newYear !== null}
        onClose={() => setNewYear(null)}
        title="New fiscal year"
        footer={
          <>
            <Button onClick={() => setNewYear(null)}>Cancel</Button>
            <Button variant="primary" loading={mutation.isPending} onClick={() => mutation.mutate({ path: '/fiscal-years', body: { entityId: entity!.id, startDate: newYear } })}>
              Create 12 periods
            </Button>
          </>
        }
      >
        <Field label="Start date" hint="Must be the first day of a month. Twelve monthly periods are created.">
          <Input type="date" value={newYear ?? ''} onChange={(e) => setNewYear(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
