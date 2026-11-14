'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { departmentName, useDepartments, useEmployeeOptions } from '@/modules/hr/ui/hooks';

interface JobGroup { id: string; code: string; name: string; rank: number; notches: string[]; allowances: { code: string; name: string; amount: string; taxable: boolean }[]; active: boolean }
interface EstRow { departmentId: string | null; department: string; jobGroupId: string | null; jobGroup: string; designations: string[]; authorised: number; inPost: number; vacant: number; over: number; acting: number }
interface Posting { departmentId: string | null; jobGroupId: string | null; notch: number | null; jobTitle: string; station: string; basicSalary: string | null }
interface CareerEvent { id: string; kind: string; effectiveDate: string; endDate: string | null; from: Posting; to: Posting; reason: string; actingAllowance: string | null; requestedBy: string; employee: { id: string; employeeNo: string; name: string } }
interface Due { employeeId: string; employeeNo: string; name: string; jobGroup: string; notch: number; nextNotch: number; dueDate: string; currentPay: string | null; newPay: string | null; pending: boolean }
interface Ending { employeeId: string; employeeNo: string; name: string; jobTitle: string; contractEndDate: string; ended: boolean }

const KINDS = ['PROMOTION', 'TRANSFER', 'REDESIGNATION', 'SECONDMENT', 'ACTING', 'SALARY_CHANGE', 'DEMOTION'] as const;
const today = () => new Date().toISOString().slice(0, 10);

export default function EstablishmentPage() {
  const can = useCan();
  const [tab, setTab] = useState<'establishment' | 'changes' | 'increments' | 'contracts' | 'groups'>('establishment');
  return (
    <>
      <PageHeader title="Establishment & careers" subtitle="Authorised posts against staff in post, job groups and salary scales, and approved career changes: promotions, transfers, secondments, acting appointments, salary changes and increments." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'establishment', label: 'Establishment' },
          { id: 'changes', label: 'Career changes' },
          { id: 'increments', label: 'Increments due' },
          { id: 'contracts', label: 'Contracts ending' },
          { id: 'groups', label: 'Job groups & scales' },
        ]}
      />
      {tab === 'establishment' && <Establishment canEdit={can('hr.settings.manage')} />}
      {tab === 'changes' && <Changes />}
      {tab === 'increments' && <Increments />}
      {tab === 'contracts' && <Contracts />}
      {tab === 'groups' && <Groups canEdit={can('hr.settings.manage')} />}
    </>
  );
}

function useGroups() {
  return useQuery({ queryKey: ['hr-job-groups'], queryFn: () => api.get<JobGroup[]>('/job-groups') });
}

