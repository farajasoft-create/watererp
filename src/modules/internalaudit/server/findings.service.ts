import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { assertCanSee, assertCanWork, isManager, onTeam } from './access';
import { iaSettings, InternalauditDb as Db } from './db';
import { EngagementsService } from './engagements.service';
import { Rating } from './schemas';

type FindingRef = { _id: Types.ObjectId; ref: string; title: string; ownerId?: Types.ObjectId | null };

type Id = Types.ObjectId;
const DAY = 86_400_000;
const OPEN = ['AGREED', 'IN_PROGRESS'];
const day = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export interface FindingInput {
  ref: string;
  title: string;
  condition?: string;
  criteria?: string;
  cause?: string;
  effect?: string;
  rating: Rating;
  recommendation?: string;
  workpaperId?: Id | null;
  ownerId?: Id | null;
  dueDate?: Date | null;
}

/** Days past due (0 when not yet due) and the ageing band it falls in. */
export function ageing(due: Date | null | undefined, now = new Date()) {
  const late = due ? Math.floor((now.getTime() - due.getTime()) / DAY) : 0;
  const band = !due || late <= 0 ? 'Not yet due' : late <= 30 ? '1–30 days' : late <= 90 ? '31–90 days' : late <= 180 ? '91–180 days' : 'Over 180 days';
  return { daysOverdue: Math.max(late, 0), band };
}
export const AGEING_BANDS = ['Not yet due', '1–30 days', '31–90 days', '91–180 days', 'Over 180 days'];

/**
 * Audit findings and the recommendations that come from them: written up by the team, answered by
 * management with an action plan, then tracked to closure: updates with evidence, implementation,
 * verification by audit, reminders before the due date and escalation once long overdue.
 */
