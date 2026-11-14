import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

export const RATINGS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Rating = (typeof RATINGS)[number];

/** Impact × likelihood on 1–5 scales gives 1–25. */
export function ratingOf(score: number): Rating {
  return score >= 17 ? 'CRITICAL' : score >= 10 ? 'HIGH' : score >= 5 ? 'MEDIUM' : 'LOW';
}
/** How often an area should be audited, by its risk. */
export const CYCLE_MONTHS: Record<Rating, number> = { CRITICAL: 12, HIGH: 12, MEDIUM: 24, LOW: 36 };

/** An auditable area: a department, process, system, project or branch. */
export const universeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ['DEPARTMENT', 'PROCESS', 'SYSTEM', 'PROJECT', 'BRANCH', 'OTHER'], default: 'PROCESS' },
    owner: String,
    ownerId: { type: ObjectId, default: null },
    description: String,
    /** The area's own assessment when it has no risks in the register yet. */
    impact: { type: Number, min: 1, max: 5, default: 3 },
    likelihood: { type: Number, min: 1, max: 5, default: 3 },
    lastAuditedAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
universeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** The risk register: each risk scored before (inherent) and after (residual) its controls. */
export const riskSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, enum: ['STRATEGIC', 'OPERATIONAL', 'FINANCIAL', 'COMPLIANCE', 'ICT', 'FRAUD', 'REPUTATIONAL'], default: 'OPERATIONAL' },
    universeId: { type: ObjectId, default: null },
    owner: String,
    cause: String,
    consequence: String,
    impact: { type: Number, min: 1, max: 5, required: true },
    likelihood: { type: Number, min: 1, max: 5, required: true },
    controls: String,
    residualImpact: { type: Number, min: 1, max: 5, required: true },
    residualLikelihood: { type: Number, min: 1, max: 5, required: true },
    treatment: { type: String, enum: ['ACCEPT', 'REDUCE', 'TRANSFER', 'AVOID'], default: 'REDUCE' },
    reviewDate: Date,
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  },
  opts,
);
riskSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** A reusable audit programme: the procedures an engagement of a given kind works through. */
export const programmeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    area: String,
    objective: String,
    procedures: [{ _id: false, ref: String, title: String, steps: String }],
    active: { type: Boolean, default: true },
  },
  opts,
);

export const PLAN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;

/** The annual (risk-based) audit plan, approved by the audit committee before work starts. */
export const planSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    year: { type: String, required: true },
    title: { type: String, required: true },
    status: { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
    /** Hours the audit team has in the year, to check the plan fits. */
    availableHours: { type: Number, default: 0 },
    items: [
      new Schema({
        universeId: ObjectId,
        title: String,
        kind: { type: String, default: 'ASSURANCE' },
        quarter: { type: Number, min: 1, max: 4 },
        start: Date,
        end: Date,
        hours: { type: Number, default: 0 },
        cost: { ...D128 },
        leadId: { type: ObjectId, default: null },
        rating: String,
        engagementId: { type: ObjectId, default: null },
      }),
    ],
    preparedBy: ObjectId,
    submittedAt: Date,
    decidedBy: ObjectId,
    decidedAt: Date,
    decisionNote: String,
    version: { type: Number, default: 1 },
  },
  opts,
);
planSchema.index({ organisationId: 1, year: 1, version: 1 }, { unique: true });

export const ENGAGEMENT_KINDS = ['ASSURANCE', 'CONSULTING', 'INVESTIGATION', 'FOLLOW_UP', 'SPECIAL'] as const;
export const ENGAGEMENT_STATUSES = ['PLANNING', 'FIELDWORK', 'REPORTING', 'ISSUED', 'CLOSED', 'CANCELLED'] as const;
export const REPORT_STATUSES = ['NONE', 'DRAFT', 'REVIEWED', 'APPROVED', 'ISSUED'] as const;

export const engagementSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true },
    kind: { type: String, enum: ENGAGEMENT_KINDS, default: 'ASSURANCE' },
    universeId: { type: ObjectId, default: null },
    area: String,
    planId: { type: ObjectId, default: null },
    planItemId: { type: ObjectId, default: null },
    objectives: String,
    scope: String,
    start: Date,
    end: Date,
    leadId: { type: ObjectId, required: true },
    team: [ObjectId],
    /** Only the team, audit managers and the head see it (investigations). */
    restricted: { type: Boolean, default: false },
    status: { type: String, enum: ENGAGEMENT_STATUSES, default: 'PLANNING' },
    budgetHours: { type: Number, default: 0 },
    budgetCost: { ...D128 },
    tasks: [
      new Schema({ title: String, assigneeId: ObjectId, due: Date, done: { type: Boolean, default: false }, doneAt: Date }),
    ],
    report: {
      status: { type: String, enum: REPORT_STATUSES, default: 'NONE' },
      summary: String,
      conclusion: String,
      opinion: { type: String, enum: ['SATISFACTORY', 'NEEDS_IMPROVEMENT', 'UNSATISFACTORY', null], default: null },
      draftedBy: ObjectId,
      draftedAt: Date,
      reviewedBy: ObjectId,
      reviewedAt: Date,
      approvedBy: ObjectId,
      approvedAt: Date,
      issuedAt: Date,
      returnNote: String,
    },
    closedAt: Date,
    createdBy: ObjectId,
  },
  opts,
);
engagementSchema.index({ organisationId: 1, number: 1 }, { unique: true });

