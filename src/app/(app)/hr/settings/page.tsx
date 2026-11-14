'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Tabs } from '@/components/ui';
import { api as platformApi } from '@/lib/api';
import { fmtDate, fmtMoney, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useDepartments, useEmployeeOptions, useLeaveTypes } from '@/modules/hr/ui/hooks';
import { Department, LeaveType } from '@/modules/hr/ui/types';

interface HrSettings {
  employeeNoPrefix: string;
  holidays: { date: string; name: string }[];
  accounts: Record<string, string>;
  mappingLabels: Record<string, string>;
}

interface RateSet {
  id: string;
  effectiveFrom: string;
  reference?: string;
  paye: { bands: { upTo: string | null; rate: string }[]; personalRelief: string };
  nssf: { rate: string; lowerLimit: string; upperLimit: string };
  shif: { rate: string; minimum: string };
  ahl: { employeeRate: string; employerRate: string };
  nitaPerEmployee: string;
  pensionReliefCap: string;
}

type Tab = 'general' | 'rates' | 'schemes' | 'departments' | 'leave' | 'ledger';

function General({ s }: { s: HrSettings }) {
  const qc = useQueryClient();
  const [prefix, setPrefix] = useState(s.employeeNoPrefix);
  const [holidays, setHolidays] = useState(s.holidays);
  const [add, setAdd] = useState({ date: '', name: '' });
  const save = useMutation({ mutationFn: () => api.patch('/settings/general', { employeeNoPrefix: prefix, holidays }), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-settings'] }) });
  return (
    <Card title="Numbering and public holidays" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <Field label="Employee number prefix" hint={`New employees are numbered ${prefix}-0001, ${prefix}-0002…`}><Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} className="max-w-[8rem]" /></Field>
      <div className="mt-4 text-sm font-medium">Public holidays</div>
      <p className="mb-2 text-xs text-muted">Not counted as leave days or unpaid days. Add Idd-ul-Fitr and any special holidays when they are gazetted.</p>
      <div className="mb-2 flex flex-wrap gap-2">
        <Input type="date" value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} className="max-w-40" />
        <Input placeholder="Name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} className="max-w-xs" />
        <Button
          variant="secondary"
          disabled={!add.date || !add.name}
          onClick={() => {
            setHolidays([...holidays.filter((h) => h.date !== add.date), add].sort((a, b) => a.date.localeCompare(b.date)));
            setAdd({ date: '', name: '' });
          }}
        >
          Add
        </Button>
      </div>
      <div className="grid gap-x-6 sm:grid-cols-2">
        {holidays.map((h) => (
          <div key={h.date} className="flex items-center justify-between border-b border-line py-1 text-sm">
            <span>{fmtDate(h.date)} · {h.name}</span>
            <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => setHolidays(holidays.filter((x) => x.date !== h.date))}>remove</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RateForm({ set, base, onClose }: { set?: RateSet; base?: RateSet; onClose: () => void }) {
  const qc = useQueryClient();
  const from = set ?? base;
  const [f, setF] = useState({
    effectiveFrom: set ? set.effectiveFrom.slice(0, 10) : '',
    reference: set?.reference ?? '',
    bands: from?.paye.bands ?? [{ upTo: null, rate: '' }],
    personalRelief: from?.paye.personalRelief ?? '',
    nssf: from?.nssf ?? { rate: '6', lowerLimit: '', upperLimit: '' },
    shif: from?.shif ?? { rate: '2.75', minimum: '300' },
    ahl: from?.ahl ?? { employeeRate: '1.5', employerRate: '1.5' },
    nitaPerEmployee: from?.nitaPerEmployee ?? '50',
    pensionReliefCap: from?.pensionReliefCap ?? '30000',
  });
  const save = useMutation({
    mutationFn: () => (set ? api.put(`/rates/${set.id}`, f) : api.post('/rates', f)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-rates'] });
      onClose();
    },
  });
  const band = (i: number, patch: Partial<{ upTo: string | null; rate: string }>) => setF({ ...f, bands: f.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <Modal open wide onClose={onClose} title={set ? `Rates from ${fmtDate(set.effectiveFrom)}` : 'New statutory rates'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.effectiveFrom}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="In force from" hint="Payrolls use the latest set in force at the end of their month"><Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
        <Field label="Legal reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Finance Act 2026, NSSF notice…" /></Field>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium">PAYE bands (monthly taxable pay)</div>
        {f.bands.map((b, i) => (
          <div key={i} className="mb-1 flex items-center gap-2 text-sm">
            <span className="w-16 text-muted">{i === 0 ? 'First' : 'Next'}</span>
            <Input inputMode="decimal" placeholder="up to (blank = above)" value={b.upTo ?? ''} onChange={(e) => band(i, { upTo: e.target.value || null })} className="max-w-48" />
            <span>at</span>
            <Input inputMode="decimal" value={b.rate} onChange={(e) => band(i, { rate: e.target.value })} className="max-w-20" />
            <span>%</span>
            {f.bands.length > 1 && <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => setF({ ...f, bands: f.bands.filter((_, j) => j !== i) })}>remove</button>}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setF({ ...f, bands: [...f.bands, { upTo: null, rate: '' }] })}>Add band</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Personal relief (KES a month)"><Input inputMode="decimal" value={f.personalRelief} onChange={(e) => setF({ ...f, personalRelief: e.target.value })} /></Field>
        <Field label="Pension relief cap (KES a month)" hint="NSSF and registered pension together"><Input inputMode="decimal" value={f.pensionReliefCap} onChange={(e) => setF({ ...f, pensionReliefCap: e.target.value })} /></Field>
        <Field label="NITA levy per employee (KES)"><Input inputMode="decimal" value={f.nitaPerEmployee} onChange={(e) => setF({ ...f, nitaPerEmployee: e.target.value })} /></Field>
        <Field label="NSSF rate % (each side)"><Input inputMode="decimal" value={f.nssf.rate} onChange={(e) => setF({ ...f, nssf: { ...f.nssf, rate: e.target.value } })} /></Field>
        <Field label="NSSF lower earnings limit (Tier I)"><Input inputMode="decimal" value={f.nssf.lowerLimit} onChange={(e) => setF({ ...f, nssf: { ...f.nssf, lowerLimit: e.target.value } })} /></Field>
        <Field label="NSSF upper earnings limit"><Input inputMode="decimal" value={f.nssf.upperLimit} onChange={(e) => setF({ ...f, nssf: { ...f.nssf, upperLimit: e.target.value } })} /></Field>
        <Field label="SHIF rate %"><Input inputMode="decimal" value={f.shif.rate} onChange={(e) => setF({ ...f, shif: { ...f.shif, rate: e.target.value } })} /></Field>
        <Field label="SHIF minimum (KES)"><Input inputMode="decimal" value={f.shif.minimum} onChange={(e) => setF({ ...f, shif: { ...f.shif, minimum: e.target.value } })} /></Field>
        <div />
        <Field label="Housing levy % (employee)"><Input inputMode="decimal" value={f.ahl.employeeRate} onChange={(e) => setF({ ...f, ahl: { ...f.ahl, employeeRate: e.target.value } })} /></Field>
        <Field label="Housing levy % (employer)"><Input inputMode="decimal" value={f.ahl.employerRate} onChange={(e) => setF({ ...f, ahl: { ...f.ahl, employerRate: e.target.value } })} /></Field>
      </div>
    </Modal>
  );
}

function Rates() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-rates'], queryFn: () => api.get<RateSet[]>('/rates') });
  const [edit, setEdit] = useState<RateSet | 'new' | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/rates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-rates'] }) });
  const now = new Date().toISOString();
  const current = data?.find((r) => r.effectiveFrom <= now);
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">When the law changes, add a new set from the date it takes effect; earlier payrolls keep the rates they were worked with.</p>
        <Button onClick={() => setEdit('new')}>New rate set</Button>
      </div>
      <ErrorBox error={error || remove.error} />
      {isLoading && <Loading />}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.map((r) => (
          <Card
            key={r.id}
            title={<span className="flex items-center gap-2">From {fmtDate(r.effectiveFrom)} {r.id === current?.id && <Badge tone="green">in force</Badge>}{r.effectiveFrom > now && <Badge tone="blue">upcoming</Badge>}</span>}
            actions={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEdit(r)}>Edit</Button>
                <Button variant="secondary" onClick={() => remove.mutate(r.id)} disabled={remove.isPending}>Delete</Button>
              </div>
            }
          >
            <div className="text-xs text-muted">{r.reference}</div>
            <div className="mt-2 text-sm">
              PAYE:{' '}
              {r.paye.bands.map((b, i) => `${b.rate}%${b.upTo ? ` to ${fmtMoney(b.upTo)}` : ' above'}${i < r.paye.bands.length - 1 ? ', ' : ''}`)} · relief {fmtMoney(r.paye.personalRelief)}
            </div>
            <div className="text-sm">NSSF {r.nssf.rate}% each, Tier I to {fmtMoney(r.nssf.lowerLimit)}, Tier II to {fmtMoney(r.nssf.upperLimit)}</div>
            <div className="text-sm">SHIF {r.shif.rate}% (min {fmtMoney(r.shif.minimum)}) · Housing levy {r.ahl.employeeRate}% + {r.ahl.employerRate}% · NITA {fmtMoney(r.nitaPerEmployee)}</div>
          </Card>
        ))}
        {data && !data.length && <Empty>No statutory rates yet. Payroll needs at least one set.</Empty>}
      </div>
      {edit && <RateForm set={edit === 'new' ? undefined : edit} base={edit === 'new' ? current : undefined} onClose={() => setEdit(null)} />}
    </>
  );
}

const UNIT_LEVELS: Record<string, string> = { DIRECTORATE: 'Directorate', DEPARTMENT: 'Department', DIVISION: 'Division', SECTION: 'Section', SERVICE_UNIT: 'Service unit' };

function Departments() {
  const qc = useQueryClient();
  const { data } = useDepartments();
  const { data: people } = useEmployeeOptions();
  const [edit, setEdit] = useState<Department | 'new' | null>(null);
  const [f, setF] = useState({ code: '', name: '', level: 'DEPARTMENT', parentId: '', headId: '', active: true });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, parentId: f.parentId || null, headId: f.headId || null };
      return edit && edit !== 'new' ? api.put(`/departments/${edit.id}`, body) : api.post('/departments', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-departments'] });
      setEdit(null);
    },
  });
  const open = (d: Department | 'new') => {
    setF(d === 'new' ? { code: '', name: '', level: 'DEPARTMENT', parentId: '', headId: '', active: true } : { code: d.code, name: d.name, level: d.level ?? 'DEPARTMENT', parentId: d.parentId ?? '', headId: d.headId ?? '', active: d.active });
    setEdit(d);
  };
  return (
    <Card padded={false} title="Organisation units" actions={<Button onClick={() => open('new')}>New unit</Button>}>
      <p className="px-4 pt-3 text-xs text-muted">Line managers are limited to departments under Settings → Users &amp; roles.</p>
      <table className="table-base">
        <thead><tr><th>Unit</th><th>Code</th><th>Level</th><th>Head</th><th className="num">Staff</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id}><td style={{ paddingLeft: 16 + (d.depth ?? 0) * 18 }}>{d.name}</td><td>{d.code}</td><td className="text-xs">{UNIT_LEVELS[d.level ?? 'DEPARTMENT']}</td><td className="text-sm">{d.head}</td><td className="num">{d.staffBelow ?? 0}</td><td><Badge value={d.active ? 'ACTIVE' : 'CLOSED'}>{d.active ? 'Active' : 'Closed'}</Badge></td><td className="text-right"><Button variant="secondary" onClick={() => open(d)}>Edit</Button></td></tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit === 'new' ? 'New department' : `Edit ${edit.name}`} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Level"><Select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>{Object.entries(UNIT_LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Part of"><Select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">(top level)</option>{data?.filter((x) => edit === 'new' || x.id !== edit.id).map((x) => <option key={x.id} value={x.id}>{x.path ?? x.name}</option>)}</Select></Field>
            <Field label="Head" className="sm:col-span-2"><Select value={f.headId} onChange={(e) => setF({ ...f, headId: e.target.value })}><option value="">—</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.employeeNo})</option>)}</Select></Field>
          </div>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </Modal>
      )}
    </Card>
  );
}

