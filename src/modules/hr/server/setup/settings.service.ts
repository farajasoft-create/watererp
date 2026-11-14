import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { HrDb as Db, hrSettings } from '../db';
import { periodEnd } from '../payroll/calendar';
import { StatutoryRates } from '../payroll/engine';
import { AccountMapping, MAPPING_LABELS } from '../payroll/journals';
import { RateSetDoc } from '../schemas';

export interface RateSetInput {
  effectiveFrom: Date;
  reference?: string;
  paye: { bands: { upTo: Decimal | null; rate: Decimal }[]; personalRelief: Decimal };
  nssf: { rate: Decimal; lowerLimit: Decimal; upperLimit: Decimal };
  shif: { rate: Decimal; minimum: Decimal };
  ahl: { employeeRate: Decimal; employerRate: Decimal };
  nitaPerEmployee: Decimal;
  pensionReliefCap: Decimal;
}

export interface LeaveTypeInput {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: number;
  accrual: 'MONTHLY' | 'ANNUAL';
  carryForwardMax: number;
  gender?: 'MALE' | 'FEMALE' | null;
  unlimited: boolean;
  active: boolean;
}

/** A stored rate set as the payroll engine takes it. */
export function toRates(r: Pick<RateSetDoc, 'paye' | 'nssf' | 'shif' | 'ahl' | 'nitaPerEmployee' | 'pensionReliefCap'>): StatutoryRates {
  const s = (v: { toString(): string } | null | undefined) => v?.toString() ?? '0';
  return {
    paye: { bands: (r.paye?.bands ?? []).map((b) => ({ upTo: b.upTo ? b.upTo.toString() : null, rate: s(b.rate) })), personalRelief: s(r.paye?.personalRelief) },
    nssf: { rate: s(r.nssf?.rate), lowerLimit: s(r.nssf?.lowerLimit), upperLimit: s(r.nssf?.upperLimit) },
    shif: { rate: s(r.shif?.rate), minimum: s(r.shif?.minimum) },
    ahl: { employeeRate: s(r.ahl?.employeeRate), employerRate: s(r.ahl?.employerRate) },
    nitaPerEmployee: s(r.nitaPerEmployee),
    pensionReliefCap: s(r.pensionReliefCap),
  };
}

const storeRates = (i: RateSetInput) => ({
  effectiveFrom: i.effectiveFrom,
  reference: i.reference,
  paye: { bands: i.paye.bands.map((b) => ({ upTo: b.upTo ? toD128(b.upTo) : null, rate: toD128(b.rate) })), personalRelief: toD128(i.paye.personalRelief) },
  nssf: { rate: toD128(i.nssf.rate), lowerLimit: toD128(i.nssf.lowerLimit), upperLimit: toD128(i.nssf.upperLimit) },
  shif: { rate: toD128(i.shif.rate), minimum: toD128(i.shif.minimum) },
  ahl: { employeeRate: toD128(i.ahl.employeeRate), employerRate: toD128(i.ahl.employerRate) },
  nitaPerEmployee: toD128(i.nitaPerEmployee),
  pensionReliefCap: toD128(i.pensionReliefCap),
});

