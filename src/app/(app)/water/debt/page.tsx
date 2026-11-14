'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, label, today } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { CustomerPicker } from '@/modules/water/ui/customer-picker';
import { Customer } from '@/modules/water/ui/types';

const STAGES = ['REMINDER', 'DEMAND_LETTER', 'FINAL_NOTICE', 'DEBT_COLLECTOR', 'LEGAL', 'JUDGEMENT', 'SETTLED'];

interface Plan {
  id: string;
  number: string;
  customerId: string;
  accountNo: string;
  customer: { name: string; balance: string } | null;
  arrears: string;
  deposit: string;
  paidToDate: string;
  instalments: { dueDate: string; amount: string; paid: string }[];
  startDate: string;
  status: string;
  createdBy: string;
  notes?: string;
}

interface DebtCase {
  id: string;
  number: string;
  customerId: string;
  accountNo: string;
  category: string;
  amount: string;
  stage: string;
  open: boolean;
  collector?: string;
  legal?: { advocate?: string; court?: string; caseNo?: string; nextHearing?: string };
  customer: { name: string; balance: string } | null;
  updatedAt: string;
  history: { at: string; stage: string; note?: string }[];
}

interface Summary {
  cases: { stage: string; category: string; count: number; amount: string }[];
  plans: { id: string; n: number; arrears: string; paid: string }[];
}

function NewPlan({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ deposit: '', instalments: '3', startDate: today(), graceDays: '7', notes: '' });
  const save = useMutation({
    mutationFn: () => api.post('/payment-plans', { customerId: customer!.id, deposit: f.deposit || '0', instalments: Number(f.instalments), startDate: f.startDate, graceDays: Number(f.graceDays), notes: f.notes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payment-plans'] });
      onClose();
    },
  });
  const rest = customer ? Number(customer.balance) - Number(f.deposit || 0) : 0;
  return (
    <Modal open onClose={onClose} title="Propose a payment plan" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !customer}>Propose plan</Button>}>
      <ErrorBox error={save.error} />
      {customer ? (
        <div className="rounded border border-line px-3 py-2 text-sm">
          <b>{customer.accountNo}</b> · {customer.name} owes <Money value={customer.balance} />
        </div>
      ) : (
        <CustomerPicker onPick={setCustomer} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Deposit now (KES)"><Input inputMode="decimal" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></Field>
        <Field label="Monthly instalments"><Input type="number" min={1} max={36} value={f.instalments} onChange={(e) => setF({ ...f, instalments: e.target.value })} /></Field>
        <Field label="Plan starts"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Days late allowed"><Input type="number" min={0} max={60} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      {customer && rest > 0 && <Notice>About KES {(rest / Math.max(1, Number(f.instalments))).toFixed(2)} a month on top of current bills. While the plan is honoured the account stays off the disconnection list.</Notice>}
    </Modal>
  );
}

