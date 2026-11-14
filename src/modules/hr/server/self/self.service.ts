import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { NotFoundException } from '@/platform/common/errors';
import { fullName, HrDb as Db } from '../db';
import { LeaveService } from '../leave/leave.service';
import { PayrollService } from '../payroll/payroll.service';
import { HrReportsService } from '../reports/reports.service';

/** What employees see of themselves: payslips, P9s and leave. Everything is keyed to their own login. */
export class SelfService {
  constructor(
    private readonly db: Db,
    private readonly payroll: PayrollService,
    private readonly leave: LeaveService,
    private readonly reports: HrReportsService,
  ) {}

  private async employee(user: AuthUser) {
    const e = await this.db.employees.findOne({ organisationId: user.organisationId, userId: user.id }).lean();
    if (!e) throw new NotFoundException('Your login is not linked to an employee record yet; ask HR to link it');
    return e;
  }

  async me(user: AuthUser) {
    const e = await this.employee(user);
    const year = new Date().getUTCFullYear();
    const [department, balances, payslips, requests, types] = await Promise.all([
      e.departmentId ? this.db.departments.findById(e.departmentId, { name: 1 }).lean() : null,
      this.leave.balances(user.organisationId, e, year),
      this.db.payslips.find({ organisationId: user.organisationId, employeeId: e._id, status: { $in: ['APPROVED', 'PAID'] } }, { period: 1, title: 1, payslipNo: 1, gross: 1, totalDeductions: 1, netPay: 1 }).sort({ period: -1 }).limit(36).lean(),
      this.db.leaveRequests.find({ organisationId: user.organisationId, employeeId: e._id }).sort({ startDate: -1 }).limit(30).lean(),
      this.db.leaveTypes.find({ organisationId: user.organisationId, active: true }, { name: 1, code: 1, gender: 1 }).lean(),
    ]);
    return {
      employee: { id: e._id, employeeNo: e.employeeNo, name: fullName(e), jobTitle: e.jobTitle, department: department?.name ?? null, hireDate: e.hireDate, kraPin: e.kraPin, status: e.status },
      year,
      balances,
      payslips,
      requests: await this.leave.describe(requests),
      leaveTypes: types.filter((t) => !t.gender || !e.gender || t.gender === e.gender),
    };
  }

  async payslip(user: AuthUser, id: Types.ObjectId) {
    const e = await this.employee(user);
    const slip = await this.db.payslips.findOne({ _id: id, organisationId: user.organisationId, employeeId: e._id, status: { $in: ['APPROVED', 'PAID'] } }, { repayments: 0 }).lean();
    if (!slip) throw new NotFoundException('Payslip not found');
    return this.payroll.withOrganisation(slip);
  }

  async p9(user: AuthUser, year: number) {
    const e = await this.employee(user);
    return this.reports.p9(user.organisationId, e._id, year);
  }

  async applyForLeave(user: AuthUser, input: { leaveTypeId: Types.ObjectId; startDate: Date; endDate: Date; reason?: string; handoverTo?: Types.ObjectId | null; handoverNotes?: string }) {
    const e = await this.employee(user);
    return this.leave.request(user, { ...input, employeeId: e._id });
  }

  cancelLeave(user: AuthUser, id: Types.ObjectId) {
    return this.leave.cancel(user, id, true);
  }
}
