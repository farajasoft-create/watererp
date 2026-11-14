import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId } = Schema.Types;
const opts = { timestamps: true } as const;

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
/**
 * OPEN → ASSIGNED → IN_PROGRESS (or ON_HOLD, waiting on the user or a supplier) → RESOLVED → CLOSED once
 * the requester confirms (or after a few days without a reply). A requester who is not satisfied
 * REOPENS it. A request still OPEN can be CANCELLED by the requester.
 */
export const TICKET_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED'] as const;
export const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'] as const;
export const CHANNELS = ['PORTAL', 'EMAIL', 'PHONE', 'WALK_IN'] as const;

/** Hours to first response and to resolution for each priority, used when the organisation has not set its own. */
export const DEFAULT_SLA: Record<(typeof PRIORITIES)[number], { respond: number; resolve: number }> = {
  CRITICAL: { respond: 1, resolve: 4 },
  HIGH: { respond: 2, resolve: 8 },
  MEDIUM: { respond: 4, resolve: 24 },
  LOW: { respond: 8, resolve: 72 },
};

export const DEFAULT_CATEGORIES = [
  { code: 'HARDWARE', name: 'Computer and hardware' },
  { code: 'SOFTWARE', name: 'Software and applications' },
  { code: 'ERP', name: 'ERP system' },
  { code: 'NETWORK', name: 'Network and internet' },
  { code: 'EMAIL', name: 'Email and user accounts' },
  { code: 'PRINTER', name: 'Printing and scanning' },
  { code: 'PHONE', name: 'Telephone' },
  { code: 'ACCESS', name: 'Access request (system or room)' },
  { code: 'OTHER', name: 'Other' },
];

/** Help desk settings of an organisation (one document each). */
export const ictSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    sla: {
      type: [{ _id: false, priority: { type: String, enum: PRIORITIES }, respond: Number, resolve: Number }],
      default: () => Object.entries(DEFAULT_SLA).map(([priority, v]) => ({ priority, ...v })),
    },
    /** A resolved ticket closes by itself when the requester has not replied in this many days. */
    autoCloseDays: { type: Number, default: 3 },
    /** Email the requester at each step, as well as the in-app notice. */
    emailRequester: { type: Boolean, default: true },
  },
  opts,
);

export const categorySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    /** New tickets in this category go straight to this officer. */
    defaultAssignee: { type: ObjectId, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
categorySchema.index({ organisationId: 1, code: 1 }, { unique: true });

const historySchema = new Schema({ at: { type: Date, required: true }, by: ObjectId, byName: String, action: String, note: String }, { _id: false });
const commentSchema = new Schema({ at: { type: Date, required: true }, by: ObjectId, byName: String, body: String, internal: { type: Boolean, default: false } });

export const ticketSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, default: 'PORTAL' },
    requesterId: { type: ObjectId, required: true },
    requesterName: String,
    requesterEmail: String,
    department: String,
    location: String,
    phone: String,
    categoryId: { type: ObjectId, required: true },
    category: String,
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    subject: { type: String, required: true },
    description: String,
    /** Office asset the problem is with (its tag), so each asset's history can be seen. */
    assetTag: String,
    status: { type: String, enum: TICKET_STATUSES, default: 'OPEN' },
    assignedTo: { type: ObjectId, default: null },
    assignedName: String,
    respondBy: Date,
    resolveBy: Date,
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    resolution: String,
    /** Requester's rating, 1 to 5, and comment when closing. */
    rating: { type: Number, default: null },
    feedback: String,
    reopenCount: { type: Number, default: 0 },
    /** 1 when a deadline was missed, 2 when it is twice as late. */
    escalationLevel: { type: Number, default: 0 },
    escalatedAt: Date,
    /** Time spent on hold, which does not count against the resolution time. */
    onHoldSince: { type: Date, default: null },
    onHoldMinutes: { type: Number, default: 0 },
    history: [historySchema],
    comments: [commentSchema],
  },
  opts,
);
ticketSchema.index({ organisationId: 1, number: 1 }, { unique: true });
ticketSchema.index({ organisationId: 1, status: 1, resolveBy: 1 });
ticketSchema.index({ organisationId: 1, requesterId: 1, createdAt: -1 });
ticketSchema.index({ organisationId: 1, assignedTo: 1, status: 1 });

export const ASSET_KINDS = ['COMPUTER', 'LAPTOP', 'PRINTER', 'PHONE', 'TABLET', 'MONITOR', 'NETWORK', 'FURNITURE', 'VEHICLE_ACCESSORY', 'OTHER'] as const;
export const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'FAULTY'] as const;

/** A piece of office equipment and who holds it. The tag can be the fixed-asset register's tag. */
export const officeAssetSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    tag: { type: String, required: true },
    description: { type: String, required: true },
    kind: { type: String, enum: ASSET_KINDS, default: 'OTHER' },
    make: String,
    model: String,
    serialNo: String,
    location: String,
    condition: { type: String, enum: ASSET_CONDITIONS, default: 'GOOD' },
    status: { type: String, enum: ['IN_STORE', 'ISSUED', 'UNDER_REPAIR', 'DISPOSED'], default: 'IN_STORE' },
    holderId: { type: ObjectId, default: null },
    holderName: String,
    department: String,
    issuedAt: Date,
    allocations: [
      new Schema({ holderId: ObjectId, holderName: String, department: String, issuedAt: Date, issuedBy: ObjectId, conditionOut: String, returnedAt: Date, receivedBy: ObjectId, conditionIn: String, note: String }),
    ],
  },
  opts,
);
officeAssetSchema.index({ organisationId: 1, tag: 1 }, { unique: true });

/** Office consumables (toner, paper, cartridges…) held by administration. */
export const consumableSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    unit: { type: String, default: 'each' },
    onHand: { type: Number, default: 0 },
    reorderLevel: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  opts,
);
consumableSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** Each receipt into or issue out of consumables stock. */
export const consumableMoveSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    consumableId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['RECEIPT', 'ISSUE', 'ADJUSTMENT'], required: true },
    quantity: { type: Number, required: true },
    /** Issues: who it went to, and their department. Receipts: supplier or LPO reference. */
    toId: { type: ObjectId, default: null },
    toName: String,
    department: String,
    reference: String,
    date: { type: Date, required: true },
    by: ObjectId,
  },
  opts,
);
consumableMoveSchema.index({ organisationId: 1, consumableId: 1, date: -1 });
consumableMoveSchema.index({ organisationId: 1, date: -1 });

export type TicketDoc = InferSchemaType<typeof ticketSchema> & { _id: Types.ObjectId };
