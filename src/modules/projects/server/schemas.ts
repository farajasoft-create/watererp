import { Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

export const DONOR_TYPES = ['BILATERAL', 'MULTILATERAL', 'GOVERNMENT', 'NGO', 'PRIVATE', 'OTHER'] as const;

export const donorSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: DONOR_TYPES, default: 'OTHER' },
    contactName: String,
    email: String,
    phone: String,
    /** Read-only donor portal: a hash of the secret in the link, so a leaked database does not leak links. */
    portalTokenHash: { type: String, default: null },
    portalEnabled: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  opts,
);

/** A grant (or loan) agreement with a donor, spent through a finance fund. */
export const grantSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    donorId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    title: { type: String, required: true },
    agreementRef: String,
    currency: { type: String, default: 'KES' },
    amount: { ...D128 },
    startDate: Date,
    endDate: Date,
    /** The FUND dimension code in finance that tags this grant's spending. */
    fundCode: String,
    status: { type: String, enum: ['PIPELINE', 'ACTIVE', 'CLOSED'], default: 'ACTIVE' },
    conditions: String,
    reportingFrequency: { type: String, enum: ['MONTHLY', 'QUARTERLY', 'BIANNUAL', 'ANNUAL'], default: 'QUARTERLY' },
    /** Budget lines agreed with the donor, each covering ledger accounts by code prefix. */
    budgetLines: [new Schema({ code: { type: String, required: true }, name: { type: String, required: true }, amount: { ...D128 }, accountPrefixes: [String] }, { _id: false })],
    disbursements: [new Schema({ date: { type: Date, required: true }, amount: { ...D128 }, reference: String, note: String, by: ObjectId })],
  },
  opts,
);
grantSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** A project: capital works or a programme, spent through a finance project dimension. */
export const projectSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    kind: { type: String, enum: ['CAPEX', 'OPEX', 'MIXED'], default: 'CAPEX' },
    /** The PROJECT dimension code in finance that tags this project's spending. */
    financeCode: { type: String, required: true },
    grantIds: [ObjectId],
    budget: { ...D128 },
    startDate: Date,
    endDate: Date,
    location: String,
    managerId: { type: ObjectId, default: null },
    status: { type: String, enum: ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'], default: 'ACTIVE' },
    milestones: [new Schema({ name: { type: String, required: true }, due: Date, weight: { type: Number, default: 1 }, percentComplete: { type: Number, min: 0, max: 100, default: 0 }, completedAt: Date, note: String })],
    kpis: [
      new Schema({
        name: { type: String, required: true },
        unit: String,
        baseline: { type: Number, default: 0 },
        target: { type: Number, required: true },
        actual: { type: Number, default: null },
        /** Higher is better (connections made), or lower is better (NRW %). */
        direction: { type: String, enum: ['UP', 'DOWN'], default: 'UP' },
        updates: [new Schema({ at: Date, value: Number, note: String, by: ObjectId }, { _id: false })],
      }),
    ],
    /** Work in progress moved to fixed assets once the works are commissioned. */
    capitalisations: [new Schema({ date: { type: Date, required: true }, amount: { ...D128 }, assetRef: String, note: String, by: ObjectId })],
  },
  opts,
);
projectSchema.index({ organisationId: 1, code: 1 }, { unique: true });
