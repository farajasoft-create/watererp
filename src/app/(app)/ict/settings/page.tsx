'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/modules/ict/ui/api';
import { PRIORITIES, PRIORITY_HELP, Priority } from '@/modules/ict/ui/shared';

interface Category { id: string; code: string; name: string; defaultAssignee: string | null; active: boolean }
interface Settings { sla: { priority: Priority; respond: number; resolve: number }[]; autoCloseDays: number; emailRequester: boolean; categories: Category[] }
interface Agent { id: string; name: string }

function CategoryForm({ cat, agents, onClose }: { cat?: Category; agents: Agent[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: cat?.code ?? '', name: cat?.name ?? '', defaultAssignee: cat?.defaultAssignee ?? '', active: cat?.active ?? true });
  const save = useMutation({
    mutationFn: () => {
      const body = { code: f.code, name: f.name, defaultAssignee: f.defaultAssignee || null, ...(cat && { active: f.active }) };
      return cat ? api.put(`/helpdesk/categories/${cat.id}`, body) : api.post('/helpdesk/categories', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ict-settings'] });
      qc.invalidateQueries({ queryKey: ['ict-categories'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={cat ? `Edit ${cat.name}` : 'New category'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.code.length < 2 || f.name.length < 2}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={20} /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></Field>
        <Field label="Send new tickets to" hint="Blank: the ICT manager assigns them" className="sm:col-span-2">
          <Select value={f.defaultAssignee} onChange={(e) => setF({ ...f, defaultAssignee: e.target.value })}>
            <option value="">Nobody (manager assigns)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        {cat && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> In use</label>}
      </div>
    </Modal>
  );
}

function Deadlines({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ sla: PRIORITIES.map((p) => s.sla.find((r) => r.priority === p) ?? { priority: p, respond: 4, resolve: 24 }), autoCloseDays: s.autoCloseDays, emailRequester: s.emailRequester });
  const save = useMutation({ mutationFn: () => api.put('/helpdesk/settings', f), onSuccess: () => qc.invalidateQueries({ queryKey: ['ict-settings'] }) });
  const setRow = (i: number, k: 'respond' | 'resolve', v: string) => setF({ ...f, sla: f.sla.map((r, j) => (j === i ? { ...r, [k]: Number(v) } : r)) });
  return (
    <Card title="Response and resolution times" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved. New tickets get these deadlines.</Notice>}
      <table className="table-base mt-2">
        <thead><tr><th>Priority</th><th>Meaning</th><th>Respond within (hours)</th><th>Resolve within (hours)</th></tr></thead>
        <tbody>
          {f.sla.map((r, i) => (
            <tr key={r.priority}>
              <td className="font-medium">{r.priority.toLowerCase()}</td>
              <td className="text-sm text-muted">{PRIORITY_HELP[r.priority]}</td>
              <td><Input inputMode="decimal" value={String(r.respond)} onChange={(e) => setRow(i, 'respond', e.target.value)} className="max-w-24" /></td>
              <td><Input inputMode="decimal" value={String(r.resolve)} onChange={(e) => setRow(i, 'resolve', e.target.value)} className="max-w-24" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Close resolved tickets after (days without a reply)"><Input inputMode="numeric" value={String(f.autoCloseDays)} onChange={(e) => setF({ ...f, autoCloseDays: Number(e.target.value) || 1 })} className="max-w-24" /></Field>
        <label className="flex items-center gap-1.5 self-end text-sm"><input type="checkbox" checked={f.emailRequester} onChange={(e) => setF({ ...f, emailRequester: e.target.checked })} /> Email requesters as well as the in-app notice</label>
      </div>
      <p className="mt-2 text-xs text-muted">Times are in calendar hours. Time on hold does not count. Late tickets are escalated to the ICT manager when the help desk check runs (schedule POST /api/v1/ict/helpdesk/housekeeping every few minutes).</p>
    </Card>
  );
}

export default function HelpdeskSettingsPage() {
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['ict-settings'], queryFn: () => api.get<Settings>('/helpdesk/settings') });
  const agents = useQuery({ queryKey: ['ict-agents'], queryFn: () => api.get<Agent[]>('/helpdesk/agents') });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const name = (id: string | null) => agents.data?.find((a) => a.id === id)?.name;
  return (
    <>
      <PageHeader title="Help desk settings" subtitle="Deadlines by priority, and ticket categories" />
      <div className="space-y-5">
        <Deadlines s={data} />
        <Card padded={false} title="Categories" actions={<Button onClick={() => setEditing('new')}>Add category</Button>}>
          <table className="table-base">
            <thead><tr><th>Code</th><th>Name</th><th>New tickets go to</th><th /></tr></thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'text-muted'}>
                  <td className="font-medium">{c.code}</td>
                  <td>{c.name} {!c.active && <Badge tone="gray">not in use</Badge>}</td>
                  <td>{name(c.defaultAssignee) ?? <span className="text-muted">manager assigns</span>}</td>
                  <td><Button variant="secondary" onClick={() => setEditing(c)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      {editing && <CategoryForm cat={editing === 'new' ? undefined : editing} agents={agents.data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}
