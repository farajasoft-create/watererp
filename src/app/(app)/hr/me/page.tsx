'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Money, Notice, PageHeader, Select } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { api } from '@/modules/hr/ui/api';
import { MyRequests as RequestsAndApprovals } from '@/modules/hr/ui/my-requests';
import { MyTransport } from '@/modules/hr/ui/request-transport';
import { LeaveBalance, LeaveRequest, Payslip } from '@/modules/hr/ui/types';

interface Me {
  employee: { id: string; employeeNo: string; name: string; jobTitle?: string; department: string | null; hireDate: string; kraPin?: string; status: string };
  year: number;
  balances: LeaveBalance[];
  payslips: Pick<Payslip, 'id' | 'period' | 'title' | 'payslipNo' | 'gross' | 'totalDeductions' | 'netPay'>[];
  requests: LeaveRequest[];
  leaveTypes: { id: string; name: string; code: string }[];
}

function ApplyForLeave({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '', handoverTo: '', handoverNotes: '' });
  const colleagues = useQuery({ queryKey: ['hr-me-colleagues'], queryFn: () => api.get<{ id: string; name: string; jobTitle: string }[]>('/me/colleagues') });
  const days = useQuery({ queryKey: ['hr-leave-days', f.startDate, f.endDate], queryFn: () => api.get<{ days: number }>('/leave/days', { from: f.startDate, to: f.endDate }), enabled: Boolean(f.startDate && f.endDate && f.endDate >= f.startDate) });
  const apply = useMutation({
    mutationFn: () => api.post('/me/leave', { ...f, reason: f.reason || undefined, handoverTo: f.handoverTo || null, handoverNotes: f.handoverNotes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-me'] });
      setF({ leaveTypeId: '', startDate: '', endDate: '', reason: '', handoverTo: '', handoverNotes: '' });
    },
  });
  return (
    <Card title="Apply for leave" actions={<Button onClick={() => apply.mutate()} disabled={apply.isPending || !f.leaveTypeId || !f.startDate || !f.endDate}>Apply</Button>}>
      <ErrorBox error={apply.error} />
      {apply.isSuccess && <Notice tone="green">Sent for approval.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Leave">
          <Select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>
            <option value="">Select…</option>
            {me.leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="To" hint={days.data ? `${days.data.days} working days` : 'Weekends and public holidays are not counted'}><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Handing over to">
          <Select value={f.handoverTo} onChange={(e) => setF({ ...f, handoverTo: e.target.value })}>
            <option value="">No one</option>
            {colleagues.data?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.jobTitle ? ` · ${c.jobTitle}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Handover notes"><Input value={f.handoverNotes} onChange={(e) => setF({ ...f, handoverNotes: e.target.value })} /></Field>
      </div>
    </Card>
  );
}

/** Ask HR to update contact details or bank details, and raise a grievance. */
function MyRequests() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['hr-me-changes'], queryFn: () => api.get<{ id: string; kind: string; status: string; createdAt: string; note?: string }[]>('/me/changes') });
  const [kind, setKind] = useState<'contact' | 'bank' | 'grievance'>('contact');
  const [c, setC] = useState({ phone: '', email: '', address: '' });
  const [b, setB] = useState({ name: '', branch: '', accountNo: '' });
  const [g, setG] = useState({ category: '', against: '', description: '' });
  const [done, setDone] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      if (kind === 'contact') {
        const changes = Object.fromEntries(Object.entries(c).filter(([, v]) => v.trim()));
        await api.post('/me/changes/personal', changes);
        return 'Sent to HR for approval.';
      }
      if (kind === 'bank') {
        await api.post('/me/changes/bank', { payMethod: 'BANK', bank: b });
        return 'Sent to payroll for approval.';
      }
      const res = await api.post<{ number: string }>('/me/grievances', { ...g, against: g.against || undefined });
      return `Grievance ${res.number} received; HR will contact you.`;
    },
    onSuccess: (msg) => (setDone(msg), setC({ phone: '', email: '', address: '' }), setB({ name: '', branch: '', accountNo: '' }), setG({ category: '', against: '', description: '' }), qc.invalidateQueries({ queryKey: ['hr-me-changes'] })),
  });
  return (
    <Card title="Requests to HR" actions={<Select value={kind} onChange={(e) => (setDone(null), setKind(e.target.value as typeof kind))}><option value="contact">Update my contact details</option><option value="bank">Change my bank account</option><option value="grievance">Raise a grievance</option></Select>}>
      <ErrorBox error={send.error} />
      {done && <Notice tone="green">{done}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === 'contact' && (
          <>
            <Field label="New phone"><Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></Field>
            <Field label="New email"><Input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
            <Field label="New address"><Input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></Field>
          </>
        )}
        {kind === 'bank' && (
          <>
            <Field label="Bank"><Input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
            <Field label="Branch"><Input value={b.branch} onChange={(e) => setB({ ...b, branch: e.target.value })} /></Field>
            <Field label="Account number"><Input value={b.accountNo} onChange={(e) => setB({ ...b, accountNo: e.target.value })} /></Field>
          </>
        )}
        {kind === 'grievance' && (
          <>
            <Field label="Category"><Input value={g.category} onChange={(e) => setG({ ...g, category: e.target.value })} placeholder="Workload, treatment, pay…" /></Field>
            <Field label="About whom or what"><Input value={g.against} onChange={(e) => setG({ ...g, against: e.target.value })} /></Field>
            <Field label="What happened" className="sm:col-span-2"><Input value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} /></Field>
          </>
        )}
      </div>
      <div className="mt-3"><Button disabled={send.isPending} onClick={() => send.mutate()}>Send</Button></div>
      {!!mine.data?.length && (
        <ul className="mt-3 space-y-1 text-sm">
          {mine.data.map((m) => <li key={m.id}>{fmtDate(m.createdAt)} · {m.kind === 'BANK' ? 'Bank details' : 'Contact details'} · <Badge value={m.status} />{m.note && <span className="text-muted"> {m.note}</span>}</li>)}
        </ul>
      )}
    </Card>
  );
}

interface MyTarget { id: string; perspective: string; objective: string; measure: string; target: string; weight: number; selfRating: number | null; rating: number | null }
interface MyAppraisal { id: string; cycle: string; status: string; score: number | null; grade: string; targets: MyTarget[]; supervisorComment?: string }
interface MyTraining { id: string; title: string; kind: string; startDate: string; endDate: string; status: string; me?: { attended: boolean | null; rating: number | null } }

/** My appraisal (agree targets, rate myself, accept or appeal) and my training (rate it afterwards). */
function MyPerformance() {
  const qc = useQueryClient();
  const appraisals = useQuery({ queryKey: ['hr-me-appraisals'], queryFn: () => api.get<MyAppraisal[]>('/me/appraisals') });
  const trainings = useQuery({ queryKey: ['hr-me-trainings'], queryFn: () => api.get<MyTraining[]>('/me/trainings') });
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [grounds, setGrounds] = useState('');
  const refresh = () => ['hr-me-appraisals', 'hr-me-trainings'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'agree' | 'self-review' | 'accept' | 'appeal' }) =>
      api.post(`/me/appraisals/${v.id}/${v.action}`, v.action === 'self-review' ? { ratings: Object.entries(ratings).map(([targetId, r]) => ({ targetId, rating: Number(r) })) } : v.action === 'appeal' ? { grounds } : {}),
    onSuccess: () => (setRatings({}), setGrounds(''), refresh()),
  });
  const rate = useMutation({ mutationFn: (v: { id: string; rating: number }) => api.post(`/me/trainings/${v.id}/evaluate`, { rating: v.rating }), onSuccess: refresh });
  const a = appraisals.data?.[0];
  if (!a && !trainings.data?.length) return null;
  return (
    <Card title="My performance and training">
      <ErrorBox error={act.error ?? rate.error} />
      {a && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{a.cycle} <Badge value={a.status} /> {a.score !== null && `${a.score}% (${a.grade})`}</p>
          <table className="w-full">
            <tbody>
              {a.targets.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="py-1">{t.objective}<div className="text-xs text-muted">{t.perspective.replace('_', ' ').toLowerCase()} · {t.weight}%{t.target && ` · target ${t.target}`}</div></td>
                  <td className="text-right">
                    {a.status === 'AGREED' ? (
                      <Select value={ratings[t.id] ?? ''} onChange={(e) => setRatings({ ...ratings, [t.id]: e.target.value })} aria-label="My rating"><option value="">Rate</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                    ) : (
                      <span className="text-xs">Me {t.selfRating ?? '—'} · Supervisor {t.rating ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.supervisorComment && <p className="text-xs italic">Supervisor: {a.supervisorComment}</p>}
          <div className="flex flex-wrap gap-2">
            {a.status === 'TARGETS_SET' && <Button onClick={() => act.mutate({ id: a.id, action: 'agree' })}>Agree targets</Button>}
            {a.status === 'AGREED' && <Button disabled={Object.keys(ratings).length < a.targets.length} onClick={() => act.mutate({ id: a.id, action: 'self-review' })}>Submit my ratings</Button>}
            {a.status === 'REVIEWED' && (
              <>
                <Button onClick={() => act.mutate({ id: a.id, action: 'accept' })}>Accept</Button>
                <Input className="w-64" placeholder="Grounds, to appeal" value={grounds} onChange={(e) => setGrounds(e.target.value)} />
                <Button variant="secondary" disabled={grounds.trim().length < 10} onClick={() => act.mutate({ id: a.id, action: 'appeal' })}>Appeal</Button>
              </>
            )}
          </div>
        </div>
      )}
      {!!trainings.data?.length && (
        <ul className="mt-3 space-y-1 text-sm">
          {trainings.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              {t.title} · {fmtDate(t.startDate)} <Badge value={t.status} />
              {t.status === 'COMPLETED' && t.me?.attended && !t.me.rating && (
                <span className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <Button key={n} variant="secondary" onClick={() => rate.mutate({ id: t.id, rating: n })}>{n}★</Button>)}</span>
              )}
              {t.me?.rating && <span className="text-xs text-muted">You rated it {t.me.rating}/5</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function MyHrPage() {
  const qc = useQueryClient();
  const { data: me, error, isLoading } = useQuery({ queryKey: ['hr-me'], queryFn: () => api.get<Me>('/me'), retry: false });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/me/leave/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-me'] }) });
  if (isLoading) return <Loading />;
  if (!me) return <ErrorBox error={error} />;
  const years = [...new Set(me.payslips.map((p) => p.period.slice(0, 4)))];
  return (
    <>
      <PageHeader title={me.employee.name} subtitle={`${me.employee.employeeNo} · ${me.employee.jobTitle ?? ''} · ${me.employee.department ?? ''} · since ${fmtDate(me.employee.hireDate)}`} />
      <div className="mb-4"><RequestsAndApprovals /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card padded={false} title="My payslips" actions={<div className="flex gap-3 text-sm">{years.map((y) => <Link key={y} href={`/hr/p9/me?year=${y}`} className="text-brand-700 hover:underline">P9 {y}</Link>)}</div>}>
          {!me.payslips.length ? (
            <Empty>No payslips yet.</Empty>
          ) : (
            <table className="table-base">
              <thead>
                <tr><th>Month</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th /></tr>
              </thead>
              <tbody>
                {me.payslips.map((p) => (
                  <tr key={p.id}>
                    <td>{p.period}{p.title && <span className="text-muted"> · {p.title}</span>}</td>
                    <td className="num"><Money value={p.gross} /></td>
                    <td className="num"><Money value={p.totalDeductions} /></td>
                    <td className="num font-medium"><Money value={p.netPay} /></td>
                    <td className="text-right"><Link href={`/hr/payslips/${p.id}?mine=1`} className="text-brand-700 hover:underline">View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card padded={false} title={`My leave ${me.year}`}>
          <table className="table-base">
            <thead>
              <tr><th>Leave</th><th className="num">Earned</th><th className="num">Taken</th><th className="num">Waiting</th><th className="num">Left</th></tr>
            </thead>
            <tbody>
              {me.balances.filter((b) => !b.unlimited).map((b) => (
                <tr key={b.leaveTypeId}>
                  <td>{b.name}</td>
                  <td className="num">{b.earned + b.adjusted}</td>
                  <td className="num">{b.taken}</td>
                  <td className="num">{b.pending || '—'}</td>
                  <td className="num font-medium">{b.available}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <ApplyForLeave me={me} />
        <MyRequests />
        <MyPerformance />
        <MyTransport />
        <Card padded={false} title="My leave applications">
          <ErrorBox error={cancel.error} />
          {!me.requests.length ? (
            <Empty>None yet.</Empty>
          ) : (
            <table className="table-base">
              <tbody>
                {me.requests.map((r) => (
                  <tr key={r.id}>
                    <td>{r.leaveType}</td>
                    <td>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</td>
                    <td className="num">{r.days} d</td>
                    <td><Badge value={r.status} />{r.reviewNote && <div className="text-xs text-muted">{r.reviewNote}</div>}</td>
                    <td className="text-right">
                      {(r.status === 'PENDING' || (r.status === 'APPROVED' && new Date(r.startDate) > new Date())) && (
                        <Button variant="secondary" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>Cancel</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
