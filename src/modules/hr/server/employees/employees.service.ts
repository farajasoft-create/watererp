import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope, canSeePay, redact, scopeFilter } from '../access';
import { fullName, HrDb as Db, hrSettings } from '../db';

export interface EmployeeInput {
  employeeNo?: string;
  firstName: string;
  lastName: string;
  otherNames?: string;
  gender?: 'MALE' | 'FEMALE' | null;
  dateOfBirth?: Date | null;
  nationalId?: string;
  kraPin?: string;
  nssfNo?: string;
  shaNo?: string;
  phone?: string;
  email?: string;
  address?: string;
  departmentId?: Types.ObjectId | null;
  jobTitle?: string;
  employmentType: 'PERMANENT' | 'CONTRACT' | 'CASUAL' | 'INTERN';
  hireDate: Date;
  probationEndDate?: Date | null;
  contractEndDate?: Date | null;
  managerId?: Types.ObjectId | null;
  nextOfKin?: { name?: string; phone?: string; relationship?: string };
  station?: string;
  payGroup?: 'STAFF' | 'BOARD' | 'SECONDED';
  qualifications?: { level: string; title: string; institution?: string; year?: number | null }[];
  dependants?: { name: string; relationship: string; dateOfBirth?: Date | null }[];
}

export interface PayDetailsInput {
  basicSalary: Decimal;
  payType?: 'MONTHLY' | 'DAILY' | 'HOURLY';
  /** Pay for a day or an hour, for daily and hourly staff. */
  rate?: Decimal;
  payMethod: 'BANK' | 'MPESA' | 'CASH';
  bank?: { name?: string; branch?: string; accountNo?: string; accountName?: string };
  mpesaPhone?: string;
  exempt: { paye: boolean; nssf: boolean; shif: boolean; ahl: boolean };
  /** Grade and notch; on a scale, the notch sets the basic salary. */
  jobGroupId?: Types.ObjectId | null;
  notch?: number | null;
  /** Contract gratuity accrued each month, % of basic pay. */
  gratuityRate?: number;
}

export interface PayItemInput {
  kind: 'EARNING' | 'DEDUCTION';
  code: string;
  name: string;
  amount: Decimal;
  taxable: boolean;
  pension: boolean;
  insurance?: boolean;
  employerAmount?: Decimal | null;
  employerRate?: number | null;
  memberNo?: string | null;
  balance?: Decimal | null;
  fromPeriod: string;
  toPeriod?: string | null;
}

const duplicate = (err: unknown) => (err as { code?: number }).code === 11000;

