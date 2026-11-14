import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, round, toD128 } from '@/platform/common/money';
import { escapeRegex, formatDate } from '@/platform/common/validation';
import { LedgerService } from '@/platform/ledger/ledger.service';
import { AuditService } from '@/platform/services/audit.service';
import { assertInScope, scopeFilter } from '../access';
import { fullName, HrDb as Db, hrSettings } from '../db';
import { LeaveService } from '../leave/leave.service';
import { PayRunDoc } from '../schemas';
import { HrSettingsService, toRates } from '../setup/settings.service';
import { periodEnd, periodStart, proratedBasic, unpaidLeaveDeduction, workingDays } from './calendar';
import { calculatePay, nssfTiers, PayResult, PriorPay, StatutoryRates } from './engine';
import { schemeAmounts } from './schemes.service';
import { AccountMapping, APPROVAL_ACCOUNTS, missingAccounts, PAYMENT_ACCOUNTS, payrollJournalLines, paymentJournalLines } from './journals';

const TOTAL_KEYS = ['gross', 'paye', 'nssfEmployee', 'nssfEmployer', 'shif', 'ahlEmployee', 'ahlEmployer', 'nita', 'otherDeductions', 'netPay', 'employerPension', 'gratuity', 'gratuityPaid', 'employerCost'] as const;
const PRIOR_KEYS = ['grossPay', 'nssfEmployee', 'shif', 'ahlEmployee', 'ahlEmployer', 'pensionRelief', 'taxablePay', 'taxCharged', 'personalRelief', 'nita'] as const satisfies readonly (keyof PriorPay)[];
const SLIP_AMOUNTS = ['gross', 'grossPay', 'nssfEmployee', 'nssfEmployer', 'shif', 'ahlEmployee', 'ahlEmployer', 'pensionRelief', 'taxablePay', 'taxCharged', 'personalRelief', 'insuranceRelief', 'paye', 'otherDeductions', 'totalDeductions', 'netPay', 'nita', 'employerPension', 'gratuity', 'gratuityPaid', 'employerCost'] as const;

/** Hooks run once a payroll is approved or paid; wired to the ledger and events in the container. */
export interface PayrollHooks {
  afterApproved(user: AuthUser, runId: Types.ObjectId): Promise<void>;
  afterPaid(user: AuthUser, runId: Types.ObjectId): Promise<void>;
}

/** A payment on an off-cycle payroll, as entered. */
export interface PayEntryInput {
  employeeId: Types.ObjectId;
  kind: 'EARNING' | 'DEDUCTION';
  code?: string;
  name: string;
  amount: Decimal;
  taxable: boolean;
  payItemId?: Types.ObjectId;
  leaveTypeId?: Types.ObjectId;
  leaveDays?: number;
  leaveYear?: number;
}

const codeOf = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'PAYMENT';

