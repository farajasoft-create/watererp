import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { EventBus } from '@/platform/events';
import { AuditService } from '@/platform/services/audit.service';
import { assertInScope, scopeFilter } from '../access';
import { EmployeeDoc } from '../schemas';
import { fullName, HrDb as Db } from '../db';
import { periodEnd, periodStart, workingDays } from '../payroll/calendar';
import { HrSettingsService } from '../setup/settings.service';
import { balance, earned } from './entitlement';

export interface LeaveRequestInput {
  employeeId: Types.ObjectId;
  leaveTypeId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  reason?: string;
  /** Who covers while the employee is away, and what was handed over. */
  handoverTo?: Types.ObjectId | null;
  handoverNotes?: string;
}

export interface AdjustmentInput {
  employeeId: Types.ObjectId;
  leaveTypeId: Types.ObjectId;
  year: number;
  days: number;
  kind: 'OPENING' | 'ADJUSTMENT' | 'ENCASHMENT';
  reason: string;
}

const yearRange = (year: number) => ({ $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) });

export class LeaveService {
  /** Tells people about leave decisions (set by the container to the platform notifications). */
  notify: (organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { title: string; body?: string; link?: string }) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: HrSettingsService,
    private readonly events: EventBus,
  ) {}

  async days(organisationId: Types.ObjectId, start: Date, end: Date) {
    if (end < start) throw new BadRequestException('The leave ends before it starts');
    return workingDays(start, end, await this.settings.holidays(organisationId));
  }

  /** Every leave type the employee can take, with what they have earned, taken and have left. */
  async balances(organisationId: Types.ObjectId, employee: Pick<EmployeeDoc, '_id' | 'hireDate' | 'gender'>, year: number, asOf = new Date()) {
    const [types, adjustments, used] = await Promise.all([
      this.db.leaveTypes.find({ organisationId, active: true }).sort({ name: 1 }).lean(),
      this.db.leaveAdjustments.aggregate<{ _id: Types.ObjectId; days: number }>([{ $match: { organisationId, employeeId: employee._id, year } }, { $group: { _id: '$leaveTypeId', days: { $sum: '$days' } } }]),
      this.db.leaveRequests.aggregate<{ _id: { t: Types.ObjectId; s: string }; days: number }>([
        { $match: { organisationId, employeeId: employee._id, status: { $in: ['APPROVED', 'PENDING'] }, startDate: yearRange(year) } },
        { $group: { _id: { t: '$leaveTypeId', s: '$status' }, days: { $sum: '$days' } } },
      ]),
    ]);
    const adj = new Map(adjustments.map((a) => [a._id.toHexString(), a.days]));
    const usedBy = (t: Types.ObjectId, s: string) => used.find((u) => u._id.t.equals(t) && u._id.s === s)?.days ?? 0;
    return types
      .filter((t) => !t.gender || !employee.gender || t.gender === employee.gender)
      .map((t) => ({
        leaveTypeId: t._id,
        code: t.code,
        name: t.name,
        paid: t.paid,
        unlimited: t.unlimited,
        ...balance(t.unlimited ? 0 : earned({ daysPerYear: t.daysPerYear ?? 0, accrual: (t.accrual as 'MONTHLY' | 'ANNUAL') ?? 'ANNUAL' }, year, employee.hireDate, asOf), adj.get(t._id.toHexString()) ?? 0, usedBy(t._id, 'APPROVED'), usedBy(t._id, 'PENDING')),
      }));
  }

  async employeeBalances(user: AuthUser, employeeId: Types.ObjectId, year: number) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    return this.balances(user.organisationId, e, year);
  }

  async list(user: AuthUser, q: { status?: string; employeeId?: Types.ObjectId; from?: Date; to?: Date; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, ...scopeFilter(user) };
    if (q.status) filter.status = q.status;
    if (q.employeeId) filter.employeeId = q.employeeId;
    if (q.from) filter.endDate = { $gte: q.from };
    if (q.to) filter.startDate = { $lte: q.to };
    const [items, total] = await Promise.all([
      this.db.leaveRequests
        .find(filter)
        .sort({ status: -1, startDate: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.leaveRequests.countDocuments(filter),
    ]);
    return { items: await this.describe(items), total, page: q.page, pageSize: q.pageSize };
  }

  /** Adds employee and leave type names to requests. */
  async describe<T extends { employeeId: Types.ObjectId; leaveTypeId: Types.ObjectId }>(rows: T[]) {
    const [employees, types] = await Promise.all([
      this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean(),
      this.db.leaveTypes.find({ _id: { $in: rows.map((r) => r.leaveTypeId) } }, { code: 1, name: 1, paid: 1 }).lean(),
    ]);
    const e = new Map(employees.map((x) => [x._id.toHexString(), x]));
    const t = new Map(types.map((x) => [x._id.toHexString(), x]));
    return rows.map((r) => {
      const emp = e.get(r.employeeId.toHexString());
      return { ...r, employeeNo: emp?.employeeNo, employeeName: emp ? fullName(emp) : '—', leaveType: t.get(r.leaveTypeId.toHexString())?.name ?? '—' };
    });
  }

  /** A leave application, by the employee (self-service) or by HR or a manager for them. */
  async request(user: AuthUser, input: LeaveRequestInput) {
    const e = await this.db.employees.findOne({ _id: input.employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    if (!e.userId?.equals(user.id)) assertInScope(user, e.departmentId);
    if (e.status !== 'ACTIVE') throw new BadRequestException(`${fullName(e)} is not active`);
    const type = await this.db.leaveTypes.findOne({ _id: input.leaveTypeId, organisationId: user.organisationId, active: true }).lean();
    if (!type) throw new NotFoundException('Leave type not found');
    if (type.gender && e.gender && type.gender !== e.gender) throw new BadRequestException(`${type.name} does not apply to this employee`);
    if (input.startDate.getUTCFullYear() !== input.endDate.getUTCFullYear()) throw new BadRequestException('Split leave that crosses into a new year into two applications');
    const days = await this.days(user.organisationId, input.startDate, input.endDate);
    if (days <= 0) throw new BadRequestException('Those dates are all weekends or public holidays');
    const clash = await this.db.leaveRequests.findOne({ organisationId: user.organisationId, employeeId: e._id, status: { $in: ['PENDING', 'APPROVED'] }, startDate: { $lte: input.endDate }, endDate: { $gte: input.startDate } }).lean();
    if (clash) throw new BadRequestException('This overlaps leave already applied for');
    if (!type.unlimited) {
      const b = (await this.balances(user.organisationId, e, input.startDate.getUTCFullYear())).find((x) => x.leaveTypeId.equals(type._id));
      const available = b?.available ?? 0;
      if (days > available) throw new BadRequestException(`Only ${available} ${type.name.toLowerCase()} days are available; this needs ${days}`);
    }
    if (input.handoverTo) {
      if (input.handoverTo.equals(e._id)) throw new BadRequestException('Hand over to someone else');
      const cover = await this.db.employees.findOne({ _id: input.handoverTo, organisationId: user.organisationId, status: 'ACTIVE' }, { _id: 1 }).lean();
      if (!cover) throw new BadRequestException('The person covering must be an active employee');
    }
    const [doc] = await this.db.leaveRequests.create([{ organisationId: user.organisationId, employeeId: e._id, departmentId: e.departmentId, leaveTypeId: type._id, startDate: input.startDate, endDate: input.endDate, days, reason: input.reason, requestedBy: user.id, handoverTo: input.handoverTo ?? null, handoverNotes: input.handoverNotes ?? '' }]);
    await this.audit.record(user, 'hr.leave.request', 'hrLeaveRequest', doc._id, { employeeId: e._id, type: type.code, days });
    return doc.toObject();
  }

  async review(user: AuthUser, id: Types.ObjectId, decision: 'APPROVED' | 'REJECTED', note?: string) {
    const r = await this.db.leaveRequests.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Leave request not found');
    assertInScope(user, r.departmentId);
    if (r.status !== 'PENDING') throw new BadRequestException(`The request is already ${r.status.toLowerCase()}`);
    const e = await this.db.employees.findById(r.employeeId, { userId: 1 }).lean();
    if (e?.userId?.equals(user.id)) throw new ForbiddenException('Someone else must approve your own leave');
    const updated = await this.db.leaveRequests.findOneAndUpdate({ _id: id, status: 'PENDING' }, { status: decision, reviewedBy: user.id, reviewedAt: new Date(), reviewNote: note }, { new: true }).lean();
    if (!updated) throw new BadRequestException('The request was changed by someone else');
    await this.audit.record(user, decision === 'APPROVED' ? 'hr.leave.approve' : 'hr.leave.reject', 'hrLeaveRequest', id, { note });
    if (decision === 'APPROVED') await this.events.emit(user.organisationId, 'hr.leave.approved', { leaveRequestId: id, employeeId: r.employeeId, startDate: r.startDate, endDate: r.endDate });
    const span = `${r.startDate.toISOString().slice(0, 10)} to ${r.endDate.toISOString().slice(0, 10)}`;
    if (e?.userId) await this.notify(user.organisationId, [e.userId], { title: `Your leave from ${span} was ${decision === 'APPROVED' ? 'approved' : 'not approved'}`, body: note, link: '/hr/me' });
    if (decision === 'APPROVED' && r.handoverTo) {
      const cover = await this.db.employees.findById(r.handoverTo, { userId: 1 }).lean();
      const away = await this.db.employees.findById(r.employeeId, { firstName: 1, lastName: 1, otherNames: 1 }).lean();
      if (cover?.userId && away) await this.notify(user.organisationId, [cover.userId], { title: `You are covering for ${fullName(away)} from ${span}`, body: r.handoverNotes ?? '', link: '/hr/me' });
    }
    return updated;
  }

  /**
   * Recalls an employee from approved leave already under way: the leave now ends the day before they
   * return, and the working days from the return date are given back to their balance.
   */
  async recall(user: AuthUser, id: Types.ObjectId, input: { returnDate: Date; reason: string }) {
    const r = await this.db.leaveRequests.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Leave request not found');
    assertInScope(user, r.departmentId);
    if (r.status !== 'APPROVED') throw new BadRequestException('Only approved leave can be recalled');
    if (r.recalledAt) throw new BadRequestException('This leave has already been recalled');
    if (input.returnDate <= r.startDate || input.returnDate > r.endDate) throw new BadRequestException('The return date must fall after the first day and within the leave');
    const restored = await this.days(user.organisationId, input.returnDate, r.endDate);
    const newEnd = new Date(input.returnDate.getTime() - 86_400_000);
    const updated = await this.db.leaveRequests.findOneAndUpdate(
      { _id: id, status: 'APPROVED', recalledAt: null },
      { endDate: newEnd, days: r.days - restored, daysRestored: restored, recalledAt: new Date(), recalledBy: user.id, recallReason: input.reason },
      { new: true },
    ).lean();
    if (!updated) throw new BadRequestException('The leave was changed by someone else');
    await this.audit.record(user, 'hr.leave.recall', 'hrLeaveRequest', id, { returnDate: input.returnDate, restored, reason: input.reason });
    const e = await this.db.employees.findById(r.employeeId, { userId: 1 }).lean();
    if (e?.userId) await this.notify(user.organisationId, [e.userId], { title: `You are recalled from leave; please report back on ${input.returnDate.toISOString().slice(0, 10)}`, body: `${input.reason} (${restored} day${restored === 1 ? '' : 's'} returned to your balance)`, link: '/hr/me' });
    return updated;
  }

  /** Withdraws a request still waiting, or approved leave that has not started. */
  async cancel(user: AuthUser, id: Types.ObjectId, own: boolean) {
    const r = await this.db.leaveRequests.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Leave request not found');
    if (own) {
      const e = await this.db.employees.findById(r.employeeId, { userId: 1 }).lean();
      if (!e?.userId?.equals(user.id)) throw new NotFoundException('Leave request not found');
    } else assertInScope(user, r.departmentId);
    const started = r.startDate <= new Date();
    if (r.status !== 'PENDING' && !(r.status === 'APPROVED' && !started)) throw new BadRequestException('Only a request still waiting, or leave that has not started, can be cancelled');
    const updated = await this.db.leaveRequests.findOneAndUpdate({ _id: id, status: r.status }, { status: 'CANCELLED' }, { new: true }).lean();
    await this.audit.record(user, 'hr.leave.cancel', 'hrLeaveRequest', id, { was: r.status });
    return updated;
  }

  async adjust(user: AuthUser, input: AdjustmentInput) {
    const e = await this.db.employees.findOne({ _id: input.employeeId, organisationId: user.organisationId }, { departmentId: 1 }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    if (!(await this.db.leaveTypes.exists({ _id: input.leaveTypeId, organisationId: user.organisationId }))) throw new NotFoundException('Leave type not found');
    const [doc] = await this.db.leaveAdjustments.create([{ organisationId: user.organisationId, ...input, createdBy: user.id }]);
    await this.audit.record(user, 'hr.leave.adjust', 'hrLeaveAdjustment', doc._id, input);
    return doc.toObject();
  }

  /**
   * Moves each active employee's unused days of a year into the next, up to each type's limit. Safe
   * to run again: an employee's carry-forward for a type and year is stored once and then updated.
   */
  async carryForward(user: AuthUser, year: number) {
    const types = await this.db.leaveTypes.find({ organisationId: user.organisationId, active: true, carryForwardMax: { $gt: 0 } }).lean();
    if (!types.length) return { employees: 0, days: 0 };
    const employees = await this.db.employees.find({ organisationId: user.organisationId, status: { $ne: 'TERMINATED' } }, { hireDate: 1, gender: 1 }).lean();
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    let total = 0;
    for (const e of employees) {
      const balances = await this.balances(user.organisationId, e, year, yearEnd);
      for (const t of types) {
        const b = balances.find((x) => x.leaveTypeId.equals(t._id));
        const days = Math.max(0, Math.min(b?.available ?? 0, t.carryForwardMax ?? 0));
        await this.db.leaveAdjustments.updateOne(
          { organisationId: user.organisationId, employeeId: e._id, leaveTypeId: t._id, year: year + 1, kind: 'CARRY_FORWARD' },
          { $set: { days, reason: `Carried forward from ${year}`, createdBy: user.id } },
          { upsert: true },
        );
        total += days;
      }
    }
    await this.audit.record(user, 'hr.leave.carryForward', 'organisation', user.organisationId, { year, employees: employees.length, days: total });
    return { employees: employees.length, days: Math.round(total * 100) / 100 };
  }

  /** Working days of approved unpaid leave each employee has in a payroll month. */
  async unpaidDays(organisationId: Types.ObjectId, period: string): Promise<Map<string, number>> {
    const start = periodStart(period);
    const end = periodEnd(period);
    const unpaid = await this.db.leaveTypes.distinct('_id', { organisationId, paid: false });
    if (!unpaid.length) return new Map();
    const [requests, holidays] = await Promise.all([
      this.db.leaveRequests.find({ organisationId, status: 'APPROVED', leaveTypeId: { $in: unpaid }, startDate: { $lte: end }, endDate: { $gte: start } }, { employeeId: 1, startDate: 1, endDate: 1 }).lean(),
      this.settings.holidays(organisationId),
    ]);
    const out = new Map<string, number>();
    for (const r of requests) {
      const from = r.startDate > start ? r.startDate : start;
      const to = r.endDate < end ? r.endDate : end;
      const key = r.employeeId.toHexString();
      out.set(key, (out.get(key) ?? 0) + workingDays(from, to, holidays));
    }
    return out;
  }

  /** Who is away on a given day (approved leave), for the dashboard. */
  async away(organisationId: Types.ObjectId, day: Date) {
    const rows = await this.db.leaveRequests.find({ organisationId, status: 'APPROVED', startDate: { $lte: day }, endDate: { $gte: day } }).sort({ endDate: 1 }).limit(50).lean();
    return this.describe(rows);
  }
}
