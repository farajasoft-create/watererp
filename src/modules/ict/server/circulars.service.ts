import { Schema, Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { PERMISSIONS as P } from '../manifest';
import type { IctDb as Db } from './db';

type Id = Types.ObjectId;
const { ObjectId } = Schema.Types;

export const CIRCULAR_KINDS = ['MEMO', 'NOTICE', 'CIRCULAR'] as const;

export const circularSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: CIRCULAR_KINDS, default: 'MEMO' },
    title: { type: String, required: true },
    body: { type: String, required: true },
    reference: String,
    documentIds: [ObjectId],
    issuedBy: { type: ObjectId, required: true },
    issuedByName: String,
    /** Everyone; named people; or everyone with a role in a module (e.g. all of HR). */
    audience: { type: String, enum: ['ALL', 'USERS', 'MODULE'], default: 'ALL' },
    audienceUserIds: [ObjectId],
    audienceModule: String,
    /** When set, this person approves before the memo goes out. */
    approverId: { type: ObjectId, default: null },
    approvedAt: Date,
    requiresAck: { type: Boolean, default: false },
    actionBy: { type: Date, default: null },
    status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'RECALLED'], default: 'DRAFT' },
    issuedAt: Date,
    recalledReason: String,
    recipients: [new Schema({ userId: ObjectId, name: String, readAt: Date, ackAt: Date, ackComment: String, forwardedBy: ObjectId }, { _id: false })],
    /** Minutes written on the memo as it moves (e.g. "DHR: please action"). */
    minutes: [new Schema({ by: ObjectId, byName: String, to: ObjectId, toName: String, text: String, at: Date }, { _id: false })],
  },
  { timestamps: true },
);
circularSchema.index({ organisationId: 1, number: 1 }, { unique: true });
circularSchema.index({ organisationId: 1, 'recipients.userId': 1, issuedAt: -1 });

export interface CircularInput {
  kind: (typeof CIRCULAR_KINDS)[number];
  title: string;
  body: string;
  reference?: string;
  documentIds: Id[];
  audience: 'ALL' | 'USERS' | 'MODULE';
  audienceUserIds: Id[];
  audienceModule?: string;
  approverId?: Id | null;
  requiresAck: boolean;
  actionBy?: Date | null;
}

/**
 * Official memos, notices and circulars: drafted, approved where the drafter names an approver, issued to
 * everyone, named staff or a module's users (each notified), read receipts and acknowledgements tracked,
 * minuted and forwarded to another officer for action, and recalled with a reason.
 */
