'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, Notice, PageHeader, Pager, Stat } from '@/components/ui';
import { fmtDate, fmtMoney, today } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { Payments } from '@/modules/hr/ui/off-cycle';
import { ChangeAdvice, PensionRemittance } from '@/modules/hr/ui/payroll-extras';
import { Page, PayEntry, PayRun, Payslip } from '@/modules/hr/ui/types';

type Rated = { employeeId: string; employeeNo: string; name: string; payType: 'DAILY' | 'HOURLY'; units: number; rate: string };
type RunDetail = PayRun & { rated: Rated[]; entries: PayEntry[]; payslips: Page<Payslip> };

const runName = (run: PayRun) => (run.kind === 'OFF_CYCLE' ? `${run.title} ${run.period}` : run.kind === 'GROUP' ? `${run.title ?? 'Group payroll'}` : `Payroll ${run.period}`);

/** Days or hours worked by daily and hourly staff, saved and the payroll worked again. */
function TimeWorked({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const [units, setUnits] = useState<Record<string, string>>(() => Object.fromEntries(run.rated.map((r) => [r.employeeId, r.units ? String(r.units) : ''])));
  const save = useMutation({
    mutationFn: () => api.put(`/payroll/${run.id}/units`, { rows: run.rated.map((r) => ({ employeeId: r.employeeId, units: Number(units[r.employeeId]) || 0 })) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-payroll', run.id] });
      qc.invalidateQueries({ queryKey: ['hr-payrolls'] });
    },
  });
  return (
    <Card padded={false} title="Days and hours worked" className="mb-5" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Recalculating…' : 'Save and recalculate'}</Button>}>
      <div className="px-4 pt-3"><ErrorBox error={save.error} /></div>
      <table className="table-base">
        <thead>
          <tr><th>Employee</th><th>Name</th><th className="num">Rate</th><th>Worked</th><th className="num">Basic pay</th></tr>
        </thead>
        <tbody>
          {run.rated.map((r) => (
            <tr key={r.employeeId}>
              <td>{r.employeeNo}</td>
              <td>{r.name}</td>
              <td className="num">{fmtMoney(r.rate)} / {r.payType === 'DAILY' ? 'day' : 'hour'}</td>
              <td>
                <span className="flex items-center gap-2">
                  <Input inputMode="decimal" value={units[r.employeeId] ?? ''} onChange={(e) => setUnits({ ...units, [r.employeeId]: e.target.value })} className="max-w-24" />
                  {r.payType === 'DAILY' ? 'days' : 'hours'}
                </span>
              </td>
              <td className="num">{fmtMoney(Number(r.rate) * (Number(units[r.employeeId]) || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MarkPaid({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ paidAt: today(), reference: '' });
  const save = useMutation({
    mutationFn: () => api.post(`/payroll/${run.id}/paid`, { paidAt: f.paidAt, reference: f.reference || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-payroll', run.id] });
      qc.invalidateQueries({ queryKey: ['hr-payrolls'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`${runName(run)} paid`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Confirm</Button></>}>
      <ErrorBox error={save.error} />
      <p className="text-sm">Net pay of KES {fmtMoney(run.totals.netPay)} left the bank. The payment journal goes to the ledger.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Paid on"><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
        <Field label="Bank or M-Pesa reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export default function PayRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState({ search: '', warnings: false, page: 1 });
  const [paying, setPaying] = useState(false);
  const { data: run, error, isLoading } = useQuery({ queryKey: ['hr-payroll', id, q], queryFn: () => api.get<RunDetail>(`/payroll/${id}`, { ...q, warnings: q.warnings || undefined, pageSize: 50 }) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['hr-payroll', id] });
    qc.invalidateQueries({ queryKey: ['hr-payrolls'] });
  };
  const approve = useMutation({ mutationFn: () => api.post(`/payroll/${id}/approve`), onSuccess: invalidate });
  const recalc = useMutation({ mutationFn: () => api.post(`/payroll/${id}/recalculate`), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => api.post(`/payroll/${id}/cancel`), onSuccess: invalidate });

  if (isLoading) return <Loading />;
  if (!run) return <ErrorBox error={error} />;
  const draft = run.status === 'DRAFT';
  const offCycle = run.kind === 'OFF_CYCLE';
  const ownRun = me?.id === run.createdBy && !me?.isAdmin;
  const t = run.totals;
  const sync = run.status === 'PAID' && run.paymentAccounting?.status === 'FAILED' ? run.paymentAccounting : run.accounting;

  return (
    <>
      <PageHeader
        title={runName(run)}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge value={run.status} /> {offCycle && <Badge tone="gray">off-cycle</Badge>} {run.kind === 'GROUP' && <Badge tone="gray">{run.payGroup === 'BOARD' ? 'board' : 'seconded staff'}</Badge>} pay date {fmtDate(run.payDate)}
            {run.paidAt && <> · paid {fmtDate(run.paidAt)} {run.paymentReference}</>}
          </span>
        }
        actions={
          <>
            <a href={`/api/v1/hr/payroll/${id}/register`} className="text-sm text-brand-700 hover:underline">Payroll register (CSV)</a>
            {draft && can('hr.payroll.run') && (
              <>
                <Button variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel</Button>
                <Button variant="secondary" onClick={() => recalc.mutate()} disabled={recalc.isPending}>{recalc.isPending ? 'Recalculating…' : 'Recalculate'}</Button>
              </>
            )}
            {draft && can('hr.payroll.approve') && (
              <Button onClick={() => approve.mutate()} disabled={approve.isPending || ownRun} title={ownRun ? 'Someone else must approve a payroll you prepared' : undefined}>
                {approve.isPending ? 'Approving…' : 'Approve'}
              </Button>
            )}
            {run.status === 'APPROVED' && can('hr.payroll.pay') && <Button onClick={() => setPaying(true)}>Mark salaries paid</Button>}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={approve.error || recalc.error || cancel.error} />
        {draft && !offCycle && <Notice>Changed an employee, a pay item or leave? Recalculate before approving. Approving numbers the payslips, takes loan repayments off their balances and shows the payslips to staff.</Notice>}
        {draft && offCycle && (
          <Notice>
            Only the payments below are paid. PAYE, NSSF, SHIF and the levy are worked on each person&apos;s total pay for {run.period}, less what the month&apos;s other approved payrolls already took.
            If another payroll for the month is approved before this one, recalculate this one first.
          </Notice>
        )}
        {ownRun && draft && <Notice>You prepared this payroll, so another user with approval rights must approve it.</Notice>}
        {run.warningCount > 0 && draft && <Notice tone="amber">{run.warningCount} payslips need a look (part months, no salary, deductions above two-thirds of pay).</Notice>}
        {run.imported && <Notice>Brought across from farajasofterp. It is already in the books, so it is not sent to the ledger.</Notice>}
        {sync?.status === 'FAILED' && <Notice tone="amber">Posting to the ledger failed: {sync.error}. Fix it, then use HR settings → Ledger accounts → Send everything outstanding.</Notice>}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Employees" value={run.employeeCount} />
        <Stat label="Gross pay" value={fmtMoney(t.gross)} />
        <Stat label="PAYE" value={fmtMoney(t.paye)} />
        <Stat label="NSSF (both)" value={fmtMoney(Number(t.nssfEmployee) + Number(t.nssfEmployer))} />
        <Stat label="SHIF" value={fmtMoney(t.shif)} />
        <Stat label="Housing levy (both)" value={fmtMoney(Number(t.ahlEmployee) + Number(t.ahlEmployer))} />
        <Stat label="Other deductions" value={fmtMoney(t.otherDeductions)} />
        <Stat label="NITA" value={fmtMoney(t.nita)} />
        <Stat label="Net pay" value={fmtMoney(t.netPay)} tone="good" />
        {Number(t.employerPension ?? 0) > 0 && <Stat label="Employer pension" value={fmtMoney(t.employerPension)} />}
        {Number(t.gratuity ?? 0) > 0 && <Stat label="Gratuity accrued" value={fmtMoney(t.gratuity)} />}
        {Number(t.gratuityPaid ?? 0) > 0 && <Stat label="Gratuity paid" value={fmtMoney(t.gratuityPaid)} />}
        <Stat label="Cost to employer" value={fmtMoney(t.employerCost)} />
      </div>
      {!offCycle && run.status !== 'CANCELLED' && <ChangeAdvice runId={run.id} />}
      {run.status !== 'CANCELLED' && <PensionRemittance runId={run.id} />}
      {offCycle && (draft || run.entries.length > 0) && <Payments runId={run.id} entries={run.entries} editable={draft && can('hr.payroll.run')} />}
      {draft && run.rated.length > 0 && can('hr.payroll.run') && <TimeWorked key={run.rated.map((r) => `${r.employeeId}:${r.units}`).join()} run={run} />}
      <Card padded={false} title="Payslips">
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <Input placeholder="Employee number or name" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} className="max-w-xs" />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={q.warnings} onChange={(e) => setQ({ ...q, warnings: e.target.checked, page: 1 })} /> Only those with warnings
          </label>
        </div>
        {!run.payslips.items.length ? (
          <Empty>No payslips.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Name</th>
                  <th>Payslip</th>
                  <th className="num">Days</th>
                  <th className="num">Gross</th>
                  <th className="num">PAYE</th>
                  <th className="num">NSSF</th>
                  <th className="num">SHIF</th>
                  <th className="num">Housing</th>
                  <th className="num">Other</th>
                  <th className="num">Net pay</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {run.payslips.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/hr/employees/${p.employeeId}`} className="text-brand-700 hover:underline">{p.employee.employeeNo}</Link>
                    </td>
                    <td>{p.employee.name}</td>
                    <td>
                      <Link href={`/hr/payslips/${p.id}`} className="text-brand-700 hover:underline">{p.payslipNo ?? 'view draft'}</Link>
                    </td>
                    <td className="num">{offCycle ? '—' : p.payType === 'DAILY' || p.payType === 'HOURLY' ? `${p.units ?? 0} ${p.payType === 'DAILY' ? 'd' : 'h'}` : p.daysPaid === p.daysInPeriod ? 'full' : `${p.daysPaid}/${p.daysInPeriod}`}</td>
                    <td className="num"><Money value={p.gross} /></td>
                    <td className="num"><Money value={p.paye} /></td>
                    <td className="num"><Money value={p.nssfEmployee} /></td>
                    <td className="num"><Money value={p.shif} /></td>
                    <td className="num"><Money value={p.ahlEmployee} /></td>
                    <td className="num"><Money value={p.otherDeductions} /></td>
                    <td className="num font-medium"><Money value={p.netPay} /></td>
                    <td className="max-w-xs text-xs text-amber-800">{p.warnings.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={run.payslips.page} pageSize={run.payslips.pageSize} total={run.payslips.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />
      </Card>
      {paying && <MarkPaid run={run} onClose={() => setPaying(false)} />}
    </>
  );
}
