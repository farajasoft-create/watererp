'use client';

import { Attachments } from '@/components/attachments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Tabs } from '@/components/ui';
import { currentPeriod, fmtDate, fmtMoney, label, today } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { EmployeeForm } from '@/modules/hr/ui/employee-form';
import { PayLines } from '@/modules/hr/ui/pay-lines';
import { fullName, useLeaveTypes } from '@/modules/hr/ui/hooks';
import { Employee, LeaveBalance, LeaveRequest, Page, PayItem, PayLine, Payslip } from '@/modules/hr/ui/types';

type Detail = Employee & {
  department: { code: string; name: string } | null;
  manager: { id: string; employeeNo: string; name: string } | null;
  portalUser: { email: string; active: boolean } | null;
  payItems: PayItem[];
  payslips: Pick<Payslip, 'id' | 'period' | 'payslipNo' | 'gross' | 'paye' | 'netPay' | 'status'>[];
};

type Tab = 'details' | 'career' | 'pay' | 'leave' | 'payslips' | 'documents';

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right">{v || '—'}</span>
    </div>
  );
}

function Details({ e }: { e: Detail }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="Personal">
        <Row k="Gender" v={label(e.gender)} />
        <Row k="Date of birth" v={fmtDate(e.dateOfBirth)} />
        <Row k="ID number" v={e.nationalId} />
        <Row k="Phone" v={e.phone} />
        <Row k="Email" v={e.email} />
        <Row k="Address" v={e.address} />
        <Row k="Next of kin" v={[e.nextOfKin?.name, e.nextOfKin?.relationship, e.nextOfKin?.phone].filter(Boolean).join(', ')} />
      </Card>
      <Card title="Job">
        <Row k="Department" v={e.department?.name} />
        <Row k="Job title" v={e.jobTitle} />
        <Row k="Type" v={label(e.employmentType)} />
        <Row k="Hired" v={fmtDate(e.hireDate)} />
        <Row k="Probation ends" v={fmtDate(e.probationEndDate)} />
        {e.contractEndDate && <Row k="Contract ends" v={fmtDate(e.contractEndDate)} />}
        <Row k="Reports to" v={e.manager && <Link href={`/hr/employees/${e.manager.id}`} className="text-brand-700 hover:underline">{e.manager.name}</Link>} />
        {e.status !== 'ACTIVE' && <Row k={e.status === 'TERMINATED' ? 'Left' : 'Suspended'} v={`${fmtDate(e.terminationDate)} ${label(e.terminationReason)} ${e.terminationNote ?? ''}`} />}
      </Card>
      <Card title="Statutory numbers">
        <Row k="KRA PIN" v={e.kraPin} />
        <Row k="NSSF" v={e.nssfNo} />
        <Row k="SHA" v={e.shaNo} />
        <Row k="Self-service login" v={e.portalUser ? `${e.portalUser.email}${e.portalUser.active ? '' : ' (disabled)'}` : 'None'} />
        {e.station && <Row k="Duty station" v={e.station} />}
      </Card>
      {!!e.qualifications?.length && (
        <Card title="Qualifications">
          {e.qualifications.map((q, i) => <Row key={i} k={q.level} v={[q.title, q.institution, q.year].filter(Boolean).join(', ')} />)}
        </Card>
      )}
      {!!e.dependants?.length && (
        <Card title="Dependants">
          {e.dependants.map((d, i) => <Row key={i} k={d.relationship} v={`${d.name}${d.dateOfBirth ? ` (born ${fmtDate(d.dateOfBirth)})` : ''}`} />)}
        </Card>
      )}
    </div>
  );
}