export class CircularsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(user: AuthUser, id: Id) {
    const c = await this.db.circulars.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!c) throw new NotFoundException('Memo not found');
    const mine = c.issuedBy.equals(user.id) || c.approverId?.equals(user.id) || c.recipients.some((r) => r.userId?.equals(user.id)) || hasPermission(user, P.CIRCULARS_ISSUE);
    if (!mine) throw new NotFoundException('Memo not found');
    return c;
  }

  async list(user: AuthUser, box: 'inbox' | 'sent' | 'all') {
    const base = { organisationId: user.organisationId };
    const filter =
      box === 'inbox' ? { ...base, status: { $in: ['ISSUED', 'RECALLED'] }, 'recipients.userId': user.id }
      : box === 'sent' ? { ...base, $or: [{ issuedBy: user.id }, { approverId: user.id, status: 'PENDING_APPROVAL' }] }
      : hasPermission(user, P.CIRCULARS_ISSUE) ? base : { ...base, 'recipients.userId': user.id };
    const rows = await this.db.circulars.find(filter, { body: 0 }).sort({ issuedAt: -1, createdAt: -1 }).limit(300).lean();
    return rows.map((c) => {
      const me = c.recipients.find((r) => r.userId?.equals(user.id));
      return { ...c, recipients: undefined, total: c.recipients.length, read: c.recipients.filter((r) => r.readAt).length, acknowledged: c.recipients.filter((r) => r.ackAt).length, mine: me ? { readAt: me.readAt ?? null, ackAt: me.ackAt ?? null } : null };
    });
  }

  /** Opening a memo records that the recipient has read it. */
  async get(user: AuthUser, id: Id) {
    const c = await this.load(user, id);
    const me = c.recipients.find((r) => r.userId?.equals(user.id));
    if (me && !me.readAt && c.status === 'ISSUED') await this.db.circulars.updateOne({ _id: id, 'recipients.userId': user.id }, { $set: { 'recipients.$.readAt': new Date() } });
    const full = await this.db.circulars.findById(id).lean();
    const canSeeAll = c.issuedBy.equals(user.id) || hasPermission(user, P.CIRCULARS_ISSUE);
    return { ...full, recipients: canSeeAll ? full!.recipients : full!.recipients.filter((r) => r.userId?.equals(user.id)) };
  }

  private async checkInput(user: AuthUser, input: CircularInput) {
    if (input.audience === 'USERS' && !input.audienceUserIds.length) throw new BadRequestException('Choose who receives it');
    if (input.audience === 'MODULE' && !input.audienceModule) throw new BadRequestException('Choose the module whose users receive it');
    if (input.approverId?.equals(user.id)) throw new BadRequestException('Someone else approves your memo');
    if (input.documentIds.length && (await this.db.documents.countDocuments({ _id: { $in: input.documentIds }, organisationId: user.organisationId, deletedAt: null })) !== input.documentIds.length) throw new BadRequestException('An attachment was not found');
  }

  async create(user: AuthUser, input: CircularInput) {
    await this.checkInput(user, input);
    const year = new Date().getUTCFullYear();
    const seq = await this.db.next(user.organisationId, `ict:circular:${input.kind}:${year}`);
    const [doc] = await this.db.circulars.create([{ ...input, organisationId: user.organisationId, number: `${input.kind}/${year}/${String(seq).padStart(3, '0')}`, issuedBy: user.id, issuedByName: user.name }]);
    await this.audit.record(user, 'ict.circular.create', 'circular', doc._id, { number: doc.number, title: input.title });
    return doc.toObject();
  }

  async update(user: AuthUser, id: Id, input: CircularInput) {
    const c = await this.load(user, id);
    if (!c.issuedBy.equals(user.id) || c.status !== 'DRAFT') throw new BadRequestException('Only the drafter changes a draft');
    await this.checkInput(user, input);
    await this.db.circulars.updateOne({ _id: id }, input);
    return this.get(user, id);
  }

  /** Sends for approval when an approver is named, otherwise issues straight away. */
  async send(user: AuthUser, id: Id) {
    const c = await this.load(user, id);
    if (!c.issuedBy.equals(user.id) || c.status !== 'DRAFT') throw new BadRequestException(`${c.number} is ${c.status.toLowerCase().replace('_', ' ')}`);
    if (c.approverId) {
      await this.db.circulars.updateOne({ _id: id }, { status: 'PENDING_APPROVAL' });
      await this.notifications.notify(user.organisationId, [c.approverId], { title: `Approve ${c.number}: ${c.title}`, body: `From ${user.name}`, link: `/ict/memos/${id}`, module: 'ict', email: true });
      return this.get(user, id);
    }
    return this.issue(user, c);
  }

  async approve(user: AuthUser, id: Id, decision: { approve: boolean; comment?: string }) {
    const c = await this.load(user, id);
    if (c.status !== 'PENDING_APPROVAL' || !c.approverId?.equals(user.id)) throw new ForbiddenException('This memo is not waiting for your approval');
    if (!decision.approve) {
      await this.db.circulars.updateOne({ _id: id }, { status: 'DRAFT', $push: { minutes: { by: user.id, byName: user.name, text: `Returned: ${decision.comment ?? ''}`.trim(), at: new Date() } } });
      await this.notifications.notify(user.organisationId, [c.issuedBy], { title: `${c.number} returned`, body: decision.comment, link: `/ict/memos/${id}`, module: 'ict' });
      return this.get(user, id);
    }
    await this.db.circulars.updateOne({ _id: id }, { approvedAt: new Date(), ...(decision.comment && { $push: { minutes: { by: user.id, byName: user.name, text: `Approved: ${decision.comment}`, at: new Date() } } }) });
    return this.issue(user, c);
  }

  private async issue(user: AuthUser, c: { _id: Id; number: string; title: string; kind: string; audience?: string | null; audienceUserIds: Id[]; audienceModule?: string | null; issuedBy: Id; requiresAck?: boolean | null }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, active: true };
    if (c.audience === 'USERS') filter._id = { $in: c.audienceUserIds };
    if (c.audience === 'MODULE') filter.$or = [{ 'access.module': c.audienceModule }, { isAdmin: true }];
    const people = await this.db.users.find(filter, { name: 1 }).lean();
    if (!people.length) throw new BadRequestException('Nobody would receive it');
    await this.db.circulars.updateOne({ _id: c._id }, { status: 'ISSUED', issuedAt: new Date(), recipients: people.map((p) => ({ userId: p._id, name: p.name })) });
    await this.notifications.notify(user.organisationId, people.map((p) => p._id).filter((p) => !p.equals(c.issuedBy)), { title: `${c.kind === 'NOTICE' ? 'Notice' : 'Memo'} ${c.number}: ${c.title}`, body: c.requiresAck ? 'Please read and acknowledge.' : undefined, link: `/ict/memos/${c._id}`, module: 'ict', email: true });
    await this.audit.record(user, 'ict.circular.issue', 'circular', c._id, { number: c.number, recipients: people.length });
    return this.get(user, c._id);
  }

  async acknowledge(user: AuthUser, id: Id, comment?: string) {
    const c = await this.load(user, id);
    if (c.status !== 'ISSUED') throw new BadRequestException(`${c.number} is ${c.status.toLowerCase()}`);
    const r = await this.db.circulars.updateOne({ _id: id, 'recipients.userId': user.id }, { $set: { 'recipients.$.ackAt': new Date(), 'recipients.$.ackComment': comment ?? '', 'recipients.$.readAt': c.recipients.find((x) => x.userId?.equals(user.id))?.readAt ?? new Date() } });
    if (!r.matchedCount) throw new ForbiddenException('This memo was not sent to you');
    return this.get(user, id);
  }

  /** Minutes the memo to another officer, who becomes a recipient and is notified. */
  async forward(user: AuthUser, id: Id, input: { userId: Id; minute: string }) {
    const c = await this.load(user, id);
    if (c.status !== 'ISSUED') throw new BadRequestException(`${c.number} is ${c.status.toLowerCase()}`);
    if (!c.recipients.some((r) => r.userId?.equals(user.id)) && !c.issuedBy.equals(user.id)) throw new ForbiddenException('Only someone it was sent to can minute it on');
    const to = await this.db.users.findOne({ _id: input.userId, organisationId: user.organisationId, active: true }, { name: 1 }).lean();
    if (!to) throw new NotFoundException('User not found');
    const minute = { by: user.id, byName: user.name, to: to._id, toName: to.name, text: input.minute, at: new Date() };
    if (c.recipients.some((r) => r.userId?.equals(to._id))) await this.db.circulars.updateOne({ _id: id }, { $push: { minutes: minute } });
    else await this.db.circulars.updateOne({ _id: id }, { $push: { minutes: minute, recipients: { userId: to._id, name: to.name, forwardedBy: user.id } } });
    await this.notifications.notify(user.organisationId, [to._id], { title: `${c.number} minuted to you by ${user.name}`, body: input.minute, link: `/ict/memos/${id}`, module: 'ict', email: true });
    await this.audit.record(user, 'ict.circular.forward', 'circular', id, { to: to.name });
    return this.get(user, id);
  }

  async recall(user: AuthUser, id: Id, reason: string) {
    const c = await this.load(user, id);
    if (!c.issuedBy.equals(user.id) && !hasPermission(user, P.CIRCULARS_ISSUE)) throw new ForbiddenException('Only the issuer recalls a memo');
    if (c.status !== 'ISSUED') throw new BadRequestException(`${c.number} is ${c.status.toLowerCase()}`);
    await this.db.circulars.updateOne({ _id: id }, { status: 'RECALLED', recalledReason: reason });
    await this.notifications.notify(user.organisationId, c.recipients.map((r) => r.userId!).filter(Boolean), { title: `${c.number} recalled`, body: reason, link: `/ict/memos/${id}`, module: 'ict' });
    await this.audit.record(user, 'ict.circular.recall', 'circular', id, { reason });
    return this.get(user, id);
  }
}
