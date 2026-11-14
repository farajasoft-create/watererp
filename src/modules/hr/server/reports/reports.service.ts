import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { csvResponse } from '@/platform/common/csv';
import { Decimal, dec } from '@/platform/common/money';
import { assertInScope, departmentScope, scopeFilter } from '../access';
import { fullName, HrDb as Db } from '../db';
import { LeaveService } from '../leave/leave.service';
import { PayslipDoc } from '../schemas';

export const RETURN_TYPES = ['PAYE', 'NSSF', 'SHIF', 'AHL', 'NET_PAY'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

const DAY = 86_400_000;
const m = (v: { toString(): string } | null | undefined) => dec(v?.toString()).toFixed(2);
const lineTotal = (s: Pick<PayslipDoc, 'lines'>, type: string) => s.lines.filter((l) => l.type === type).reduce((t, l) => t.plus(dec(l.amount?.toString())), new Decimal(0));

const MERGED = ['gross', 'grossPay', 'nssfEmployee', 'nssfTier1', 'nssfTier2', 'nssfEmployer', 'shif', 'ahlEmployee', 'ahlEmployer', 'pensionRelief', 'taxablePay', 'taxCharged', 'personalRelief', 'paye', 'netPay', 'nita'] as const;
type Merged = (typeof MERGED)[number];

/** One row per employee for the month, adding up their payslips from every payroll that month. */
function byEmployee<T extends Pick<PayslipDoc, 'lines' | 'employeeId'> & { employee?: unknown } & Partial<Record<Merged, { toString(): string } | null>>>(slips: T[]) {
  type Row = { employee: T['employee']; basic: Decimal } & Record<Merged, Decimal>;
  const out = new Map<string, Row>();
  for (const s of slips) {
    const key = s.employeeId.toHexString();
    const row = out.get(key) ?? ({ employee: s.employee, basic: new Decimal(0), ...Object.fromEntries(MERGED.map((k) => [k, new Decimal(0)])) } as Row);
    for (const k of MERGED) row[k] = row[k].plus(dec(s[k]?.toString()));
    row.basic = row.basic.plus(lineTotal(s, 'BASIC'));
    out.set(key, row);
  }
  return [...out.values()];
}

/** The 9th of the month after the payroll month: when PAYE, NSSF, SHIF and the housing levy are due. */
export function remittanceDue(period: string): string {
  const [y, mo] = period.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 9)).toISOString().slice(0, 10);
}

export class HrReportsService {
  constructor(
    private readonly db: Db,
    private readonly leave: LeaveService,
  ) {}

