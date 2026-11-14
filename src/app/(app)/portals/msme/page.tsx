'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Notice, PageHeader, Select } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/portals/ui/api';

interface Msme { id: string; reference: string; businessName: string; ownerName: string; phone: string; email?: string; sector: string; location?: string; kraPin?: string; agpo: string; agpoCertificate?: string; description?: string; status: string; reason?: string; products: { name: string }[]; createdAt: string }

export default function MsmeRegisterPage() {
  const can = useCan();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [status, setStatus] = useState('PENDING');
  const [reason, setReason] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['portals-msmes', status], queryFn: () => api.get<Msme[]>('/msmes', status ? { status } : {}) });
  const decide = useMutation({
    mutationFn: (x: { id: string; status: string }) => api.post<{ path: string | null }>(`/msmes/${x.id}/decide`, { status: x.status, reason: reason[x.id] || undefined }),
    onSuccess: (r) => { if (r.path) setLink(`${window.location.origin}${r.path}`); qc.invalidateQueries({ queryKey: ['portals-msmes'] }); },
  });
  const code = me?.organisation?.code?.toLowerCase();
  return (
    <>
      <PageHeader title="MSME register" subtitle={<>Local businesses that registered on the {code ? <a className="text-brand-700 hover:underline" href={`/msme/${code}`} target="_blank" rel="noreferrer">MSME products portal</a> : 'MSME portal'}; approved ones are listed publicly.</>} />
      <ErrorBox error={error || decide.error} />
      {link && <div className="mb-3"><Notice tone="green">Approved and texted. Their own link to keep products up to date: <Input readOnly value={link} onFocus={(e) => e.target.select()} /></Notice></div>}
      <div className="mb-3 w-48"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="PENDING">Waiting</option><option value="APPROVED">Listed</option><option value="REJECTED">Rejected</option><option value="SUSPENDED">Suspended</option><option value="">All</option></Select></div>
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing here.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Business</th><th>Sector</th><th>Contact</th><th>AGPO</th><th>Products</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td>{m.businessName}<div className="text-xs text-muted">{m.reference} · {m.ownerName} · {fmtDate(m.createdAt)}{m.kraPin && ` · PIN ${m.kraPin}`}</div></td>
                  <td>{label(m.sector)}<div className="text-xs text-muted">{m.location}</div></td>
                  <td className="text-sm">{m.phone}<div className="text-xs text-muted">{m.email}</div></td>
                  <td>{m.agpo === 'NONE' ? '—' : <>{m.agpo.toLowerCase()}<div className="text-xs text-muted">{m.agpoCertificate}</div></>}</td>
                  <td className="text-xs">{m.products.map((p) => p.name).join(', ')}</td>
                  <td><Badge value={m.status} />{m.reason && <div className="text-xs text-muted">{m.reason}</div>}</td>
                  <td>
                    {can('portals.manage') && (
                      <div className="flex flex-wrap gap-1">
                        {m.status !== 'APPROVED' && <Button onClick={() => decide.mutate({ id: m.id, status: 'APPROVED' })}>Approve</Button>}
                        <Input placeholder="Reason" value={reason[m.id] ?? ''} onChange={(e) => setReason({ ...reason, [m.id]: e.target.value })} className="w-32" />
                        {m.status === 'PENDING' && <Button variant="secondary" disabled={!reason[m.id]} onClick={() => decide.mutate({ id: m.id, status: 'REJECTED' })}>Reject</Button>}
                        {m.status === 'APPROVED' && <Button variant="secondary" disabled={!reason[m.id]} onClick={() => decide.mutate({ id: m.id, status: 'SUSPENDED' })}>Suspend</Button>}
                      </div>
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
