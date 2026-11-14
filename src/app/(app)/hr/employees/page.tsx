'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Money, PageHeader, Pager, Select } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { EmployeeForm } from '@/modules/hr/ui/employee-form';
import { departmentName, fullName, useDepartments } from '@/modules/hr/ui/hooks';
import { Employee, Page } from '@/modules/hr/ui/types';

export default function EmployeesPage() {
  const router = useRouter();
  const can = useCan();
  const { data: departments } = useDepartments();
  const [q, setQ] = useState({ search: '', departmentId: '', status: 'ACTIVE', page: 1 });
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-employees', q], queryFn: () => api.get<Page<Employee>>('/employees', { ...q, pageSize: 50 }) });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));
  const pay = can('hr.salary.view');

  return (
    <>
      <PageHeader title="Employees" subtitle="Staff records, pay and statutory numbers" actions={<div className="flex items-center gap-3 text-sm"><span className="text-muted">Download</span>{(['xls', 'doc', 'pdf', 'csv'] as const).map((f) => <a key={f} href={`/api/v1/hr/employees/export/${f}`} className="text-brand-700 hover:underline">{({ xls: 'Excel', doc: 'Word', pdf: 'PDF', csv: 'CSV' } as const)[f]}</a>)}{can('hr.employee.manage') && <Button onClick={() => setCreating(true)}>New employee</Button>}</div>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input placeholder="Search number, name, ID, KRA PIN, phone" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
          <Select value={q.departmentId} onChange={(e) => set({ departmentId: e.target.value })} className="max-w-[14rem]">
            <option value="">All departments</option>
            {departments?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select value={q.status} onChange={(e) => set({ status: e.target.value })} className="max-w-[10rem]">
            <option value="">Any status</option>
            {['ACTIVE', 'SUSPENDED', 'TERMINATED'].map((s) => <option key={s} value={s}>{s === 'TERMINATED' ? 'Left' : label(s)}</option>)}
          </Select>
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No employees match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Job title</th>
                  <th>Type</th>
                  <th>Hired</th>
                  <th>KRA PIN</th>
                  {pay && <th className="num">Basic (KES)</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/hr/employees/${e.id}`} className="font-medium text-brand-700 hover:underline">{e.employeeNo}</Link>
                    </td>
                    <td>{fullName(e)}</td>
                    <td>{departmentName(departments, e.departmentId)}</td>
                    <td>{e.jobTitle ?? '—'}</td>
                    <td>{label(e.employmentType)}</td>
                    <td>{fmtDate(e.hireDate)}</td>
                    <td className="font-mono text-xs">{e.kraPin ?? <span className="text-amber-700">missing</span>}</td>
                    {pay && <td className="num">{e.payType === 'DAILY' || e.payType === 'HOURLY' ? <span className="text-muted">{fmtMoney(e.rate)} / {e.payType === 'DAILY' ? 'day' : 'hr'}</span> : <Money value={e.basicSalary} />}</td>}
                    <td><Badge value={e.status}>{e.status === 'TERMINATED' ? 'Left' : undefined}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {creating && <EmployeeForm onClose={() => setCreating(false)} onSaved={(e) => router.push(`/hr/employees/${e.id}`)} />}
    </>
  );
}