function LeaveTypes() {
  const qc = useQueryClient();
  const { data } = useLeaveTypes();
  const [edit, setEdit] = useState<LeaveType | 'new' | null>(null);
  const blank = { code: '', name: '', paid: true, daysPerYear: 0, accrual: 'ANNUAL' as LeaveType['accrual'], carryForwardMax: 0, gender: null as LeaveType['gender'], unlimited: false, active: true };
  const [f, setF] = useState(blank);
  const save = useMutation({
    mutationFn: () => (edit && edit !== 'new' ? api.put(`/leave-types/${edit.id}`, f) : api.post('/leave-types', f)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-leave-types'] });
      setEdit(null);
    },
  });
  const open = (t: LeaveType | 'new') => {
    setF(t === 'new' ? blank : { code: t.code, name: t.name, paid: t.paid, daysPerYear: t.daysPerYear, accrual: t.accrual, carryForwardMax: t.carryForwardMax, gender: t.gender, unlimited: t.unlimited, active: t.active });
    setEdit(t);
  };
  return (
    <Card padded={false} title="Leave types" actions={<Button onClick={() => open('new')}>New leave type</Button>}>
      <table className="table-base">
        <thead><tr><th>Code</th><th>Name</th><th className="num">Days a year</th><th>Earned</th><th className="num">Carry forward</th><th>Paid</th><th>For</th><th /></tr></thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id} className={t.active ? '' : 'text-muted'}>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td className="num">{t.unlimited ? 'no limit' : t.daysPerYear}</td>
              <td>{t.accrual === 'MONTHLY' ? 'Monthly' : 'At the start of the year'}</td>
              <td className="num">{t.carryForwardMax || '—'}</td>
              <td>{t.paid ? 'Yes' : <Badge tone="amber">unpaid</Badge>}</td>
              <td>{t.gender ? label(t.gender) : 'Everyone'}</td>
              <td className="text-right"><Button variant="secondary" onClick={() => open(t)}>Edit</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit === 'new' ? 'New leave type' : `Edit ${edit.name}`} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Days a year"><Input inputMode="decimal" value={f.daysPerYear} onChange={(e) => setF({ ...f, daysPerYear: Number(e.target.value) || 0 })} /></Field>
            <Field label="Earned">
              <Select value={f.accrual} onChange={(e) => setF({ ...f, accrual: e.target.value as LeaveType['accrual'] })}>
                <option value="MONTHLY">Monthly (a twelfth each month)</option>
                <option value="ANNUAL">All at the start of the year</option>
              </Select>
            </Field>
            <Field label="Days carried into next year (max)"><Input inputMode="decimal" value={f.carryForwardMax} onChange={(e) => setF({ ...f, carryForwardMax: Number(e.target.value) || 0 })} /></Field>
            <Field label="For">
              <Select value={f.gender ?? ''} onChange={(e) => setF({ ...f, gender: (e.target.value || null) as LeaveType['gender'] })}>
                <option value="">Everyone</option>
                <option value="FEMALE">Women</option>
                <option value="MALE">Men</option>
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!f.paid} onChange={(e) => setF({ ...f, paid: !e.target.checked })} /> Unpaid (taken off pay)</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.unlimited} onChange={(e) => setF({ ...f, unlimited: e.target.checked })} /> No balance limit</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Ledger({ s }: { s: HrSettings }) {
  const qc = useQueryClient();
  const canPlatform = useCan()('core.settings.manage');
  const [accounts, setAccounts] = useState<Record<string, string>>({ ...(s.accounts ?? {}) });
  const ledgerAccounts = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => platformApi.get<{ id: string; code: string; name: string }[]>('/ledger/accounts') });
  const save = useMutation({ mutationFn: () => api.patch('/settings/accounts', { accounts }), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-settings'] }) });
  const retry = useMutation({ mutationFn: () => api.post<{ sent: number; failed: number; skipped: number }>('/accounting/retry') });
  const options = ledgerAccounts.data ?? [];
  return (
    <Card title="Ledger accounts for payroll" actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>Send everything outstanding</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></div>}>
      <p className="mb-3 text-sm text-muted">
        An approved payroll posts the salary expense and what is owed to KRA, NSSF, SHA, the housing fund, NITA and the staff; marking it paid clears net pay against the bank. The ledger connection is shared by every module and set
        {canPlatform ? <> under <Link href="/settings" className="text-brand-700 hover:underline">Settings → Ledger</Link></> : ' by an administrator'}.
      </p>
      <ErrorBox error={save.error || ledgerAccounts.error || retry.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      {retry.data && <Notice tone="green">Sent {retry.data.sent}, failed {retry.data.failed}, skipped {retry.data.skipped}.</Notice>}
      {ledgerAccounts.isSuccess && !options.length && <Notice tone="amber">The ledger is not connected yet, so there are no accounts to choose from.</Notice>}
      <div className="mt-1 grid gap-3 sm:grid-cols-2">
        {Object.entries(s.mappingLabels).map(([key, text]) => (
          <Field key={key} label={text}>
            <Select value={accounts[key] ?? ''} onChange={(e) => setAccounts({ ...accounts, [key]: e.target.value })}>
              <option value="">{options.length ? 'Select…' : accounts[key] ? 'Mapped (connect to view)' : 'Connect the ledger first'}</option>
              {options.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
            </Select>
          </Field>
        ))}
      </div>
    </Card>
  );
}

interface Scheme { id: string; code: string; name: string; kind: string; employeeRate: number | null; employeeAmount: string | null; minimum: string | null; maximum: string | null; employerRate: number | null; employerAmount: string | null; payee?: string; payeeAccount?: string; active: boolean; members: number }
const SCHEME_KINDS = ['PENSION', 'UNION', 'SACCO', 'WELFARE', 'INSURANCE', 'LOAN', 'OTHER'];

/** Pension schemes, unions, SACCOs and other deduction tables: their rates drive every member's deduction. */
function Schemes() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['hr-schemes'], queryFn: () => api.get<Scheme[]>('/deduction-schemes') });
  const { data: people } = useEmployeeOptions();
  const [edit, setEdit] = useState<Scheme | 'new' | null>(null);
  const [members, setMembers] = useState<Scheme | null>(null);
  const blank = { code: '', name: '', kind: 'UNION', basis: 'RATE', employeeRate: '', employeeAmount: '', minimum: '', maximum: '', employerRate: '', employerAmount: '', payee: '', payeeAccount: '', active: true };
  const [f, setF] = useState(blank);
  const [enrol, setEnrol] = useState({ employeeId: '', memberNo: '', fromPeriod: new Date().toISOString().slice(0, 7) });
  const list = useQuery({ queryKey: ['hr-scheme-members', members?.id], queryFn: () => api.get<{ payItemId: string; employeeNo: string; name: string; memberNo?: string; fromPeriod: string; toPeriod?: string }[]>(`/deduction-schemes/${members!.id}/members`), enabled: !!members });
  const save = useMutation({
    mutationFn: () => {
      const body = { code: f.code, name: f.name, kind: f.kind, employeeRate: f.basis === 'RATE' ? Number(f.employeeRate) : null, employeeAmount: f.basis === 'AMOUNT' ? f.employeeAmount : null, minimum: f.minimum || null, maximum: f.maximum || null, employerRate: f.employerRate ? Number(f.employerRate) : null, employerAmount: f.employerAmount || null, payee: f.payee || undefined, payeeAccount: f.payeeAccount || undefined, active: f.active };
      return edit && edit !== 'new' ? api.put(`/deduction-schemes/${edit.id}`, body) : api.post('/deduction-schemes', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['hr-schemes'] }); setEdit(null); },
  });
  const add = useMutation({ mutationFn: () => api.post(`/deduction-schemes/${members!.id}/members`, { ...enrol, memberNo: enrol.memberNo || undefined }), onSuccess: () => { list.refetch(); qc.invalidateQueries({ queryKey: ['hr-schemes'] }); setEnrol({ ...enrol, employeeId: '', memberNo: '' }); } });
  const open = (x: Scheme | 'new') => {
    setF(x === 'new' ? blank : { code: x.code, name: x.name, kind: x.kind, basis: x.employeeAmount ? 'AMOUNT' : 'RATE', employeeRate: x.employeeRate?.toString() ?? '', employeeAmount: x.employeeAmount ?? '', minimum: x.minimum ?? '', maximum: x.maximum ?? '', employerRate: x.employerRate?.toString() ?? '', employerAmount: x.employerAmount ?? '', payee: x.payee ?? '', payeeAccount: x.payeeAccount ?? '', active: x.active });
    setEdit(x);
  };
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card padded={false} title="Deduction schemes" actions={<Button onClick={() => open('new')}>New scheme</Button>}>
      <ErrorBox error={error} />
      <p className="px-4 pt-3 text-xs text-muted">Each payroll works members&apos; deductions out from these rates, so a change applies to everyone at the next run.</p>
      <table className="table-base">
        <thead><tr><th>Scheme</th><th>Kind</th><th>Member pays</th><th>Employer adds</th><th className="num">Members</th><th /></tr></thead>
        <tbody>
          {data?.map((x) => (
            <tr key={x.id} className={x.active ? '' : 'text-muted'}>
              <td>{x.name}<div className="text-xs text-muted">{x.code}{x.payee && ` · to ${x.payee}`}</div></td>
              <td>{label(x.kind)}</td>
              <td>{x.employeeAmount ? fmtMoney(x.employeeAmount) : `${x.employeeRate}% of basic`}{(x.minimum || x.maximum) && <div className="text-xs text-muted">{x.minimum && `min ${fmtMoney(x.minimum)}`} {x.maximum && `max ${fmtMoney(x.maximum)}`}</div>}</td>
              <td>{x.employerAmount ? fmtMoney(x.employerAmount) : x.employerRate ? `${x.employerRate}%` : '—'}</td>
              <td className="num">{x.members}</td>
              <td className="whitespace-nowrap text-right"><Button variant="secondary" onClick={() => setMembers(x)}>Members</Button> <Button variant="secondary" onClick={() => open(x)}>Edit</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit === 'new' ? 'New deduction scheme' : `Edit ${edit.name}`} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={t('name')} /></Field>
            <Field label="Kind"><Select value={f.kind} onChange={t('kind')}>{SCHEME_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
            <Field label="Member pays"><Select value={f.basis} onChange={t('basis')}><option value="RATE">A % of basic pay</option><option value="AMOUNT">A fixed amount</option></Select></Field>
            {f.basis === 'RATE' ? <Field label="% of basic"><Input inputMode="decimal" value={f.employeeRate} onChange={t('employeeRate')} /></Field> : <Field label="Amount"><Input inputMode="decimal" value={f.employeeAmount} onChange={t('employeeAmount')} /></Field>}
            <Field label="Minimum / maximum"><div className="flex gap-1"><Input placeholder="min" value={f.minimum} onChange={t('minimum')} /><Input placeholder="max" value={f.maximum} onChange={t('maximum')} /></div></Field>
            <Field label="Employer adds (% of basic)"><Input inputMode="decimal" value={f.employerRate} onChange={t('employerRate')} /></Field>
            <Field label="or a fixed amount"><Input inputMode="decimal" value={f.employerAmount} onChange={t('employerAmount')} /></Field>
            <Field label="Paid to"><Input value={f.payee} onChange={t('payee')} /></Field>
            <Field label="Their account"><Input value={f.payeeAccount} onChange={t('payeeAccount')} /></Field>
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </Modal>
      )}
      {members && (
        <Modal open wide onClose={() => setMembers(null)} title={`${members.name}: members`}>
          <ErrorBox error={add.error || list.error} />
          <table className="table-base"><thead><tr><th>Employee</th><th>Member no.</th><th>From</th><th>To</th></tr></thead>
            <tbody>{list.data?.map((m) => <tr key={m.payItemId}><td>{m.employeeNo} · {m.name}</td><td>{m.memberNo}</td><td>{m.fromPeriod}</td><td>{m.toPeriod ?? '—'}</td></tr>)}</tbody>
          </table>
          <div className="mt-3 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <Select value={enrol.employeeId} onChange={(e) => setEnrol({ ...enrol, employeeId: e.target.value })}><option value="">Add a member</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.employeeNo})</option>)}</Select>
            <Input placeholder="Member no." value={enrol.memberNo} onChange={(e) => setEnrol({ ...enrol, memberNo: e.target.value })} />
            <Input type="month" value={enrol.fromPeriod} onChange={(e) => setEnrol({ ...enrol, fromPeriod: e.target.value })} />
            <Button disabled={!enrol.employeeId || add.isPending} onClick={() => add.mutate()}>Enrol</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function HrSettingsPage() {
  const [tab, setTab] = useState<Tab>('rates');
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-settings'], queryFn: () => api.get<HrSettings>('/settings') });
  return (
    <>
      <PageHeader title="HR settings" subtitle="Statutory rates, departments, leave, holidays and ledger accounts" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'rates', label: 'Statutory rates' },
          { id: 'schemes', label: 'Deduction schemes' },
          { id: 'departments', label: 'Departments' },
          { id: 'leave', label: 'Leave types' },
          { id: 'general', label: 'Numbering & holidays' },
          { id: 'ledger', label: 'Ledger accounts' },
        ]}
      />
      <ErrorBox error={error} />
      {tab === 'rates' && <Rates />}
      {tab === 'schemes' && <Schemes />}
      {tab === 'departments' && <Departments />}
      {tab === 'leave' && <LeaveTypes />}
      {(tab === 'general' || tab === 'ledger') && (isLoading || !data ? <Loading /> : tab === 'general' ? <General s={data} /> : <Ledger s={data} />)}
    </>
  );
}
