'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Money, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate } from '@/lib/format';
import { useZones, zoneName } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';

interface Row {
  id: string;
  customerId: string;
  accountNo: string;
  status: string;
  arrears: string;
  listedAt: string;
  noticeSentAt?: string;
  disconnectedAt?: string;
  customer: { accountNo: string; name: string; phone?: string; balance: string; zoneId: string; plotNo?: string; status: string } | null;
}

export default function DisconnectionsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, error, isLoading } = useQuery({ queryKey: ['disconnections', status], queryFn: () => api.get<Row[]>('/disconnections', { status }) });
  const done = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['disconnections'] });
    qc.invalidateQueries({ queryKey: ['customers'] });
  };
  const generate = useMutation({ mutationFn: () => api.post<{ listed: number }>('/disconnections/generate', {}), onSuccess: done });
  const notices = useMutation({ mutationFn: () => api.post<{ sent: number }>('/disconnections/notices', { ids: [...selected] }), onSuccess: done });
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'disconnect' | 'cancel' | 'reconnect' }) => api.post(`/disconnections/${id}/${action}`, {}), onSuccess: done });
  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <>
      <PageHeader
        title="Disconnections"
        subtitle="Accounts with arrears past the grace period set in Settings"
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">Open (listed / notified / off)</option>
              <option value="RECONNECTED">Reconnected</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
            {can('water.disconnection.manage') && (
              <>
                <Button variant="secondary" disabled={!selected.size || notices.isPending} onClick={() => notices.mutate()}>Send SMS notice ({selected.size})</Button>
                <Button onClick={() => generate.mutate()} disabled={generate.isPending}>Generate list</Button>
              </>
            )}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={error || generate.error || notices.error || act.error} />
        {generate.data && <Notice tone="green">{generate.data.listed} accounts added to the list.</Notice>}
        {notices.data && <Notice tone="green">{notices.data.sent} notices queued by SMS.</Notice>}
      </div>
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No accounts on the list.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th />
                  <th>Account</th>
                  <th>Zone / plot</th>
                  <th className="num">Arrears when listed</th>
                  <th className="num">Balance now</th>
                  <th>Status</th>
                  <th>Since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((d) => {
                  const paid = Number(d.customer?.balance ?? 0) <= 0;
                  return (
                    <tr key={d.id}>
                      <td>{d.status === 'LISTED' && <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.accountNo}`} />}</td>
                      <td>
                        <Link href={`/water/customers/${d.customerId}`} className="text-brand-700 hover:underline">{d.accountNo}</Link>
                        <div className="text-xs text-muted">{d.customer?.name}</div>
                      </td>
                      <td className="text-xs">{zoneName(zones, d.customer?.zoneId)}<div className="text-muted">{d.customer?.plotNo}</div></td>
                      <td className="num"><Money value={d.arrears} /></td>
                      <td className="num"><Money value={d.customer?.balance} /> {paid && <Badge tone="green">Paid</Badge>}</td>
                      <td><Badge value={d.status} /></td>
                      <td>{fmtDate(d.disconnectedAt ?? d.noticeSentAt ?? d.listedAt)}</td>
                      <td className="whitespace-nowrap text-right">
                        {can('water.disconnection.manage') && ['LISTED', 'NOTICE_SENT'].includes(d.status) && (
                          <>
                            <Button variant="ghost" onClick={() => act.mutate({ id: d.id, action: 'cancel' })}>Remove</Button>
                            {!paid && <Button variant="danger" onClick={() => act.mutate({ id: d.id, action: 'disconnect' })}>Disconnected</Button>}
                          </>
                        )}
                        {can('water.disconnection.manage') && d.status === 'DISCONNECTED' && <Button onClick={() => act.mutate({ id: d.id, action: 'reconnect' })}>Reconnect</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
