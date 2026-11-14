'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { useZones, zoneName } from '@/modules/water/ui/hooks';

interface Notice {
  id: string;
  type: string;
  title: string;
  message: string;
  zoneIds: string[];
  startsAt?: string;
  endsAt?: string;
  sentCount: number;
  publish: boolean;
  createdAt: string;
}

function NewNotice({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [f, setF] = useState({ type: 'INTERRUPTION', title: '', message: '', zoneIds: [] as string[], startsAt: '', endsAt: '', sendSms: true, publish: true });
  const save = useMutation({
    mutationFn: () => api.post<Notice>('/notices', { ...f, startsAt: f.startsAt || null, endsAt: f.endsAt || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notices'] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title="New notice" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 3 || f.message.length < 10}>{f.sendSms ? 'Send' : 'Publish'}</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {['INTERRUPTION', 'RATIONING', 'WATER_QUALITY', 'TARIFF', 'GENERAL'].map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </Select>
        </Field>
        <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="From"><Input type="date" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
        <Field label="Until"><Input type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
      </div>
      <Field label={`Message (${f.message.length}/400; one SMS is 160 characters)`}><Textarea rows={3} maxLength={400} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      <Field label="Zones" hint="None ticked: every customer">
        <div className="flex flex-wrap gap-3 text-sm">
          {zones?.map((z) => (
            <label key={z.id} className="flex items-center gap-1">
              <input type="checkbox" checked={f.zoneIds.includes(z.id)} onChange={(e) => setF({ ...f, zoneIds: e.target.checked ? [...f.zoneIds, z.id] : f.zoneIds.filter((x) => x !== z.id) })} />
              {z.code} · {z.name}
            </label>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.sendSms} onChange={(e) => setF({ ...f, sendSms: e.target.checked })} /> Text every active customer in these zones</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.publish} onChange={(e) => setF({ ...f, publish: e.target.checked })} /> Show on the customer portal and USSD while it runs</label>
    </Modal>
  );
}

export default function NoticesPage() {
  const can = useCan();
  const { data: zones } = useZones();
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['notices'], queryFn: () => api.get<Notice[]>('/notices') });
  return (
    <>
      <PageHeader title="Notices to customers" subtitle="Planned interruptions, rationing timetables and other announcements, by SMS, portal and USSD" actions={can('water.notice.send') && <Button onClick={() => setCreating(true)}>New notice</Button>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No notices sent yet.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Sent</th><th>Type</th><th>Notice</th><th>Zones</th><th>Runs</th><th className="num">SMS</th></tr></thead>
            <tbody>
              {data.map((n) => (
                <tr key={n.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(n.createdAt)}</td>
                  <td><Badge tone={n.type === 'INTERRUPTION' || n.type === 'WATER_QUALITY' ? 'amber' : 'blue'}>{label(n.type)}</Badge></td>
                  <td className="max-w-md"><b>{n.title}</b><div className="text-sm text-muted">{n.message}</div></td>
                  <td className="text-sm">{n.zoneIds.length ? n.zoneIds.map((z) => zoneName(zones, z)).join(', ') : 'All zones'}</td>
                  <td className="whitespace-nowrap text-sm">{n.startsAt || n.endsAt ? `${fmtDate(n.startsAt)} – ${fmtDate(n.endsAt)}` : '—'}</td>
                  <td className="num">{n.sentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <NewNotice onClose={() => setCreating(false)} />}
    </>
  );
}