function Establishment({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['hr-establishment'], queryFn: () => api.get<{ rows: EstRow[]; totals: { authorised: number; inPost: number; vacant: number; over: number } }>('/establishment') });
  const { data: departments } = useDepartments();
  const { data: groups } = useGroups();
  const [row, setRow] = useState<null | { departmentId: string; jobGroupId: string; designation: string; authorised: string }>(null);
  const save = useMutation({
    mutationFn: () => api.put('/establishment', { rows: [{ ...row!, authorised: Number(row!.authorised || 0) }] }),
    onSuccess: () => (setRow(null), qc.invalidateQueries({ queryKey: ['hr-establishment'] })),
  });
  if (isLoading || !data) return <Loading />;
  return (
    <Card title={`${data.totals.inPost} in post of ${data.totals.authorised} authorised · ${data.totals.vacant} vacant${data.totals.over ? ` · ${data.totals.over} over establishment` : ''}`} actions={canEdit && <Button onClick={() => setRow({ departmentId: departments?.[0]?.id ?? '', jobGroupId: groups?.[0]?.id ?? '', designation: '', authorised: '1' })}>Set authorised posts</Button>}>
      {!data.rows.length ? (
        <Empty>No posts yet. Set authorised posts by department and job group.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Department</th><th>Job group</th><th>Designations</th><th className="text-right">Authorised</th><th className="text-right">In post</th><th className="text-right">Vacant</th><th className="text-right">Acting</th></tr></thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="py-2">{r.department}</td>
                <td>{r.jobGroup}</td>
                <td className="text-xs text-muted">{r.designations.join(', ') || (r.authorised ? '' : 'Not on the establishment')}</td>
                <td className="text-right">{r.authorised}</td>
                <td className="text-right">{r.inPost}{r.over > 0 && <Badge tone="amber">+{r.over}</Badge>}</td>
                <td className="text-right">{r.vacant ? <Badge tone="blue">{r.vacant}</Badge> : '—'}</td>
                <td className="text-right">{r.acting || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={!!row} onClose={() => setRow(null)} title="Authorised posts" footer={<><Button variant="secondary" onClick={() => setRow(null)}>Cancel</Button><Button disabled={save.isPending || !row?.designation} onClick={() => save.mutate()}>Save</Button></>}>
        {row && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBox error={save.error} />
            <Field label="Department"><Select value={row.departmentId} onChange={(e) => setRow({ ...row, departmentId: e.target.value })}>{departments?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="Job group"><Select value={row.jobGroupId} onChange={(e) => setRow({ ...row, jobGroupId: e.target.value })}>{groups?.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}</option>)}</Select></Field>
            <Field label="Designation"><Input value={row.designation} onChange={(e) => setRow({ ...row, designation: e.target.value })} /></Field>
            <Field label="Authorised" hint="0 removes the posts"><Input inputMode="numeric" value={row.authorised} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setRow({ ...row, authorised: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Changes() {
  const can = useCan();
  const qc = useQueryClient();
  const { data: pending, isLoading } = useQuery({ queryKey: ['hr-career-pending'], queryFn: () => api.get<CareerEvent[]>('/career-events') });
  const { data: people } = useEmployeeOptions();
  const { data: departments } = useDepartments();
  const { data: groups } = useGroups();
  const [f, setF] = useState<null | { employeeId: string; kind: (typeof KINDS)[number]; effectiveDate: string; endDate: string; departmentId: string; jobGroupId: string; notch: string; jobTitle: string; station: string; basicSalary: string; actingAllowance: string; secondedTo: string; reason: string }>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const refresh = () => ['hr-career-pending', 'hr-establishment'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const request = useMutation({
    mutationFn: () => {
      const x = f!;
      return api.post('/career-events', {
        employeeId: x.employeeId,
        kind: x.kind,
        effectiveDate: x.effectiveDate,
        endDate: x.endDate || null,
        ...(x.departmentId && { departmentId: x.departmentId }),
        ...(x.jobGroupId && { jobGroupId: x.jobGroupId }),
        ...(x.notch && { notch: Number(x.notch) }),
        ...(x.jobTitle && { jobTitle: x.jobTitle }),
        ...(x.station && { station: x.station }),
        ...(x.basicSalary && { basicSalary: x.basicSalary }),
        ...(x.actingAllowance && { actingAllowance: x.actingAllowance }),
        ...(x.secondedTo && { secondedTo: x.secondedTo }),
        reason: x.reason,
      });
    },
    onSuccess: () => (setF(null), refresh()),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) => api.post(`/career-events/${v.id}/decide`, { approve: v.approve, note: v.note }),
    onSuccess: () => (setRejecting(null), refresh()),
  });
  const show = (p: Posting) => [departmentName(departments, p.departmentId), groups?.find((g) => g.id === p.jobGroupId)?.code, p.notch && `notch ${p.notch}`, p.jobTitle, p.station, p.basicSalary && fmtMoney(p.basicSalary)].filter(Boolean).join(' · ');
  return (
    <Card title="Awaiting approval" actions={can('hr.employee.manage') && <Button onClick={() => setF({ employeeId: '', kind: 'PROMOTION', effectiveDate: today(), endDate: '', departmentId: '', jobGroupId: '', notch: '', jobTitle: '', station: '', basicSalary: '', actingAllowance: '', secondedTo: '', reason: '' })}>New career change</Button>}>
      <ErrorBox error={decide.error} />
      {isLoading ? (
        <Loading />
      ) : !pending?.length ? (
        <Empty>Nothing awaiting approval.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {pending.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div>
                <p className="font-medium"><Link className="text-brand-700 hover:underline" href={`/hr/employees/${e.employee.id}`}>{e.employee.employeeNo} · {e.employee.name}</Link> <Badge>{label(e.kind)}</Badge> from {fmtDate(e.effectiveDate)}{e.endDate && ` to ${fmtDate(e.endDate)}`}</p>
                <p className="text-muted">{show(e.from)} → <span className="text-ink">{show(e.to)}</span>{e.actingAllowance && ` · acting allowance ${fmtMoney(e.actingAllowance)}`}</p>
                <p className="text-xs text-muted">{e.reason}</p>
              </div>
              {can('hr.career.approve') && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setRejecting({ id: e.id, note: '' })}>Reject</Button>
                  <Button disabled={decide.isPending} onClick={() => decide.mutate({ id: e.id, approve: true })}>Approve</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject the change" footer={<><Button variant="secondary" onClick={() => setRejecting(null)}>Back</Button><Button disabled={!rejecting?.note.trim()} onClick={() => decide.mutate({ id: rejecting!.id, approve: false, note: rejecting!.note })}>Reject</Button></>}>
        <Field label="Reason"><Textarea rows={3} value={rejecting?.note ?? ''} onChange={(e) => setRejecting({ ...rejecting!, note: e.target.value })} /></Field>
      </Modal>
      <Modal wide open={!!f} onClose={() => setF(null)} title="Career change" footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button disabled={request.isPending || !f?.employeeId || !f?.reason.trim()} onClick={() => request.mutate()}>Submit for approval</Button></>}>
        {f && (
          <div className="space-y-3">
            <ErrorBox error={request.error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Employee"><Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select…</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}</Select></Field>
              <Field label="Change"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as (typeof KINDS)[number] })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <Field label="Effective"><Input type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>
              {['ACTING', 'SECONDMENT'].includes(f.kind) && <Field label="Ends"><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>}
              {['TRANSFER', 'PROMOTION', 'DEMOTION', 'REDESIGNATION'].includes(f.kind) && (
                <Field label="Department"><Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">Unchanged</option>{departments?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
              )}
              {['PROMOTION', 'DEMOTION', 'REDESIGNATION'].includes(f.kind) && (
                <>
                  <Field label="Job group"><Select value={f.jobGroupId} onChange={(e) => setF({ ...f, jobGroupId: e.target.value })}><option value="">Unchanged</option>{groups?.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}</option>)}</Select></Field>
                  <Field label="Notch" hint="Blank starts at notch 1"><Input inputMode="numeric" value={f.notch} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setF({ ...f, notch: e.target.value })} /></Field>
                </>
              )}
              <Field label={f.kind === 'ACTING' ? 'Acting as' : 'Job title'}><Input value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></Field>
              {f.kind === 'TRANSFER' && <Field label="Duty station"><Input value={f.station} onChange={(e) => setF({ ...f, station: e.target.value })} /></Field>}
              {f.kind === 'SALARY_CHANGE' && <Field label="New basic salary"><Input inputMode="decimal" value={f.basicSalary} onChange={(e) => setF({ ...f, basicSalary: e.target.value })} /></Field>}
              {f.kind === 'ACTING' && <Field label="Acting allowance (monthly)"><Input inputMode="decimal" value={f.actingAllowance} onChange={(e) => setF({ ...f, actingAllowance: e.target.value })} /></Field>}
              {f.kind === 'SECONDMENT' && <Field label="Seconded to"><Input value={f.secondedTo} onChange={(e) => setF({ ...f, secondedTo: e.target.value })} /></Field>}
            </div>
            <Field label="Reason"><Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Increments() {
  const can = useCan();
  const qc = useQueryClient();
  const [asOf, setAsOf] = useState(today());
  const { data, isLoading } = useQuery({ queryKey: ['hr-increments', asOf], queryFn: () => api.get<Due[]>('/increments/due', { asOf }) });
  const [picked, setPicked] = useState<string[]>([]);
  const request = useMutation({
    mutationFn: () => api.post<{ requested: number }>('/increments', { employeeIds: picked, effectiveDate: asOf }),
    onSuccess: () => (setPicked([]), ['hr-increments', 'hr-career-pending'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
  return (
    <Card title="Annual increments due" actions={<div className="flex items-end gap-2"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />{can('hr.salary.manage') && <Button disabled={!picked.length || request.isPending} onClick={() => request.mutate()}>Request {picked.length || ''} increment{picked.length === 1 ? '' : 's'}</Button>}</div>}>
      <ErrorBox error={request.error} />
      {request.data && <p className="mb-2 text-sm text-muted">{request.data.requested} sent for approval under Career changes.</p>}
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No increments due by this date.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th /><th className="py-2">Employee</th><th>Job group</th><th>Notch</th><th>Due</th><th className="text-right">Now</th><th className="text-right">After</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.employeeId} className="border-t border-line">
                <td><input type="checkbox" disabled={d.pending} checked={picked.includes(d.employeeId)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.employeeId] : picked.filter((x) => x !== d.employeeId))} aria-label={`Select ${d.name}`} /></td>
                <td className="py-2">{d.employeeNo} · {d.name}{d.pending && <Badge tone="amber">Change pending</Badge>}</td>
                <td>{d.jobGroup}</td>
                <td>{d.notch} → {d.nextNotch}</td>
                <td>{fmtDate(d.dueDate)}</td>
                <td className="text-right">{d.currentPay ? fmtMoney(d.currentPay) : '—'}</td>
                <td className="text-right">{d.newPay ? fmtMoney(d.newPay) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Contracts() {
  const [days, setDays] = useState('60');
  const { data, isLoading } = useQuery({ queryKey: ['hr-contracts-ending', days], queryFn: () => api.get<Ending[]>('/contracts/ending', { days: days || '0' }) });
  return (
    <Card title="Contracts ending" actions={<Field label="Within days"><Input className="w-24" value={days} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDays(e.target.value)} /></Field>}>
      <p className="mb-2 text-sm text-muted">Pay stops automatically once a contract ends; renew the contract or record the exit.</p>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No contracts end in this window.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.map((e) => (
            <li key={e.employeeId} className="flex justify-between py-2">
              <Link className="text-brand-700 hover:underline" href={`/hr/employees/${e.employeeId}`}>{e.employeeNo} · {e.name}</Link>
              <span>{e.jobTitle} · {fmtDate(e.contractEndDate)} {e.ended && <Badge tone="red">Ended</Badge>}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Groups({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useGroups();
  const [f, setF] = useState<null | { id?: string; code: string; name: string; rank: string; notches: string; allowances: { code: string; name: string; amount: string; taxable: boolean }[] }>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { code: f!.code, name: f!.name, rank: Number(f!.rank || 0), notches: f!.notches.split(/[\s,]+/).filter(Boolean), allowances: f!.allowances.filter((a) => a.code && a.amount), active: true };
      return f!.id ? api.patch(`/job-groups/${f!.id}`, body) : api.post('/job-groups', body);
    },
    onSuccess: () => (setF(null), qc.invalidateQueries({ queryKey: ['hr-job-groups'] })),
  });
  return (
    <Card title="Job groups and salary scales" actions={canEdit && <Button onClick={() => setF({ code: '', name: '', rank: '', notches: '', allowances: [] })}>New job group</Button>}>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No job groups yet.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Code</th><th>Name</th><th>Rank</th><th>Scale (notches)</th><th>Allowances</th><th /></tr></thead>
          <tbody>
            {data.map((g) => (
              <tr key={g.id} className="border-t border-line">
                <td className="py-2 font-mono">{g.code}</td>
                <td>{g.name}</td>
                <td>{g.rank}</td>
                <td className="text-xs">{g.notches.map((n) => fmtMoney(n)).join(' · ') || '—'}</td>
                <td className="text-xs">{g.allowances.map((a) => `${a.name} ${fmtMoney(a.amount)}`).join(', ') || '—'}</td>
                <td>{canEdit && <Button variant="secondary" onClick={() => setF({ id: g.id, code: g.code, name: g.name, rank: String(g.rank), notches: g.notches.join(', '), allowances: g.allowances })}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal wide open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit job group' : 'New job group'} footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button disabled={save.isPending || !f?.code || !f?.name} onClick={() => save.mutate()}>Save</Button></>}>
        {f && (
          <div className="space-y-3">
            <ErrorBox error={save.error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Rank" hint="Higher is more senior"><Input inputMode="numeric" value={f.rank} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setF({ ...f, rank: e.target.value })} /></Field>
            </div>
            <Field label="Salary scale" hint="Monthly basic at each notch, lowest first, separated by commas"><Input value={f.notches} onChange={(e) => setF({ ...f, notches: e.target.value })} /></Field>
            <p className="text-xs font-semibold uppercase text-muted">Allowances with this grade</p>
            {f.allowances.map((a, i) => {
              const set = (p: Partial<typeof a>) => setF({ ...f, allowances: f.allowances.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_8rem_6rem]">
                  <Input placeholder="Code" value={a.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
                  <Input placeholder="Name" value={a.name} onChange={(e) => set({ name: e.target.value })} />
                  <Input placeholder="Amount" value={a.amount} onChange={(e) => set({ amount: e.target.value })} />
                  <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={a.taxable} onChange={(e) => set({ taxable: e.target.checked })} />Taxable</label>
                </div>
              );
            })}
            <Button variant="secondary" onClick={() => setF({ ...f, allowances: [...f.allowances, { code: '', name: '', amount: '', taxable: true }] })}>Add allowance</Button>
          </div>
        )}
      </Modal>
    </Card>
  );
}
