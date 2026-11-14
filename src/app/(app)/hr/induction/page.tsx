'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useDepartments } from '@/modules/hr/ui/hooks';

interface Starter { id: string; employeeNo: string; name: string; jobTitle?: string; hireDate: string }
interface Induction {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  venue?: string;
  status: string;
  sessions: { id: string; date?: string; time?: string; topic: string; department: string; facilitator?: string }[];
  participants: { employeeId: string; employeeNo: string; name: string; jobTitle: string; department: string; notifiedAt?: string; remindedAt?: string; attended: boolean | null }[];
}

function NewInduction({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const starters = useQuery({ queryKey: ['hr-new-starters'], queryFn: () => api.get<Starter[]>('/inductions/new-starters') });
  const [f, setF] = useState({ title: 'New staff induction', startDate: '', endDate: '', venue: '', participants: [] as string[] });
  const save = useMutation({ mutationFn: () => api.post<{ id: string }>('/inductions', { ...f, venue: f.venue || undefined, sessions: [] }), onSuccess: (i) => onSaved(i.id) });
  return (
    <Modal open wide onClose={onClose} title="New induction programme" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.startDate || !f.endDate || f.title.length < 3}>Create and alert participants</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Starts"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Ends"><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Venue" className="sm:col-span-2"><Input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></Field>
      </div>
      <Field label="Participants (staff hired in the last 90 days, not yet inducted)">
        {starters.isLoading ? <Loading /> : !starters.data?.length ? <p className="text-sm text-muted">No new starters waiting.</p> : (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto text-sm">
            {starters.data.map((s) => <label key={s.id} className="flex items-center gap-2"><input type="checkbox" checked={f.participants.includes(s.id)} onChange={(e) => setF({ ...f, participants: e.target.checked ? [...f.participants, s.id] : f.participants.filter((x) => x !== s.id) })} />{s.employeeNo} · {s.name} <span className="text-muted">{s.jobTitle}, joined {fmtDate(s.hireDate)}</span></label>)}
          </div>
        )}
      </Field>
      <p className="text-xs text-muted">Participants get an SMS and email now and a reminder the day before. Departments add their sessions to the programme afterwards.</p>
    </Modal>
  );
}

function Programme({ id }: { id: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const departments = useDepartments();
  const { data: i, error, isLoading } = useQuery({ queryKey: ['hr-induction', id], queryFn: () => api.get<Induction>(`/inductions/${id}`) });
  const [s, setS] = useState({ date: '', time: '', topic: '', departmentId: '', facilitator: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['hr-induction', id] });
  const addSession = useMutation({ mutationFn: () => api.post(`/inductions/${id}/sessions`, { ...s, date: s.date || null, departmentId: s.departmentId || null, time: s.time || undefined, facilitator: s.facilitator || undefined }), onSuccess: () => { setS({ date: '', time: '', topic: '', departmentId: '', facilitator: '' }); refresh(); } });
  const mark = useMutation({ mutationFn: (rows: { employeeId: string; attended: boolean }[]) => api.put(`/inductions/${id}/attendance`, { rows }), onSuccess: refresh });
  const close = useMutation({ mutationFn: (status: string) => api.post(`/inductions/${id}/status`, { status }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['hr-inductions'] }); } });
  if (isLoading) return <Loading />;
  if (!i) return <ErrorBox error={error} />;
  const hr = can('hr.employee.manage');
  return (
    <div className="space-y-4">
      <ErrorBox error={addSession.error || mark.error || close.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-lg font-semibold">{i.title} <Badge value={i.status === 'PLANNED' ? 'OPEN' : i.status} /></h2><p className="text-sm text-muted">{fmtDate(i.startDate)} – {fmtDate(i.endDate)}{i.venue && ` · ${i.venue}`}</p></div>
        {hr && i.status === 'PLANNED' && <div className="flex gap-2"><Button variant="secondary" onClick={() => close.mutate('CANCELLED')}>Cancel</Button><Button onClick={() => close.mutate('COMPLETED')}>Mark completed</Button></div>}
      </div>
      <Card padded={false} title="Programme">
        {!i.sessions.length ? <Empty>No sessions yet. HR and the departments add theirs below.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Day</th><th>Time</th><th>Session</th><th>By</th><th>Facilitator</th></tr></thead>
            <tbody>{i.sessions.map((x) => <tr key={x.id}><td>{x.date ? fmtDate(x.date) : '—'}</td><td>{x.time}</td><td>{x.topic}</td><td>{x.department}</td><td>{x.facilitator}</td></tr>)}</tbody>
          </table>
        )}
        {i.status === 'PLANNED' && (
          <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-6">
            <Input type="date" value={s.date} onChange={(e) => setS({ ...s, date: e.target.value })} aria-label="Day" />
            <Input placeholder="09:00" value={s.time} onChange={(e) => setS({ ...s, time: e.target.value })} aria-label="Time" />
            <Input placeholder="Session" value={s.topic} onChange={(e) => setS({ ...s, topic: e.target.value })} className="sm:col-span-2" />
            <Select value={s.departmentId} onChange={(e) => setS({ ...s, departmentId: e.target.value })}><option value="">HR</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
            <div className="flex gap-1"><Input placeholder="Facilitator" value={s.facilitator} onChange={(e) => setS({ ...s, facilitator: e.target.value })} /><Button onClick={() => addSession.mutate()} disabled={s.topic.length < 2 || addSession.isPending}>Add</Button></div>
          </div>
        )}
      </Card>
      <Card padded={false} title="Participants">
        <table className="table-base">
          <thead><tr><th>Employee</th><th>Department</th><th>Alerted</th><th>Reminded</th><th>Attended</th></tr></thead>
          <tbody>
            {i.participants.map((p) => (
              <tr key={p.employeeId}>
                <td>{p.employeeNo} · {p.name}<div className="text-xs text-muted">{p.jobTitle}</div></td>
                <td>{p.department}</td>
                <td>{p.notifiedAt ? fmtDate(p.notifiedAt) : '—'}</td>
                <td>{p.remindedAt ? fmtDate(p.remindedAt) : '—'}</td>
                <td>{hr ? <input type="checkbox" checked={Boolean(p.attended)} onChange={(e) => mark.mutate([{ employeeId: p.employeeId, attended: e.target.checked }])} aria-label="Attended" /> : p.attended ? 'Yes' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function InductionPage() {
  const can = useCan();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-inductions'], queryFn: () => api.get<Induction[]>('/inductions') });
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = chosen ?? data?.[0]?.id ?? null;
  return (
    <>
      <PageHeader title="Induction" subtitle="Programmes for new staff, built by HR with the departments" actions={can('hr.employee.manage') && <Button onClick={() => setCreating(true)}>New programme</Button>} />
      <ErrorBox error={error} />
      <Notice>Attendance ticks off the induction step of each new employee&apos;s onboarding checklist. Reminders go out the day before when the daily HR job runs (POST /api/v1/hr/inductions/remind).</Notice>
      <div className="mt-4">
        {isLoading ? <Loading /> : !data?.length ? <Card><Empty>No induction programmes yet.</Empty></Card> : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">{data.map((i) => <Button key={i.id} variant={i.id === current ? 'primary' : 'secondary'} onClick={() => setChosen(i.id)}>{i.title} · {fmtDate(i.startDate)}</Button>)}</div>
            {current && <Programme key={current} id={current} />}
          </>
        )}
      </div>
      {creating && <NewInduction onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); setChosen(id); qc.invalidateQueries({ queryKey: ['hr-inductions'] }); }} />}
    </>
  );
}
