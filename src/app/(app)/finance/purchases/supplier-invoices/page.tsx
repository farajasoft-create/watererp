'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBanner, Input, Loading, PageHeader, Select, TableWrap } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';

interface Submission { id: string; supplierId: string; supplier: string; purchaseOrder: string | null; purchaseOrderId: string | null; invoiceNumber: string; invoiceDate: string; amount: string; currency: string; etimsNumber: string; note: string; status: string; reason: string; createdAt: string }

/** Invoices suppliers sent through the vendor portal, waiting for accounts payable to enter or turn back. */
export default function SupplierInvoicesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState('SUBMITTED');
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['supplier-invoices', status], queryFn: () => api.get<Submission[]>('/supplier-invoices', status ? { status } : {}) });
  const decide = useMutation({
    mutationFn: (x: { id: string; status: 'ENTERED' | 'REJECTED' }) => api.post(`/supplier-invoices/${x.id}/decide`, { status: x.status, reason: reason[x.id] || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-invoices'] }),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Invoices from suppliers" description="Sent in through the vendor portal. Enter each as a bill (matched to its order and goods received), then mark it entered; or turn it back with a reason the supplier sees." />
      <ErrorBanner error={error} />
      <div className="mb-3 w-48"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="SUBMITTED">Waiting</option><option value="ENTERED">Entered</option><option value="REJECTED">Turned back</option><option value="">All</option></Select></div>
      <Card>
        {isLoading ? <Loading /> : !data?.length ? <Empty title="Nothing here" /> : (
          <TableWrap>
            <table className="table-base">
              <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th>Order</th><th>eTIMS</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.map((x) => (
                  <tr key={x.id}>
                    <td><Link href={`/finance/purchases/suppliers/${x.supplierId}`} className="text-brand-700 hover:underline">{x.supplier}</Link></td>
                    <td>{x.invoiceNumber}{x.note && <div className="text-xs text-muted">{x.note}</div>}</td>
                    <td>{formatDate(x.invoiceDate)}</td>
                    <td>{x.purchaseOrderId ? <Link href={`/finance/purchases/orders/${x.purchaseOrderId}`} className="text-brand-700 hover:underline">{x.purchaseOrder}</Link> : '—'}</td>
                    <td>{x.etimsNumber || '—'}</td>
                    <td className="num">{x.currency} {formatAmount(x.amount)}</td>
                    <td><Badge tone={x.status === 'ENTERED' ? 'green' : x.status === 'REJECTED' ? 'red' : 'amber'}>{x.status.toLowerCase()}</Badge>{x.reason && <div className="text-xs text-muted">{x.reason}</div>}</td>
                    <td>
                      {x.status === 'SUBMITTED' && can('ap.manage') && (
                        <div className="flex gap-1">
                          <Button onClick={() => decide.mutate({ id: x.id, status: 'ENTERED' })}>Entered</Button>
                          <Input placeholder="Reason to turn back" value={reason[x.id] ?? ''} onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} />
                          <Button variant="secondary" disabled={!reason[x.id]} onClick={() => decide.mutate({ id: x.id, status: 'REJECTED' })}>Turn back</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
