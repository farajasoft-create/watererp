'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Textarea } from '@/components/ui';
import { api } from '@/modules/internalaudit/ui/api';

interface Programme { id: string; name: string; area?: string; objective?: string; procedures: { ref: string; title: string; steps?: string }[]; active: boolean }
interface Settings { hourlyRate: string; remindDays: number; escalateDays: number }

function ProgrammeForm({ p, onClose }: { p?: Programme; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: p?.name ?? '', area: p?.area ?? '', objective: p?.objective ?? '', active: p?.active ?? true });
  const [steps, setSteps] = useState(p?.procedures.map((x) => ({ ...x, steps: x.steps ?? '' })) ?? [{ ref: 'P-01', title: '', steps: '' }]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, area: f.area || undefined, objective: f.objective || undefined, procedures: steps.filter((s) => s.title).map((s) => ({ ...s, steps: s.steps || undefined })) };
      return p ? api.put(`/programmes/${p.id}`, body) : api.post('/programmes', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ia-programmes'] });
      onClose();
    },
  });
  const set = (i: number, k: 'ref' | 'title' | 'steps', v: string) => setSteps(steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  return (
    <Modal open wide onClose={onClose} title={p ? `Edit ${p.name}` : 'New audit programme'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.name.length < 3}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Area"><Input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} /></Field>
        <Field label="Objective" className="sm:col-span-2"><Textarea rows={2} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Procedures (each becomes a working paper)</div>
        {steps.map((s, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[90px_1fr_2fr_auto]">
            <Input value={s.ref} onChange={(e) => set(i, 'ref', e.target.value.toUpperCase())} />
            <Input placeholder="Procedure" value={s.title} onChange={(e) => set(i, 'title', e.target.value)} />
            <Input placeholder="Steps" value={s.steps} onChange={(e) => set(i, 'steps', e.target.value)} />
            <Button variant="secondary" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove">✕</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setSteps([...steps, { ref: `P-${String(steps.length + 1).padStart(2, '0')}`, title: '', steps: '' }])}>Add procedure</Button>
      </div>
      {p && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> In use</label>}
    </Modal>
  );
}

function SettingsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['ia-settings'], queryFn: () => api.get<Settings>('/settings') });
  const [f, setF] = useState<{ hourlyRate: string; remindDays: string; escalateDays: string } | null>(null);
  const v = f ?? { hourlyRate: data?.hourlyRate ?? '0', remindDays: String(data?.remindDays ?? 14), escalateDays: String(data?.escalateDays ?? 30) };
  const save = useMutation({ mutationFn: () => api.put('/settings', { hourlyRate: v.hourlyRate, remindDays: Number(v.remindDays), escalateDays: Number(v.escalateDays) }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['ia-settings'] }); } });
  return (
    <Card title="Settings" actions={f && <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Cost of an audit hour (KES)" hint={data ? undefined : ''}><Input inputMode="decimal" value={v.hourlyRate} onChange={(e) => setF({ ...v, hourlyRate: e.target.value })} /></Field>
        <Field label="Remind owners (days before due)"><Input inputMode="numeric" value={v.remindDays} onChange={(e) => setF({ ...v, remindDays: e.target.value })} /></Field>
        <Field label="Escalate to the head (days overdue)"><Input inputMode="numeric" value={v.escalateDays} onChange={(e) => setF({ ...v, escalateDays: e.target.value })} /></Field>
      </div>
      <p className="mt-2 text-xs text-muted">Current rate: KES <Money value={data?.hourlyRate} /> an hour. Reminders and escalations go out when POST /api/v1/internalaudit/housekeeping runs (schedule it daily).</p>
    </Card>
  );
}

export default function ProgrammesPage() {
  const [editing, setEditing] = useState<Programme | 'new' | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['ia-programmes'], queryFn: () => api.get<Programme[]>('/programmes') });
  return (
    <>
      <PageHeader title="Audit programmes" subtitle="Standard procedures that become an engagement's working papers" />
      <div className="space-y-5">
        <Card padded={false} title="Programmes" actions={<Button onClick={() => setEditing('new')}>New programme</Button>}>
          <ErrorBox error={error} />
          {isLoading ? <Loading /> : !data?.length ? <Empty>No programmes yet.</Empty> : (
            <table className="table-base">
              <thead><tr><th>Programme</th><th>Area</th><th className="num">Procedures</th><th /></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'text-muted'}>
                    <td>{p.name} {!p.active && <Badge tone="gray">not in use</Badge>}<div className="text-xs text-muted">{p.objective}</div></td>
                    <td>{p.area}</td>
                    <td className="num">{p.procedures.length}</td>
                    <td><Button variant="secondary" onClick={() => setEditing(p)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <SettingsCard />
      </div>
      {editing && <ProgrammeForm p={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
