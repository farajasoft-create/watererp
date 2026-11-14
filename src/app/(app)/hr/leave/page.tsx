'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Pager, Select } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useEmployeeOptions, useLeaveTypes } from '@/modules/hr/ui/hooks';
import { LeaveRequest, Page } from '@/modules/hr/ui/types';

function Apply({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions();
  const { data: types } = useLeaveTypes();
  const [f, setF] = useState({ employeeId: '', leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const person = people?.find((p) => p.id === f.employeeId);
  const days = useQuery({ queryKey: ['hr-leave-days', f.startDate, f.endDate], queryFn: () => api.get<{ days: number }>('/leave/days', { from: f.startDate, to: f.endDate }), enabled: Boolean(f.startDate && f.endDate && f.endDate >= f.startDate) });
  const save = useMutation({
    mutationFn: () => api.post('/leave', { ...f, reason: f.reason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-leave'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Leave for an employee" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.employeeId || !f.leaveTypeId || !f.startDate || !f.endDate}>Submit</Button></>}>
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">For staff without self-service. It waits for approval like any other request.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee">
          <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
            <option value="">Select…</option>
            {people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Leave">
          <Select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>
            <option value="">Select…</option>
            {types?.filter((t) => t.active && (!t.gender || !person?.gender || t.gender === person.gender)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="To" hint={days.data ? `${days.data.days} working days` : undefined}><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Reason" className="sm:col-span-2"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function CarryForward({ onClose }: { onClose: () => void }) {
  const [year, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
  const run = useMutation({ mutationFn: () => api.post<{ employees: number; days: number }>('/leave/carry-forward', { year }) });
  return (
    <Modal open onClose={onClose} title="Close the leave year" footer={run.isSuccess ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => run.mutate()} disabled={run.isPending}>Carry forward</Button></>}>
      <ErrorBox error={run.error} />
      {run.data ? (
        <Notice tone="green">{run.data.days} days carried into {year + 1} for {run.data.employees} employees.</Notice>
      ) : (
        <>
          <p className="text-sm">Moves each employee&apos;s unused days into the next year, up to each leave type&apos;s carry-forward limit (HR settings → Leave types). Running it again updates the figures.</p>
          <Field label="Year to close"><Input inputMode="numeric" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="max-w-28" /></Field>
        </>
      )}
    </Modal>
  );
}

function Review({ request, onClose }: { request: LeaveRequest; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') => api.post(`/leave/${request.id}/review`, { decision, note: note || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-leave'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`${request.leaveType}: ${request.employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => review.mutate('REJECTED')} disabled={review.isPending || !note}>Reject</Button>
          <Button onClick={() => review.mutate('APPROVED')} disabled={review.isPending}>Approve</Button>
        </>
      }
    >
      <ErrorBox error={review.error} />
      <p className="text-sm">
        {fmtDate(request.startDate)} to {fmtDate(request.endDate)}: <b>{request.days} working days</b>. {request.reason}
      </p>
      <Field label="Note" hint="Required to reject"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

export default function LeavePage() {
  const can = useCan();
  const qc = useQueryClient();
  const [q, setQ] = useState({ status: 'PENDING', page: 1 });
  const [modal, setModal] = useState<'apply' | 'carry' | LeaveRequest | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-leave', q], queryFn: () => api.get<Page<LeaveRequest>>('/leave', { ...q, pageSize: 50 }) });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/leave/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-leave'] }) });
  const [recalling, setRecalling] = useState<{ id: string; returnDate: string; reason: string } | null>(null);
  const recall = useMutation({ mutationFn: () => api.post(`/leave/${recalling!.id}/recall`, { returnDate: recalling!.returnDate, reason: recalling!.reason }), onSuccess: () => (setRecalling(null), qc.invalidateQueries({ queryKey: ['hr-leave'] })) });
  const approver = can('hr.leave.approve');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Leave"
        subtitle="Applications, approvals and balances"
        actions={
          <>
            {can('hr.leave.manage') && <Button variant="secondary" onClick={() => setModal('carry')}>Close leave year</Button>}
            {approver && <Button onClick={() => setModal('apply')}>Leave for an employee</Button>}
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select value={q.status} onChange={(e) => setQ({ status: e.target.value, page: 1 })} className="max-w-[12rem]">
            <option value="">All</option>
            {['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s === 'PENDING' ? 'Waiting for approval' : label(s)}</option>)}
          </Select>
        </div>
        <ErrorBox error={error || cancel.error} />
        <Modal open={!!recalling} onClose={() => setRecalling(null)} title="Recall from leave" footer={<><Button variant="secondary" onClick={() => setRecalling(null)}>Cancel</Button><Button disabled={recall.isPending || !recalling?.reason.trim()} onClick={() => recall.mutate()}>Recall</Button></>}>
          <ErrorBox error={recall.error} />
          <p className="text-sm text-muted">The employee is told to report back; days from the return date go back to their balance.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Back at work on"><Input type="date" value={recalling?.returnDate ?? ''} onChange={(e) => setRecalling({ ...recalling!, returnDate: e.target.value })} /></Field>
            <Field label="Reason"><Input value={recalling?.reason ?? ''} onChange={(e) => setRecalling({ ...recalling!, reason: e.target.value })} /></Field>
          </div>
        </Modal>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>{q.status === 'PENDING' ? 'Nothing waiting for approval.' : 'No leave.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="num">Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/hr/employees/${r.employeeId}`} className="text-brand-700 hover:underline">{r.employeeName}</Link> <span className="text-xs text-muted">{r.employeeNo}</span>
                    </td>
                    <td>{r.leaveType}</td>
                    <td>{fmtDate(r.startDate)}</td>
                    <td>{fmtDate(r.endDate)}</td>
                    <td className="num">{r.days}</td>
                    <td className="max-w-xs">{r.reason}{r.reviewNote && <div className="text-xs text-muted">Note: {r.reviewNote}</div>}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="whitespace-nowrap text-right">
                      {approver && r.status === 'PENDING' && <Button variant="secondary" onClick={() => setModal(r)}>Review</Button>}
                      {approver && r.status === 'APPROVED' && new Date(r.startDate) > new Date() && (
                        <Button variant="secondary" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>Cancel</Button>
                      )}
                      {approver && r.status === 'APPROVED' && !r.recalledAt && r.startDate.slice(0, 10) < today && r.endDate.slice(0, 10) >= today && (
                        <Button variant="secondary" onClick={() => setRecalling({ id: r.id, returnDate: today, reason: '' })}>Recall</Button>
                      )}
                      {r.recalledAt && <span className="text-xs text-muted">Recalled ({r.daysRestored} day{r.daysRestored === 1 ? '' : 's'} back)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {modal === 'apply' && <Apply onClose={() => setModal(null)} />}
      {modal === 'carry' && <CarryForward onClose={() => setModal(null)} />}
      {modal && typeof modal === 'object' && <Review request={modal} onClose={() => setModal(null)} />}
    </>
  );
}