export class PayrollService {
  hooks: PayrollHooks = { afterApproved: async () => undefined, afterPaid: async () => undefined };

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: HrSettingsService,
    private readonly leave: LeaveService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Works out pay for everyone on a payroll (or one employee). The month's payroll pays basic pay
   * pro-rated for joiners and leavers, unpaid leave, recurring and one-off pay items and loans up to
   * their balance; an off-cycle payroll pays only its own entries. Either way the statutory
   * deductions are worked together with the month's other approved payrolls.
   */
  async calculate(organisationId: Types.ObjectId, period: string, opts: { employeeId?: Types.ObjectId; run?: Pick<PayRunDoc, '_id' | 'kind' | 'entries'> & { payGroup?: string | null } } = {}) {
    const rateSet = await this.settings.ratesFor(organisationId, period);
    const rates = toRates(rateSet);
    const start = periodStart(period);
    const end = periodEnd(period);
    const offCycle = opts.run?.kind === 'OFF_CYCLE';
    const entries = offCycle ? (opts.run?.entries ?? []) : [];
    const filter: Record<string, unknown> = offCycle
      ? { organisationId, _id: { $in: entries.map((x) => x.employeeId) } }
      : {
          organisationId,
          hireDate: { $lte: end },
          $and: [
            { $or: [{ status: 'ACTIVE' }, { status: 'TERMINATED', terminationDate: { $gte: start } }] },
            // Pay stops when a contract ends, even before HR records the exit.
            { $or: [{ contractEndDate: null }, { contractEndDate: { $exists: false } }, { contractEndDate: { $gte: start } }] },
            // Board members and seconded staff have their own payroll.
            opts.run?.kind === 'GROUP' ? { payGroup: opts.run.payGroup } : opts.employeeId ? {} : { payGroup: { $nin: ['BOARD', 'SECONDED'] } },
          ],
        };
    if (opts.employeeId) filter._id = opts.employeeId;
    const employees = await this.db.employees.find(filter).sort({ employeeNo: 1 }).lean();
    const ids = employees.map((e) => e._id);
    const groups = await this.db.jobGroups.find({ organisationId, _id: { $in: employees.map((e) => e.jobGroupId).filter(Boolean) } }).lean();
    const [items, departments, unpaid, holidays, inputs, priors] = await Promise.all([
      this.db.payItems.find({ organisationId, employeeId: { $in: offCycle ? [] : ids }, active: true, fromPeriod: { $lte: period }, $or: [{ toPeriod: null }, { toPeriod: { $gte: period } }] }).sort({ kind: 1, code: 1 }).lean(),
      this.db.departments.find({ organisationId }, { name: 1 }).lean(),
      this.leave.unpaidDays(organisationId, period),
      this.settings.holidays(organisationId),
      this.db.payInputs.find({ organisationId, period, employeeId: { $in: ids } }, { employeeId: 1, units: 1 }).lean(),
      this.priorPay(organisationId, period, ids, opts.run?._id),
    ]);
    const schemes = await this.db.deductionSchemes.find({ organisationId, _id: { $in: items.map((i) => i.schemeId).filter(Boolean) as Types.ObjectId[] } }).lean();
    const schemeOf = (i: { schemeId?: Types.ObjectId | null }) => (i.schemeId ? schemes.find((x) => x._id.equals(i.schemeId!)) : undefined);
    const unitsOf = new Map(inputs.map((i) => [i.employeeId.toHexString(), i.units]));
    const deptName = new Map(departments.map((d) => [d._id.toHexString(), d.name]));
    const monthWorkingDays = workingDays(start, end, holidays);

    const slips = employees.map((e) => {
      const key = e._id.toHexString();
      const prior = priors.get(key);
      const exempt = { paye: Boolean(e.exempt?.paye), nssf: Boolean(e.exempt?.nssf), shif: Boolean(e.exempt?.shif), ahl: Boolean(e.exempt?.ahl) };
      const payType = (e.payType ?? 'MONTHLY') as 'MONTHLY' | 'DAILY' | 'HOURLY';
      const tiersOf = (r: PayResult) => (exempt.nssf ? { tier1: new Decimal(0), tier2: new Decimal(0) } : monthTiers(r, prior, rates.nssf));
      const common = {
        employeeId: e._id,
        employee: {
          employeeNo: e.employeeNo,
          name: fullName(e),
          departmentId: e.departmentId,
          department: e.departmentId ? deptName.get(e.departmentId.toHexString()) : undefined,
          jobTitle: e.jobTitle,
          kraPin: e.kraPin,
          nssfNo: e.nssfNo,
          shaNo: e.shaNo,
          nationalId: e.nationalId,
          payMethod: e.payMethod,
          bankName: e.bank?.name,
          bankBranch: e.bank?.branch,
          accountNo: e.bank?.accountNo,
          mpesaPhone: e.mpesaPhone,
        },
        payType,
        priorGrossPay: prior?.grossPay,
      };

      if (offCycle) {
        const own = entries.filter((x) => x.employeeId.equals(e._id));
        const of = (kind: string) => own.filter((x) => x.kind === kind).map((x) => ({ code: x.code, name: x.name, amount: dec(x.amount?.toString()), taxable: x.taxable !== false, payItemId: x.payItemId }));
        const deductions = of('DEDUCTION');
        const result = calculatePay({ basic: 0, earnings: of('EARNING'), deductions, rates, exempt, prior });
        const tiers = tiersOf(result);
        const repayments = deductions.filter((d) => d.payItemId).map((d) => ({ payItemId: d.payItemId!, amount: d.amount }));
        return { ...common, daysPaid: undefined, daysInPeriod: undefined, unpaidLeaveDays: 0, units: undefined, rate: undefined, result, nssfTier1: tiers.tier1, nssfTier2: tiers.tier2, repayments };
      }

      const own = items.filter((i) => i.employeeId.equals(e._id));
      const leaving = e.status === 'TERMINATED' ? e.terminationDate : (e.contractEndDate ?? null);
      const pr = proratedBasic(e.basicSalary?.toString(), period, e.hireDate, leaving);
      // Daily and hourly staff are paid for the time entered for the month: no pro-rating, and
      // unpaid leave is simply time not worked.
      const rated = payType !== 'MONTHLY';
      const units = rated ? (unitsOf.get(key) ?? 0) : undefined;
      const unit = payType === 'DAILY' ? 'day' : 'hour';
      const basic = rated ? round(dec(e.rate?.toString()).times(units!), 2) : pr.amount;
      const part = !rated && pr.days < pr.ofDays;
      const unpaidDays = rated ? 0 : (unpaid.get(key) ?? 0);
      const unpaidAmount = Decimal.min(unpaidLeaveDeduction(e.basicSalary?.toString(), unpaidDays, monthWorkingDays), pr.amount);

      const earnings = own
        .filter((i) => i.kind === 'EARNING')
        .map((i) => {
          // Recurring allowances follow basic pay for a part month; one-off items are paid as entered.
          const oneOff = i.toPeriod === i.fromPeriod;
          const amount = part && !oneOff ? round(dec(i.amount).times(pr.days).dividedBy(pr.ofDays), 2) : dec(i.amount);
          return { code: i.code, name: i.name, amount, taxable: i.taxable !== false };
        });
      // Allowances that come with the job group, unless the employee has their own item with that code.
      const group = e.jobGroupId ? groups.find((g) => g._id.equals(e.jobGroupId!)) : null;
      for (const a of group?.allowances ?? []) {
        if (rated || earnings.some((x) => x.code === a.code)) continue;
        const amount = part ? round(dec(a.amount?.toString()).times(pr.days).dividedBy(pr.ofDays), 2) : dec(a.amount?.toString());
        earnings.push({ code: a.code, name: a.name, amount, taxable: a.taxable !== false });
      }
      if (unpaidAmount.gt(0)) earnings.unshift({ code: 'UNPAID_LEAVE', name: `Unpaid leave (${unpaidDays} day${unpaidDays === 1 ? '' : 's'})`, amount: unpaidAmount.neg(), taxable: true });

      const repayments: { payItemId: Types.ObjectId; amount: Decimal }[] = [];
      const deductions = own
        .filter((i) => i.kind === 'DEDUCTION')
        .map((i) => {
          const scheme = schemeOf(i);
          let amount = scheme ? (scheme.active === false ? new Decimal(0) : schemeAmounts(scheme, basic).employee) : dec(i.amount);
          if (i.balance !== null && i.balance !== undefined) {
            amount = Decimal.min(amount, Decimal.max(dec(i.balance), 0));
            if (amount.gt(0)) repayments.push({ payItemId: i._id, amount });
          }
          return { code: i.code, name: i.balance ? `${i.name} (balance ${dec(i.balance).toFixed(2)})` : i.name, amount, pension: Boolean(i.pension), insurance: Boolean(i.insurance) };
        })
        .filter((d) => d.amount.gt(0));

      // The employer's share of pension schemes, and gratuity accrued for contract staff, on this month's basic.
      const employerContributions = own
        .filter((i) => i.kind === 'DEDUCTION' && !i.schemeId && i.pension && (i.employerAmount || i.employerRate))
        .map((i) => ({ code: `${i.code}_ER`.slice(0, 16), name: `${i.name} (employer)`, amount: i.employerAmount ? dec(i.employerAmount) : round(basic.times(i.employerRate!).dividedBy(100), 2) }));
      for (const i of own.filter((x) => x.kind === 'DEDUCTION' && x.schemeId)) {
        const scheme = schemeOf(i);
        const er = scheme && scheme.active !== false ? schemeAmounts(scheme, basic).employer : null;
        if (er?.gt(0)) employerContributions.push({ code: `${i.code}_ER`.slice(0, 16), name: `${i.name} (employer)`, amount: er });
      }
      if (!rated && e.gratuityRate) employerContributions.push({ code: 'GRATUITY', name: `Gratuity accrued (${e.gratuityRate}%)`, amount: round(basic.times(e.gratuityRate).dividedBy(100), 2) });
      const result = calculatePay({ basic, basicLabel: rated ? `${units} ${unit}${units === 1 ? '' : 's'} at ${dec(e.rate?.toString()).toFixed(2)}` : undefined, earnings, deductions, employerContributions, rates, exempt, prior });
      const tiers = tiersOf(result);
      if (part) result.warnings.push(`Part month: paid for ${pr.days} of ${pr.ofDays} days`);
      if (e.status !== 'TERMINATED' && e.contractEndDate && e.contractEndDate <= end) result.warnings.push(`Contract ends ${e.contractEndDate.toISOString().slice(0, 10)}: renew it or record the exit`);
      if (rated && dec(e.rate?.toString()).lte(0)) result.warnings.push(`No ${payType === 'DAILY' ? 'daily' : 'hourly'} rate set`);
      else if (rated && !units) result.warnings.push(`No ${unit}s entered for the month`);
      else if (!rated && dec(e.basicSalary?.toString()).lte(0)) result.warnings.push('No basic salary set');

      return {
        ...common,
        daysPaid: pr.days as number | undefined,
        daysInPeriod: pr.ofDays as number | undefined,
        unpaidLeaveDays: unpaidDays,
        units,
        rate: rated ? dec(e.rate?.toString()) : undefined,
        result,
        nssfTier1: tiers.tier1,
        nssfTier2: tiers.tier2,
        repayments,
      };
    });
    return { rateSet, slips };
  }

