import { Schema, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import type { HrDb as Db } from '../db';

const { ObjectId, Decimal128 } = Schema.Types;
export const SCHEME_KINDS = ['PENSION', 'UNION', 'SACCO', 'WELFARE', 'INSURANCE', 'LOAN', 'OTHER'] as const;

/**
 * A deduction table the organisation defines: a pension scheme, union, SACCO, welfare fund or insurer with
 * its own rates. Members carry a pay item linked to it; every payroll works their deduction (and any
 * employer share) out from the scheme's current rates, so a rate change applies to everyone at once.
 */
export const deductionSchemeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: SCHEME_KINDS, required: true },
    /** Member's deduction: a percentage of basic pay, or a fixed amount. */
    employeeRate: { type: Number, default: null },
    employeeAmount: { type: Decimal128, default: null },
    /** Lower and upper limits on the member's deduction per month. */
    minimum: { type: Decimal128, default: null },
    maximum: { type: Decimal128, default: null },
    /** Employer's share (pensions): a percentage of basic or a fixed amount. */
    employerRate: { type: Number, default: null },
    employerAmount: { type: Decimal128, default: null },
    /** Who the deductions are paid to, for the remittance. */
    payee: String,
    payeeAccount: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
deductionSchemeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export interface SchemeInput {
  code: string;
  name: string;
  kind: (typeof SCHEME_KINDS)[number];
  employeeRate?: number | null;
  employeeAmount?: Decimal | null;
  minimum?: Decimal | null;
  maximum?: Decimal | null;
  employerRate?: number | null;
  employerAmount?: Decimal | null;
  payee?: string;
  payeeAccount?: string;
  active?: boolean;
}

type SchemeDoc = { _id: Types.ObjectId; kind: string; employeeRate?: number | null; employeeAmount?: unknown; minimum?: unknown; maximum?: unknown; employerRate?: number | null; employerAmount?: unknown; active?: boolean | null };
const n = (v: unknown) => (v === null || v === undefined ? null : dec((v as { toString(): string }).toString()));
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** The member's deduction and the employer's share for a month's basic pay under a scheme. */
export function schemeAmounts(s: SchemeDoc, basic: Decimal) {
  let employee = n(s.employeeAmount) ?? round2(basic.times(s.employeeRate ?? 0).dividedBy(100));
  const min = n(s.minimum);
  const max = n(s.maximum);
  if (min && employee.lt(min)) employee = min;
  if (max && employee.gt(max)) employee = max;
  const employer = n(s.employerAmount) ?? (s.employerRate ? round2(basic.times(s.employerRate).dividedBy(100)) : null);
  return { employee, employer };
}

export class DeductionSchemesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser) {
    const schemes = await this.db.deductionSchemes.find({ organisationId: user.organisationId }).sort({ kind: 1, code: 1 }).lean();
    const counts = await this.db.payItems.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { organisationId: user.organisationId, schemeId: { $in: schemes.map((s) => s._id) }, active: true } }, { $group: { _id: '$schemeId', n: { $sum: 1 } } }]);
    return schemes.map((s) => ({ ...s, members: counts.find((c) => c._id.equals(s._id))?.n ?? 0 }));
  }

  async save(user: AuthUser, id: Types.ObjectId | null, input: SchemeInput) {
    if ((input.employeeRate === null || input.employeeRate === undefined) === !input.employeeAmount) throw new BadRequestException('Give the member deduction as either a percentage of basic pay or a fixed amount');
    if (input.employerRate && input.employerAmount) throw new BadRequestException('Give the employer share as a percentage or an amount, not both');
    if (input.minimum && input.maximum && input.minimum.gt(input.maximum)) throw new BadRequestException('The minimum is above the maximum');
    const d = (v?: Decimal | null) => (v ? toD128(v) : null);
    const fields = { ...input, code: input.code.toUpperCase(), employeeAmount: d(input.employeeAmount), minimum: d(input.minimum), maximum: d(input.maximum), employerAmount: d(input.employerAmount), employeeRate: input.employeeRate ?? null, employerRate: input.employerRate ?? null };
    try {
      const doc = id ? await this.db.deductionSchemes.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.deductionSchemes.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Scheme not found');
      // Members' items carry the scheme's code, name and kind flags.
      await this.db.payItems.updateMany({ organisationId: user.organisationId, schemeId: doc._id }, { code: doc.code, name: doc.name, pension: doc.kind === 'PENSION', insurance: doc.kind === 'INSURANCE' });
      await this.audit.record(user, id ? 'hr.scheme.update' : 'hr.scheme.create', 'hrDeductionScheme', doc._id, { code: fields.code, employeeRate: fields.employeeRate, employerRate: fields.employerRate });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Scheme code ${fields.code} is taken`);
      throw err;
    }
  }

  async members(user: AuthUser, id: Types.ObjectId) {
    const items = await this.db.payItems.find({ organisationId: user.organisationId, schemeId: id, active: true }).lean();
    const people = await this.db.employees.find({ _id: { $in: items.map((i) => i.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1 }).lean();
    return items.map((i) => {
      const e = people.find((p) => p._id.equals(i.employeeId));
      return { payItemId: i._id, employeeId: i.employeeId, employeeNo: e?.employeeNo, name: e ? `${e.firstName} ${e.lastName}` : '', memberNo: i.memberNo, fromPeriod: i.fromPeriod, toPeriod: i.toPeriod };
    });
  }

  /** Enrols an employee: a deduction item linked to the scheme, from a month. */
  async enrol(user: AuthUser, id: Types.ObjectId, input: { employeeId: Types.ObjectId; memberNo?: string; fromPeriod: string }) {
    const s = await this.db.deductionSchemes.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!s?.active) throw new NotFoundException('Scheme not found');
    if (!(await this.db.employees.exists({ _id: input.employeeId, organisationId: user.organisationId }))) throw new NotFoundException('Employee not found');
    if (await this.db.payItems.exists({ organisationId: user.organisationId, employeeId: input.employeeId, schemeId: id, active: true })) throw new ConflictException('Already a member');
    const [item] = await this.db.payItems.create([{ organisationId: user.organisationId, employeeId: input.employeeId, kind: 'DEDUCTION', code: s.code, name: s.name, amount: toD128(0), pension: s.kind === 'PENSION', insurance: s.kind === 'INSURANCE', memberNo: input.memberNo ?? null, fromPeriod: input.fromPeriod, schemeId: id }]);
    await this.audit.record(user, 'hr.scheme.enrol', 'hrPayItem', item._id, { scheme: s.code, employeeId: input.employeeId });
    return item.toObject();
  }

  /** Ends membership from a month (the last month deducted is the one before). */
  async leave(user: AuthUser, payItemId: Types.ObjectId, lastPeriod: string) {
    const r = await this.db.payItems.updateOne({ _id: payItemId, organisationId: user.organisationId, schemeId: { $ne: null } }, { toPeriod: lastPeriod });
    if (!r.matchedCount) throw new NotFoundException('Membership not found');
    await this.audit.record(user, 'hr.scheme.leave', 'hrPayItem', payItemId, { lastPeriod });
    return { ended: true };
  }
}
