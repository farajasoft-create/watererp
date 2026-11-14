'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Select } from '@/components/ui';
import { label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from './api';
import { useDepartments, useEmployeeOptions } from './hooks';
import { Employee } from './types';

const TYPES = ['PERMANENT', 'CONTRACT', 'CASUAL', 'INTERN'];
const date = (v?: string | null) => (v ? v.slice(0, 10) : '');
const phone = (v?: string) => (v?.startsWith('254') ? `0${v.slice(3)}` : (v ?? ''));

function initial(e?: Employee) {
  return {
    employeeNo: e?.employeeNo ?? '',
    firstName: e?.firstName ?? '',
    lastName: e?.lastName ?? '',
    otherNames: e?.otherNames ?? '',
    gender: e?.gender ?? '',
    dateOfBirth: date(e?.dateOfBirth),
    nationalId: e?.nationalId ?? '',
    kraPin: e?.kraPin ?? '',
    nssfNo: e?.nssfNo ?? '',
    shaNo: e?.shaNo ?? '',
    phone: phone(e?.phone),
    email: e?.email ?? '',
    address: e?.address ?? '',
    departmentId: e?.departmentId ?? '',
    jobTitle: e?.jobTitle ?? '',
    employmentType: e?.employmentType ?? 'PERMANENT',
    hireDate: date(e?.hireDate),
    probationEndDate: date(e?.probationEndDate),
    contractEndDate: date(e?.contractEndDate),
    managerId: e?.managerId ?? '',
    nextOfKin: { name: e?.nextOfKin?.name ?? '', phone: e?.nextOfKin?.phone ?? '', relationship: e?.nextOfKin?.relationship ?? '' },
    station: e?.station ?? '',
    payGroup: e?.payGroup ?? 'STAFF',
    qualifications: (e?.qualifications ?? []).map((q) => ({ level: q.level, title: q.title, institution: q.institution ?? '', year: q.year ? String(q.year) : '' })),
    dependants: (e?.dependants ?? []).map((d) => ({ name: d.name, relationship: d.relationship, dateOfBirth: date(d.dateOfBirth) })),
  };
}

type Form = ReturnType<typeof initial>;

/** Adding an employee (with their pay, for those allowed) or editing their details. */
export function EmployeeForm({ employee, onClose, onSaved }: { employee?: Employee; onClose: () => void; onSaved?: (e: Employee) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const { data: departments } = useDepartments();
  const { data: people } = useEmployeeOptions();
  const [f, setF] = useState<Form>(() => initial(employee));
  const [pay, setPay] = useState({ payType: 'MONTHLY', basicSalary: '', rate: '', payMethod: 'BANK', bankName: '', branch: '', accountNo: '', mpesaPhone: '', jobGroupId: '', notch: '' });
  const groups = useQuery({ queryKey: ['hr-job-groups'], queryFn: () => api.get<{ id: string; code: string; name: string; notches: string[] }[]>('/job-groups'), enabled: !employee && can('hr.salary.manage') });
  const group = groups.data?.find((g) => g.id === pay.jobGroupId);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const withPay = !employee && can('hr.salary.manage');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        gender: f.gender || null,
        dateOfBirth: f.dateOfBirth || null,
        departmentId: f.departmentId || null,
        managerId: f.managerId || null,
        probationEndDate: f.probationEndDate || null,
        contractEndDate: f.contractEndDate || null,
        qualifications: f.qualifications.filter((q) => q.level && q.title).map((q) => ({ ...q, year: q.year ? Number(q.year) : null })),
        dependants: f.dependants.filter((d) => d.name && d.relationship).map((d) => ({ ...d, dateOfBirth: d.dateOfBirth || null })),
      };
      if (employee) return api.patch<Employee>(`/employees/${employee.id}`, body);
      const monthly = pay.payType === 'MONTHLY';
      const scaled = Boolean(group?.notches.length && pay.notch);
      const payBody =
        withPay && (scaled || (monthly ? pay.basicSalary : pay.rate))
          ? { pay: { payType: pay.payType, basicSalary: monthly ? pay.basicSalary || '0' : '0', rate: monthly ? undefined : pay.rate, payMethod: pay.payMethod, bank: { name: pay.bankName, branch: pay.branch, accountNo: pay.accountNo }, mpesaPhone: pay.mpesaPhone, ...(pay.jobGroupId && { jobGroupId: pay.jobGroupId, notch: pay.notch ? Number(pay.notch) : null }) } }
          : {};
      return api.post<Employee>('/employees', { ...body, ...payBody });
    },
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: ['hr-employees'] });
      qc.invalidateQueries({ queryKey: ['hr-employee'] });
      qc.invalidateQueries({ queryKey: ['hr-employee-options'] });
      onSaved?.(e);
      onClose();
    },
  });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={employee ? `Edit ${employee.employeeNo}` : 'New employee'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.firstName || !f.lastName || !f.hireDate}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="First name"><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
        <Field label="Other names"><Input value={f.otherNames} onChange={(e) => set('otherNames', e.target.value)} /></Field>
        <Field label="Last name"><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
        <Field label="Gender">
          <Select value={f.gender} onChange={(e) => set('gender', e.target.value as Form['gender'])}>
            <option value="">—</option>
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
          </Select>
        </Field>
        <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} /></Field>
        <Field label="ID number"><Input value={f.nationalId} onChange={(e) => set('nationalId', e.target.value)} /></Field>
        <Field label="KRA PIN"><Input value={f.kraPin} onChange={(e) => set('kraPin', e.target.value.toUpperCase())} placeholder="A012345678Z" /></Field>
        <Field label="NSSF number"><Input value={f.nssfNo} onChange={(e) => set('nssfNo', e.target.value)} /></Field>
        <Field label="SHA number"><Input value={f.shaNo} onChange={(e) => set('shaNo', e.target.value)} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="0712345678" /></Field>
        <Field label="Email" hint="Their sign-in for self-service"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Address"><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
        <Field label="Employee number" hint={employee ? undefined : 'Leave blank to number automatically'}><Input value={f.employeeNo} onChange={(e) => set('employeeNo', e.target.value)} /></Field>
        <Field label="Department">
          <Select value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">—</option>
            {departments?.filter((d) => d.active || d.id === f.departmentId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Job title"><Input value={f.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} /></Field>
        <Field label="Employment type">
          <Select value={f.employmentType} onChange={(e) => set('employmentType', e.target.value as Form['employmentType'])}>
            {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </Select>
        </Field>
        <Field label="Hire date"><Input type="date" value={f.hireDate} onChange={(e) => set('hireDate', e.target.value)} /></Field>
        <Field label="Reports to">
          <Select value={f.managerId} onChange={(e) => set('managerId', e.target.value)}>
            <option value="">—</option>
            {people?.filter((p) => p.id !== employee?.id).map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Probation ends"><Input type="date" value={f.probationEndDate} onChange={(e) => set('probationEndDate', e.target.value)} /></Field>
        {f.employmentType !== 'PERMANENT' && <Field label="Contract ends"><Input type="date" value={f.contractEndDate} onChange={(e) => set('contractEndDate', e.target.value)} /></Field>}
      </div>
      <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
        <Field label="Next of kin"><Input value={f.nextOfKin.name} onChange={(e) => set('nextOfKin', { ...f.nextOfKin, name: e.target.value })} /></Field>
        <Field label="Relationship"><Input value={f.nextOfKin.relationship} onChange={(e) => set('nextOfKin', { ...f.nextOfKin, relationship: e.target.value })} /></Field>
        <Field label="Their phone"><Input value={f.nextOfKin.phone} onChange={(e) => set('nextOfKin', { ...f.nextOfKin, phone: e.target.value })} /></Field>
        <Field label="Duty station / region"><Input value={f.station} onChange={(e) => set('station', e.target.value)} /></Field>
        <Field label="Payroll" hint="Board members and seconded staff are paid on their own payroll">
          <Select value={f.payGroup} onChange={(e) => set('payGroup', e.target.value as Form['payGroup'])}>
            <option value="STAFF">Monthly staff payroll</option>
            <option value="BOARD">Board payroll</option>
            <option value="SECONDED">Seconded staff payroll</option>
          </Select>
        </Field>
      </div>
      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-xs font-semibold uppercase text-muted">Qualifications</p>
        {f.qualifications.map((q, i) => {
          const upd = (p: Partial<typeof q>) => set('qualifications', f.qualifications.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_5rem_2rem]">
              <Input placeholder="Level" value={q.level} onChange={(e) => upd({ level: e.target.value })} />
              <Input placeholder="Title" value={q.title} onChange={(e) => upd({ title: e.target.value })} />
              <Input placeholder="Institution" value={q.institution} onChange={(e) => upd({ institution: e.target.value })} />
              <Input placeholder="Year" value={q.year} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && upd({ year: e.target.value })} />
              <Button variant="secondary" onClick={() => set('qualifications', f.qualifications.filter((_, j) => j !== i))} aria-label="Remove">×</Button>
            </div>
          );
        })}
        <Button variant="secondary" onClick={() => set('qualifications', [...f.qualifications, { level: '', title: '', institution: '', year: '' }])}>Add qualification</Button>
        <p className="pt-2 text-xs font-semibold uppercase text-muted">Dependants</p>
        {f.dependants.map((d, i) => {
          const upd = (p: Partial<typeof d>) => set('dependants', f.dependants.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_10rem_2rem]">
              <Input placeholder="Name" value={d.name} onChange={(e) => upd({ name: e.target.value })} />
              <Input placeholder="Relationship" value={d.relationship} onChange={(e) => upd({ relationship: e.target.value })} />
              <Input type="date" value={d.dateOfBirth} onChange={(e) => upd({ dateOfBirth: e.target.value })} aria-label="Date of birth" />
              <Button variant="secondary" onClick={() => set('dependants', f.dependants.filter((_, j) => j !== i))} aria-label="Remove">×</Button>
            </div>
          );
        })}
        <Button variant="secondary" onClick={() => set('dependants', [...f.dependants, { name: '', relationship: '', dateOfBirth: '' }])}>Add dependant</Button>
      </div>
      {withPay && (
        <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
          <Field label="Paid">
            <Select value={pay.payType} onChange={(e) => setPay({ ...pay, payType: e.target.value })}>
              <option value="MONTHLY">A monthly salary</option>
              <option value="DAILY">By the day (casual)</option>
              <option value="HOURLY">By the hour</option>
            </Select>
          </Field>
          {pay.payType === 'MONTHLY' && !!groups.data?.length && (
            <>
              <Field label="Job group"><Select value={pay.jobGroupId} onChange={(e) => setPay({ ...pay, jobGroupId: e.target.value, notch: '' })}><option value="">None</option>{groups.data.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}</option>)}</Select></Field>
              {!!group?.notches.length && (
                <Field label="Notch"><Select value={pay.notch} onChange={(e) => setPay({ ...pay, notch: e.target.value })}><option value="">Select…</option>{group.notches.map((n, i) => <option key={i} value={i + 1}>{i + 1} · KES {n}</option>)}</Select></Field>
              )}
            </>
          )}
          {pay.payType === 'MONTHLY' && group?.notches.length ? null : pay.payType === 'MONTHLY' ? (
            <Field label="Basic salary (KES a month)"><Input inputMode="decimal" value={pay.basicSalary} onChange={(e) => setPay({ ...pay, basicSalary: e.target.value })} /></Field>
          ) : (
            <Field label={`Rate (KES a ${pay.payType === 'DAILY' ? 'day' : 'hour'})`}><Input inputMode="decimal" value={pay.rate} onChange={(e) => setPay({ ...pay, rate: e.target.value })} /></Field>
          )}
          <Field label="Paid by">
            <Select value={pay.payMethod} onChange={(e) => setPay({ ...pay, payMethod: e.target.value })}>
              <option value="BANK">Bank</option>
              <option value="MPESA">M-Pesa</option>
              <option value="CASH">Cash</option>
            </Select>
          </Field>
          {pay.payMethod === 'BANK' && (
            <>
              <Field label="Bank"><Input value={pay.bankName} onChange={(e) => setPay({ ...pay, bankName: e.target.value })} /></Field>
              <Field label="Branch"><Input value={pay.branch} onChange={(e) => setPay({ ...pay, branch: e.target.value })} /></Field>
              <Field label="Account number"><Input value={pay.accountNo} onChange={(e) => setPay({ ...pay, accountNo: e.target.value })} /></Field>
            </>
          )}
          {pay.payMethod === 'MPESA' && <Field label="M-Pesa number"><Input value={pay.mpesaPhone} onChange={(e) => setPay({ ...pay, mpesaPhone: e.target.value })} placeholder="0712345678" /></Field>}
        </div>
      )}
    </Modal>
  );
}