  /**
   * What each employee was paid, and had deducted, on the month's other approved payrolls. A
   * preview (no payroll yet) counts only off-cycle payrolls, as it stands in for the monthly one.
   */
  private async priorPay(organisationId: Types.ObjectId, period: string, employeeIds: Types.ObjectId[], runId?: Types.ObjectId) {
    const out = new Map<string, Prior>();
    const runs = await this.db.payRuns.find({ organisationId, period, status: { $in: ['APPROVED', 'PAID'] }, ...(runId ? { _id: { $ne: runId } } : { kind: 'OFF_CYCLE' }) }, { _id: 1 }).lean();
    if (!runs.length || !employeeIds.length) return out;
    const slips = await this.db.payslips.find({ organisationId, payRunId: { $in: runs.map((r) => r._id) }, employeeId: { $in: employeeIds } }).lean();
    for (const s of slips) {
      const key = s.employeeId.toHexString();
      const t = out.get(key) ?? (Object.fromEntries([...PRIOR_KEYS, 'nssfTier1'].map((k) => [k, new Decimal(0)])) as Prior);
      for (const k of PRIOR_KEYS) t[k] = t[k].plus(dec(s[k]?.toString()));
      t.nssfTier1 = t.nssfTier1.plus(dec(s.nssfTier1?.toString()));
      out.set(key, t);
    }
    return out;
  }

