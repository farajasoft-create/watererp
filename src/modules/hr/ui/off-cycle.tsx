'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, Select } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';
import { api } from './api';
import { useDepartments } from './hooks';
import { EmployeeOption, FinalDues, PayEntry } from './types';

function useRefresh(runId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['hr-payroll', runId] });
    qc.invalidateQueries({ queryKey: ['hr-payrolls'] });
  };
}

function useStaff() {
  return useQuery({ queryKey: ['hr-employee-options', 'leavers'], queryFn: () => api.get<EmployeeOption[]>('/employees/options', { leavers: true }), staleTime: 30_000 });
}

const who = (p: EmployeeOption) => `${p.employeeNo} · ${p.name}${p.status === 'TERMINATED' ? ' (left)' : ''}`;

/** One payment, or a recovery, for one employee. */
function AddOne({ runId, onClose }: { runId: string; onClose: () => void }) {
  const refresh = useRefresh(runId);
  const { data: staff } = useStaff();
  const [f, setF] = useState({ employeeId: '', kind: 'EARNING', name: '', amount: '', taxable: true });
  const save = useMutation({
    mutationFn: () => api.post(`/payroll/${runId}/entries`, { rows: [{ ...f, taxable: f.kind === 'EARNING' ? f.taxable : true }] }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Add a payment" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.employeeId || !f.name || !(Number(f.amount) > 0)}>Add</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee" className="sm:col-span-2">
          <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
            <option value="">Select…</option>
            {staff?.map((p) => <option key={p.id} value={p.id}>{who(p)}</option>)}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="EARNING">Payment</option>
            <option value="DEDUCTION">Deduction</option>
          </Select>
        </Field>
        <Field label="Amount (KES)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Description" hint="As it reads on the payslip" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === 'EARNING' ? 'Performance bonus' : 'Salary advance'} /></Field>
      </div>
      {f.kind === 'EARNING' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!f.taxable} onChange={(e) => setF({ ...f, taxable: !e.target.checked })} /> A reimbursement of costs, not pay (no PAYE or statutory deductions)
        </label>
      )}
    </Modal>
  );
}