const versionSchema = new Schema({ version: Number, content: String, conclusion: String, savedBy: ObjectId, savedByName: String, at: Date }, { _id: false });

/** An electronic working paper: what was tested, how, what was found, signed by preparer and reviewer. */
export const workpaperSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    engagementId: { type: ObjectId, required: true },
    ref: { type: String, required: true },
    title: { type: String, required: true },
    procedure: String,
    content: String,
    conclusion: String,
    /** Only the engagement lead and audit managers can open it. */
    confidential: { type: Boolean, default: false },
    status: { type: String, enum: ['DRAFT', 'PREPARED', 'REVIEWED'], default: 'DRAFT' },
    preparedBy: ObjectId,
    preparedByName: String,
    preparedAt: Date,
    reviewedBy: ObjectId,
    reviewedByName: String,
    reviewedAt: Date,
    reviewNotes: [{ _id: false, at: Date, byName: String, note: String }],
    version: { type: Number, default: 1 },
    versions: [versionSchema],
    sample: {
      population: Number,
      size: Number,
      method: { type: String, enum: ['RANDOM', 'SYSTEMATIC', 'MONETARY'] },
      seed: Number,
      /** Item numbers (1-based) chosen from the population. */
      items: [Number],
      populationValue: Number,
      drawnBy: ObjectId,
      drawnAt: Date,
    },
    /** Transactions pulled from another module to test: the query, and the rows as they were when pulled. */
    population: {
      dataset: String,
      label: String,
      filters: Schema.Types.Mixed,
      columns: [{ key: String, label: String, type: { type: String } }],
      valueField: String,
      count: Number,
      total: Number,
      rows: [Schema.Types.Mixed],
      truncated: Boolean,
      pulledBy: ObjectId,
      pulledAt: Date,
    },
  },
  opts,
);
workpaperSchema.index({ organisationId: 1, engagementId: 1, ref: 1 }, { unique: true });

export const FINDING_STATUSES = ['DRAFT', 'AGREED', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'NOT_ACCEPTED'] as const;

/** A finding (condition, criteria, cause, effect), its recommendation and management's action on it. */
export const findingSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    engagementId: { type: ObjectId, required: true },
    ref: { type: String, required: true },
    title: { type: String, required: true },
    condition: String,
    criteria: String,
    cause: String,
    effect: String,
    rating: { type: String, enum: RATINGS, default: 'MEDIUM' },
    recommendation: String,
    workpaperId: { type: ObjectId, default: null },
    /** Management's response and action plan. */
    ownerId: { type: ObjectId, default: null },
    ownerName: String,
    response: String,
    accepted: { type: Boolean, default: null },
    action: String,
    dueDate: Date,
    originalDueDate: Date,
    status: { type: String, enum: FINDING_STATUSES, default: 'DRAFT' },
    updates: [{ _id: false, at: Date, byName: String, note: String, documentIds: [ObjectId], kind: String }],
    implementedAt: Date,
    verifiedBy: ObjectId,
    verifiedAt: Date,
    lastReminderAt: Date,
    escalatedAt: Date,
    createdBy: ObjectId,
  },
  opts,
);
findingSchema.index({ organisationId: 1, engagementId: 1, ref: 1 }, { unique: true });
findingSchema.index({ organisationId: 1, status: 1, dueDate: 1 });
findingSchema.index({ organisationId: 1, ownerId: 1 });

/** Hours an auditor spent, by engagement and activity. */
export const timeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    engagementId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    userName: String,
    date: { type: Date, required: true },
    hours: { type: Number, required: true, min: 0.25, max: 24 },
    activity: { type: String, enum: ['PLANNING', 'FIELDWORK', 'REVIEW', 'REPORTING', 'FOLLOW_UP', 'TRAVEL'], default: 'FIELDWORK' },
    note: String,
  },
  opts,
);
timeSchema.index({ organisationId: 1, engagementId: 1 });
timeSchema.index({ organisationId: 1, userId: 1, date: 1 });

/** Other engagement costs: travel, allowances, experts. */
export const costSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    engagementId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    amount: { ...D128 },
    by: ObjectId,
  },
  opts,
);
costSchema.index({ organisationId: 1, engagementId: 1 });

/** Module settings: the cost of an audit hour, used for engagement costs. */
export const iaSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    hourlyRate: { ...D128 },
    /** Remind action owners this many days before a recommendation is due. */
    remindDays: { type: Number, default: 14 },
    /** Escalate to the head of internal audit this many days after it is overdue. */
    escalateDays: { type: Number, default: 30 },
  },
  opts,
);

export type EngagementDoc = InferSchemaType<typeof engagementSchema> & { _id: Types.ObjectId };
export type FindingDoc = InferSchemaType<typeof findingSchema> & { _id: Types.ObjectId };
export type WorkpaperDoc = InferSchemaType<typeof workpaperSchema> & { _id: Types.ObjectId };