/** A new starter's onboarding checklist. */
function Onboarding({ e }: { e: Detail }) {
  const can = useCan();
  const qc = useQueryClient();
  const tick = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api.patch(`/employees/${e.id}/onboarding/${v.id}`, { done: v.done }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-employee', e.id] }),
  });
  if (!e.onboarding?.length) return null;
  const done = e.onboarding.filter((t) => t.done).length;
  return (
    <Card title={`Onboarding · ${done} of ${e.onboarding.length} done`}>
      <ErrorBox error={tick.error} />
      <ul className="space-y-1 text-sm">
        {e.onboarding.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <input type="checkbox" checked={t.done} disabled={!can('hr.employee.manage') || tick.isPending} onChange={(x) => tick.mutate({ id: t.id, done: x.target.checked })} aria-label={t.task} />
            <span className={t.done ? 'text-muted line-through' : ''}>{t.task}</span>
            <span className="text-xs text-muted">{t.owner}{t.doneAt ? ` · ${fmtDate(t.doneAt)}` : ''}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface CareerRow { id: string; kind: string; status: string; effectiveDate: string; endDate: string | null; reason: string; decisionNote?: string; secondedTo?: string; actingAllowance: string | null; from: { jobTitle: string; station: string; notch: number | null; basicSalary: string | null }; to: { jobTitle: string; station: string; notch: number | null; basicSalary: string | null } }

/** Job and salary history: every approved, pending or rejected career change. */
function Career({ e }: { e: Detail }) {
  const { data, isLoading } = useQuery({ queryKey: ['hr-career', e.id], queryFn: () => api.get<CareerRow[]>(`/employees/${e.id}/career`) });
  const side = (p: CareerRow['from']) => [p.jobTitle, p.station, p.notch && `notch ${p.notch}`, p.basicSalary && fmtMoney(p.basicSalary)].filter(Boolean).join(' · ');
  return (
    <Card title="Job and salary history" actions={<Link className="text-sm text-brand-700 hover:underline" href="/hr/establishment">Request a change →</Link>}>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No promotions, transfers or salary changes recorded.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.map((c) => (
            <li key={c.id} className="py-2">
              <p className="font-medium">{fmtDate(c.effectiveDate)}{c.endDate && ` – ${fmtDate(c.endDate)}`} · {label(c.kind)} <Badge value={c.status} /></p>
              <p className="text-muted">{side(c.from)} → {side(c.to)}{c.actingAllowance && ` · acting allowance ${fmtMoney(c.actingAllowance)}`}{c.secondedTo && ` · seconded to ${c.secondedTo}`}</p>
              <p className="text-xs text-muted">{c.reason}{c.decisionNote ? ` · ${c.decisionNote}` : ''}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PayDetailsForm({ e, onClose }: { e: Detail; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    basicSalary: e.basicSalary ?? '',
    payType: e.payType ?? 'MONTHLY',
    rate: e.rate && Number(e.rate) ? e.rate : '',
    payMethod: e.payMethod ?? 'BANK',
    bank: { name: e.bank?.name ?? '', branch: e.bank?.branch ?? '', accountNo: e.bank?.accountNo ?? '', accountName: e.bank?.accountName ?? '' },
    mpesaPhone: e.mpesaPhone?.startsWith('254') ? `0${e.mpesaPhone.slice(3)}` : (e.mpesaPhone ?? ''),
    exempt: e.exempt ?? { paye: false, nssf: false, shif: false, ahl: false },
    gratuityRate: e.gratuityRate ? String(e.gratuityRate) : '',
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/employees/${e.id}/pay`, { ...f, basicSalary: f.payType === 'MONTHLY' ? f.basicSalary || '0' : '0', rate: f.payType === 'MONTHLY' ? undefined : f.rate || '0', gratuityRate: Number(f.gratuityRate) || 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-employee', e.id] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Pay details" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Paid">
          <Select value={f.payType} onChange={(x) => setF({ ...f, payType: x.target.value as typeof f.payType })}>
            <option value="MONTHLY">A monthly salary</option>
            <option value="DAILY">By the day (casual)</option>
            <option value="HOURLY">By the hour</option>
          </Select>
        </Field>
        {f.payType === 'MONTHLY' ? (
          <Field label="Basic salary (KES a month)"><Input inputMode="decimal" value={f.basicSalary} onChange={(x) => setF({ ...f, basicSalary: x.target.value })} /></Field>
        ) : (
          <Field label={`Rate (KES a ${f.payType === 'DAILY' ? 'day' : 'hour'})`} hint="Days or hours are entered on each payroll"><Input inputMode="decimal" value={f.rate} onChange={(x) => setF({ ...f, rate: x.target.value })} /></Field>
        )}
        <Field label="Paid by">
          <Select value={f.payMethod} onChange={(x) => setF({ ...f, payMethod: x.target.value as typeof f.payMethod })}>
            <option value="BANK">Bank</option>
            <option value="MPESA">M-Pesa</option>
            <option value="CASH">Cash</option>
          </Select>
        </Field>
        <Field label="Bank"><Input value={f.bank.name} onChange={(x) => setF({ ...f, bank: { ...f.bank, name: x.target.value } })} /></Field>
        <Field label="Branch"><Input value={f.bank.branch} onChange={(x) => setF({ ...f, bank: { ...f.bank, branch: x.target.value } })} /></Field>
        <Field label="Account number"><Input value={f.bank.accountNo} onChange={(x) => setF({ ...f, bank: { ...f.bank, accountNo: x.target.value } })} /></Field>
        <Field label="M-Pesa number"><Input value={f.mpesaPhone} onChange={(x) => setF({ ...f, mpesaPhone: x.target.value })} /></Field>
        {f.payType === 'MONTHLY' && (
          <Field label="Contract gratuity (% of basic)" hint="Accrued each month; paid with final dues">
            <Input inputMode="decimal" value={f.gratuityRate} onChange={(x) => setF({ ...f, gratuityRate: x.target.value })} placeholder="e.g. 31" />
          </Field>
        )}
      </div>
      <div className="text-sm">
        <div className="mb-1 font-medium">Exempt from</div>
        <div className="flex flex-wrap gap-4">
          {(['paye', 'nssf', 'shif', 'ahl'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={f.exempt[k]} onChange={(x) => setF({ ...f, exempt: { ...f.exempt, [k]: x.target.checked } })} /> {k === 'ahl' ? 'Housing levy' : k.toUpperCase()}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">Only with a certificate, e.g. KRA PAYE exemption for a disability.</p>
      </div>
    </Modal>
  );
}

function PayItemForm({ employeeId, item, onClose }: { employeeId: string; item?: PayItem; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    kind: item?.kind ?? 'EARNING',
    code: item?.code ?? '',
    name: item?.name ?? '',
    amount: item?.amount ?? '',
    taxable: item?.taxable ?? true,
    pension: item?.pension ?? false,
    insurance: item?.insurance ?? false,
    employerShare: item?.employerRate ? 'RATE' : item?.employerAmount ? 'AMOUNT' : 'NONE',
    employerValue: item?.employerRate ? String(item.employerRate) : (item?.employerAmount ?? ''),
    memberNo: item?.memberNo ?? '',
    balance: item?.balance ?? '',
    fromPeriod: item?.fromPeriod ?? currentPeriod(),
    toPeriod: item?.toPeriod ?? '',
    active: item?.active ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const { employerShare, employerValue, ...rest } = f;
      const share = f.pension && employerValue ? employerShare : 'NONE';
      const body = {
        ...rest,
        balance: f.balance || null,
        toPeriod: f.toPeriod || null,
        memberNo: f.pension ? f.memberNo || null : null,
        employerRate: share === 'RATE' ? Number(employerValue) : null,
        employerAmount: share === 'AMOUNT' ? employerValue : null,
      };
      return item ? api.put(`/pay-items/${item.id}`, body) : api.post(`/employees/${employeeId}/pay-items`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-employee', employeeId] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={item ? `Edit ${item.name}` : 'New pay item'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name || !f.amount}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={f.kind} onChange={(x) => setF({ ...f, kind: x.target.value as typeof f.kind })}>
            <option value="EARNING">Earning (allowance, overtime, bonus)</option>
            <option value="DEDUCTION">Deduction (loan, SACCO, union, pension)</option>
          </Select>
        </Field>
        <Field label="Code"><Input value={f.code} onChange={(x) => setF({ ...f, code: x.target.value.toUpperCase() })} placeholder="HOUSE" /></Field>
        <Field label="Name on payslip"><Input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} /></Field>
        <Field label="Amount a month (KES)"><Input inputMode="decimal" value={f.amount} onChange={(x) => setF({ ...f, amount: x.target.value })} /></Field>
        <Field label="From month"><Input type="month" value={f.fromPeriod} onChange={(x) => setF({ ...f, fromPeriod: x.target.value })} /></Field>
        <Field label="Until month" hint="Blank = every month; same as From = one-off"><Input type="month" value={f.toPeriod} onChange={(x) => setF({ ...f, toPeriod: x.target.value })} /></Field>
        {f.kind === 'DEDUCTION' && <Field label="Balance to recover" hint="For a loan: stops once repaid"><Input inputMode="decimal" value={f.balance} onChange={(x) => setF({ ...f, balance: x.target.value })} /></Field>}
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {f.kind === 'EARNING' ? (
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!f.taxable} onChange={(x) => setF({ ...f, taxable: !x.target.checked })} /> Reimbursement (not pay: no tax or statutory deductions)</label>
        ) : (
          <>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.pension} onChange={(x) => setF({ ...f, pension: x.target.checked, insurance: x.target.checked ? false : f.insurance })} /> Registered pension scheme (tax relief)</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.insurance} onChange={(x) => setF({ ...f, insurance: x.target.checked, pension: x.target.checked ? false : f.pension })} /> Life, health or education insurance premium (insurance relief)</label>
          </>
        )}
        {item && <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.active} onChange={(x) => setF({ ...f, active: x.target.checked })} /> Active</label>}
      </div>
      {f.kind === 'DEDUCTION' && f.pension && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Employer adds">
            <Select value={f.employerShare} onChange={(x) => setF({ ...f, employerShare: x.target.value })}>
              <option value="NONE">Nothing</option>
              <option value="RATE">A % of basic pay</option>
              <option value="AMOUNT">A fixed amount</option>
            </Select>
          </Field>
          {f.employerShare !== 'NONE' && (
            <Field label={f.employerShare === 'RATE' ? 'Employer %' : 'Employer KES a month'}><Input inputMode="decimal" value={f.employerValue} onChange={(x) => setF({ ...f, employerValue: x.target.value })} /></Field>
          )}
          <Field label="Member number" hint="On the scheme's remittance file"><Input value={f.memberNo} onChange={(x) => setF({ ...f, memberNo: x.target.value })} maxLength={40} /></Field>
        </div>
      )}
    </Modal>
  );
}

function Pay({ e }: { e: Detail }) {
  const can = useCan();
  const [editPay, setEditPay] = useState(false);
  const [item, setItem] = useState<PayItem | 'new' | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const preview = useQuery({
    queryKey: ['hr-pay-preview', e.id, period],
    queryFn: () => api.get<{ result: { lines: PayLine[]; gross: string; totalDeductions: string; netPay: string; taxablePay: string; warnings: string[] } }>(`/employees/${e.id}/pay-preview`, { period }),
    enabled: Boolean(period),
    retry: false,
  });
  const manage = can('hr.salary.manage');
  return (
    <div className="space-y-4">
      <Card title="Pay details" actions={manage && <Button variant="secondary" onClick={() => setEditPay(true)}>Edit</Button>}>
        <div className="grid gap-x-6 md:grid-cols-3">
          {e.payType === 'DAILY' || e.payType === 'HOURLY' ? (
            <Row k="Rate" v={`KES ${fmtMoney(e.rate)} a ${e.payType === 'DAILY' ? 'day' : 'hour'}`} />
          ) : (
            <Row k="Basic salary" v={`KES ${fmtMoney(e.basicSalary)}`} />
          )}
          <Row k="Paid by" v={e.payMethod === 'BANK' ? [e.bank?.name, e.bank?.branch, e.bank?.accountNo].filter(Boolean).join(' · ') : e.payMethod === 'MPESA' ? `M-Pesa ${e.mpesaPhone ?? ''}` : 'Cash'} />
          {e.gratuityRate ? <Row k="Contract gratuity" v={`${e.gratuityRate}% of basic a month`} /> : null}
          {e.payGroup && e.payGroup !== 'STAFF' && <Row k="Payroll" v={e.payGroup === 'BOARD' ? 'Board payroll' : 'Seconded staff payroll'} />}
          <Row k="Exempt from" v={Object.entries(e.exempt ?? {}).filter(([, v]) => v).map(([k]) => (k === 'ahl' ? 'housing levy' : k.toUpperCase())).join(', ') || 'Nothing'} />
        </div>
      </Card>
      <Card padded={false} title="Recurring and one-off pay items" actions={manage && <Button variant="secondary" onClick={() => setItem('new')}>Add item</Button>}>
        {!e.payItems.length ? (
          <Empty>No allowances or deductions.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
                <th>Months</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {e.payItems.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'text-muted'}>
                  <td>{manage ? <button type="button" className="text-brand-700 hover:underline" onClick={() => setItem(i)}>{i.code}</button> : i.code}</td>
                  <td>
                    {i.name} {i.kind === 'EARNING' && !i.taxable && <Badge tone="gray">reimbursement</Badge>} {i.pension && <Badge tone="gray">pension{i.employerRate ? ` + ${i.employerRate}% employer` : i.employerAmount ? ` + ${fmtMoney(i.employerAmount)} employer` : ''}</Badge>} {i.insurance && <Badge tone="gray">insurance relief</Badge>}
                  </td>
                  <td>{label(i.kind)}</td>
                  <td className="num"><Money value={i.amount} /></td>
                  <td className="num">{i.balance === null ? '—' : <Money value={i.balance} />}</td>
                  <td>{i.toPeriod ? (i.toPeriod === i.fromPeriod ? `${i.fromPeriod} only` : `${i.fromPeriod} – ${i.toPeriod}`) : `from ${i.fromPeriod}`}</td>
                  <td><Badge value={i.active ? 'ACTIVE' : 'CLOSED'}>{i.active ? 'Active' : 'Ended'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="What this employee would be paid" actions={<Input type="month" value={period} onChange={(x) => setPeriod(x.target.value)} className="max-w-40" />}>
        <ErrorBox error={preview.error} />
        {preview.data && (
          <>
            {preview.data.result.warnings.map((w) => <Notice key={w} tone="amber">{w}</Notice>)}
            <PayLines lines={preview.data.result.lines} />
            <div className="mt-3 flex flex-wrap gap-6 text-sm">
              <span>Gross <b>KES {fmtMoney(preview.data.result.gross)}</b></span>
              <span>Taxable <b>{fmtMoney(preview.data.result.taxablePay)}</b></span>
              <span>Deductions <b>{fmtMoney(preview.data.result.totalDeductions)}</b></span>
              <span>Net pay <b>KES {fmtMoney(preview.data.result.netPay)}</b></span>
            </div>
          </>
        )}
      </Card>
      {editPay && <PayDetailsForm e={e} onClose={() => setEditPay(false)} />}
      {item && <PayItemForm employeeId={e.id} item={item === 'new' ? undefined : item} onClose={() => setItem(null)} />}
    </div>
  );
}

function Leave({ e }: { e: Detail }) {
  const can = useCan();
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const [adjusting, setAdjusting] = useState(false);
  const balances = useQuery({ queryKey: ['hr-balances', e.id, year], queryFn: () => api.get<LeaveBalance[]>(`/employees/${e.id}/leave`, { year }) });
  const requests = useQuery({ queryKey: ['hr-leave', { employeeId: e.id }], queryFn: () => api.get<Page<LeaveRequest>>('/leave', { employeeId: e.id, pageSize: 50 }) });
  const { data: types } = useLeaveTypes();
  const [adj, setAdj] = useState({ leaveTypeId: '', days: '', kind: 'OPENING', reason: '' });
  const save = useMutation({
    mutationFn: () => api.post('/leave/adjustments', { employeeId: e.id, leaveTypeId: adj.leaveTypeId, year, days: Number(adj.days), kind: adj.kind, reason: adj.reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-balances', e.id] });
      setAdjusting(false);
    },
  });
  return (
    <div className="space-y-4">
      <Card
        padded={false}
        title={`Leave balances ${year}`}
        actions={
          <div className="flex gap-2">
            <Select value={year} onChange={(x) => setYear(Number(x.target.value))} className="max-w-24">
              {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            {can('hr.leave.manage') && <Button variant="secondary" onClick={() => setAdjusting(true)}>Adjust</Button>}
          </div>
        }
      >
        <ErrorBox error={balances.error} />
        <table className="table-base">
          <thead>
            <tr>
              <th>Leave</th>
              <th className="num">Earned</th>
              <th className="num">Adjustments</th>
              <th className="num">Taken</th>
              <th className="num">Waiting</th>
              <th className="num">Available</th>
            </tr>
          </thead>
          <tbody>
            {balances.data?.map((b) => (
              <tr key={b.leaveTypeId}>
                <td>{b.name}{!b.paid && <span className="text-muted"> (unpaid)</span>}</td>
                <td className="num">{b.unlimited ? '—' : b.earned}</td>
                <td className="num">{b.adjusted || '—'}</td>
                <td className="num">{b.taken}</td>
                <td className="num">{b.pending || '—'}</td>
                <td className="num font-medium">{b.unlimited ? '—' : b.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card padded={false} title="Leave taken and applied for">
        {!requests.data?.items.length ? (
          <Empty>None.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Leave</th><th>From</th><th>To</th><th className="num">Days</th><th>Reason</th><th>Status</th></tr>
            </thead>
            <tbody>
              {requests.data.items.map((r) => (
                <tr key={r.id}><td>{r.leaveType}</td><td>{fmtDate(r.startDate)}</td><td>{fmtDate(r.endDate)}</td><td className="num">{r.days}</td><td>{r.reason}</td><td><Badge value={r.status} /></td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adjusting && (
        <Modal open onClose={() => setAdjusting(false)} title={`Adjust ${year} leave`} footer={<><Button variant="secondary" onClick={() => setAdjusting(false)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !adj.leaveTypeId || !adj.days || !adj.reason}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Leave type">
              <Select value={adj.leaveTypeId} onChange={(x) => setAdj({ ...adj, leaveTypeId: x.target.value })}>
                <option value="">Select…</option>
                {types?.filter((t) => !t.unlimited).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={adj.kind} onChange={(x) => setAdj({ ...adj, kind: x.target.value })}>
                <option value="OPENING">Opening balance (from the old system)</option>
                <option value="ADJUSTMENT">Correction</option>
                <option value="ENCASHMENT">Paid out (enter as negative)</option>
              </Select>
            </Field>
            <Field label="Days (negative to take away)"><Input inputMode="decimal" value={adj.days} onChange={(x) => setAdj({ ...adj, days: x.target.value })} /></Field>
            <Field label="Reason"><Input value={adj.reason} onChange={(x) => setAdj({ ...adj, reason: x.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Payslips({ e }: { e: Detail }) {
  const years = [...new Set(e.payslips.map((p) => p.period.slice(0, 4)))];
  return (
    <Card padded={false} title="Payslips" actions={<div className="flex gap-3 text-sm">{years.map((y) => <Link key={y} href={`/hr/p9/${e.id}?year=${y}`} className="text-brand-700 hover:underline">P9 {y}</Link>)}</div>}>
      {!e.payslips.length ? (
        <Empty>No approved payslips yet.</Empty>
      ) : (
        <table className="table-base">
          <thead>
            <tr><th>Period</th><th>Payslip</th><th className="num">Gross</th><th className="num">PAYE</th><th className="num">Net pay</th><th>Status</th></tr>
          </thead>
          <tbody>
            {e.payslips.map((p) => (
              <tr key={p.id}>
                <td>{p.period}</td>
                <td><Link href={`/hr/payslips/${p.id}`} className="text-brand-700 hover:underline">{p.payslipNo}</Link></td>
                <td className="num"><Money value={p.gross} /></td>
                <td className="num"><Money value={p.paye} /></td>
                <td className="num font-medium"><Money value={p.netPay} /></td>
                <td><Badge value={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StatusAction({ e, onClose }: { e: Detail; onClose: () => void }) {
  const qc = useQueryClient();
  const leaving = e.status === 'ACTIVE';
  const [f, setF] = useState({ action: leaving ? 'terminate' : 'reinstate', date: today(), reason: 'RESIGNATION', note: '' });
  const save = useMutation({
    mutationFn: () =>
      f.action === 'terminate'
        ? api.post(`/employees/${e.id}/terminate`, { date: f.date, reason: f.reason, note: f.note || undefined })
        : f.action === 'suspend'
          ? api.post(`/employees/${e.id}/suspend`, { note: f.note })
          : api.post(`/employees/${e.id}/reinstate`, { hireDate: f.date }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-employee', e.id] });
      qc.invalidateQueries({ queryKey: ['hr-employees'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={leaving ? 'Employee leaving or suspended' : 'Bring back'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || (f.action === 'suspend' && !f.note)}>Confirm</Button></>}>
      <ErrorBox error={save.error} />
      {leaving && (
        <Field label="What is happening">
          <Select value={f.action} onChange={(x) => setF({ ...f, action: x.target.value })}>
            <option value="terminate">Leaving the organisation</option>
            <option value="suspend">Suspended (off the payroll until reinstated)</option>
          </Select>
        </Field>
      )}
      {f.action !== 'suspend' && <Field label={f.action === 'terminate' ? 'Last day' : e.status === 'TERMINATED' ? 'New hire date' : 'Back from'}><Input type="date" value={f.date} onChange={(x) => setF({ ...f, date: x.target.value })} /></Field>}
      {f.action === 'terminate' && (
        <Field label="Reason">
          <Select value={f.reason} onChange={(x) => setF({ ...f, reason: x.target.value })}>
            {['RESIGNATION', 'END_OF_CONTRACT', 'DISMISSAL', 'REDUNDANCY', 'RETIREMENT', 'DEATH', 'OTHER'].map((r) => <option key={r} value={r}>{label(r)}</option>)}
          </Select>
        </Field>
      )}
      {f.action !== 'reinstate' && <Field label="Note"><Input value={f.note} onChange={(x) => setF({ ...f, note: x.target.value })} /></Field>}
      {f.action === 'terminate' && <p className="text-sm text-muted">They are paid to their last day in that month&apos;s payroll, and lose self-service access.</p>}
    </Modal>
  );
}

function Portal({ e, onClose }: { e: Detail; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => api.post<{ email: string; newLogin: boolean }>(`/employees/${e.id}/portal`, { password: password || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-employee', e.id] }),
  });
  return (
    <Modal open onClose={onClose} title="Self-service login" footer={save.isSuccess ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Give access</Button></>}>
      <ErrorBox error={save.error} />
      {save.data ? (
        <Notice tone="green">{save.data.newLogin ? `A login was created for ${save.data.email}. Give them the password; they can change it after signing in.` : `${save.data.email} already signs in to FarajaSoft; they now also see their payslips and leave with the same login.`}</Notice>
      ) : (
        <>
          <p className="text-sm">{fullName(e)} will sign in as <b>{e.email ?? '— add an email first'}</b> to see their payslips and P9s and apply for leave. Someone who already has a login keeps it.</p>
          <Field label="First password (only for a new login)" hint="At least 10 characters"><Input type="text" value={password} onChange={(x) => setPassword(x.target.value)} /></Field>
        </>
      )}
    </Modal>
  );
}

export default function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const [tab, setTab] = useState<Tab>('details');
  const [modal, setModal] = useState<'edit' | 'status' | 'portal' | null>(null);
  const { data: e, error, isLoading } = useQuery({ queryKey: ['hr-employee', id], queryFn: () => api.get<Detail>(`/employees/${id}`) });
  if (isLoading) return <Loading />;
  if (!e) return <ErrorBox error={error} />;
  const pay = can('hr.salary.view');
  const manage = can('hr.employee.manage');
  return (
    <>
      <PageHeader
        title={fullName(e)}
        subtitle={
          <span className="flex items-center gap-2">
            {e.employeeNo} · {e.jobTitle ?? 'No job title'} · {e.department?.name ?? 'No department'} <Badge value={e.status}>{e.status === 'TERMINATED' ? 'Left' : undefined}</Badge>
          </span>
        }
        actions={
          manage && (
            <>
              {!e.portalUser && e.status !== 'TERMINATED' && <Button variant="secondary" onClick={() => setModal('portal')}>Give self-service login</Button>}
              <Button variant="secondary" onClick={() => setModal('status')}>{e.status === 'ACTIVE' ? 'Leaving / suspend' : 'Reinstate'}</Button>
              <Button onClick={() => setModal('edit')}>Edit</Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'details' as Tab, label: 'Details' }, { id: 'career' as Tab, label: 'Career' }, ...(pay ? [{ id: 'pay' as Tab, label: 'Pay' }] : []), ...(can('hr.leave.view') ? [{ id: 'leave' as Tab, label: 'Leave' }] : []), ...(pay ? [{ id: 'payslips' as Tab, label: 'Payslips' }] : []), { id: 'documents' as Tab, label: 'Documents' }]}
      />
      {tab === 'details' && (
        <div className="space-y-4">
          <Onboarding e={e} />
          <Details e={e} />
        </div>
      )}
      {tab === 'career' && <Career e={e} />}
      {tab === 'pay' && <Pay e={e} />}
      {tab === 'leave' && <Leave e={e} />}
      {tab === 'payslips' && <Payslips e={e} />}
      {tab === 'documents' && <Attachments module="hr" entity="employee" entityId={e.id} categories={['CONTRACT', 'APPOINTMENT', 'CERTIFICATE', 'ID', 'TRANSFER', 'DISCIPLINARY', 'APPRAISAL', 'GENERAL']} title="Personnel file" />}
      {modal === 'edit' && <EmployeeForm employee={e} onClose={() => setModal(null)} />}
      {modal === 'status' && <StatusAction e={e} onClose={() => setModal(null)} />}
      {modal === 'portal' && <Portal e={e} onClose={() => setModal(null)} />}
    </>
  );
}
