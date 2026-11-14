'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader } from '@/components/ui';
import { label } from '@/lib/format';
import { api } from '@/modules/tenders/ui/api';

interface Settings { thresholds: { method: string; max: string | null }[]; minNoticeDays: number; standstillDays: number }

function Form({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ thresholds: s.thresholds.map((t) => ({ method: t.method, max: t.max ?? '' })), minNoticeDays: String(s.minNoticeDays), standstillDays: String(s.standstillDays) });
  const save = useMutation({ mutationFn: () => api.put('/settings', { thresholds: f.thresholds.map((t) => ({ method: t.method, max: t.max || null })), minNoticeDays: Number(f.minNoticeDays), standstillDays: Number(f.standstillDays) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tenders', 'settings'] }) });
  return (
    <Card actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Field label="Minimum days an advertised tender stays open"><Input inputMode="numeric" value={f.minNoticeDays} onChange={(e) => setF({ ...f, minNoticeDays: e.target.value })} /></Field>
        <Field label="Standstill days after notification before signing"><Input inputMode="numeric" value={f.standstillDays} onChange={(e) => setF({ ...f, standstillDays: e.target.value })} /></Field>
      </div>
      <div className="mb-1 text-sm font-medium">Highest estimate per method (KES; blank for no limit)</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {f.thresholds.map((t, i) => (
          <Field key={t.method} label={label(t.method)}><Input inputMode="decimal" value={t.max} onChange={(e) => setF({ ...f, thresholds: f.thresholds.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)) })} /></Field>
        ))}
      </div>
    </Card>
  );
}

export default function TenderSettingsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['tenders', 'settings'], queryFn: () => api.get<Settings>('/settings') });
  return (
    <>
      <PageHeader title="Procurement thresholds" subtitle="Ceilings per method from the PPAD Regulations 2020 and the notice and standstill periods; a tender above its method's ceiling cannot be saved." />
      <ErrorBox error={error} />
      {isLoading || !data ? <Loading /> : <Form s={data} />}
    </>
  );
}