/** The same payment to everyone, or one department: a bonus, an across-the-board arrears. */
function AddMany({ runId, onClose }: { runId: string; onClose: () => void }) {
  const refresh = useRefresh(runId);
  const { data: departments } = useDepartments();
  const [f, setF] = useState({ departmentId: '', name: '', how: 'percent', value: '' });
  const save = useMutation({
    mutationFn: () => api.post(`/payroll/${runId}/entries/many`, { departmentId: f.departmentId || null, name: f.name, ...(f.how === 'percent' ? { percentOfBasic: Number(f.value) } : { amount: f.value }) }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Same payment to many staff" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.name || !(Number(f.value) > 0)}>Add</Button></>}>
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">Everyone active is paid it. Staff with no basic salary (daily and hourly) are left out of a percentage; add them one at a time.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who">
          <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
            <option value="">Everyone</option>
            {departments?.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Description"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="December bonus" /></Field>
        <Field label="Worked as">
          <Select value={f.how} onChange={(e) => setF({ ...f, how: e.target.value })}>
            <option value="percent">A percentage of basic salary</option>
            <option value="amount">The same amount each</option>
          </Select>
        </Field>
        <Field label={f.how === 'percent' ? 'Percent of basic' : 'Amount each (KES)'}><Input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder={f.how === 'percent' ? '100 = a 13th month' : ''} /></Field>
      </div>
    </Modal>
  );
}

/** What is owed to someone leaving, to tick and adjust before it goes on the payroll. */
function FinalDuesForm({ runId, onClose }: { runId: string; onClose: () => void }) {
  const refresh = useRefresh(runId);
  const { data: staff } = useStaff();
  const [employeeId, setEmployeeId] = useState('');
  const dues = useQuery({ queryKey: ['hr-final-dues', employeeId], queryFn: () => api.get<FinalDues>(`/final-dues/${employeeId}`), enabled: Boolean(employeeId) });
  const [picked, setPicked] = useState<Record<number, { on: boolean; amount: string }>>({});
  const lines = dues.data?.lines ?? [];
  const row = (i: number) => picked[i] ?? { on: lines[i].suggested, amount: lines[i].amount };
  const save = useMutation({
    mutationFn: () =>
      api.post(`/payroll/${runId}/entries`, {
        rows: lines
          .map((l, i) => ({ l, r: row(i) }))
          .filter(({ r }) => r.on && Number(r.amount) > 0)
          .map(({ l, r }) => ({ employeeId: l.employeeId, kind: l.kind, code: l.code, name: l.name, amount: r.amount, taxable: l.taxable, payItemId: l.payItemId, leaveTypeId: l.leaveTypeId, leaveDays: l.leaveDays, leaveYear: l.leaveYear })),
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const chosen = lines.filter((_, i) => row(i).on);
  const leavers = staff?.filter((p) => p.status === 'TERMINATED') ?? [];
  const others = staff?.filter((p) => p.status !== 'TERMINATED') ?? [];
  const e = dues.data?.employee;

  return (
    <Modal open wide onClose={onClose} title="Final dues" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !chosen.length}>Add to the payroll</Button></>}>
      <ErrorBox error={save.error || dues.error} />
      <Field label="Employee" hint="Record that they left on their employee page first, so the month's payroll pays them only up to their last day">
        <Select
          value={employeeId}
          onChange={(ev) => {
            setEmployeeId(ev.target.value);
            setPicked({});
          }}
        >
          <option value="">Select…</option>
          {leavers.length > 0 && <optgroup label="Left">{leavers.map((p) => <option key={p.id} value={p.id}>{who(p)}</option>)}</optgroup>}
          <optgroup label="Still employed">{others.map((p) => <option key={p.id} value={p.id}>{who(p)}</option>)}</optgroup>
        </Select>
      </Field>
      {employeeId && dues.isLoading && <Loading />}
      {e && (
        <>
          <p className="text-sm">
            Joined {fmtDate(e.hireDate)}
            {e.terminationDate ? <>, left {fmtDate(e.terminationDate)}{e.terminationReason && <> ({label(e.terminationReason).toLowerCase()})</>}</> : ', still employed'}: {dues.data!.yearsOfService} completed year{dues.data!.yearsOfService === 1 ? '' : 's'}. A day&apos;s pay is KES {fmtMoney(dues.data!.dayRate)} ({dues.data!.dayRateBasis}).
          </p>
          {!lines.length ? (
            <Empty>Nothing owed beyond the month&apos;s salary: no leave left, no loans.</Empty>
          ) : (
            <table className="table-base">
              <thead>
                <tr><th /><th>Item</th><th className="num">Amount (KES)</th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.code}-${i}`}>
                    <td><input type="checkbox" checked={row(i).on} onChange={(ev) => setPicked({ ...picked, [i]: { ...row(i), on: ev.target.checked } })} aria-label={l.name} /></td>
                    <td>
                      {l.name} {l.kind === 'DEDUCTION' && <Badge tone="amber">deducted</Badge>}
                      {l.note && <div className="text-xs text-muted">{l.note}</div>}
                    </td>
                    <td className="num">
                      <Input inputMode="decimal" value={row(i).amount} onChange={(ev) => setPicked({ ...picked, [i]: { ...row(i), amount: ev.target.value } })} className="ml-auto max-w-36 text-right" disabled={!row(i).on} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Notice>Leave paid out comes off their balance when the payroll is approved, and recovered loans are closed. All of it is taxed as pay, worked together with anything else paid to them this month.</Notice>
        </>
      )}
    </Modal>
  );
}

/** The payments on a draft off-cycle payroll. */
export function Payments({ runId, entries, editable }: { runId: string; entries: PayEntry[]; editable: boolean }) {
  const refresh = useRefresh(runId);
  const [modal, setModal] = useState<'one' | 'many' | 'dues' | null>(null);
  const remove = useMutation({ mutationFn: (entryId: string) => api.delete(`/payroll/${runId}/entries/${entryId}`), onSuccess: refresh });
  return (
    <Card
      padded={false}
      title="Payments"
      className="mb-5"
      actions={
        editable && (
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal('dues')}>Final dues</Button>
            <Button variant="secondary" onClick={() => setModal('many')}>Same payment to many</Button>
            <Button onClick={() => setModal('one')}>Add a payment</Button>
          </span>
        )
      }
    >
      <div className="px-4 pt-3"><ErrorBox error={remove.error} /></div>
      {!entries.length ? (
        <Empty>Nothing on this payroll yet. Add a bonus, arrears or someone&apos;s final dues.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr><th>Employee</th><th>Name</th><th>Payment</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {entries.map((x) => (
                <tr key={x.id}>
                  <td>{x.employeeNo}</td>
                  <td>{x.employeeName}</td>
                  <td>
                    {x.name} {x.kind === 'DEDUCTION' && <Badge tone="amber">deducted</Badge>} {!x.taxable && <Badge tone="gray">not taxed</Badge>}
                  </td>
                  <td className="num">{x.kind === 'DEDUCTION' ? `−${fmtMoney(x.amount)}` : fmtMoney(x.amount)}</td>
                  <td className="text-right">{editable && <Button variant="secondary" onClick={() => remove.mutate(x.id)} disabled={remove.isPending}>Remove</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal === 'one' && <AddOne runId={runId} onClose={() => setModal(null)} />}
      {modal === 'many' && <AddMany runId={runId} onClose={() => setModal(null)} />}
      {modal === 'dues' && <FinalDuesForm runId={runId} onClose={() => setModal(null)} />}
    </Card>
  );
}
