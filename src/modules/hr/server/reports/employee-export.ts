import { AuthUser, hasPermission } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { PERMISSIONS as P } from '../../manifest';
import type { HrDb } from '../db';
import { FileFormat, inFormat } from './formats';

const day = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

/**
 * The staff list with personal, statutory and posting details as CSV, Excel, Word or PDF. Pay and bank
 * details are included only for users who may see salaries.
 */
export async function exportEmployees(db: HrDb, user: AuthUser, q: { status?: string; departmentId?: unknown }, format: FileFormat) {
  const filter: Record<string, unknown> = { organisationId: user.organisationId };
  if (q.status) filter.status = q.status;
  if (q.departmentId) filter.departmentId = q.departmentId;
  const [rows, departments, groups, org] = await Promise.all([
    db.employees.find(filter).sort({ employeeNo: 1 }).lean(),
    db.departments.find({ organisationId: user.organisationId }, { name: 1 }).lean(),
    db.jobGroups.find({ organisationId: user.organisationId }, { code: 1 }).lean(),
    db.organisations.findById(user.organisationId, { name: 1 }).lean(),
  ]);
  const pay = hasPermission(user, P.SALARY_VIEW);
  const head = ['Number', 'Name', 'Gender', 'Date of birth', 'ID number', 'KRA PIN', 'NSSF', 'SHA', 'Phone', 'Email', 'Department', 'Job title', 'Job group', 'Station', 'Employment', 'Hired', 'Contract ends', 'Status', ...(pay ? ['Basic salary', 'Pay method', 'Bank', 'Account'] : [])];
  const table = [
    head,
    ...rows.map((e) => [
      e.employeeNo,
      [e.firstName, e.otherNames, e.lastName].filter(Boolean).join(' '),
      e.gender ?? '',
      day(e.dateOfBirth),
      e.nationalId ?? '',
      e.kraPin ?? '',
      e.nssfNo ?? '',
      e.shaNo ?? '',
      e.phone ?? '',
      e.email ?? '',
      departments.find((d) => e.departmentId && d._id.equals(e.departmentId))?.name ?? '',
      e.jobTitle ?? '',
      groups.find((g) => e.jobGroupId && g._id.equals(e.jobGroupId))?.code ?? '',
      e.station ?? '',
      e.employmentType,
      day(e.hireDate),
      day(e.contractEndDate),
      e.status,
      ...(pay ? [e.basicSalary?.toString() ?? '', e.payMethod, e.bank?.name ?? '', e.bank?.accountNo ?? ''] : []),
    ]),
  ];
  return inFormat(csvResponse('employees.csv', table), format, 'Staff list', org?.name ?? '');
}
