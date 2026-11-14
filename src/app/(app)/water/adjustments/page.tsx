'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Money, PageHeader, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { SyncState } from '@/modules/water/ui/types';

interface Adjustment {
  id: string;
  customerId: string;
  customer: { accountNo: string; name: string } | null;
  amount: string;
  reason: string;
  category: string;
  status: string;
  requestedBy: string;
  createdAt: string;
  accounting: SyncState;
}

export default function AdjustmentsPage() {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const { data, error, isLoading } = useQuery({ queryKey: ['adjustments', status], queryFn: () => api.get<Adjustment[]>('/adjustments', { status }) });
  const review = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/adjustments/${id}/review`, { approve }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['adjustments'] }),
  });
  return (
    <>
      <PageHeader
        title="Adjustments"
        subtitle="Credits and debit notes on accounts. Request them from the customer's page; another user approves."
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="PENDING">Awaiting approval</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </Select>
        }
      />
      <ErrorBox error={error || review.error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Account</th>
                <th>Category</th>
                <th>Reason</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDate(a.createdAt)}</td>
                  <td>
                    <Link href={`/water/customers/${a.customerId}`} className="text-brand-700 hover:underline">{a.customer?.accountNo}</Link>
                    <div className="text-xs text-muted">{a.customer?.name}</div>
                  </td>
                  <td>{label(a.category)}</td>
                  <td className="max-w-md">{a.reason}</td>
                  <td className="num">
                    <Money value={a.amount} /> <span className="text-xs text-muted">{Number(a.amount) < 0 ? 'credit' : 'debit'}</span>
                  </td>
                  <td>
                    <Badge value={a.status} /> {a.status === 'APPROVED' && <Badge value={a.accounting?.status ?? 'NOT_SENT'} />}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {a.status === 'PENDING' && can('water.adjustment.approve') && a.requestedBy !== me?.id && (
                      <>
                        <Button variant="ghost" onClick={() => review.mutate({ id: a.id, approve: false })}>Reject</Button>
                        <Button onClick={() => review.mutate({ id: a.id, approve: true })}>Approve</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