  async dashboard(user: AuthUser) {
    const org = user.organisationId;
    const scope = scopeFilter(user);
    const scopeIds = departmentScope(user);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const soon = (days: number) => ({ $gte: now, $lte: new Date(now.getTime() + days * DAY) });
    const [byStatus, byDepartment, departments, joiners, leavers, latestRun, pendingLeave, away, contracts, probation, missing] = await Promise.all([
      this.db.employees.aggregate<{ _id: string; n: number }>([{ $match: { organisationId: org, ...scope } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      this.db.employees.aggregate<{ _id: Types.ObjectId | null; n: number }>([{ $match: { organisationId: org, status: 'ACTIVE', ...scope } }, { $group: { _id: '$departmentId', n: { $sum: 1 } } }]),
      this.db.departments.find({ organisationId: org }, { name: 1 }).lean(),
      this.db.employees.countDocuments({ organisationId: org, hireDate: { $gte: monthStart }, ...scope }),
      this.db.employees.countDocuments({ organisationId: org, terminationDate: { $gte: monthStart }, ...scope }),
      this.db.payRuns.findOne({ organisationId: org, kind: 'REGULAR', status: { $ne: 'CANCELLED' } }, { entries: 0 }).sort({ period: -1 }).lean(),
      this.db.leaveRequests.countDocuments({ organisationId: org, status: 'PENDING', ...scope }),
      this.leave.away(org, now),
      this.db.employees.find({ organisationId: org, status: 'ACTIVE', contractEndDate: soon(60), ...scope }, { employeeNo: 1, firstName: 1, lastName: 1, contractEndDate: 1 }).sort({ contractEndDate: 1 }).limit(20).lean(),
      this.db.employees.find({ organisationId: org, status: 'ACTIVE', probationEndDate: soon(30), ...scope }, { employeeNo: 1, firstName: 1, lastName: 1, probationEndDate: 1 }).sort({ probationEndDate: 1 }).limit(20).lean(),
      this.db.employees.countDocuments({ organisationId: org, status: 'ACTIVE', ...scope, $or: [{ kraPin: { $in: [null, ''] } }, { nssfNo: { $in: [null, ''] } }, { shaNo: { $in: [null, ''] } }] }),
    ]);
    const names = new Map(departments.map((d) => [d._id.toHexString(), d.name]));
    const person = (e: { _id: Types.ObjectId; employeeNo: string; firstName: string; lastName: string }) => ({ id: e._id, employeeNo: e.employeeNo, name: fullName(e) });
    return {
      headcount: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
      byDepartment: byDepartment.map((d) => ({ department: d._id ? (names.get(d._id.toHexString()) ?? '—') : 'No department', count: d.n })).sort((a, b) => b.count - a.count),
      joiners,
      leavers,
      latestRun: latestRun ? { id: latestRun._id, period: latestRun.period, status: latestRun.status, employeeCount: latestRun.employeeCount, totals: latestRun.totals } : null,
      pendingLeave,
      away: scopeIds.length ? away.filter((a) => a.departmentId && scopeIds.some((d) => d.equals(a.departmentId!))) : away,
      contractsEnding: contracts.map((e) => ({ ...person(e), date: e.contractEndDate })),
      probationEnding: probation.map((e) => ({ ...person(e), date: e.probationEndDate })),
      missingStatutoryNumbers: missing,
    };
  }

  private async slipsFor(organisationId: Types.ObjectId, period: string) {
    const runs = await this.db.payRuns.find({ organisationId, period, status: { $in: ['APPROVED', 'PAID'] } }, { _id: 1 }).lean();
    if (!runs.length) throw new BadRequestException(`There is no approved payroll for ${period}`);
    return this.db.payslips.find({ organisationId, payRunId: { $in: runs.map((r) => r._id) } }).sort({ 'employee.employeeNo': 1, createdAt: 1 }).lean();
  }

  /** Totals to remit for a month, and when they are due. */
  async statutory(user: AuthUser, period: string) {
    const slips = await this.slipsFor(user.organisationId, period);
    const sum = (f: (s: (typeof slips)[number]) => { toString(): string } | null | undefined) => slips.reduce((t, s) => t.plus(dec(f(s)?.toString())), new Decimal(0)).toFixed(2);
    return {
      period,
      due: remittanceDue(period),
      employees: new Set(slips.map((s) => s.employeeId.toHexString())).size,
      paye: sum((s) => s.paye),
      nssf: { employee: sum((s) => s.nssfEmployee), employer: sum((s) => s.nssfEmployer), tier1: sum((s) => s.nssfTier1), tier2: sum((s) => s.nssfTier2) },
      shif: sum((s) => s.shif),
      ahl: { employee: sum((s) => s.ahlEmployee), employer: sum((s) => s.ahlEmployer) },
      nita: sum((s) => s.nita),
      netPay: sum((s) => s.netPay),
      gross: sum((s) => s.gross),
    };
  }

  /** The schedules each authority asks for (KRA iTax P10, NSSF, SHA, housing levy) and the bank/M-Pesa list. */
  async returnCsv(user: AuthUser, period: string, type: ReturnType): Promise<Response> {
    const each = await this.slipsFor(user.organisationId, period);
    const slips = byEmployee(each);
    const who = (s: { employee?: (typeof each)[number]['employee'] }) => [s.employee?.employeeNo, s.employee?.name];
    const rows: unknown[][] =
      type === 'PAYE'
        ? [
            ['Employee no', 'Name', 'KRA PIN', 'Basic', 'Gross pay', 'NSSF', 'SHIF', 'Housing levy', 'Pension relief', 'Taxable pay', 'Tax charged', 'Personal relief', 'PAYE'],
            ...slips.map((s) => [...who(s), s.employee?.kraPin, s.basic.toFixed(2), m(s.grossPay), m(s.nssfEmployee), m(s.shif), m(s.ahlEmployee), m(s.pensionRelief), m(s.taxablePay), m(s.taxCharged), m(s.personalRelief), m(s.paye)]),
          ]
        : type === 'NSSF'
          ? [
              ['Employee no', 'Name', 'ID number', 'KRA PIN', 'NSSF number', 'Gross pay', 'Tier I (employee)', 'Tier II (employee)', 'Employer', 'Total'],
              ...slips.map((s) => [...who(s), s.employee?.nationalId, s.employee?.kraPin, s.employee?.nssfNo, m(s.grossPay), m(s.nssfTier1), m(s.nssfTier2), m(s.nssfEmployer), s.nssfEmployee.plus(s.nssfEmployer).toFixed(2)]),
            ]
          : type === 'SHIF'
            ? [['Employee no', 'Name', 'ID number', 'SHA number', 'Gross pay', 'SHIF'], ...slips.map((s) => [...who(s), s.employee?.nationalId, s.employee?.shaNo, m(s.grossPay), m(s.shif)])]
            : type === 'AHL'
              ? [
                  ['Employee no', 'Name', 'ID number', 'KRA PIN', 'Gross pay', 'Employee levy', 'Employer levy', 'Total'],
                  ...slips.map((s) => [...who(s), s.employee?.nationalId, s.employee?.kraPin, m(s.grossPay), m(s.ahlEmployee), m(s.ahlEmployer), s.ahlEmployee.plus(s.ahlEmployer).toFixed(2)]),
                ]
              : [
                  // Paid per payroll, so one row per payslip.
                  ['Employee no', 'Name', 'Payroll', 'Pay method', 'Bank', 'Branch', 'Account number', 'M-Pesa number', 'Net pay'],
                  ...each.map((s) => [...who(s), s.title ?? 'Monthly', s.employee?.payMethod, s.employee?.bankName, s.employee?.bankBranch, s.employee?.accountNo, s.employee?.mpesaPhone, m(s.netPay)]),
                ];
    return csvResponse(`${type.toLowerCase().replace('_', '-')}-${period}.csv`, rows);
  }

  /** Every payslip of a payroll in one sheet, for review and audit. */
  async registerCsv(user: AuthUser, runId: Types.ObjectId): Promise<Response> {
    const run = await this.db.payRuns.findOne({ _id: runId, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    const slips = await this.db.payslips.find({ payRunId: runId }).sort({ 'employee.employeeNo': 1 }).lean();
    const rows = [
      ['Payslip no', 'Employee no', 'Name', 'Department', 'Days paid', 'Basic', 'Other pay', 'Gross', 'PAYE', 'NSSF', 'SHIF', 'Housing levy', 'Other deductions', 'Total deductions', 'Net pay', 'Employer NSSF', 'Employer housing levy', 'NITA', 'Employer cost', 'Warnings'],
      ...slips.map((s) => {
        const basic = lineTotal(s, 'BASIC');
        return [
          s.payslipNo ?? 'draft',
          s.employee?.employeeNo,
          s.employee?.name,
          s.employee?.department,
          s.daysInPeriod ? `${s.daysPaid}/${s.daysInPeriod}` : '',
          basic.toFixed(2),
          dec(s.gross?.toString()).minus(basic).toFixed(2),
          m(s.gross),
          m(s.paye),
          m(s.nssfEmployee),
          m(s.shif),
          m(s.ahlEmployee),
          m(s.otherDeductions),
          m(s.totalDeductions),
          m(s.netPay),
          m(s.nssfEmployer),
          m(s.ahlEmployer),
          m(s.nita),
          m(s.employerCost),
          (s.warnings ?? []).join('; '),
        ];
      }),
    ];
    return csvResponse(`payroll-register-${run.period}${run.kind === 'OFF_CYCLE' ? `-${run.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}.csv`, rows);
  }

  /** The year's tax deduction card (P9A) for one employee, from their approved payslips. */
  async p9(organisationId: Types.ObjectId, employeeId: Types.ObjectId, year: number, user?: AuthUser) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    if (user) assertInScope(user, e.departmentId);
    const [org, slips] = await Promise.all([
      this.db.organisations.findById(organisationId, { name: 1, kraPin: 1, address: 1 }).lean(),
      this.db.payslips.find({ organisationId, employeeId, status: { $in: ['APPROVED', 'PAID'] }, period: { $gte: `${year}-01`, $lte: `${year}-12` } }).sort({ period: 1 }).lean(),
    ]);
    const months = Array.from({ length: 12 }, (_, i) => {
      const period = `${year}-${String(i + 1).padStart(2, '0')}`;
      const own = slips.filter((s) => s.period === period);
      const t = (f: (s: (typeof slips)[number]) => { toString(): string } | null | undefined) => own.reduce((sum, s) => sum.plus(dec(f(s)?.toString())), new Decimal(0));
      const basic = own.reduce((sum, s) => sum.plus(lineTotal(s, 'BASIC')), new Decimal(0));
      const gross = t((s) => s.grossPay);
      return {
        period,
        basic: basic.toFixed(2),
        otherPay: gross.minus(basic).toFixed(2),
        gross: gross.toFixed(2),
        retirement: t((s) => s.nssfEmployee).plus(t((s) => s.pensionRelief)).toFixed(2),
        shif: t((s) => s.shif).toFixed(2),
        ahl: t((s) => s.ahlEmployee).toFixed(2),
        taxablePay: t((s) => s.taxablePay).toFixed(2),
        taxCharged: t((s) => s.taxCharged).toFixed(2),
        relief: t((s) => s.personalRelief).toFixed(2),
        paye: t((s) => s.paye).toFixed(2),
      };
    });
    const keys = ['basic', 'otherPay', 'gross', 'retirement', 'shif', 'ahl', 'taxablePay', 'taxCharged', 'relief', 'paye'] as const;
    const totals = Object.fromEntries(keys.map((k) => [k, months.reduce((s, row) => s.plus(row[k]), new Decimal(0)).toFixed(2)]));
    return {
      year,
      employer: { name: org?.name, kraPin: org?.kraPin, address: org?.address },
      employee: { employeeNo: e.employeeNo, name: fullName(e), kraPin: e.kraPin, nationalId: e.nationalId },
      months,
      totals,
    };
  }
}
