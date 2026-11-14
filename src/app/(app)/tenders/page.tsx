'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, PageHeader, Select } from '@/components/ui';
import { fmtDateTime, fmtMoney, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/tenders/ui/api';
import { TenderForm } from '@/modules/tenders/ui/shared';

interface Row { id: string; number: string; title: string; method: string; category: string; estimate: string; status: string; closingAt: string; bids: number; reservedFor: string }
const STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATED', 'RECOMMENDED', 'AWARDED', 'CONTRACTED', 'CANCELLED'];

export default function TendersPage() {
  const can = useCan();
  const router = useRouter();
  const { data: me } = useMe();
  const [q, setQ] = useState({ status: '', search: '' });
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['tenders', q], queryFn: () => api.get<Row[]>('/tenders', Object.fromEntries(Object.entries(q).filter(([, v]) => v))), enabled: can('tenders.view') });
  const code = me?.organisation?.code?.toLowerCase();
  if (!can('tenders.view')) {
    return <><PageHeader title="Tenders" /><Notice /></>;
  }
  return (
    <>
      <PageHeader
        title="Tenders"
        subtitle={<>Tendering under the PPADA 2015, from notice to contract. Bidders use the {code ? <a className="text-brand-700 hover:underline" href={`/tender-notices/${code}`} target="_blank" rel="noreferrer">tenders portal</a> : 'tenders portal'}.</>}
        actions={<div className="flex gap-2"><a href={`/api/v1/tenders/tenders/register.csv`} className="self-center text-sm text-brand-700 hover:underline">Tender register (CSV)</a><a href={`/api/v1/tenders/tenders/ppip.csv`} className="self-center text-sm text-brand-700 hover:underline">PPIP upload (CSV)</a>{can('tenders.manage') && <Button onClick={() => setCreating(true)}>New tender</Button>}</div>}
      />
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Number or title" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="max-w-sm" />
        <Select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })} className="max-w-48"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
      </div>
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No tenders yet.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Tender</th><th>Method</th><th className="num">Estimate</th><th>Closing</th><th className="num">Bids</th><th>Status</th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/tenders/${t.id}`} className="font-medium text-brand-700 hover:underline">{t.number}</Link><div className="text-xs text-muted">{t.title}</div></td>
                  <td>{label(t.method)}<div className="text-xs text-muted">{label(t.category)}{t.reservedFor !== 'NONE' && ` · ${label(t.reservedFor)}`}</div></td>
                  <td className="num">{fmtMoney(t.estimate)}</td>
                  <td>{fmtDateTime(t.closingAt)}</td>
                  <td className="num">{t.bids}</td>
                  <td><Badge value={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <TenderForm onClose={() => setCreating(false)} onSaved={(id) => router.push(`/tenders/${id}`)} />}
    </>
  );
}

/** Committee members without a tenders role reach their tenders from the link they are sent. */
function Notice() {
  return <Card><p className="text-sm text-muted">Open the tender from the link in your notification or approvals inbox to take part as a committee member.</p></Card>;
}