export class EmployeesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Loads an employee the user may see, or fails. */
  async find(user: AuthUser, id: Types.ObjectId) {
    const e = await this.db.employees.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    return e;
  }

  async list(user: AuthUser, q: { search?: string; departmentId?: Types.ObjectId; status?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, ...scopeFilter(user) };
    if (q.status) filter.status = q.status;
    if (q.departmentId) filter.departmentId = q.departmentId;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
      filter.$or = [{ employeeNo: rx }, { firstName: rx }, { lastName: rx }, { nationalId: rx }, { kraPin: rx }, { phone: rx }, { email: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.employees
        .find(filter)
        .sort({ employeeNo: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.employees.countDocuments(filter),
    ]);
    return { items: items.map((e) => redact(user, e)), total, page: q.page, pageSize: q.pageSize };
  }

  /** Short list for pickers (managers, leave on behalf of someone). */
  /** Staff to pick from; `withLeavers` adds those who left, for final dues. */
  async options(user: AuthUser, withLeavers = false) {
    const rows = await this.db.employees
      .find({ organisationId: user.organisationId, ...(withLeavers ? {} : { status: { $ne: 'TERMINATED' } }), ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, departmentId: 1, gender: 1, status: 1 })
      .sort({ employeeNo: 1 })
      .lean();
    return rows.map((e) => ({ id: e._id, employeeNo: e.employeeNo, name: fullName(e), departmentId: e.departmentId, gender: e.gender, status: e.status }));
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const e = await this.find(user, id);
    const [department, manager, portalUser, payItems, payslips] = await Promise.all([
      e.departmentId ? this.db.departments.findById(e.departmentId, { code: 1, name: 1 }).lean() : null,
      e.managerId ? this.db.employees.findById(e.managerId, { employeeNo: 1, firstName: 1, lastName: 1 }).lean() : null,
      e.userId ? this.db.users.findById(e.userId, { email: 1, active: 1 }).lean() : null,
      canSeePay(user) ? this.db.payItems.find({ organisationId: user.organisationId, employeeId: id }).sort({ active: -1, kind: 1, code: 1 }).lean() : [],
      canSeePay(user)
        ? this.db.payslips.find({ organisationId: user.organisationId, employeeId: id, status: { $in: ['APPROVED', 'PAID'] } }, { period: 1, payslipNo: 1, gross: 1, paye: 1, netPay: 1, status: 1 }).sort({ period: -1 }).limit(24).lean()
        : [],
    ]);
    return {
      ...redact(user, e),
      department,
      manager: manager ? { id: manager._id, employeeNo: manager.employeeNo, name: fullName(manager) } : null,
      portalUser: portalUser ? { email: portalUser.email, active: portalUser.active } : null,
      payItems,
      payslips,
    };
  }

  async create(user: AuthUser, input: EmployeeInput, pay?: PayDetailsInput) {
    if (pay && !hasPermission(user, P.SALARY_MANAGE)) throw new ForbiddenException('You may not set pay details');
    assertInScope(user, input.departmentId);
    const settings = await hrSettings(this.db, user.organisationId);
    return this.db.transaction(async (session) => {
      const employeeNo = input.employeeNo?.trim() || `${settings.employeeNoPrefix ?? 'EMP'}-${String(await this.db.next(user.organisationId, 'hr:employee', session)).padStart(4, '0')}`;
      try {
        const scaled = pay ? await onScale(this.db, user.organisationId, pay) : undefined;
        const [doc] = await this.db.employees.create([{ organisationId: user.organisationId, ...input, employeeNo, ...(scaled ? payFields(scaled) : {}) }], { session });
        await this.audit.record(user, 'hr.employee.create', 'hrEmployee', doc._id, { employeeNo, name: fullName(input) }, session);
        return doc.toObject();
      } catch (err) {
        if (duplicate(err)) throw new ConflictException(`Employee number ${employeeNo} or ID number ${input.nationalId ?? ''} is already in use`);
        throw err;
      }
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: EmployeeInput) {
    await this.find(user, id);
    assertInScope(user, input.departmentId);
    if (input.managerId?.equals(id)) throw new BadRequestException('An employee cannot be their own manager');
    try {
      const doc = await this.db.employees.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { ...input, employeeNo: input.employeeNo?.trim() || undefined }, { new: true }).lean();
      await this.audit.record(user, 'hr.employee.update', 'hrEmployee', id, { name: fullName(input) });
      return redact(user, doc!);
    } catch (err) {
      if (duplicate(err)) throw new ConflictException('That employee number or ID number is already in use');
      throw err;
    }
  }

  async updatePay(user: AuthUser, id: Types.ObjectId, pay: PayDetailsInput) {
    const before = await this.find(user, id);
    pay = await onScale(this.db, user.organisationId, pay);
    const doc = await this.db.employees.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, payFields(pay), { new: true }).lean();
    await this.audit.record(user, 'hr.employee.pay', 'hrEmployee', id, {
      basicSalary: { from: before.basicSalary?.toString(), to: pay.basicSalary.toFixed(2) },
      payType: { from: before.payType, to: pay.payType ?? 'MONTHLY' },
      rate: pay.rate?.toFixed(2),
      payMethod: pay.payMethod,
    });
    return doc;
  }

  async terminate(user: AuthUser, id: Types.ObjectId, input: { date: Date; reason: string; note?: string }) {
    const e = await this.find(user, id);
    if (e.status === 'TERMINATED') throw new BadRequestException('The employee has already left');
    if (input.date < e.hireDate) throw new BadRequestException('The last day cannot be before the hire date');
    await this.db.employees.updateOne({ _id: id }, { status: 'TERMINATED', terminationDate: input.date, terminationReason: input.reason, terminationNote: input.note });
    // Their portal sign-in ends with the job; HR can reopen it on rehire.
    if (e.userId) await this.db.users.updateOne({ _id: e.userId, isAdmin: { $ne: true } }, { $pull: { access: { module: 'hr', role: 'EMPLOYEE' } } });
    await this.audit.record(user, 'hr.employee.terminate', 'hrEmployee', id, input);
    return this.get(user, id);
  }

  async reinstate(user: AuthUser, id: Types.ObjectId, hireDate: Date) {
    const e = await this.find(user, id);
    if (e.status !== 'TERMINATED' && e.status !== 'SUSPENDED') throw new BadRequestException('The employee is active');
    await this.db.employees.updateOne({ _id: id }, { status: 'ACTIVE', hireDate: e.status === 'TERMINATED' ? hireDate : e.hireDate, $unset: { terminationDate: 1, terminationReason: 1, terminationNote: 1 } });
    await this.audit.record(user, 'hr.employee.reinstate', 'hrEmployee', id, { hireDate });
    return this.get(user, id);
  }

  async suspend(user: AuthUser, id: Types.ObjectId, note: string) {
    const e = await this.find(user, id);
    if (e.status !== 'ACTIVE') throw new BadRequestException('Only an active employee can be suspended');
    await this.db.employees.updateOne({ _id: id }, { status: 'SUSPENDED', terminationNote: note });
    await this.audit.record(user, 'hr.employee.suspend', 'hrEmployee', id, { note });
    return this.get(user, id);
  }

  /**
   * Lets the employee sign in to see their payslips and apply for leave. Someone who already has a
   * login (a meter reader, say) keeps it and gains self-service; otherwise a login is created.
   */
  async grantPortal(user: AuthUser, id: Types.ObjectId, password?: string) {
    const e = await this.find(user, id);
    if (e.status === 'TERMINATED') throw new BadRequestException('The employee has left');
    if (!e.email) throw new BadRequestException("Add the employee's email address first; it is their sign-in");
    const email = e.email.toLowerCase().trim();
    const existing = await this.db.users.findOne({ email }).lean();
    if (existing && !existing.organisationId.equals(user.organisationId)) throw new ConflictException('That email signs in to another organisation');
    if (existing && (await this.db.employees.exists({ organisationId: user.organisationId, userId: existing._id, _id: { $ne: id } }))) throw new ConflictException('That login belongs to another employee');

    let userId: Types.ObjectId;
    if (existing) {
      userId = existing._id;
      if (!existing.isAdmin && !(existing.access ?? []).some((a) => a.module === 'hr')) await this.db.users.updateOne({ _id: userId }, { $push: { access: { module: 'hr', role: 'EMPLOYEE', scope: [] } } });
    } else {
      if (!password) throw new BadRequestException('Set a first password for the new login');
      const [created] = await this.db.users.create([{ organisationId: user.organisationId, name: fullName(e), email, phone: e.phone, access: [{ module: 'hr', role: 'EMPLOYEE', scope: [] }], passwordHash: await bcrypt.hash(password, 10) }]);
      userId = created._id;
    }
    await this.db.employees.updateOne({ _id: id }, { userId });
    await this.audit.record(user, 'hr.employee.portal', 'hrEmployee', id, { email, newLogin: !existing });
    return { email, newLogin: !existing };
  }

  // Pay items ------------------------------------------------------------------------------------

  async addPayItem(user: AuthUser, employeeId: Types.ObjectId, input: PayItemInput) {
    await this.find(user, employeeId);
    checkPeriods(input);
    const [doc] = await this.db.payItems.create([{ organisationId: user.organisationId, employeeId, ...itemFields(input) }]);
    await this.audit.record(user, 'hr.payItem.create', 'hrPayItem', doc._id, { employeeId, code: input.code, amount: input.amount.toFixed(2) });
    return doc.toObject();
  }

  async updatePayItem(user: AuthUser, id: Types.ObjectId, input: PayItemInput & { active: boolean }) {
    checkPeriods(input);
    const doc = await this.db.payItems.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { ...itemFields(input), active: input.active }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Pay item not found');
    await this.audit.record(user, 'hr.payItem.update', 'hrPayItem', id, { code: input.code, amount: input.amount.toFixed(2), active: input.active });
    return doc;
  }
}

function payFields(pay: PayDetailsInput) {
  return {
    basicSalary: toD128(pay.payType && pay.payType !== 'MONTHLY' ? 0 : pay.basicSalary),
    payType: pay.payType ?? 'MONTHLY',
    rate: toD128(pay.rate ?? 0),
    payMethod: pay.payMethod,
    bank: pay.bank ?? {},
    mpesaPhone: pay.mpesaPhone,
    exempt: pay.exempt,
    ...(pay.jobGroupId !== undefined && { jobGroupId: pay.jobGroupId, notch: pay.notch ?? null }),
    ...(pay.gratuityRate !== undefined && { gratuityRate: pay.gratuityRate }),
  };
}

/** Puts the basic salary on the scale when a job group with notches is chosen. */
async function onScale(db: Db, organisationId: Types.ObjectId, pay: PayDetailsInput) {
  if (!pay.jobGroupId) return pay;
  const group = await db.jobGroups.findOne({ _id: pay.jobGroupId, organisationId }).lean();
  if (!group) throw new BadRequestException('Job group not found');
  if (!group.notches.length) return pay;
  if (!pay.notch || pay.notch < 1 || pay.notch > group.notches.length) throw new BadRequestException(`Choose a notch from 1 to ${group.notches.length} on ${group.code}`);
  return { ...pay, basicSalary: new Decimal(group.notches[pay.notch - 1].toString()) };
}

function itemFields(i: PayItemInput) {
  return {
    kind: i.kind,
    code: i.code.toUpperCase(),
    name: i.name,
    amount: toD128(i.amount),
    taxable: i.kind === 'EARNING' ? i.taxable : true,
    pension: i.kind === 'DEDUCTION' ? i.pension : false,
    insurance: i.kind === 'DEDUCTION' ? !!i.insurance : false,
    employerAmount: i.kind === 'DEDUCTION' && i.pension && i.employerAmount ? toD128(i.employerAmount) : null,
    employerRate: i.kind === 'DEDUCTION' && i.pension && i.employerRate ? i.employerRate : null,
    memberNo: i.kind === 'DEDUCTION' && i.pension && i.memberNo ? i.memberNo : null,
    balance: i.kind === 'DEDUCTION' && i.balance ? toD128(i.balance) : null,
    fromPeriod: i.fromPeriod,
    toPeriod: i.toPeriod ?? null,
  };
}

function checkPeriods(i: PayItemInput) {
  if (i.toPeriod && i.toPeriod < i.fromPeriod) throw new BadRequestException('The last month cannot be before the first');
  if (i.amount.lte(0)) throw new BadRequestException('Enter an amount above zero');
}
