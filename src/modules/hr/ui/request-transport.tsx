'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { api } from './api';

/** Asking for transport: anyone signed in. */
export function RequestTransport({ onDone }: { onDone?: () => void }) {
  const [f, setF] = useState({ purpose: '', destination: '', from: '', to: '', passengers: '1' });
  const send = useMutation({ mutationFn: () => api.post<{ number: string }>('/fleet/trips', { ...f, from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString(), passengers: Number(f.passengers || 1) }), onSuccess: () => (setF({ purpose: '', destination: '', from: '', to: '', passengers: '1' }), onDone?.()) });
  return (
    <div className="space-y-3">
      <ErrorBox error={send.error} />
      {send.data && <Notice tone="green">Request {send.data.number} sent for approval.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Purpose"><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
        <Field label="Destination"><Input value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></Field>
        <Field label="Leaving"><Input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="Back"><Input type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Passengers"><Input inputMode="numeric" value={f.passengers} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setF({ ...f, passengers: e.target.value })} /></Field>
      </div>
      <Button disabled={send.isPending || !f.purpose || !f.destination || !f.from || !f.to} onClick={() => send.mutate()}>Request transport</Button>
    </div>
  );
}


/** Self-service: ask for transport and follow your requests. */
export function MyTransport() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['hr-my-trips'], queryFn: () => api.get<{ id: string; number: string; destination: string; from: string; status: string; vehicle: string; driver: string }[]>('/fleet/trips') });
  return (
    <Card title="Transport">
      <RequestTransport onDone={() => qc.invalidateQueries({ queryKey: ['hr-my-trips'] })} />
      {!!mine.data?.length && (
        <ul className="mt-3 space-y-1 text-sm">
          {mine.data.slice(0, 10).map((t) => <li key={t.id}>{t.number} · {fmtDateTime(t.from)} · {t.destination} <Badge value={t.status} />{t.vehicle && ` ${t.vehicle}`}{t.driver && ` · ${t.driver}`}</li>)}
        </ul>
      )}
    </Card>
  );
}
