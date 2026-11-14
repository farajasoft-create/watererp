'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, Stat, Tabs } from '@/components/ui';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useDepartments } from '@/modules/hr/ui/hooks';

interface Row { employeeId: string; employeeNo: string; name: string; status: string; firstIn: string | null; lastOut: string | null; hours: number | null; lateMinutes: number }
interface Day { totals: { present: number; late: number; absent: number; onLeave: number; off: number }; rows: Row[] }
interface Summary { rows: { employeeId: string; employeeNo: string; name: string; workingDays: number; present: number; late: number; lateMinutes: number; absent: number; onLeave: number; hours: number }[] }
interface Settings { start: string; end: string; graceMinutes: number; workSaturday: boolean }

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) : '—');
const TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'gray'> = { PRESENT: 'green', LATE: 'amber', ABSENT: 'red', ON_LEAVE: 'blue', OFF: 'gray', NOT_EMPLOYED: 'gray' };
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

function SettingsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['hr-att-settings'], queryFn: () => api.get<Settings>('/attendance/settings') });
  const [f, setF] = useState<Settings | null>(null);
  const v = f ?? data;
  const save = useMutation({ mutationFn: () => api.put('/attendance/settings', v), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['hr-att'] }); qc.invalidateQueries({ queryKey: ['hr-att-settings'] }); } });
  if (!v) return <Loading />;
  return (
    <Card title="Working day" actions={<Button onClick={() => save.mutate()} disabled={!f || save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Starts"><Input type="time" value={v.start} onChange={(e) => setF({ ...v, start: e.target.value })} /></Field>
        <Field label="Ends"><Input type="time" value={v.end} onChange={(e) => setF({ ...v, end: e.target.value })} /></Field>
        <Field label="Minutes allowed before late"><Input inputMode="numeric" value={String(v.graceMinutes)} onChange={(e) => setF({ ...v, graceMinutes: Number(e.target.value) || 0 })} /></Field>
        <label className="flex items-center gap-1.5 self-end text-sm"><input type="checkbox" checked={v.workSaturday} onChange={(e) => setF({ ...v, workSaturday: e.target.checked })} /> Saturday is a working day</label>
      </div>
      <p className="mt-2 text-xs text-muted">Terminals send clock events to POST /api/v1/hr/attendance/punches (employee number and time) using an API key of a service user with the attendance permission.</p>
    </Card>
  );
}

export default function AttendancePage() {
  const can = useCan();
  const { data: departments } = useDepartments();
  const [tab, setTab] = useState<'day' | 'period' | 'settings'>('day');
  const [date, setDate] = useState(today());
  const [dept, setDept] = useState('');
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() });
  const day = useQuery({ queryKey: ['hr-att', 'day', date, dept], queryFn: () => api.get<Day>('/attendance/day', { date, ...(dept && { departmentId: dept }) }), enabled: tab === 'day' });
  const sum = useQuery({ queryKey: ['hr-att', 'sum', range, dept], queryFn: () => api.get<Summary>('/attendance/summary', { ...range, ...(dept && { departmentId: dept }) }), enabled: tab === 'period' });
  return (
    <>
      <PageHeader title="Attendance" subtitle="Clock-ins from biometric terminals, checked against the working day, approved leave and public holidays" />
      <Tabs tabs={[{ id: 'day', label: 'Day register' }, { id: 'period', label: 'Period summary' }, ...(can('hr.settings.manage') ? [{ id: 'settings' as const, label: 'Working day' }] : [])]} value={tab} onChange={setTab} />
      {tab !== 'settings' && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          {tab === 'day' ? <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field> : <><Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></>}
          <Field label="Department"><Select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All</option>{departments?.map((d) => <option key={d.id} value={d.id}>{d.path ?? d.name}</option>)}</Select></Field>
          {tab === 'period' && <a className="pb-2 text-sm text-brand-700 hover:underline" href={`/api/v1/hr/attendance/summary?from=${range.from}&to=${range.to}${dept ? `&departmentId=${dept}` : ''}&csv=true`}>CSV</a>}
        </div>
      )}
      {tab === 'day' && (
        <>
          <ErrorBox error={day.error} />
          {day.data && <div className="mb-3 grid gap-3 sm:grid-cols-5"><Stat label="Present" value={day.data.totals.present} /><Stat label="Late" value={day.data.totals.late} tone={day.data.totals.late ? 'warn' : undefined} /><Stat label="Absent" value={day.data.totals.absent} tone={day.data.totals.absent ? 'bad' : undefined} /><Stat label="On leave" value={day.data.totals.onLeave} /><Stat label="Off" value={day.data.totals.off} /></div>}
          <Card padded={false}>
            {day.isLoading ? <Loading /> : !day.data?.rows.length ? <Empty>No staff.</Empty> : (
              <table className="table-base">
                <thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th className="num">Hours</th><th className="num">Minutes late</th></tr></thead>
                <tbody>{day.data.rows.map((r) => <tr key={r.employeeId}><td>{r.name}<div className="text-xs text-muted">{r.employeeNo}</div></td><td><Badge tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge></td><td>{time(r.firstIn)}</td><td>{time(r.lastOut)}</td><td className="num">{r.hours ?? '—'}</td><td className="num">{r.lateMinutes || ''}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </>
      )}
      {tab === 'period' && (
        <Card padded={false}>
          <ErrorBox error={sum.error} />
          {sum.isLoading ? <Loading /> : !sum.data?.rows.length ? <Empty>No staff.</Empty> : (
            <table className="table-base">
              <thead><tr><th>Employee</th><th className="num">Working days</th><th className="num">Present</th><th className="num">Late</th><th className="num">Minutes late</th><th className="num">Absent</th><th className="num">On leave</th><th className="num">Hours</th></tr></thead>
              <tbody>{sum.data.rows.map((r) => <tr key={r.employeeId}><td>{r.name}<div className="text-xs text-muted">{r.employeeNo}</div></td><td className="num">{r.workingDays}</td><td className="num">{r.present}</td><td className="num">{r.late}</td><td className="num">{r.lateMinutes}</td><td className="num">{r.absent}</td><td className="num">{r.onLeave}</td><td className="num">{r.hours}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'settings' && <SettingsCard />}
    </>
  );
}