/** HR settings: statutory rates, departments, leave types, public holidays and ledger accounts. */
export class HrSettingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get(user: AuthUser) {
    return { ...(await hrSettings(this.db, user.organisationId)), mappingLabels: MAPPING_LABELS };
  }

  async updateGeneral(user: AuthUser, input: { employeeNoPrefix: string; holidays: { date: string; name: string }[] }) {
    const holidays = [...new Map(input.holidays.map((h) => [h.date, h])).values()].sort((a, b) => a.date.localeCompare(b.date));
    await this.db.hrSettings.updateOne({ organisationId: user.organisationId }, { employeeNoPrefix: input.employeeNoPrefix, holidays }, { upsert: true });
    await this.audit.record(user, 'hr.settings.general', 'organisation', user.organisationId, { employeeNoPrefix: input.employeeNoPrefix, holidays: holidays.length });
    return this.get(user);
  }

  async updateAccounts(user: AuthUser, accounts: Partial<AccountMapping>) {
    const clean = Object.fromEntries(Object.entries(accounts).filter(([k, v]) => k in MAPPING_LABELS && typeof v === 'string' && /^[a-f\d]{24}$/i.test(v)));
    await this.db.hrSettings.updateOne({ organisationId: user.organisationId }, { accounts: clean }, { upsert: true });
    await this.audit.record(user, 'hr.settings.accounts', 'organisation', user.organisationId, clean);
    return this.get(user);
  }

  async holidays(organisationId: Types.ObjectId): Promise<string[]> {
    return ((await hrSettings(this.db, organisationId)).holidays ?? []).map((h) => h.date!).filter(Boolean);
  }

  listRateSets(user: AuthUser) {
    return this.db.rateSets.find({ organisationId: user.organisationId }).sort({ effectiveFrom: -1 }).lean();
  }

  /** The rate set in force at the end of a payroll month. */
  async ratesFor(organisationId: Types.ObjectId, period: string) {
    const set = await this.db.rateSets.findOne({ organisationId, effectiveFrom: { $lte: periodEnd(period) } }).sort({ effectiveFrom: -1 }).lean();
    if (!set) throw new BadRequestException(`No statutory rates are in force for ${period}; add them under HR settings → Statutory rates`);
    return set;
  }

  async saveRateSet(user: AuthUser, id: Types.ObjectId | null, input: RateSetInput) {
    const bands = input.paye.bands;
    if (!bands.length || bands[bands.length - 1].upTo !== null) throw new BadRequestException('The last PAYE band must have no upper limit');
    for (let i = 1; i < bands.length; i++) {
      if (bands[i].upTo !== null && !bands[i].upTo!.gt(bands[i - 1].upTo!)) throw new BadRequestException('PAYE band limits must rise from band to band');
    }
    if (input.nssf.upperLimit.lt(input.nssf.lowerLimit)) throw new BadRequestException('The NSSF upper limit must be above the lower limit');
    const data = storeRates(input);
    try {
      const doc = id
        ? await this.db.rateSets.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, data, { new: true }).lean()
        : (await this.db.rateSets.create([{ organisationId: user.organisationId, ...data }]))[0].toObject();
      if (!doc) throw new NotFoundException('Rate set not found');
      await this.audit.record(user, id ? 'hr.rates.update' : 'hr.rates.create', 'hrRateSet', doc._id, { effectiveFrom: input.effectiveFrom, reference: input.reference });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('There is already a rate set from that date');
      throw err;
    }
  }

  async deleteRateSet(user: AuthUser, id: Types.ObjectId) {
    if (await this.db.payRuns.exists({ organisationId: user.organisationId, rateSetId: id, status: { $ne: 'CANCELLED' } })) throw new BadRequestException('Payrolls were worked with these rates; add a newer set instead');
    const res = await this.db.rateSets.deleteOne({ _id: id, organisationId: user.organisationId });
    if (!res.deletedCount) throw new NotFoundException('Rate set not found');
    await this.audit.record(user, 'hr.rates.delete', 'hrRateSet', id);
    return { ok: true };
  }

  /** Units in tree order with their full path, depth, head and staff count (including the units below). */
  async listDepartments(user: AuthUser) {
    const all = await this.db.departments.find({ organisationId: user.organisationId }).sort({ name: 1 }).lean();
    const staff = await this.db.employees.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { organisationId: user.organisationId, status: { $in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] }, departmentId: { $ne: null } } }, { $group: { _id: '$departmentId', n: { $sum: 1 } } }]);
    const heads = await this.db.employees.find({ _id: { $in: all.map((d) => d.headId).filter(Boolean) as Types.ObjectId[] } }, { firstName: 1, lastName: 1 }).lean();
    const out: (typeof all[number] & { path: string; depth: number; staff: number; staffBelow: number; head: string })[] = [];
    const walk = (parent: Types.ObjectId | null, path: string, depth: number): number => {
      let total = 0;
      for (const d of all.filter((x) => (parent ? x.parentId?.equals(parent) : !x.parentId || !all.some((y) => y._id.equals(x.parentId!))))) {
        const p = path ? `${path} / ${d.name}` : d.name;
        const h = heads.find((e) => d.headId && e._id.equals(d.headId));
        const row = { ...d, path: p, depth, staff: staff.find((s) => s._id.equals(d._id))?.n ?? 0, staffBelow: 0, head: h ? `${h.firstName} ${h.lastName}` : '' };
        out.push(row);
        row.staffBelow = row.staff + walk(d._id, p, depth + 1);
        total += row.staffBelow;
      }
      return total;
    };
    walk(null, '', 0);
    return out;
  }

  async saveDepartment(user: AuthUser, id: Types.ObjectId | null, input: { code: string; name: string; level?: string; parentId?: Types.ObjectId | null; headId?: Types.ObjectId | null; active: boolean }) {
    const data = { ...input, code: input.code.toUpperCase() };
    if (input.parentId) {
      const all = await this.db.departments.find({ organisationId: user.organisationId }, { parentId: 1 }).lean();
      if (!all.some((d) => d._id.equals(input.parentId!))) throw new NotFoundException('Parent unit not found');
      for (let cur: Types.ObjectId | null | undefined = input.parentId, guard = 0; cur && guard < 50; guard++) {
        if (id && cur.equals(id)) throw new BadRequestException('A unit cannot sit under itself or one of its own units');
        cur = all.find((d) => d._id.equals(cur!))?.parentId;
      }
    }
    if (input.headId && !(await this.db.employees.exists({ _id: input.headId, organisationId: user.organisationId }))) throw new NotFoundException('Employee not found');
    try {
      const doc = id
        ? await this.db.departments.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, data, { new: true }).lean()
        : (await this.db.departments.create([{ organisationId: user.organisationId, ...data }]))[0].toObject();
      if (!doc) throw new NotFoundException('Department not found');
      await this.audit.record(user, id ? 'hr.department.update' : 'hr.department.create', 'hrDepartment', doc._id, data);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Department code ${data.code} is taken`);
      throw err;
    }
  }

  listLeaveTypes(user: AuthUser) {
    return this.db.leaveTypes.find({ organisationId: user.organisationId }).sort({ name: 1 }).lean();
  }

  async saveLeaveType(user: AuthUser, id: Types.ObjectId | null, input: LeaveTypeInput) {
    const data = { ...input, code: input.code.toUpperCase(), gender: input.gender ?? null };
    try {
      const doc = id
        ? await this.db.leaveTypes.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, data, { new: true }).lean()
        : (await this.db.leaveTypes.create([{ organisationId: user.organisationId, ...data }]))[0].toObject();
      if (!doc) throw new NotFoundException('Leave type not found');
      await this.audit.record(user, id ? 'hr.leaveType.update' : 'hr.leaveType.create', 'hrLeaveType', doc._id, data);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Leave type code ${data.code} is taken`);
      throw err;
    }
  }
}
