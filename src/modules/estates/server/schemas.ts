import { Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

export const propertySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    location: String,
    kind: { type: String, enum: ['RESIDENTIAL', 'COMMERCIAL', 'LAND', 'MIXED'], default: 'COMMERCIAL' },
    units: [new Schema({ code: { type: String, required: true }, description: String, sizeSqm: Number, marketRent: { ...D128 }, active: { type: Boolean, default: true } })],
  },
  opts,
);
propertySchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const tenantSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ['INDIVIDUAL', 'COMPANY'], default: 'INDIVIDUAL' },
    idNumber: String,
    kraPin: String,
    phone: String,
    email: String,
    /** Portal link (hashed) for the tenant's own view. */
    portalTokenHash: { type: String, default: null },
  },
  opts,
);

export const leaseSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    tenantId: { type: ObjectId, required: true },
    propertyId: { type: ObjectId, required: true },
    unitId: { type: ObjectId, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    rent: { ...D128 },
    /** Service charge billed with the rent. */
    serviceCharge: { ...D128 },
    /** Rent goes up by this % on each anniversary. */
    escalationPct: { type: Number, default: 0 },
    dueDay: { type: Number, min: 1, max: 28, default: 5 },
    deposit: { ...D128 },
    depositPaid: { ...D128 },
    depositRefunded: { ...D128 },
    status: { type: String, enum: ['ACTIVE', 'ENDED', 'TERMINATED'], default: 'ACTIVE' },
    endedAt: Date,
    /** Statement: rent bills, payments, deposit and adjustments, in date order. */
    entries: [
      new Schema({
        date: { type: Date, required: true },
        kind: { type: String, enum: ['RENT', 'SERVICE', 'PENALTY', 'PAYMENT', 'DEPOSIT_PAID', 'DEPOSIT_APPLIED', 'DEPOSIT_REFUND', 'ADJUSTMENT'], required: true },
        period: String,
        description: String,
        /** Positive adds to what the tenant owes; negative reduces it. */
        amount: { ...D128 },
        reference: String,
        by: ObjectId,
      }),
    ],
  },
  opts,
);
leaseSchema.index({ organisationId: 1, number: 1 }, { unique: true });
leaseSchema.index({ organisationId: 1, unitId: 1, status: 1 });

export const maintenanceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    leaseId: { type: ObjectId, default: null },
    tenantId: { type: ObjectId, default: null },
    propertyId: { type: ObjectId, required: true },
    unitId: { type: ObjectId, default: null },
    category: { type: String, enum: ['PLUMBING', 'ELECTRICAL', 'STRUCTURAL', 'SECURITY', 'CLEANING', 'OTHER'], default: 'OTHER' },
    description: { type: String, required: true },
    priority: { type: String, enum: ['LOW', 'NORMAL', 'URGENT'], default: 'NORMAL' },
    status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'], default: 'OPEN' },
    assignedTo: { type: ObjectId, default: null },
    raisedBy: { type: String, enum: ['TENANT', 'STAFF'], default: 'STAFF' },
    resolution: String,
    cost: { ...D128 },
    doneAt: Date,
  },
  opts,
);
