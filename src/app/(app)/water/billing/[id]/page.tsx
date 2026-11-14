'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Money, Notice, PageHeader, Pager, Stat } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, fmtMoney, fmtUnits, label } from '@/lib/format';
import { useZones, zoneName } from '@/modules/water/ui/hooks';
import { useCan, useMe } from '@/lib/session';
import { Bill, BillRun, Page } from '@/modules/water/ui/types';

type RunDetail = BillRun & { estimatedCount: number; bills: Page<Bill> };

function RunInner({ id }: { id: string }) {
  const params = useSearchParams();
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [q, setQ] = useState({ search: '', page: 1 });
  const { data: run, error, isLoading } = useQuery({ queryKey: ['bill-run', id, q], queryFn: () => api.get<RunDetail>(`/bill-runs/${id}`, { ...q, pageSize: 50 }) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['bill-run', id] });
    qc.invalidateQueries({ queryKey: ['bill-runs'] });
  };
  const approve = useMutation({ mutationFn: () => api.post(`/bill-runs/${id}/approve`), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => api.post(`/bill-runs/${id}/cancel`), onSuccess: invalidate });
  const unread = Number(params.get('unread') ?? 0);

  if (isLoading) return <Loading />;
  if (!run) return <ErrorBox error={error} />;
  const waiting = run.status === 'DRAFT' || run.status === 'APPROVING';
  const ownRun = me?.id === run.createdBy && !me?.isAdmin;

  return (
    <>
      <PageHeader
        title={`Billing run ${run.period}`}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge value={run.status} /> {zoneName(zones, run.zoneId)} · billed {fmtDate(run.billDate)} · due {fmtDate(run.dueDate)}
          </span>
        }
        actions={
          <>
            <a href={`/api/v1/water/reports/billing-register?period=${run.period}`} className="text-sm text-brand-700 hover:underline">Billing register (CSV)</a>
            {waiting && can('water.billing.run') && run.status === 'DRAFT' && (
              <Button variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel run</Button>
            )}
            {waiting && can('water.billing.approve') && (
              <Button onClick={() => approve.mutate()} disabled={approve.isPending || ownRun} title={ownRun ? 'Someone else must approve a run you prepared' : undefined}>
                {approve.isPending ? 'Issuing bills…' : run.status === 'APPROVING' ? 'Resume issuing' : 'Approve and issue'}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={approve.error || cancel.error} />
        {unread > 0 && waiting && <Notice tone="amber">{unread} active connections have no approved reading for {run.period} and were left out. Estimate or read them, then run billing for the rest.</Notice>}
        {ownRun && waiting && <Notice>You prepared this run, so another user with approval rights must approve it.</Notice>}
        {run.status === 'APPROVED' && run.accounting?.status === 'FAILED' && <Notice tone="amber">Posting to accounting failed: {run.accounting.error}. Fix it in Settings → Accounting and retry.</Notice>}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Bills" value={run.billCount.toLocaleString()} hint={`${run.estimatedCount} estimated`} />
        <Stat label="Units billed" value={`${fmtUnits(run.totalUnits)} m³`} />
        {['WATER', 'SEWER', 'METER_RENT'].map((code) => (
          <Stat key={code} label={label(code)} value={fmtMoney(run.totals?.[code] ?? 0)} />
        ))}
      </div>
      <Card padded={false} title={`Bills · total KES ${fmtMoney(run.totalAmount)}`}>
        <div className="border-b border-line p-3">
          <Input placeholder="Account or name" value={q.search} onChange={(e) => setQ({ search: e.target.value, page: 1 })} className="max-w-xs" />
        </div>
        {!run.bills.items.length ? (
          <Empty>No bills.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Name</th>
                  <th>Bill no.</th>
                  <th className="num">Previous</th>
                  <th className="num">Current</th>
                  <th className="num">Units</th>
                  <th className="num">Charges</th>
                  <th className="num">B/F</th>
                  <th className="num">Amount due</th>
                </tr>
              </thead>
              <tbody>
                {run.bills.items.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/water/customers/${b.customerId}`} className="text-brand-700 hover:underline">{b.accountNo}</Link>
                    </td>
                    <td>{b.customerName}</td>
                    <td>{b.billNo ? <Link href={`/water/bills/${b.id}`} className="text-brand-700 hover:underline">{b.billNo}</Link> : <span className="text-muted">draft</span>}</td>
                    <td className="num">{fmtUnits(b.previousReading)}</td>
                    <td className="num">{fmtUnits(b.currentReading)}</td>
                    <td className="num">
                      {fmtUnits(b.units)} {b.estimated && <Badge value="ESTIMATED">E</Badge>}
                    </td>
                    <td className="num"><Money value={b.currentCharges} /></td>
                    <td className="num"><Money value={b.balanceBroughtForward} /></td>
                    <td className="num font-medium"><Money value={b.amountDue} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={run.bills.page} pageSize={run.bills.pageSize} total={run.bills.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />
      </Card>
    </>
  );
}

export default function BillRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <RunInner id={id} />
    </Suspense>
  );
}
