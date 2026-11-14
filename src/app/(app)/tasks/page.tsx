'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label, today } from '@/lib/format';
import { useMe } from '@/lib/session';

interface Task {
  id: string;
  number: string;
  title: string;
  description?: string;
  link?: string;
  assignedTo: string;
  assignedName?: string;
  createdBy: string;
  createdName?: string;
  priority: string;
  status: string;
  dueAt?: string;
  overdue?: boolean;
  comments: { at: string; by: string; text: string }[];
  createdAt: string;
}

interface Analytics {
  total: number;
  done: number;
  overdue: number;
  byAssignee: { name: string; total: number; done: number; onTimePercent: number | null; avgTurnaroundHours: number | null }[];
}

function NewTask({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: users } = useDirectory();
  const [f, setF] = useState({ title: '', description: '', assignedTo: '', dueAt: '', priority: 'NORMAL' });
  const save = useMutation({ mutationFn: () => api.post('/tasks', { ...f, description: f.description || undefined, dueAt: f.dueAt || null }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); onClose(); } });
  return (
    <Modal open onClose={onClose} title="New task" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 3 || !f.assignedTo}>Assign</Button>}>
      <ErrorBox error={save.error} />
      <Field label="Task"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Details"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="For"><Select value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}><option value="">Choose…</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <Field label="Due"><Input type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'NORMAL', 'HIGH'].map((p) => <option key={p} value={p}>{label(p)}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/tasks/${task.id}`, body), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); onClose(); } });
  const open = ['OPEN', 'IN_PROGRESS'].includes(task.status);
  return (
    <Modal open wide onClose={onClose} title={`${task.number} · ${task.title}`}>
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">From {task.createdName} to {task.assignedName}{task.dueAt ? `, due ${fmtDate(task.dueAt)}` : ''}</p>
      {task.description && <p className="whitespace-pre-wrap text-sm">{task.description}</p>}
      <ol className="space-y-1 border-l-2 border-line pl-3 text-sm">{task.comments.map((c, i) => <li key={i}><span className="text-xs text-muted">{fmtDateTime(c.at)}</span> {c.text}</li>)}</ol>
      <Field label="Comment"><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!comment} onClick={() => save.mutate({ comment })}>Add comment</Button>
        {task.status === 'OPEN' && <Button variant="secondary" onClick={() => save.mutate({ status: 'IN_PROGRESS', comment: comment || undefined })}>Start</Button>}
        {open && <Button onClick={() => save.mutate({ status: 'DONE', comment: comment || undefined })}>Mark done</Button>}
      </div>
    </Modal>
  );
}

export default function TasksPage() {
  const { data: me } = useMe();
  const [view, setView] = useState('mine');
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<Task | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['tasks', view], queryFn: () => api.get<Task[]>('/tasks', { view: view === 'overdue' ? 'all' : view, overdue: view === 'overdue' || undefined }) });
  const monthStart = `${today().slice(0, 7)}-01`;
  const { data: stats } = useQuery({ queryKey: ['tasks', 'analytics', monthStart], queryFn: () => api.get<Analytics>('/tasks/analytics', { from: monthStart, to: today() }) });
  return (
    <>
      <PageHeader title="Tasks" subtitle="Work assigned between people and departments, with deadlines and escalation" actions={<Button onClick={() => setCreating(true)}>New task</Button>} />
      <ErrorBox error={error} />
      {stats && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Raised this month" value={stats.total} />
          <Stat label="Done" value={stats.done} />
          <Stat label="Overdue" value={stats.overdue} tone={stats.overdue ? 'bad' : 'good'} />
        </div>
      )}
      <Card padded={false} actions={<Select value={view} onChange={(e) => setView(e.target.value)} className="w-48"><option value="mine">Assigned to me</option><option value="created">Raised by me</option><option value="overdue">Overdue</option><option value="all">{me?.isAdmin ? 'Everyone' : 'All mine'}</option></Select>} title="Tasks">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No tasks.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Task</th><th>For</th><th>From</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpened(t)}>
                  <td><b>{t.number}</b> {t.title}</td>
                  <td>{t.assignedName}</td>
                  <td>{t.createdName}</td>
                  <td className={t.overdue ? 'text-red-700' : ''}>{fmtDate(t.dueAt)}</td>
                  <td>{label(t.priority)}</td>
                  <td><Badge value={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {stats && stats.byAssignee.length > 0 && (
        <Card padded={false} title="Turnaround this month" className="mt-4">
          <table className="table-base">
            <thead><tr><th>Person</th><th className="num">Tasks</th><th className="num">Done</th><th className="num">On time</th><th className="num">Average turnaround</th></tr></thead>
            <tbody>{stats.byAssignee.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{r.total}</td><td className="num">{r.done}</td><td className="num">{r.onTimePercent === null ? '—' : `${r.onTimePercent}%`}</td><td className="num">{r.avgTurnaroundHours === null ? '—' : `${r.avgTurnaroundHours} h`}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
      {creating && <NewTask onClose={() => setCreating(false)} />}
      {opened && <TaskDetail task={opened} onClose={() => setOpened(null)} />}
    </>
  );
}