function Plans() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: me } = useMe();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['payment-plans', status], queryFn: () => api.get<Plan[]>('/payment-plans', { status }) });
  const review = useMutation({ mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/payment-plans/${id}/review`, { approve }), onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-plans'] }) });
  return (
    <Card
      padded={false}
      title="Payment plans"
      actions={
        <>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All</option>
            {['PENDING', 'ACTIVE', 'DEFAULTED', 'COMPLETED', 'CANCELLED', 'REJECTED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
          {can('water.debt.manage') && <Button onClick={() => setCreating(true)}>New plan</Button>}
        </>
      }
    >
      <ErrorBox error={error || review.error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No payment plans.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Plan</th><th>Account</th><th className="num">Arrears</th><th className="num">Paid</th><th>Instalments</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.map((p) => {
              const next = p.instalments.find((i) => Number(i.paid) < Number(i.amount));
              return (
                <tr key={p.id}>
                  <td className="font-medium">{p.number}<div className="text-xs text-muted">from {fmtDate(p.startDate)}</div></td>
                  <td><Link href={`/water/customers/${p.customerId}`} className="text-brand-700 hover:underline">{p.accountNo}</Link><div className="text-xs text-muted">{p.customer?.name}</div></td>
                  <td className="num"><Money value={p.arrears} /></td>
                  <td className="num"><Money value={p.paidToDate} /></td>
                  <td className="text-sm">{p.instalments.length} × <Money value={p.instalments[0]?.amount} />{next && <div className="text-xs text-muted">next {fmtDate(next.dueDate)}</div>}</td>
                  <td><Badge value={p.status} /></td>
                  <td className="whitespace-nowrap text-right">
                    {p.status === 'PENDING' && can('water.debt.approve') && p.createdBy !== me?.id && (
                      <>
                        <Button variant="ghost" onClick={() => review.mutate({ id: p.id, approve: false })}>Reject</Button>
                        <Button onClick={() => review.mutate({ id: p.id, approve: true })}>Approve</Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {creating && <NewPlan onClose={() => setCreating(false)} />}
    </Card>
  );
}

function CaseAction({ kase, onClose }: { kase: DebtCase; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ stage: kase.stage, note: '', collector: kase.collector ?? '', advocate: kase.legal?.advocate ?? '', court: kase.legal?.court ?? '', caseNo: kase.legal?.caseNo ?? '', nextHearing: kase.legal?.nextHearing?.slice(0, 10) ?? '' });
  const [writeOff, setWriteOff] = useState(false);
  const done = () => {
    qc.invalidateQueries({ queryKey: ['debt-cases'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      writeOff
        ? api.post(`/debt-cases/${kase.id}/write-off`, { reason: f.note })
        : api.post(`/debt-cases/${kase.id}/stage`, {
            stage: f.stage,
            note: f.note || undefined,
            collector: f.collector || undefined,
            legal: ['LEGAL', 'JUDGEMENT'].includes(f.stage) ? { advocate: f.advocate || undefined, court: f.court || undefined, caseNo: f.caseNo || undefined, nextHearing: f.nextHearing || null } : undefined,
          }),
    onSuccess: done,
  });
  return (
    <Modal open wide onClose={onClose} title={`${kase.number} · ${kase.accountNo}`} footer={<Button variant={writeOff ? 'danger' : 'primary'} onClick={() => save.mutate()} disabled={save.isPending || (writeOff && f.note.length < 5)}>{writeOff ? 'Request write-off' : 'Save'}</Button>}>
      <ErrorBox error={save.error} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} /> Write the debt off (a credit for the whole balance, approved under Adjustments)</label>
      {!writeOff && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stage">
            <Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
              {STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </Select>
          </Field>
          {f.stage === 'DEBT_COLLECTOR' && <Field label="Collector"><Input value={f.collector} onChange={(e) => setF({ ...f, collector: e.target.value })} /></Field>}
          {['LEGAL', 'JUDGEMENT'].includes(f.stage) && (
            <>
              <Field label="Advocate"><Input value={f.advocate} onChange={(e) => setF({ ...f, advocate: e.target.value })} /></Field>
              <Field label="Court"><Input value={f.court} onChange={(e) => setF({ ...f, court: e.target.value })} /></Field>
              <Field label="Case no."><Input value={f.caseNo} onChange={(e) => setF({ ...f, caseNo: e.target.value })} /></Field>
              <Field label="Next hearing"><Input type="date" value={f.nextHearing} onChange={(e) => setF({ ...f, nextHearing: e.target.value })} /></Field>
            </>
          )}
        </div>
      )}
      <Field label={writeOff ? 'Reason' : 'Note'}><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <ol className="space-y-1 border-l-2 border-line pl-3 text-sm">
        {kase.history.map((h, i) => (
          <li key={i}><span className="text-xs text-muted">{fmtDate(h.at)}</span> <b>{label(h.stage)}</b>{h.note ? `: ${h.note}` : ''}</li>
        ))}
      </ol>
    </Modal>
  );
}

function Cases() {
  const qc = useQueryClient();
  const can = useCan();
  const [stage, setStage] = useState('');
  const [acting, setActing] = useState<DebtCase | null>(null);
  const [opening, setOpening] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['debt-cases', stage], queryFn: () => api.get<DebtCase[]>('/debt-cases', { stage, open: stage ? undefined : true }) });
  const run = useMutation({ mutationFn: () => api.post<{ opened: number; defaulted: number }>('/debt/collection-run'), onSuccess: () => qc.invalidateQueries({ queryKey: ['debt-cases'] }) });
  const open = useMutation({ mutationFn: (customerId: string) => api.post('/debt-cases', { customerId }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['debt-cases'] }); setOpening(false); } });
  return (
    <Card
      padded={false}
      title="Collection and legal cases"
      actions={
        <>
          <Select value={stage} onChange={(e) => setStage(e.target.value)} className="w-44">
            <option value="">All open cases</option>
            {[...STAGES, 'WRITTEN_OFF'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
          {can('water.debt.manage') && (
            <>
              <Button variant="secondary" onClick={() => run.mutate()} disabled={run.isPending}>Run collection</Button>
              <Button onClick={() => setOpening(true)}>Open case</Button>
            </>
          )}
        </>
      }
    >
      <ErrorBox error={error || run.error || open.error} />
      {run.data && <div className="px-4 pt-3 text-sm text-muted">{run.data.opened} reminder cases opened and texted, {run.data.defaulted} payment plans now in default.</div>}
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No cases.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Case</th><th>Account</th><th>Category</th><th className="num">Owed now</th><th>Stage</th><th>Details</th><th /></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.number}<div className="text-xs text-muted">{fmtDate(c.updatedAt)}</div></td>
                <td><Link href={`/water/customers/${c.customerId}`} className="text-brand-700 hover:underline">{c.accountNo}</Link><div className="text-xs text-muted">{c.customer?.name}</div></td>
                <td>{label(c.category)}</td>
                <td className="num"><Money value={c.customer?.balance ?? c.amount} /></td>
                <td><Badge tone={c.open ? (['LEGAL', 'JUDGEMENT', 'DEBT_COLLECTOR'].includes(c.stage) ? 'red' : 'amber') : 'gray'}>{label(c.stage)}</Badge></td>
                <td className="text-xs">{c.legal?.caseNo ? `${c.legal.court ?? ''} ${c.legal.caseNo}`.trim() : c.collector ?? ''}{c.legal?.nextHearing && <div>hearing {fmtDate(c.legal.nextHearing)}</div>}</td>
                <td className="text-right">{c.open && can('water.debt.manage') && <Button variant="ghost" onClick={() => setActing(c)}>Update</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {acting && <CaseAction kase={acting} onClose={() => setActing(null)} />}
      {opening && (
        <Modal open onClose={() => setOpening(false)} title="Open a collection case">
          <CustomerPicker onPick={(c) => open.mutate(c.id)} />
        </Modal>
      )}
    </Card>
  );
}

function SummaryView() {
  const { data, error } = useQuery({ queryKey: ['debt-summary'], queryFn: () => api.get<Summary>('/debt/summary') });
  const categories = [...new Set(data?.cases.map((c) => c.category) ?? [])];
  const stages = [...new Set(data?.cases.map((c) => c.stage) ?? [])];
  return (
    <Card title="Open cases by customer category and stage" padded={false}>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : !data.cases.length ? (
        <Empty>No open cases.</Empty>
      ) : (
        <table className="table-base">
          <thead><tr><th>Category</th>{stages.map((s) => <th key={s} className="num">{label(s)}</th>)}</tr></thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat}>
                <td>{label(cat)}</td>
                {stages.map((s) => {
                  const row = data.cases.find((c) => c.category === cat && c.stage === s);
                  return <td key={s} className="num">{row ? <><Money value={row.amount} /><div className="text-xs text-muted">{row.count} accounts</div></> : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function DebtPage() {
  const [tab, setTab] = useState<'cases' | 'plans' | 'summary'>('cases');
  return (
    <>
      <PageHeader title="Debt management" subtitle="Reminders, demand letters, collectors and court cases; payment plans that keep honest payers connected" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'cases', label: 'Cases' }, { id: 'plans', label: 'Payment plans' }, { id: 'summary', label: 'Summary' }]} />
      {tab === 'cases' && <Cases />}
      {tab === 'plans' && <Plans />}
      {tab === 'summary' && <SummaryView />}
    </>
  );
}