export class FindingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly engagements: EngagementsService,
  ) {}

  private async engagement(user: AuthUser, id: Id) {
    const e = await this.db.engagements.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Engagement not found');
    return e;
  }

  private async load(user: AuthUser, id: Id) {
    const f = await this.db.findings.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!f) throw new NotFoundException('Finding not found');
    const e = await this.engagement(user, f.engagementId);
    return { f, e };
  }

  /** The action owner, or audit staff who may see the engagement. */
  private async readable(user: AuthUser, id: Id) {
    const { f, e } = await this.load(user, id);
    if (!f.ownerId?.equals(user.id)) assertCanSee(user, e);
    return { f, e };
  }

  private async owner(organisationId: Id, ownerId?: Id | null) {
    if (!ownerId) return null;
    const u = await this.db.users.findOne({ _id: ownerId, organisationId, active: { $ne: false } }, { name: 1 }).lean();
    if (!u) throw new BadRequestException('Action owner not found');
    return u;
  }

  async get(user: AuthUser, id: Id) {
    const { f, e } = await this.readable(user, id);
    await this.audit.record(user, 'internalaudit.finding.view', 'iaFinding', id, { ref: f.ref });
    const documents = await this.db.documents.find({ organisationId: user.organisationId, entity: 'iaFinding', entityId: id, latest: true, deletedAt: null }, { name: 1, contentType: 1, size: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean();
    return { ...f, ...ageing(OPEN.includes(f.status) ? f.dueDate : null), engagement: { id: e._id, number: e.number, title: e.title, status: e.status }, documents, isOwner: Boolean(f.ownerId?.equals(user.id)) };
  }

  async create(user: AuthUser, engagementId: Id, input: FindingInput) {
    const e = await this.engagement(user, engagementId);
    assertCanWork(user, e);
    if (!['FIELDWORK', 'REPORTING'].includes(e.status)) throw new BadRequestException('Findings are written during fieldwork and reporting');
    if (input.workpaperId && !(await this.db.workpapers.exists({ _id: input.workpaperId, engagementId }))) throw new BadRequestException('Working paper not found on this engagement');
    const owner = await this.owner(user.organisationId, input.ownerId);
    try {
      const [f] = await this.db.findings.create([{ ...input, ref: input.ref.toUpperCase(), organisationId: user.organisationId, engagementId, ownerId: owner?._id ?? null, ownerName: owner?.name, createdBy: user.id }]);
      await this.audit.record(user, 'internalaudit.finding.create', 'iaFinding', f._id, { ref: f.ref, rating: f.rating });
      if (owner) await this.askResponse(user, e.number, f.toObject());
      return f.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new BadRequestException(`Reference ${input.ref.toUpperCase()} is already used on this engagement`);
      throw err;
    }
  }

  private async askResponse(user: AuthUser, number: string, f: FindingRef) {
    if (!f.ownerId || f.ownerId.equals(user.id)) return;
    await this.notifications.notify(user.organisationId, [f.ownerId], { title: `Audit ${number}: your response is needed on ${f.ref}`, body: `${f.title}. Please give management's response and an action plan with a date.`, link: `/internalaudit/findings/${f._id.toHexString()}`, module: 'internalaudit' });
  }

  async update(user: AuthUser, id: Id, input: Partial<FindingInput>) {
    const { f, e } = await this.load(user, id);
    assertCanWork(user, e);
    if (f.status !== 'DRAFT') throw new BadRequestException('The report is issued; the finding is now tracked as an action');
    const owner = input.ownerId !== undefined ? await this.owner(user.organisationId, input.ownerId) : undefined;
    const set: Record<string, unknown> = { ...input, ...(input.ref && { ref: input.ref.toUpperCase() }) };
    if (owner !== undefined) Object.assign(set, { ownerId: owner?._id ?? null, ownerName: owner?.name ?? null });
    await this.db.findings.updateOne({ _id: id }, set);
    await this.audit.record(user, 'internalaudit.finding.update', 'iaFinding', id, { ref: f.ref, fields: Object.keys(input) });
    if (owner && !f.ownerId?.equals(owner._id)) await this.askResponse(user, e.number, { ...f, ownerId: owner._id });
    return this.get(user, id);
  }

  /** Management's response before the report is issued: accepted or not, and the action and date. */
  async respond(user: AuthUser, id: Id, input: { accepted: boolean; response: string; action?: string; dueDate?: Date | null }) {
    const { f, e } = await this.load(user, id);
    if (!f.ownerId?.equals(user.id)) throw new ForbiddenException('Only the action owner gives management\'s response');
    if (f.status !== 'DRAFT') throw new BadRequestException('The report is already issued');
    if (input.accepted && (!input.action || !input.dueDate)) throw new BadRequestException('Give the action you will take and the date it will be done');
    await this.db.findings.updateOne({ _id: id }, { accepted: input.accepted, response: input.response, action: input.action, ...(input.dueDate && { dueDate: input.dueDate }) });
    await this.audit.record(user, 'internalaudit.finding.respond', 'iaFinding', id, { ref: f.ref, accepted: input.accepted });
    await this.notifications.notify(user.organisationId, [e.leadId], { title: `${e.number} ${f.ref}: management responded`, body: input.accepted ? `Accepted, action by ${day(input.dueDate)}` : 'Not accepted', link: `/internalaudit/findings/${id.toHexString()}`, module: 'internalaudit' });
    return this.get(user, id);
  }

  /** Files the owner uploaded become evidence on the finding, seen only by audit staff and the owner. */
  private async attach(user: AuthUser, f: FindingRef, e: { leadId: Id; team?: Id[] | null }, documentIds: Id[]) {
    if (!documentIds.length) return [];
    const docs = await this.db.documents.find({ _id: { $in: documentIds }, organisationId: user.organisationId, deletedAt: null }).lean();
    if (docs.length !== documentIds.length) throw new NotFoundException('Document not found');
    if (docs.some((d) => !d.uploadedBy?.equals(user.id))) throw new ForbiddenException('Attach files you uploaded');
    const readers = await this.engagements.evidenceReaders(user.organisationId, e);
    await this.db.documents.updateMany({ _id: { $in: documentIds } }, { module: 'internalaudit', entity: 'iaFinding', entityId: f._id, access: 'RESTRICTED', sharedWith: [...readers, ...(f.ownerId ? [f.ownerId] : [])], category: 'AUDIT_EVIDENCE' });
    return docs.map((d) => d._id);
  }

  /** The owner reports progress, or that it is done (with evidence); audit then verifies it. */
  async progress(user: AuthUser, id: Id, input: { note: string; implemented: boolean; documentIds: Id[] }) {
    const { f, e } = await this.load(user, id);
    if (!f.ownerId?.equals(user.id)) throw new ForbiddenException('Only the action owner updates progress');
    if (!OPEN.includes(f.status)) throw new BadRequestException(`The action is ${f.status.toLowerCase().replace('_', ' ')}`);
    if (input.implemented && !input.documentIds.length && !(await this.db.documents.exists({ entity: 'iaFinding', entityId: id, deletedAt: null }))) throw new BadRequestException('Attach evidence that the action is done');
    const docs = await this.attach(user, f, e, input.documentIds);
    await this.db.findings.updateOne({ _id: id }, { status: input.implemented ? 'IMPLEMENTED' : 'IN_PROGRESS', ...(input.implemented && { implementedAt: new Date() }), $push: { updates: { at: new Date(), byName: user.name, note: input.note, documentIds: docs, kind: input.implemented ? 'IMPLEMENTED' : 'PROGRESS' } } });
    await this.audit.record(user, input.implemented ? 'internalaudit.finding.implemented' : 'internalaudit.finding.progress', 'iaFinding', id, { ref: f.ref, documents: docs.length });
    if (input.implemented) await this.notifications.notify(user.organisationId, [e.leadId], { title: `${e.number} ${f.ref} reported done: verify it`, body: input.note, link: `/internalaudit/findings/${id.toHexString()}`, module: 'internalaudit' });
    return this.get(user, id);
  }

  /** Audit checks the evidence: verified (closed), or back to the owner with a reason. */
  async verify(user: AuthUser, id: Id, input: { verified: boolean; note: string }) {
    const { f, e } = await this.load(user, id);
    if (!isManager(user) && !onTeam(user, e)) throw new ForbiddenException('The engagement team or an audit manager verifies actions');
    if (f.ownerId?.equals(user.id)) throw new ForbiddenException('The action owner cannot verify their own action');
    if (f.status !== 'IMPLEMENTED') throw new BadRequestException('The owner has not reported it done');
    await this.db.findings.updateOne({ _id: id }, { status: input.verified ? 'VERIFIED' : 'IN_PROGRESS', ...(input.verified ? { verifiedBy: user.id, verifiedAt: new Date() } : { implementedAt: null }), $push: { updates: { at: new Date(), byName: user.name, note: input.note, kind: input.verified ? 'VERIFIED' : 'RETURNED' } } });
    await this.audit.record(user, input.verified ? 'internalaudit.finding.verify' : 'internalaudit.finding.return', 'iaFinding', id, { ref: f.ref, note: input.note });
    if (f.ownerId) await this.notifications.notify(user.organisationId, [f.ownerId], { title: `${e.number} ${f.ref} ${input.verified ? 'verified and closed' : 'not yet accepted as done'}`, body: input.note, link: `/internalaudit/findings/${id.toHexString()}`, module: 'internalaudit' });
    if (input.verified && e.status === 'ISSUED' && !(await this.db.findings.exists({ engagementId: e._id, status: { $in: [...OPEN, 'IMPLEMENTED'] } }))) {
      await this.notifications.notify(user.organisationId, [e.leadId], { title: `${e.number}: every action is verified`, body: 'The engagement can be closed.', link: `/internalaudit/engagements/${e._id.toHexString()}`, module: 'internalaudit' });
    }
    return this.get(user, id);
  }

  /** A new due date, agreed with audit; the original date is kept for the ageing record. */
  async extend(user: AuthUser, id: Id, input: { dueDate: Date; reason: string }) {
    const { f } = await this.load(user, id);
    if (!isManager(user)) throw new ForbiddenException('An audit manager agrees new due dates');
    if (!OPEN.includes(f.status)) throw new BadRequestException('Only open actions get a new date');
    await this.db.findings.updateOne({ _id: id }, { dueDate: input.dueDate, originalDueDate: f.originalDueDate ?? f.dueDate, escalatedAt: null, $push: { updates: { at: new Date(), byName: user.name, note: `New due date ${day(input.dueDate)}: ${input.reason}`, kind: 'EXTENDED' } } });
    await this.audit.record(user, 'internalaudit.finding.extend', 'iaFinding', id, { ref: f.ref, from: day(f.dueDate), to: day(input.dueDate), reason: input.reason });
    return this.get(user, id);
  }

  /** The actions the signed-in user owns, from any audit. */
  async mine(user: AuthUser) {
    const rows = await this.db.findings.find({ organisationId: user.organisationId, ownerId: user.id }).sort({ dueDate: 1 }).lean();
    const engagements = await this.db.engagements.find({ _id: { $in: rows.map((r) => r.engagementId) } }, { number: 1, title: 1 }).lean();
    return rows.map((f) => ({ ...f, ...ageing(OPEN.includes(f.status) ? f.dueDate : null), engagement: engagements.find((e) => e._id.equals(f.engagementId)) }));
  }

  /** Every recommendation from issued reports, with its age; filtered by status, rating, owner or engagement. */
  async register(user: AuthUser, q: { status?: string; rating?: string; overdue?: boolean; engagementId?: Id; ownerId?: Id }) {
    const engagements = await this.db.engagements.find({ organisationId: user.organisationId }, { number: 1, title: 1, leadId: 1, team: 1, restricted: 1, area: 1 }).lean();
    const visible = engagements.filter((e) => isManager(user) || !e.restricted || onTeam(user, e));
    const filter: Record<string, unknown> = { organisationId: user.organisationId, status: { $ne: 'DRAFT' }, engagementId: { $in: visible.map((e) => e._id) } };
    if (q.status) filter.status = q.status;
    if (q.rating) filter.rating = q.rating;
    if (q.engagementId) filter.engagementId = q.engagementId;
    if (q.ownerId) filter.ownerId = q.ownerId;
    if (q.overdue) Object.assign(filter, { status: { $in: OPEN }, dueDate: { $lt: new Date() } });
    const rows = await this.db.findings.find(filter, { updates: 0 }).sort({ dueDate: 1 }).lean();
    return rows.map((f) => {
      const e = visible.find((x) => x._id.equals(f.engagementId));
      return { ...f, ...ageing(OPEN.includes(f.status) ? f.dueDate : null), engagement: e ? { id: e._id, number: e.number, title: e.title, area: e.area } : null };
    });
  }

  async registerCsv(user: AuthUser, q: Parameters<FindingsService['register']>[1]) {
    const rows = await this.register(user, q);
    return csvResponse('audit-recommendations.csv', [
      ['Engagement', 'Ref', 'Finding', 'Rating', 'Recommendation', 'Owner', 'Agreed action', 'Original due', 'Due', 'Status', 'Days overdue', 'Ageing'],
      ...rows.map((f) => [f.engagement?.number, f.ref, f.title, f.rating, f.recommendation, f.ownerName, f.action, day(f.originalDueDate), day(f.dueDate), f.status, f.daysOverdue, f.band]),
    ]);
  }

  /**
   * Daily: remind owners of actions coming due (and weekly once overdue), and escalate to the head of
   * internal audit once an action is long overdue.
   */
  async housekeeping(organisationId: Id, now = new Date()) {
    const s = await iaSettings(this.db, organisationId);
    const open = await this.db.findings.find({ organisationId, status: { $in: OPEN }, dueDate: { $ne: null }, ownerId: { $ne: null } }).lean();
    const heads = await this.db.users.find({ organisationId, active: { $ne: false }, access: { $elemMatch: { module: 'internalaudit', role: 'HEAD' } } }, { _id: 1 }).lean();
    let reminded = 0;
    let escalated = 0;
    for (const f of open) {
      const due = f.dueDate!;
      const toGo = Math.ceil((due.getTime() - now.getTime()) / DAY);
      const since = f.lastReminderAt ? (now.getTime() - f.lastReminderAt.getTime()) / DAY : Infinity;
      const remind = (toGo >= 0 && toGo <= (s.remindDays ?? 14) && since >= 7) || (toGo < 0 && since >= 7);
      if (remind) {
        await this.notifications.notify(organisationId, [f.ownerId!], { title: toGo >= 0 ? `Audit action ${f.ref} due in ${toGo} days` : `Audit action ${f.ref} is ${-toGo} days overdue`, body: `${f.title}: ${f.action ?? f.recommendation ?? ''}`, link: `/internalaudit/findings/${f._id.toHexString()}`, module: 'internalaudit', email: true });
        await this.db.findings.updateOne({ _id: f._id }, { lastReminderAt: now });
        reminded++;
      }
      if (toGo < -(s.escalateDays ?? 30) && !f.escalatedAt) {
        await this.notifications.notify(organisationId, heads.map((h) => h._id), { title: `Audit action ${f.ref} escalated: ${-toGo} days overdue`, body: `${f.title}. Owner: ${f.ownerName ?? ''}. Due ${day(due)}.`, link: `/internalaudit/findings/${f._id.toHexString()}`, module: 'internalaudit', email: true });
        await this.db.findings.updateOne({ _id: f._id }, { escalatedAt: now, $push: { updates: { at: now, byName: 'System', note: `Escalated to the head of internal audit, ${-toGo} days overdue`, kind: 'ESCALATED' } } });
        escalated++;
      }
    }
    return { reminded, escalated };
  }
}