  /** One employee's pay for a month, worked out without saving anything. */
  async preview(user: AuthUser, employeeId: Types.ObjectId, period: string) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId: user.organisationId }, { departmentId: 1 }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    const { slips } = await this.calculate(user.organisationId, period, { employeeId });
    if (!slips.length) throw new BadRequestException(`The employee is not on the payroll in ${period}`);
    return slips[0];
  }

  listRuns(user: AuthUser) {
    return this.db.payRuns.find({ organisationId: user.organisationId }, { entries: 0 }).sort({ period: -1, createdAt: -1 }).limit(60).lean();
  }

  async getRun(user: AuthUser, id: Types.ObjectId, q: { search?: string; warnings?: boolean; page: number; pageSize: number }) {
    const run = await this.db.payRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    const filter: Record<string, unknown> = { organisationId: user.organisationId, payRunId: id };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
      filter.$or = [{ 'employee.employeeNo': rx }, { 'employee.name': rx }];
    }
    if (q.warnings) filter['warnings.0'] = { $exists: true };
    const [items, total] = await Promise.all([
      this.db.payslips
        .find(filter, { lines: 0, repayments: 0 })
        .sort({ 'employee.employeeNo': 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.payslips.countDocuments(filter),
    ]);
    const rated =
      run.status === 'DRAFT'
        ? (await this.db.payslips.find({ payRunId: id, payType: { $in: ['DAILY', 'HOURLY'] } }, { employeeId: 1, employee: 1, payType: 1, units: 1, rate: 1 }).sort({ 'employee.employeeNo': 1 }).lean()).map((p) => ({
            employeeId: p.employeeId,
            employeeNo: p.employee?.employeeNo,
            name: p.employee?.name,
            payType: p.payType,
            units: p.units ?? 0,
            rate: p.rate,
          }))
        : [];
    const people = run.entries?.length ? await this.db.employees.find({ _id: { $in: run.entries.map((x) => x.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean() : [];
    const who = new Map(people.map((p) => [p._id.toHexString(), p]));
    const entries = (run.entries ?? []).map((x) => {
      const p = who.get(x.employeeId.toHexString());
      return { ...x, employeeNo: p?.employeeNo, employeeName: p ? fullName(p) : undefined };
    });
    return { ...run, entries, rated, payslips: { items, total, page: q.page, pageSize: q.pageSize } };
  }

  /** Days or hours worked by daily and hourly staff; the draft payroll is worked again with them. */
  async setUnits(user: AuthUser, id: Types.ObjectId, rows: { employeeId: Types.ObjectId; units: number }[]) {
    const run = await this.db.payRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    if (run.status !== 'DRAFT' || run.kind === 'OFF_CYCLE') throw new BadRequestException('Days and hours are entered on the draft monthly payroll');
    const rated = await this.db.employees.find({ organisationId: user.organisationId, _id: { $in: rows.map((r) => r.employeeId) }, payType: { $in: ['DAILY', 'HOURLY'] } }, { _id: 1 }).lean();
    const allowed = new Set(rated.map((e) => e._id.toHexString()));
    const wrong = rows.filter((r) => !allowed.has(r.employeeId.toHexString()));
    if (wrong.length) throw new BadRequestException('Days and hours apply only to daily and hourly staff');
    if (rows.length) {
      await this.db.payInputs.bulkWrite(
        rows.map((r) => ({ updateOne: { filter: { organisationId: user.organisationId, period: run.period, employeeId: r.employeeId }, update: { $set: { units: r.units, enteredBy: user.id } }, upsert: true } })),
      );
    }
    await this.fill(user.organisationId, run);
    await this.db.payRuns.updateOne({ _id: id }, { createdBy: user.id });
    await this.audit.record(user, 'hr.payroll.units', 'hrPayRun', id, { rows: rows.length });
    return this.db.payRuns.findById(id).lean();
  }

  /** The month's payroll, worked out at once; or an empty off-cycle payroll to add payments to. */
  async createRun(user: AuthUser, input: { period: string; payDate?: Date | null; kind?: 'REGULAR' | 'OFF_CYCLE' | 'GROUP'; title?: string; payGroup?: 'BOARD' | 'SECONDED' }) {
    if (input.kind === 'GROUP') return this.createGroupRun(user, input as typeof input & { payGroup: 'BOARD' | 'SECONDED' });
    const offCycle = input.kind === 'OFF_CYCLE';
    if (offCycle && !input.title) throw new BadRequestException('Say what the payroll is for, e.g. "December bonus"');
    const taken = `There is already a payroll for ${input.period}. Use an off-cycle payroll for bonuses and final dues.`;
    if (!offCycle && (await this.db.payRuns.exists({ organisationId: user.organisationId, period: input.period, kind: 'REGULAR', status: { $ne: 'CANCELLED' } }))) throw new ConflictException(taken);
    let run;
    try {
      [run] = await this.db.payRuns.create([
        { organisationId: user.organisationId, period: input.period, kind: offCycle ? 'OFF_CYCLE' : 'REGULAR', title: offCycle ? input.title : undefined, payDate: input.payDate ?? periodEnd(input.period), createdBy: user.id },
      ]);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(taken);
      throw err;
    }
    try {
      await this.fill(user.organisationId, run);
    } catch (err) {
      await this.db.payRuns.deleteOne({ _id: run._id });
      throw err;
    }
    await this.audit.record(user, 'hr.payroll.create', 'hrPayRun', run._id, { period: input.period, kind: run.kind, title: run.title });
    return this.db.payRuns.findById(run._id).lean();
  }

  /** The month's payroll for board members or seconded staff. */
  private async createGroupRun(user: AuthUser, input: { period: string; payDate?: Date | null; payGroup: 'BOARD' | 'SECONDED' }) {
    if (!input.payGroup) throw new BadRequestException('Say which pay group');
    const label = input.payGroup === 'BOARD' ? 'Board' : 'Seconded staff';
    let run;
    try {
      [run] = await this.db.payRuns.create([{ organisationId: user.organisationId, period: input.period, kind: 'GROUP', payGroup: input.payGroup, title: `${label} ${input.period}`, payDate: input.payDate ?? periodEnd(input.period), createdBy: user.id }]);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`There is already a ${label.toLowerCase()} payroll for ${input.period}`);
      throw err;
    }
    try {
      await this.fill(user.organisationId, run);
    } catch (err) {
      await this.db.payRuns.deleteOne({ _id: run._id });
      throw err;
    }
    await this.audit.record(user, 'hr.payroll.create', 'hrPayRun', run._id, { period: input.period, kind: 'GROUP', payGroup: input.payGroup });
    return this.db.payRuns.findById(run._id).lean();
  }

  /** Works the draft payroll again after changes to employees, pay items or leave. */
  async recalculate(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.payRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    if (run.status !== 'DRAFT') throw new BadRequestException('Only a draft payroll can be recalculated');
    await this.fill(user.organisationId, run);
    await this.db.payRuns.updateOne({ _id: id }, { createdBy: user.id });
    await this.audit.record(user, 'hr.payroll.recalculate', 'hrPayRun', id, {});
    return this.db.payRuns.findById(id).lean();
  }

  private async fill(organisationId: Types.ObjectId, run: Pick<PayRunDoc, '_id' | 'period' | 'kind' | 'title' | 'entries' | 'payGroup'>) {
    const { rateSet, slips } = await this.calculate(organisationId, run.period, { run });
    const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, new Decimal(0)])) as Record<(typeof TOTAL_KEYS)[number], Decimal>;
    for (const s of slips) for (const k of TOTAL_KEYS) totals[k] = totals[k].plus(s.result[k]);
    await this.db.transaction(async (session) => {
      await this.db.payslips.deleteMany({ organisationId, payRunId: run._id, status: 'DRAFT' }, { session });
      if (slips.length) await this.db.payslips.insertMany(slips.map((s) => toPayslip(organisationId, run, s)), { session });
      await this.db.payRuns.updateOne(
        { _id: run._id },
        {
          rateSetId: rateSet._id,
          calculatedAt: new Date(),
          employeeCount: slips.length,
          warningCount: slips.filter((s) => s.result.warnings.length).length,
          totals: Object.fromEntries(TOTAL_KEYS.map((k) => [k, toD128(totals[k])])),
        },
        { session },
      );
    });
  }

  /**
   * Tax on a payroll is worked together with the month's other approved payrolls. If one of those was
   * approved after this was worked out for the same people, approving now would deduct twice.
   */
  private async assertNothingApprovedSince(organisationId: Types.ObjectId, run: PayRunDoc) {
    const since = await this.db.payRuns.find({ organisationId, period: run.period, _id: { $ne: run._id }, status: { $in: ['APPROVED', 'PAID'] }, approvedAt: { $gt: run.calculatedAt ?? run.createdAt } }, { _id: 1 }).lean();
    if (!since.length) return;
    const people = await this.db.payslips.distinct('employeeId', { payRunId: run._id });
    if (await this.db.payslips.exists({ payRunId: { $in: since.map((r) => r._id) }, employeeId: { $in: people } })) {
      throw new ConflictException(`Another payroll for ${run.period} was approved after this one was worked out. Recalculate this one first so PAYE, NSSF, SHIF and the levy are not deducted twice.`);
    }
  }

  // Off-cycle payrolls ------------------------------------------------------------------------------

  private async draftOffCycle(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.payRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    if (run.kind !== 'OFF_CYCLE') throw new BadRequestException('Payments are added to an off-cycle payroll; the monthly payroll takes pay items from each employee');
    if (run.status !== 'DRAFT') throw new BadRequestException('Payments can only change on a draft payroll');
    return run;
  }

  private async saveEntries(user: AuthUser, run: PayRunDoc, entries: PayRunDoc['entries'], action: string, detail: Record<string, unknown>) {
    const updated = await this.db.payRuns.findOneAndUpdate({ _id: run._id, status: 'DRAFT' }, { entries, createdBy: user.id }, { new: true }).lean();
    if (!updated) throw new ConflictException('The payroll was changed by someone else');
    await this.fill(user.organisationId, updated);
    await this.audit.record(user, action, 'hrPayRun', run._id, detail);
    return this.db.payRuns.findById(run._id, { entries: 0 }).lean();
  }

  /** Adds payments (or recoveries) for named employees to an off-cycle payroll. */
  async addEntries(user: AuthUser, id: Types.ObjectId, rows: PayEntryInput[]) {
    const run = await this.draftOffCycle(user, id);
    const employees = await this.db.employees.find({ organisationId: user.organisationId, _id: { $in: rows.map((r) => r.employeeId) } }, { departmentId: 1 }).lean();
    for (const r of rows) {
      const e = employees.find((x) => x._id.equals(r.employeeId));
      if (!e) throw new NotFoundException('Employee not found');
      assertInScope(user, e.departmentId);
    }
    const loans = rows.filter((r) => r.payItemId);
    if (loans.length) {
      const items = await this.db.payItems.find({ organisationId: user.organisationId, _id: { $in: loans.map((r) => r.payItemId!) }, kind: 'DEDUCTION' }).lean();
      for (const r of loans) {
        const item = items.find((i) => i._id.equals(r.payItemId!) && i.employeeId.equals(r.employeeId));
        if (!item || item.balance === null || item.balance === undefined) throw new BadRequestException('Only an employee\'s own loan can be recovered');
        if (r.kind !== 'DEDUCTION' || r.amount.gt(dec(item.balance.toString()))) throw new BadRequestException(`No more than the ${item.name} balance of ${dec(item.balance.toString()).toFixed(2)} can be recovered`);
      }
    }
    const entries = [...(run.entries ?? []), ...rows.map((r) => ({ ...r, code: r.code ?? codeOf(r.name), amount: toD128(r.amount) }))] as PayRunDoc['entries'];
    return this.saveEntries(user, run, entries, 'hr.payroll.entries.add', { count: rows.length, total: rows.reduce((t, r) => t.plus(r.amount), new Decimal(0)).toFixed(2) });
  }

  /** The same payment to everyone (or one department): a fixed amount or a share of basic salary. */
  async addToMany(user: AuthUser, id: Types.ObjectId, input: { departmentId?: Types.ObjectId | null; name: string; amount?: Decimal; percentOfBasic?: number; taxable: boolean }) {
    const run = await this.draftOffCycle(user, id);
    if (!input.amount === !input.percentOfBasic) throw new BadRequestException('Give either an amount or a percentage of basic salary');
    const filter: Record<string, unknown> = { organisationId: user.organisationId, status: 'ACTIVE', ...scopeFilter(user) };
    if (input.departmentId) filter.departmentId = input.departmentId;
    const staff = await this.db.employees.find(filter, { basicSalary: 1 }).lean();
    const rows = staff
      .map((e) => ({ employeeId: e._id, amount: input.amount ?? round(dec(e.basicSalary?.toString()).times(input.percentOfBasic!).dividedBy(100), 2) }))
      .filter((r) => r.amount.gt(0))
      .map((r) => ({ ...r, kind: 'EARNING' as const, code: codeOf(input.name), name: input.name, taxable: input.taxable, amount: toD128(r.amount) }));
    if (!rows.length) throw new BadRequestException(input.percentOfBasic ? 'Nobody there has a basic salary to work a percentage of' : 'Nobody active there');
    return this.saveEntries(user, run, [...(run.entries ?? []), ...rows] as PayRunDoc['entries'], 'hr.payroll.entries.many', { name: input.name, count: rows.length });
  }

  async removeEntry(user: AuthUser, id: Types.ObjectId, entryId: Types.ObjectId) {
    const run = await this.draftOffCycle(user, id);
    const entries = (run.entries ?? []).filter((x) => !x._id.equals(entryId));
    if (entries.length === (run.entries ?? []).length) throw new NotFoundException('Payment not found');
    return this.saveEntries(user, run, entries as PayRunDoc['entries'], 'hr.payroll.entries.remove', { entryId });
  }

  /**
   * What is usually owed to someone leaving, to choose from and adjust: earned leave not taken,
   * pay in lieu of notice, severance on redundancy (Employment Act s.40: 15 days a completed year)
   * and loan balances to recover. The month's salary itself is on the monthly payroll, pro-rated.
   */
  async finalDues(user: AuthUser, employeeId: Types.ObjectId) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    const asOf = e.terminationDate ?? new Date();
    const year = asOf.getUTCFullYear();
    const payType = (e.payType ?? 'MONTHLY') as 'MONTHLY' | 'DAILY' | 'HOURLY';
    const basic = dec(e.basicSalary?.toString());
    const rate = dec(e.rate?.toString());
    const dayRate = payType === 'MONTHLY' ? round(basic.dividedBy(30), 2) : payType === 'DAILY' ? rate : round(rate.times(8), 2);
    const dayRateBasis = payType === 'MONTHLY' ? 'basic salary ÷ 30' : payType === 'DAILY' ? 'the daily rate' : '8 hours at the hourly rate';
    const yearsOfService = Math.floor((asOf.getTime() - e.hireDate.getTime()) / (365.25 * 86_400_000));
    const [earnedTypes, balances, loans] = await Promise.all([
      this.db.leaveTypes.find({ organisationId: user.organisationId, accrual: 'MONTHLY', paid: true }, { _id: 1 }).lean(),
      this.leave.balances(user.organisationId, e, year, asOf),
      this.db.payItems.find({ organisationId: user.organisationId, employeeId, kind: 'DEDUCTION', active: true, balance: { $gt: Types.Decimal128.fromString('0') } }).lean(),
    ]);
    const lines: (PayEntryInput & { suggested: boolean; note?: string })[] = [];
    for (const b of balances.filter((x) => earnedTypes.some((t) => t._id.equals(x.leaveTypeId)) && x.available > 0)) {
      lines.push({ employeeId, kind: 'EARNING', code: 'LEAVE_PAY', name: `${b.name} not taken (${b.available} days)`, amount: round(dayRate.times(b.available), 2), taxable: true, leaveTypeId: b.leaveTypeId, leaveDays: b.available, leaveYear: year, suggested: true });
    }
    if (payType === 'MONTHLY') lines.push({ employeeId, kind: 'EARNING', code: 'NOTICE_PAY', name: 'Pay in lieu of notice (one month)', amount: basic, taxable: true, suggested: false, note: 'When they left without working their notice' });
    if (yearsOfService > 0) {
      lines.push({ employeeId, kind: 'EARNING', code: 'SEVERANCE', name: `Severance pay (15 days for each of ${yearsOfService} years)`, amount: round(dayRate.times(15 * yearsOfService), 2), taxable: true, suggested: e.terminationReason === 'REDUNDANCY', note: 'On redundancy' });
    }
    const gratuity = await this.gratuityBalance(user.organisationId, employeeId);
    if (gratuity.gt(0)) lines.push({ employeeId, kind: 'EARNING', code: 'GRATUITY_PAY', name: 'Contract gratuity accrued', amount: gratuity, taxable: true, suggested: true, note: 'Gratuity accrued on approved payrolls, less any already paid' });
    for (const l of loans) lines.push({ employeeId, kind: 'DEDUCTION', code: l.code, name: `${l.name} balance recovered`, amount: dec(l.balance!.toString()), taxable: true, payItemId: l._id, suggested: true });
    return {
      employee: { id: e._id, employeeNo: e.employeeNo, name: fullName(e), status: e.status, hireDate: e.hireDate, terminationDate: e.terminationDate, terminationReason: e.terminationReason, payType },
      dayRate,
      dayRateBasis,
      yearsOfService,
      lines,
    };
  }

  /** Gratuity accrued to an employee on approved payrolls, less gratuity already paid out. */
  async gratuityBalance(organisationId: Types.ObjectId, employeeId: Types.ObjectId) {
    const slips = await this.db.payslips.find({ organisationId, employeeId, status: { $in: ['APPROVED', 'PAID'] }, 'lines.code': { $in: ['GRATUITY', 'GRATUITY_PAY'] } }, { lines: 1 }).lean();
    let balance = new Decimal(0);
    for (const s of slips) {
      for (const l of s.lines) {
        if (l.code === 'GRATUITY' && l.type === 'EMPLOYER') balance = balance.plus(dec(l.amount?.toString()));
        if (l.code === 'GRATUITY_PAY' && l.type === 'EARNING') balance = balance.minus(dec(l.amount?.toString()));
      }
    }
    return Decimal.max(balance, 0);
  }

  async cancelRun(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.payRuns.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'DRAFT' }, { status: 'CANCELLED' }, { new: true }).lean();
    if (!run) throw new BadRequestException('Only a draft payroll can be cancelled');
    await this.db.payslips.updateMany({ organisationId: user.organisationId, payRunId: id }, { status: 'CANCELLED' });
    await this.audit.record(user, 'hr.payroll.cancel', 'hrPayRun', id, {});
    return run;
  }

  /** Numbers the payslips, takes loan repayments off their balances and locks the payroll. */
  async approveRun(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.payRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    if (run.status !== 'DRAFT') throw new BadRequestException(`The payroll is already ${run.status.toLowerCase()}`);
    if (run.createdBy?.equals(user.id) && !user.isAdmin) throw new ForbiddenException('Segregation of duties: someone else must approve a payroll you prepared');
    if (!run.employeeCount) throw new BadRequestException('The payroll has no employees');
    await this.assertNothingApprovedSince(user.organisationId, run);
    await this.db.transaction(async (session) => {
      const locked = await this.db.payRuns.updateOne({ _id: id, status: 'DRAFT' }, { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() }, { session });
      if (!locked.modifiedCount) throw new ConflictException('The payroll was changed by someone else');
      const slips = await this.db.payslips.find({ payRunId: id, status: 'DRAFT' }).sort({ 'employee.employeeNo': 1 }).session(session);
      for (const slip of slips) {
        const seq = await this.db.next(user.organisationId, `hr:payslip:${run.period}`, session);
        slip.payslipNo = `PS-${run.period.replace('-', '')}-${String(seq).padStart(4, '0')}`;
        slip.status = 'APPROVED';
        await slip.save({ session });
        for (const r of slip.repayments ?? []) {
          const item = await this.db.payItems.findById(r.payItemId).session(session);
          if (!item || item.balance === null || item.balance === undefined) continue;
          const left = Decimal.max(dec(item.balance.toString()).minus(dec(r.amount?.toString())), 0);
          item.balance = toD128(left);
          if (left.isZero()) item.active = false;
          await item.save({ session });
        }
      }
      // Leave paid out as final dues comes off the balance.
      const paidOut = (run.entries ?? []).filter((x) => x.leaveTypeId && x.leaveDays);
      if (paidOut.length) {
        await this.db.leaveAdjustments.create(
          paidOut.map((x) => ({ organisationId: user.organisationId, employeeId: x.employeeId, leaveTypeId: x.leaveTypeId, year: x.leaveYear ?? Number(run.period.slice(0, 4)), days: -x.leaveDays!, kind: 'ENCASHMENT', reason: `Paid out: ${run.title ?? 'payroll'} ${run.period}`, createdBy: user.id })),
          { session, ordered: true },
        );
      }
      await this.audit.record(user, 'hr.payroll.approve', 'hrPayRun', id, { period: run.period, payslips: slips.length, net: run.totals?.netPay?.toString() }, session);
    });
    await this.hooks.afterApproved(user, id);
    return this.db.payRuns.findById(id).lean();
  }

  async markPaid(user: AuthUser, id: Types.ObjectId, input: { paidAt: Date; reference?: string }) {
    const run = await this.db.payRuns.findOneAndUpdate(
      { _id: id, organisationId: user.organisationId, status: 'APPROVED' },
      { status: 'PAID', paidBy: user.id, paidAt: input.paidAt, paymentReference: input.reference },
      { new: true },
    ).lean();
    if (!run) throw new BadRequestException('Only an approved payroll can be marked paid');
    await this.db.payslips.updateMany({ payRunId: id, status: 'APPROVED' }, { status: 'PAID' });
    await this.audit.record(user, 'hr.payroll.paid', 'hrPayRun', id, input);
    await this.hooks.afterPaid(user, id);
    return this.db.payRuns.findById(id).lean();
  }

  /** A payslip with the employer's details, for HR. */
  async getPayslip(user: AuthUser, id: Types.ObjectId) {
    const slip = await this.db.payslips.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!slip) throw new NotFoundException('Payslip not found');
    assertInScope(user, slip.employee?.departmentId);
    return this.withOrganisation(slip);
  }

  async withOrganisation<T extends { organisationId: Types.ObjectId }>(slip: T) {
    const org = await this.db.organisations.findById(slip.organisationId, { name: 1, address: 1, phone: 1, email: 1, kraPin: 1 }).lean();
    return { ...slip, organisation: org ? { name: org.name, address: org.address, phone: org.phone, email: org.email, kraPin: org.kraPin } : null };
  }

  // Ledger -----------------------------------------------------------------------------------------

  /** Posts the payroll journal (approval) or the salary payment journal; never throws. */
  async postToLedger(organisationId: Types.ObjectId, id: Types.ObjectId, kind: 'approval' | 'payment') {
    const run = await this.db.payRuns.findById(id).lean();
    if (!run) return { status: 'SKIPPED' as const };
    const mapping = ((await hrSettings(this.db, organisationId)).accounts ?? {}) as AccountMapping;
    const t = Object.fromEntries(TOTAL_KEYS.map((k) => [k, run.totals?.[k]?.toString() ?? '0'])) as Record<(typeof TOTAL_KEYS)[number], string>;
    const common = { organisationId, model: this.db.payRuns, id, mappingHint: 'HR settings → Ledger accounts' };
    if (kind === 'approval') {
      return this.ledger.postTracked({
        ...common,
        journal: { date: formatDate(run.payDate ?? run.approvedAt ?? new Date())!, description: `${runName(run)} (${run.employeeCount} employees)`, reference: `PAYROLL-${run.period}`, lines: payrollJournalLines(t, mapping, run.period) },
        key: `farajasoft-hr:payroll:${id.toHexString()}`,
        missing: missingAccounts(mapping, APPROVAL_ACCOUNTS),
      });
    }
    const narrative = `${run.kind !== 'REGULAR' && run.title ? `${run.title} paid` : 'Salaries paid'} ${run.period}${run.paymentReference ? ` (${run.paymentReference})` : ''}`;
    return this.ledger.postTracked({
      ...common,
      field: 'paymentAccounting',
      journal: { date: formatDate(run.paidAt ?? new Date())!, description: narrative, reference: `SALARIES-${run.period}`, lines: paymentJournalLines(t.netPay, mapping, narrative) },
      key: `farajasoft-hr:salaries-paid:${id.toHexString()}`,
      missing: missingAccounts(mapping, PAYMENT_ACCOUNTS),
    });
  }

  /** Re-sends every payroll journal not yet in the ledger. */
  async retryLedger(user: AuthUser) {
    const unsent = { $ne: 'SENT' };
    const [approved, paid] = await Promise.all([
      this.db.payRuns.find({ organisationId: user.organisationId, imported: { $ne: true }, status: { $in: ['APPROVED', 'PAID'] }, 'accounting.status': unsent }, { _id: 1 }).lean(),
      this.db.payRuns.find({ organisationId: user.organisationId, imported: { $ne: true }, status: 'PAID', 'paymentAccounting.status': unsent }, { _id: 1 }).lean(),
    ]);
    const results = { sent: 0, failed: 0, skipped: 0 };
    const tally = (r: { status: string }) => {
      if (r.status === 'SENT') results.sent++;
      else if (r.status === 'FAILED') results.failed++;
      else results.skipped++;
    };
    for (const r of approved) tally(await this.postToLedger(user.organisationId, r._id, 'approval'));
    for (const r of paid) tally(await this.postToLedger(user.organisationId, r._id, 'payment'));
    return results;
  }
}

