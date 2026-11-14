'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, Empty, ErrorBox, Loading, Notice, PageHeader, Stat } from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { LeaveRequest, PayRunTotals } from '@/modules/hr/ui/types';

interface Dashboard {
  headcount: Record<string, number>;
  byDepartment: { department: string; count: number }[];
  joiners: number;
  leavers: number;
  latestRun: { id: string; period: string; status: string; employeeCount: number; totals: PayRunTotals } | null;
  pendingLeave: number;
  away: LeaveRequest[];
  contractsEnding: { id: string; employeeNo: string; name: string; date: string }[];
  probationEnding: { id: string; employeeNo: string; name: string; date: string }[];
  missingStatutoryNumbers: number;
}

function People({ title, rows, empty }: { title: string; rows: { id: string; name: string; date: string }[]; empty: string }) {
  return (
    <Card title={title}>
      {!rows.length ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="flex justify-between border-b border-line py-1.5 text-sm last:border-0">
            <Link href={`/hr/employees/${r.id}`} className="text-brand-700 hover:underline">{r.name}</Link>
            <span className="text-muted">{fmtDate(r.date)}</span>
          </div>
        ))
      )}
    </Card>
  );
}

export default function HrDashboard() {
  const can = useCan();
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-dashboard'], queryFn: () => api.get<Dashboard>('/dashboard') });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const run = data.latestRun;
  return (
    <>
      <PageHeader title="HR & payroll" subtitle="People, pay and leave at a glance" />
      {data.missingStatutoryNumbers > 0 && (
        <div className="mb-4">
          <Notice tone="amber">{data.missingStatutoryNumbers} active employees are missing a KRA PIN, NSSF or SHA number; the statutory returns need them.</Notice>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active employees" value={data.headcount.ACTIVE ?? 0} hint={data.headcount.SUSPENDED ? `${data.headcount.SUSPENDED} suspended` : undefined} />
        <Stat label="Joined this month" value={data.joiners} hint={`${data.leavers} left`} />
        <Stat label="Leave waiting for approval" value={<Link href="/hr/leave" className="hover:underline">{data.pendingLeave}</Link>} tone={data.pendingLeave ? 'warn' : undefined} />
        <Stat label="Away today" value={data.away.length} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Latest payroll">
          {!run ? (
            <Empty>No payroll yet.</Empty>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="flex items-center justify-between">
                {can('hr.salary.view') ? <Link href={`/hr/payroll/${run.id}`} className="text-base font-semibold text-brand-700 hover:underline">{run.period}</Link> : <span className="text-base font-semibold">{run.period}</span>}
                <Badge value={run.status} />
              </div>
              <div className="flex justify-between"><span className="text-muted">Employees</span><span>{run.employeeCount}</span></div>
              <div className="flex justify-between"><span className="text-muted">Gross pay</span><span className="tabular-nums">{fmtMoney(run.totals.gross)}</span></div>
              <div className="flex justify-between"><span className="text-muted">PAYE</span><span className="tabular-nums">{fmtMoney(run.totals.paye)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Net pay</span><span className="font-medium tabular-nums">{fmtMoney(run.totals.netPay)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Cost to employer</span><span className="tabular-nums">{fmtMoney(run.totals.employerCost)}</span></div>
            </div>
          )}
        </Card>
        <Card title="By department">
          {data.byDepartment.map((d) => (
            <div key={d.department} className="flex justify-between border-b border-line py-1.5 text-sm last:border-0">
              <span>{d.department}</span>
              <span className="tabular-nums">{d.count}</span>
            </div>
          ))}
        </Card>
        <Card title="Away today">
          {!data.away.length ? (
            <p className="text-sm text-muted">Everyone is in.</p>
          ) : (
            data.away.map((a) => (
              <div key={a.id} className="flex justify-between border-b border-line py-1.5 text-sm last:border-0">
                <span>{a.employeeName}</span>
                <span className="text-muted">{a.leaveType} to {fmtDate(a.endDate)}</span>
              </div>
            ))
          )}
        </Card>
        <People title="Contracts ending (60 days)" rows={data.contractsEnding} empty="None." />
        <People title="Probation ending (30 days)" rows={data.probationEnding} empty="None." />
      </div>
    </>
  );
}
