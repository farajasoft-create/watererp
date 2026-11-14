'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { api } from '@/modules/ict/ui/api';
import { NewTicket, PriorityBadge, Ticket } from '@/modules/ict/ui/shared';

interface Held { id: string; tag: string; description: string; serialNo?: string; issuedAt: string; condition: string }

export default function MyRequestsPage() {
  const [raising, setRaising] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['ict-mine'], queryFn: () => api.get<Ticket[]>('/helpdesk/mine') });
  const held = useQuery({ queryKey: ['ict-assets-mine'], queryFn: () => api.get<Held[]>('/assets/mine') });
  const waiting = data?.filter((t) => t.status === 'RESOLVED') ?? [];
  return (
    <>
      <PageHeader title="My IT requests" subtitle="Ask the ICT help desk for help, and follow what happens" actions={<Button onClick={() => setRaising(true)}>New request</Button>} />
      <ErrorBox error={error} />
      {waiting.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {waiting.length === 1 ? 'One request is' : `${waiting.length} requests are`} marked resolved. Open {waiting.length === 1 ? 'it' : 'them'} to confirm the fix and rate the service, or reopen.
        </div>
      )}
      <Card padded={false} className="mb-5">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No requests yet. Something not working? Send a request and you get a ticket number straight away.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th><th>With</th><th>Raised</th></tr>
              </thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/ict/tickets/${t.id}`} className="font-medium text-brand-700 hover:underline">{t.number}</Link></td>
                    <td>{t.subject}<div className="text-xs text-muted">{t.category}</div></td>
                    <td><PriorityBadge p={t.priority} /></td>
                    <td><Badge value={t.status} /></td>
                    <td>{t.assignedName ?? '—'}</td>
                    <td>{fmtDateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!!held.data?.length && (
        <Card padded={false} title="Equipment issued to me">
          <table className="table-base">
            <thead><tr><th>Tag</th><th>Item</th><th>Serial</th><th>Since</th><th>Condition</th></tr></thead>
            <tbody>
              {held.data.map((a) => (
                <tr key={a.id}><td className="font-medium">{a.tag}</td><td>{a.description}</td><td>{a.serialNo ?? '—'}</td><td>{fmtDate(a.issuedAt)}</td><td>{a.condition.toLowerCase()}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {raising && <NewTicket onClose={() => setRaising(false)} />}
    </>
  );
}