type Calculated = Awaited<ReturnType<PayrollService['calculate']>>['slips'][number];

/** "Payroll 2026-11", or "December bonus 2026-12" for an off-cycle payroll. */
export const runName = (run: { kind?: string | null; title?: string | null; period: string }) => (run.kind === 'OFF_CYCLE' ? `${run.title} ${run.period}` : run.kind === 'GROUP' ? `${run.title} payroll` : `Payroll ${run.period}`);

function toPayslip(organisationId: Types.ObjectId, run: Pick<PayRunDoc, '_id' | 'period' | 'kind' | 'title'>, s: Calculated) {
  const r: PayResult = s.result;
  return {
    organisationId,
    payRunId: run._id,
    employeeId: s.employeeId,
    period: run.period,
    title: run.kind !== 'REGULAR' ? run.title : undefined,
    priorGrossPay: s.priorGrossPay ? toD128(s.priorGrossPay) : undefined,
    employee: s.employee,
    daysPaid: s.daysPaid,
    daysInPeriod: s.daysInPeriod,
    unpaidLeaveDays: s.unpaidLeaveDays,
    payType: s.payType,
    units: s.units,
    rate: s.rate ? toD128(s.rate) : undefined,
    lines: r.lines.map((l) => ({ ...l, amount: toD128(l.amount) })),
    ...Object.fromEntries(SLIP_AMOUNTS.map((k) => [k, toD128(r[k])])),
    nssfTier1: toD128(s.nssfTier1),
    nssfTier2: toD128(s.nssfTier2),
    repayments: s.repayments.map((x) => ({ payItemId: x.payItemId, amount: toD128(x.amount) })),
    warnings: r.warnings,
  };
}

type Prior = Record<(typeof PRIOR_KEYS)[number] | 'nssfTier1', Decimal>;

/** This payroll's share of the month's NSSF Tier I and Tier II. */
function monthTiers(r: PayResult, prior: Prior | undefined, rates: StatutoryRates['nssf']) {
  if (!prior) return nssfTiers(r.grossPay, rates);
  const month = nssfTiers(r.grossPay.plus(prior.grossPay), rates);
  const tier1 = Decimal.max(Decimal.min(month.tier1.minus(prior.nssfTier1), r.nssfEmployee), 0);
  return { tier1, tier2: r.nssfEmployee.minus(tier1) };
}
