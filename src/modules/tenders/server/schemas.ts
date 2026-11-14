import { Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

/** Procurement methods of the Public Procurement and Asset Disposal Act, 2015 (Part IX). */
export const METHODS = ['OPEN_NATIONAL', 'OPEN_INTERNATIONAL', 'RESTRICTED', 'RFP', 'TWO_STAGE', 'DESIGN_COMPETITION', 'RFQ', 'LOW_VALUE', 'DIRECT', 'SPECIALLY_PERMITTED', 'FRAMEWORK'] as const;
export const CATEGORIES = ['GOODS', 'WORKS', 'SERVICES', 'CONSULTANCY'] as const;
export const RESERVATIONS = ['NONE', 'YOUTH', 'WOMEN', 'PWD', 'ALL_AGPO', 'LOCAL'] as const;
export const STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATED', 'RECOMMENDED', 'AWARDED', 'CONTRACTED', 'CANCELLED'] as const;

const committeeMember = new Schema({ userId: { type: ObjectId, required: true }, role: { type: String, enum: ['CHAIR', 'SECRETARY', 'MEMBER'], default: 'MEMBER' } }, { _id: false });

export const tenderSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    method: { type: String, enum: METHODS, required: true },
    category: { type: String, enum: CATEGORIES, required: true },
    /** Reserved for AGPO groups (s.157) or local firms (s.157(9)). */
    reservedFor: { type: String, enum: RESERVATIONS, default: 'NONE' },
    estimate: { ...D128 },
    /** Annual procurement plan item or budget line this draws on. */
    planReference: String,
    budgetLine: String,
    /** Why a method other than open tendering was used (required for direct and restricted). */
    justification: String,
    bidSecurity: { ...D128 },
    bidValidityDays: { type: Number, default: 120 },
    /** Documents (tender document, BoQ, drawings) from the document store. */
    documentIds: [ObjectId],
    publishedAt: Date,
    closingAt: { type: Date, required: true },
    /** Bids are opened at the closing time or soon after (s.78). */
    openingAt: { type: Date, required: true },
    openingVenue: String,
    /** Mandatory (preliminary) requirements every bidder must meet. */
    mandatory: [{ type: String }],
    /** Weighted technical criteria; the weights add up to 100. */
    criteria: [new Schema({ name: { type: String, required: true }, weight: { type: Number, required: true } }, { _id: false })],
    passMark: { type: Number, default: 70 },
    /** Weight of price in the combined score (consultancy: quality and cost); 100 means lowest evaluated price. */
    financialWeight: { type: Number, default: 100 },
    addenda: [new Schema({ number: Number, text: String, at: Date, by: ObjectId })],
    clarifications: [new Schema({ question: { type: String, required: true }, askedBy: String, askedAt: Date, answer: String, answeredAt: Date, answeredBy: ObjectId })],
    openingCommittee: [committeeMember],
    evaluationCommittee: [committeeMember],
    opening: {
      at: Date,
      attendees: [ObjectId],
      bidderRepresentatives: String,
      minutes: String,
    },
    /** Each member's technical scores per responsive bid. */
    scores: [new Schema({ memberId: ObjectId, bidId: ObjectId, criterion: String, score: Number }, { _id: false })],
    evaluation: {
      completedAt: Date,
      completedBy: ObjectId,
      report: String,
      recommendedBidId: ObjectId,
      ranking: [new Schema({ bidId: ObjectId, technical: Number, financial: Number, combined: Number, rank: Number, passed: Boolean }, { _id: false })],
    },
    /** The head of procurement's professional opinion to the accounting officer (s.84). */
    opinion: { by: ObjectId, at: Date, text: String, concurs: Boolean },
    award: { bidId: ObjectId, amount: { type: Decimal128 }, by: ObjectId, at: Date, reason: String, notifiedAt: Date, standstillEnds: Date },
    /** Requests for review to the PPARB (s.167): a pending one stops the contract being signed. */
    appeals: [new Schema({ applicant: String, filedAt: Date, grounds: String, status: { type: String, enum: ['PENDING', 'DISMISSED', 'UPHELD', 'WITHDRAWN'], default: 'PENDING' }, decision: String, decidedAt: Date })],
    contract: { number: String, signedAt: Date, value: { type: Decimal128 }, startDate: Date, endDate: Date, performanceSecurity: { type: Decimal128 }, by: ObjectId },
    status: { type: String, enum: STATUSES, default: 'DRAFT' },
    cancellation: { reason: String, at: Date, by: ObjectId },
    createdBy: ObjectId,
  },
  opts,
);
tenderSchema.index({ organisationId: 1, number: 1 }, { unique: true });
tenderSchema.index({ organisationId: 1, status: 1, closingAt: -1 });

export const bidSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    tenderId: { type: ObjectId, required: true },
    number: { type: Number, required: true },
    bidder: {
      name: { type: String, required: true },
      kraPin: { type: String, required: true },
      email: String,
      phone: { type: String, required: true },
      agpo: { type: String, enum: ['NONE', 'YOUTH', 'WOMEN', 'PWD'], default: 'NONE' },
      agpoCertificate: String,
      local: { type: Boolean, default: false },
    },
    /** Sealed until opening: staff routes hide it before the tender is opened. */
    amount: { ...D128 },
    validityDays: Number,
    bidSecurityReference: String,
    /** The bidder's statement against each mandatory requirement. */
    mandatory: [new Schema({ requirement: String, provided: Boolean, reference: String }, { _id: false })],
    technicalProposal: String,
    /** Link the bidder keeps to change or withdraw before closing and to see the outcome. */
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['SUBMITTED', 'WITHDRAWN', 'LATE'], default: 'SUBMITTED' },
    /** Preliminary evaluation. */
    responsive: { type: Boolean, default: null },
    nonResponsiveReason: String,
    outcome: { type: String, enum: ['PENDING', 'SUCCESSFUL', 'UNSUCCESSFUL'], default: 'PENDING' },
    outcomeReason: String,
  },
  opts,
);
bidSchema.index({ tenderId: 1, 'bidder.kraPin': 1 }, { unique: true, partialFilterExpression: { status: 'SUBMITTED' } });
bidSchema.index({ tokenHash: 1 });

export const tenderSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    /** Highest estimate allowed for each method (KES); blank means no limit. */
    thresholds: [new Schema({ method: String, max: { type: Decimal128 } }, { _id: false })],
    /** Days between the notice and the closing date for open tenders. */
    minNoticeDays: { type: Number, default: 14 },
    /** Days after notification before the contract may be signed (s.135(3)). */
    standstillDays: { type: Number, default: 14 },
  },
  opts,
);
