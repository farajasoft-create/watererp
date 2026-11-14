import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 8 (communication & identity) data model: the email outbox, single-use account tokens
 * (password reset, invitations) and scheduled report subscriptions.
 */

const ObjectId = Schema.Types.ObjectId;
const options = { timestamps: true, versionKey: false } as const;

export const EMAIL_CATEGORIES = ['account', 'notification', 'digest', 'reminder', 'report', 'invoice', 'procurement', 'test'] as const;

/** An email waiting to be sent, sent, or given up on. Written in the same transaction as its cause. */
export const EmailMessageSchema = new Schema(
  {
    organisationId: { type: ObjectId, default: null },
    to: { type: [String], required: true },
    replyTo: { type: String, default: null },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    text: { type: String, required: true },
    category: { type: String, enum: EMAIL_CATEGORIES, required: true },
    /** Lower is sent first: account emails (reset links) never wait behind bulk mail. */
    priority: { type: Number, default: 2 },
    /** Account emails carry secrets (reset links); their bodies are not shown in the email log. */
    sensitive: { type: Boolean, default: false },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: '' },
    provider: { type: String, default: null },
    providerId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    relatedType: { type: String, default: null },
    relatedId: { type: ObjectId, default: null },
    /** Files sent with the message (invoice PDFs), base64. */
    attachments: {
      type: [new Schema({ filename: { type: String, required: true }, contentType: { type: String, required: true }, content: { type: String, required: true } }, { _id: false })],
      default: [],
    },
  },
  options,
);
EmailMessageSchema.index({ status: 1, priority: 1, nextAttemptAt: 1 });
EmailMessageSchema.index({ organisationId: 1, createdAt: -1 });
EmailMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

/** A single-use secret sent by email. Only its SHA-256 hash is stored. */
export const AuthTokenSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    purpose: { type: String, enum: ['password_reset', 'invitation'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, default: null },
    ip: { type: String, default: null },
  },
  options,
);
AuthTokenSchema.index({ userId: 1, purpose: 1, usedAt: 1 });
AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

/** The monthly management pack, emailed to people who each see only what their role allows. */
export const ReportSubscriptionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    userIds: { type: [ObjectId], default: [] },
    /** Sent on or after this day of the month, for the previous month. */
    dayOfMonth: { type: Number, default: 5, min: 1, max: 28 },
    lastSentFor: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
ReportSubscriptionSchema.index({ organisationId: 1, entityId: 1 }, { unique: true });

export const SMS_CATEGORIES = ['payment', 'invoice', 'reminder', 'approval', 'test'] as const;

/** A text message waiting to be sent, sent, or given up on (Africa's Talking). */
export const SmsMessageSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    /** International format without spaces, e.g. +254712345678. */
    to: { type: String, required: true },
    message: { type: String, required: true },
    category: { type: String, enum: SMS_CATEGORIES, required: true },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: '' },
    provider: { type: String, default: null },
    providerId: { type: String, default: null },
    cost: { type: String, default: null },
    sentAt: { type: Date, default: null },
    relatedType: { type: String, default: null },
    relatedId: { type: ObjectId, default: null },
  },
  options,
);
SmsMessageSchema.index({ status: 1, nextAttemptAt: 1 });
SmsMessageSchema.index({ organisationId: 1, createdAt: -1 });
SmsMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const COMMUNICATION_MODELS = {
  SmsMessage: SmsMessageSchema,
  EmailMessage: EmailMessageSchema,
  AuthToken: AuthTokenSchema,
  ReportSubscription: ReportSubscriptionSchema,
} as const;

type WithId<T> = T & { _id: Types.ObjectId };
export type EmailMessage = WithId<InferSchemaType<typeof EmailMessageSchema>>;
export type AuthToken = WithId<InferSchemaType<typeof AuthTokenSchema>>;
export type SmsMessage = WithId<InferSchemaType<typeof SmsMessageSchema>>;
export type ReportSubscription = WithId<InferSchemaType<typeof ReportSubscriptionSchema>>;
