import { Types } from 'mongoose';
import { renderDocumentPdf } from '@/modules/finance/core/common/document-pdf';
import { pptx } from '@/platform/common/pptx';
import { catalogue, Filter, runQuery } from '@/modules/bi/server/engine';

/** Internal audit reads every module's data (IIA standard 1130 access), as a read-only, logged query. */
const auditReader = (user: AuthUser): AuthUser => ({ ...user, isAdmin: true });
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { PERMISSIONS as P } from '../manifest';
import { assertCanSee, assertCanWork, can, engagementFilter, isManager, onTeam } from './access';
import { iaSettings, InternalauditDb as Db } from './db';
import { ENGAGEMENT_KINDS, ENGAGEMENT_STATUSES, EngagementDoc, RATINGS } from './schemas';

type Id = Types.ObjectId;
const link = (id: Id) => `/internalaudit/engagements/${id.toHexString()}`;
const day = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export interface EngagementInput {
  title: string;
  kind: (typeof ENGAGEMENT_KINDS)[number];
  universeId?: Id | null;
  planId?: Id | null;
  planItemId?: Id | null;
  objectives?: string;
  scope?: string;
  start?: Date | null;
  end?: Date | null;
  leadId: Id;
  team: Id[];
  restricted?: boolean;
  budgetHours?: number;
  programmeId?: Id | null;
}

/** A seeded pseudo-random generator (mulberry32), so a sample can be drawn again and checked. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Attribute sample size for no expected errors: n = ln(1 − confidence) / ln(1 − tolerable rate). */
export function sampleSize(confidence: number, tolerableRate: number) {
  return Math.ceil(Math.log(1 - confidence / 100) / Math.log(1 - tolerableRate / 100));
}

/** Items (1-based) chosen from a population: simple random, systematic, or monetary-unit on the item values. */
export function drawSample(input: { population: number; size: number; method: 'RANDOM' | 'SYSTEMATIC' | 'MONETARY'; seed: number; values?: number[] }): number[] {
  const { population, method, seed } = input;
  const size = Math.min(input.size, population);
  const next = rng(seed);
  if (method === 'RANDOM') {
    const chosen = new Set<number>();
    while (chosen.size < size) chosen.add(1 + Math.floor(next() * population));
    return [...chosen].sort((a, b) => a - b);
  }
  if (method === 'SYSTEMATIC') {
    const step = population / size;
    const start = next() * step;
    return Array.from({ length: size }, (_, i) => 1 + Math.floor(start + i * step));
  }
  const values = input.values ?? [];
  if (values.length !== population) throw new BadRequestException('Give a value for each item in the population for a monetary-unit sample');
  const total = values.reduce((t, v) => t + Math.abs(v), 0);
  if (!total) throw new BadRequestException('The population has no value');
  const step = total / size;
  const start = next() * step;
  const chosen = new Set<number>();
  let cum = 0;
  let k = 0;
  for (let i = 0; i < values.length && k < size; i++) {
    cum += Math.abs(values[i]);
    while (k < size && start + k * step < cum) {
      chosen.add(i + 1);
      k++;
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Audit engagements from opening to close: the team and their tasks, working papers with versions,
 * evidence and sign-off, samples, time and costs against budget, the report through review, approval
 * and issue, and a record of everyone who opened, changed or approved anything.
 */
export class EngagementsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(user: AuthUser, id: Id) {
    const e = await this.db.engagements.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Engagement not found');
    assertCanSee(user, e);
    return e;
  }

  private async assertStaff(organisationId: Id, ids: Id[]) {
    const users = await this.db.users.find({ organisationId, _id: { $in: ids }, $or: [{ isAdmin: true }, { access: { $elemMatch: { module: 'internalaudit', role: { $in: ['HEAD', 'MANAGER', 'AUDITOR'] } } } }] }, { name: 1 }).lean();
    if (users.length !== new Set(ids.map((i) => i.toHexString())).size) throw new BadRequestException('The lead and team must be internal audit staff');
    return users;
  }

  async list(user: AuthUser, q: { status?: string; year?: number; mine?: boolean }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, ...engagementFilter(user) };
    if (q.status) filter.status = q.status;
    if (q.mine) Object.assign(filter, { $and: [{ $or: [{ leadId: user.id }, { team: user.id }] }] });
    if (q.year) filter.start = { $gte: new Date(Date.UTC(q.year, 0, 1)), $lt: new Date(Date.UTC(q.year + 1, 0, 1)) };
    const rows = await this.db.engagements.find(filter, { tasks: 0 }).sort({ start: -1, number: -1 }).limit(500).lean();
    const ids = rows.map((r) => r._id);
    const [hours, findings, leads] = await Promise.all([
      this.db.time.aggregate<{ _id: Id; hours: number }>([{ $match: { organisationId: user.organisationId, engagementId: { $in: ids } } }, { $group: { _id: '$engagementId', hours: { $sum: '$hours' } } }]),
      this.db.findings.aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: user.organisationId, engagementId: { $in: ids } } }, { $group: { _id: '$engagementId', n: { $sum: 1 } } }]),
      this.db.users.find({ _id: { $in: rows.map((r) => r.leadId) } }, { name: 1 }).lean(),
    ]);
    return rows.map((r) => ({ ...r, lead: leads.find((u) => u._id.equals(r.leadId))?.name ?? '', hours: hours.find((h) => h._id.equals(r._id))?.hours ?? 0, findings: findings.find((f) => f._id.equals(r._id))?.n ?? 0 }));
  }

  async create(user: AuthUser, input: EngagementInput) {
    const org = user.organisationId;
    if (input.start && input.end && input.end < input.start) throw new BadRequestException('The end is before the start');
    const team = [...new Map([input.leadId, ...input.team].map((t) => [t.toHexString(), t])).values()];
    await this.assertStaff(org, team);
    let area: string | undefined;
    if (input.universeId) {
      const u = await this.db.universe.findOne({ _id: input.universeId, organisationId: org }).lean();
      if (!u) throw new BadRequestException('Area not found');
      area = u.name;
    }
    if (input.planId) {
      const plan = await this.db.plans.findOne({ _id: input.planId, organisationId: org }).lean();
      if (!plan || plan.status !== 'APPROVED') throw new BadRequestException('Engagements come from an approved plan');
      const item = plan.items.find((i) => input.planItemId && i._id.equals(input.planItemId));
      if (!item) throw new BadRequestException('Audit not found in the plan');
      if (item.engagementId) throw new BadRequestException('That planned audit already has an engagement');
    }
    const programme = input.programmeId ? await this.db.programmes.findOne({ _id: input.programmeId, organisationId: org }).lean() : null;
    if (input.programmeId && !programme) throw new BadRequestException('Programme not found');
    const year = (input.start ?? new Date()).getUTCFullYear();
    const e = await this.db.transaction(async (session) => {
      const seq = await this.db.next(org, `ia:engagement:${year}`, session);
      const [doc] = await this.db.engagements.create(
        [{ organisationId: org, number: `IA-${year}-${String(seq).padStart(3, '0')}`, title: input.title, kind: input.kind, universeId: input.universeId ?? null, area, planId: input.planId ?? null, planItemId: input.planItemId ?? null, objectives: input.objectives ?? programme?.objective, scope: input.scope, start: input.start, end: input.end, leadId: input.leadId, team, restricted: Boolean(input.restricted) || input.kind === 'INVESTIGATION', budgetHours: input.budgetHours ?? 0, createdBy: user.id }],
        { session },
      );
      if (programme?.procedures.length) {
        await this.db.workpapers.insertMany(programme.procedures.map((p) => ({ organisationId: org, engagementId: doc._id, ref: p.ref, title: p.title, procedure: p.steps })), { session });
      }
      if (input.planId) await this.db.plans.updateOne({ _id: input.planId, 'items._id': input.planItemId }, { $set: { 'items.$.engagementId': doc._id } }, { session });
      await this.audit.record(user, 'internalaudit.engagement.create', 'iaEngagement', doc._id, { number: doc.number, title: input.title }, session);
      return doc.toObject();
    });
    await this.notifications.notify(org, team.filter((t) => !t.equals(user.id)), { title: `You are on engagement ${e.number}`, body: e.title, link: link(e._id), module: 'internalaudit' });
    return e;
  }

  async get(user: AuthUser, id: Id) {
    const e = await this.load(user, id);
    await this.audit.record(user, 'internalaudit.engagement.view', 'iaEngagement', id, {});
    const team = await this.db.users.find({ _id: { $in: [e.leadId, ...e.team] } }, { name: 1, email: 1 }).lean();
    const working = isManager(user) || (can(user, P.WORK) && onTeam(user, e));
    const [workpapers, findings, time, costs, settings] = await Promise.all([
      working ? this.db.workpapers.find({ engagementId: id }, { versions: 0, content: 0 }).sort({ ref: 1 }).lean() : [],
      this.db.findings.find({ engagementId: id, ...(working ? {} : { status: { $ne: 'DRAFT' } }) }).sort({ ref: 1 }).lean(),
      this.db.time.find({ engagementId: id }).sort({ date: -1 }).lean(),
      this.db.costs.find({ engagementId: id }).sort({ date: -1 }).lean(),
      iaSettings(this.db, user.organisationId),
    ]);
    const hours = time.reduce((t, x) => t + x.hours, 0);
    const otherCosts = costs.reduce((t, c) => t.plus(dec(c.amount?.toString())), new Decimal(0));
    const timeCost = dec(settings.hourlyRate?.toString()).times(hours);
    const name = (uid?: Id | null) => (uid ? (team.find((u) => u._id.equals(uid))?.name ?? '') : '');
    return {
      ...e,
      lead: name(e.leadId),
      teamMembers: team,
      tasks: (e.tasks ?? []).map((t) => ({ ...t, assignee: name(t.assigneeId) })),
      workpapers: workpapers.map((w) => ({ ...w, hidden: w.confidential && !isManager(user) && !e.leadId.equals(user.id) })),
      findings,
      time: working ? time : [],
      costs: working ? costs : [],
      totals: { hours, budgetHours: e.budgetHours ?? 0, timeCost, otherCosts, cost: timeCost.plus(otherCosts), hoursUsedPct: e.budgetHours ? Math.round((hours / e.budgetHours) * 1000) / 10 : null },
      canWork: working,
    };
  }

  async update(user: AuthUser, id: Id, input: Partial<Pick<EngagementInput, 'title' | 'objectives' | 'scope' | 'start' | 'end' | 'budgetHours' | 'restricted' | 'team' | 'leadId'>>) {
    const e = await this.load(user, id);
    if (!isManager(user) && !e.leadId.equals(user.id)) throw new ForbiddenException('Only the engagement lead or an audit manager can change it');
    if (['CLOSED', 'CANCELLED'].includes(e.status)) throw new BadRequestException('The engagement is closed');
    const set: Record<string, unknown> = { ...input };
    if (input.team || input.leadId) {
      const lead = input.leadId ?? e.leadId;
      const team = [...new Map([lead, ...(input.team ?? e.team)].map((t) => [t.toHexString(), t])).values()];
      await this.assertStaff(user.organisationId, team);
      set.team = team;
      const added = team.filter((t) => !e.team.some((x) => x.equals(t)));
      if (added.length) await this.notifications.notify(user.organisationId, added, { title: `You are on engagement ${e.number}`, body: e.title, link: link(id), module: 'internalaudit' });
    }
    await this.db.engagements.updateOne({ _id: id }, set);
    await this.audit.record(user, 'internalaudit.engagement.update', 'iaEngagement', id, { fields: Object.keys(input) });
    return this.get(user, id);
  }

  /** Planning → fieldwork → reporting; closing needs every agreed action implemented or verified, or a manager. */
  async setStatus(user: AuthUser, id: Id, status: (typeof ENGAGEMENT_STATUSES)[number], note?: string) {
    const e = await this.load(user, id);
    assertCanWork(user, e);
    const allowed: Record<string, string[]> = { PLANNING: ['FIELDWORK', 'CANCELLED'], FIELDWORK: ['REPORTING', 'CANCELLED'], REPORTING: ['FIELDWORK'], ISSUED: ['CLOSED'] };
    if (!allowed[e.status]?.includes(status)) throw new BadRequestException(`An engagement in ${e.status.toLowerCase()} cannot move to ${status.toLowerCase()}`);
    if ((status === 'CANCELLED' || status === 'CLOSED') && !isManager(user)) throw new ForbiddenException('Only an audit manager can close or cancel an engagement');
    if (status === 'REPORTING') {
      const open = await this.db.workpapers.countDocuments({ engagementId: id, status: { $ne: 'REVIEWED' } });
      if (open) throw new BadRequestException(`${open} working paper${open === 1 ? ' is' : 's are'} not yet reviewed`);
    }
    await this.db.engagements.updateOne({ _id: id }, { status, ...(status === 'CLOSED' && { closedAt: new Date() }) });
    await this.audit.record(user, 'internalaudit.engagement.status', 'iaEngagement', id, { from: e.status, to: status, note });
    return this.get(user, id);
  }

  // Tasks, time and costs --------------------------------------------------------------------------

  async addTask(user: AuthUser, id: Id, input: { title: string; assigneeId: Id; due?: Date | null }) {
    const e = await this.load(user, id);
    if (!isManager(user) && !e.leadId.equals(user.id)) throw new ForbiddenException('Only the engagement lead or an audit manager can hand out tasks');
    if (!e.team.some((t) => t.equals(input.assigneeId))) throw new BadRequestException('Tasks go to members of the engagement team');
    await this.db.engagements.updateOne({ _id: id }, { $push: { tasks: { title: input.title, assigneeId: input.assigneeId, due: input.due ?? null } } });
    await this.audit.record(user, 'internalaudit.task.add', 'iaEngagement', id, { title: input.title });
    if (!input.assigneeId.equals(user.id)) await this.notifications.notify(user.organisationId, [input.assigneeId], { title: `${e.number}: ${input.title}`, body: input.due ? `Due ${day(input.due)}` : undefined, link: link(id), module: 'internalaudit' });
    return this.get(user, id);
  }

  async completeTask(user: AuthUser, id: Id, taskId: Id, done: boolean) {
    const e = await this.load(user, id);
    const task = (e.tasks ?? []).find((t) => t._id.equals(taskId));
    if (!task) throw new NotFoundException('Task not found');
    if (!task.assigneeId?.equals(user.id) && !e.leadId.equals(user.id) && !isManager(user)) throw new ForbiddenException('Not your task');
    await this.db.engagements.updateOne({ _id: id, 'tasks._id': taskId }, { $set: { 'tasks.$.done': done, 'tasks.$.doneAt': done ? new Date() : null } });
    return this.get(user, id);
  }

  async logTime(user: AuthUser, id: Id, input: { date: Date; hours: number; activity: 'PLANNING' | 'FIELDWORK' | 'REVIEW' | 'REPORTING' | 'FOLLOW_UP' | 'TRAVEL'; note?: string }) {
    const e = await this.load(user, id);
    if (!onTeam(user, e)) throw new ForbiddenException('Only members of the engagement team log time on it');
    const already = await this.db.time.aggregate<{ h: number }>([{ $match: { userId: user.id, date: input.date } }, { $group: { _id: null, h: { $sum: '$hours' } } }]);
    if ((already[0]?.h ?? 0) + input.hours > 16) throw new BadRequestException('That makes more than 16 hours on one day');
    const [row] = await this.db.time.create([{ organisationId: user.organisationId, engagementId: id, userId: user.id, userName: user.name, ...input }]);
    return row.toObject();
  }

  async addCost(user: AuthUser, id: Id, input: { date: Date; description: string; amount: Decimal }) {
    const e = await this.load(user, id);
    if (!isManager(user) && !e.leadId.equals(user.id)) throw new ForbiddenException('Only the engagement lead or an audit manager records costs');
    const [row] = await this.db.costs.create([{ organisationId: user.organisationId, engagementId: id, date: input.date, description: input.description, amount: toD128(input.amount), by: user.id }]);
    await this.audit.record(user, 'internalaudit.cost.add', 'iaEngagement', id, { amount: input.amount.toFixed(2), description: input.description });
    return row.toObject();
  }

  // Working papers ---------------------------------------------------------------------------------

  private async paper(user: AuthUser, id: Id) {
    const w = await this.db.workpapers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!w) throw new NotFoundException('Working paper not found');
    const e = await this.load(user, w.engagementId);
    assertCanWork(user, e);
    if (w.confidential && !isManager(user) && !e.leadId.equals(user.id)) throw new ForbiddenException('This working paper is confidential to the engagement lead and audit managers');
    return { w, e };
  }

  async getWorkpaper(user: AuthUser, id: Id) {
    const { w, e } = await this.paper(user, id);
    await this.audit.record(user, 'internalaudit.workpaper.view', 'iaWorkpaper', id, { ref: w.ref });
    const documents = await this.db.documents.find({ organisationId: user.organisationId, entity: 'iaWorkpaper', entityId: id, latest: true, deletedAt: null }, { name: 1, contentType: 1, size: 1, version: 1, createdAt: 1, uploadedBy: 1 }).sort({ createdAt: -1 }).lean();
    // The pulled population is shown as a preview; sampled items are shown as the records themselves.
    const rows = (w.population?.rows ?? []) as Record<string, unknown>[];
    const population = w.population?.count ? { ...w.population, rows: undefined, preview: rows.slice(0, 20) } : null;
    const sampleRows = w.sample?.items?.length && rows.length ? w.sample.items.map((n) => ({ item: n, ...rows[n - 1] })) : null;
    return { ...w, population, sampleRows, engagement: { id: e._id, number: e.number, title: e.title, status: e.status }, documents };
  }

  /** Audit staff who may open evidence on an engagement: its team, audit managers and the head. */
  async evidenceReaders(organisationId: Id, e: { leadId: Id; team?: Id[] | null }) {
    const managers = await this.db.users.find({ organisationId, access: { $elemMatch: { module: 'internalaudit', role: { $in: ['HEAD', 'MANAGER'] } } } }, { _id: 1 }).lean();
    return [...new Map([e.leadId, ...(e.team ?? []), ...managers.map((m) => m._id)].map((x) => [x.toHexString(), x])).values()];
  }

  /**
   * Files uploaded through the document store become evidence on the working paper, readable only by
   * the engagement team and audit managers (not the whole organisation).
   */
  async attachEvidence(user: AuthUser, id: Id, documentIds: Id[]) {
    const { w, e } = await this.paper(user, id);
    const docs = await this.db.documents.find({ _id: { $in: documentIds }, organisationId: user.organisationId, deletedAt: null }).lean();
    if (docs.length !== documentIds.length) throw new NotFoundException('Document not found');
    if (docs.some((d) => !d.uploadedBy?.equals(user.id) && !(d.entity === 'iaWorkpaper' && d.entityId?.equals(id)))) throw new ForbiddenException('Attach files you uploaded');
    const readers = await this.evidenceReaders(user.organisationId, e);
    await this.db.documents.updateMany({ _id: { $in: documentIds } }, { module: 'internalaudit', entity: 'iaWorkpaper', entityId: id, access: 'RESTRICTED', sharedWith: readers, category: 'AUDIT_EVIDENCE' });
    await this.audit.record(user, 'internalaudit.workpaper.evidence', 'iaWorkpaper', id, { ref: w.ref, documents: docs.map((d) => d.name) });
    return this.getWorkpaper(user, id);
  }

  async createWorkpaper(user: AuthUser, engagementId: Id, input: { ref: string; title: string; procedure?: string; confidential?: boolean }) {
    const e = await this.load(user, engagementId);
    assertCanWork(user, e);
    if (['ISSUED', 'CLOSED', 'CANCELLED'].includes(e.status)) throw new BadRequestException('The engagement is past fieldwork');
    try {
      const [w] = await this.db.workpapers.create([{ organisationId: user.organisationId, engagementId, ref: input.ref.toUpperCase(), title: input.title, procedure: input.procedure, confidential: Boolean(input.confidential) }]);
      await this.audit.record(user, 'internalaudit.workpaper.create', 'iaWorkpaper', w._id, { ref: w.ref });
      return w.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new BadRequestException(`Reference ${input.ref.toUpperCase()} is already used on this engagement`);
      throw err;
    }
  }

  /** Saving keeps the previous text as a version; a signed-off paper goes back to draft when changed. */
  async saveWorkpaper(user: AuthUser, id: Id, input: { title?: string; procedure?: string; content?: string; conclusion?: string; confidential?: boolean }) {
    const { w, e } = await this.paper(user, id);
    if (['ISSUED', 'CLOSED', 'CANCELLED'].includes(e.status)) throw new BadRequestException('The engagement is past fieldwork');
    const changed = (input.content !== undefined && input.content !== w.content) || (input.conclusion !== undefined && input.conclusion !== w.conclusion);
    const set: Record<string, unknown> = { ...input };
    const push: Record<string, unknown> = {};
    if (changed) {
      push.versions = { version: w.version ?? 1, content: w.content, conclusion: w.conclusion, savedBy: user.id, savedByName: user.name, at: new Date() };
      set.version = (w.version ?? 1) + 1;
      if (w.status !== 'DRAFT') Object.assign(set, { status: 'DRAFT', preparedAt: null, reviewedAt: null, reviewedBy: null, reviewedByName: null });
    }
    await this.db.workpapers.updateOne({ _id: id }, { ...set, ...(changed && { $push: push }) });
    await this.audit.record(user, 'internalaudit.workpaper.update', 'iaWorkpaper', id, { ref: w.ref, version: set.version ?? w.version });
    return this.getWorkpaper(user, id);
  }

  /** The preparer signs it off as done; a reviewer (not the preparer) then signs or returns it with notes. */
  async signWorkpaper(user: AuthUser, id: Id, input: { action: 'PREPARE' | 'REVIEW' | 'RETURN'; note?: string }) {
    const { w, e } = await this.paper(user, id);
    const now = new Date();
    if (input.action === 'PREPARE') {
      if (w.status !== 'DRAFT') throw new BadRequestException('Already signed off');
      if (!w.content?.trim() || !w.conclusion?.trim()) throw new BadRequestException('Write up the work done and a conclusion first');
      await this.db.workpapers.updateOne({ _id: id }, { status: 'PREPARED', preparedBy: user.id, preparedByName: user.name, preparedAt: now });
      const reviewers = isManager(user) ? [] : [e.leadId].filter((l) => !l.equals(user.id));
      await this.notifications.notify(user.organisationId, reviewers, { title: `${e.number} ${w.ref} ready for review`, body: w.title, link: `/internalaudit/workpapers/${id.toHexString()}`, module: 'internalaudit' });
    } else {
      if (w.status !== 'PREPARED') throw new BadRequestException('The working paper is not waiting for review');
      if (w.preparedBy?.equals(user.id)) throw new ForbiddenException('Someone other than the preparer must review it');
      if (!isManager(user) && !e.leadId.equals(user.id)) throw new ForbiddenException('The engagement lead or an audit manager reviews working papers');
      if (input.action === 'RETURN' && !input.note) throw new BadRequestException('Say what needs doing');
      await this.db.workpapers.updateOne(
        { _id: id },
        {
          ...(input.action === 'REVIEW' ? { status: 'REVIEWED', reviewedBy: user.id, reviewedByName: user.name, reviewedAt: now } : { status: 'DRAFT', preparedAt: null }),
          ...(input.note && { $push: { reviewNotes: { at: now, byName: user.name, note: input.note } } }),
        },
      );
      if (input.action === 'RETURN' && w.preparedBy) await this.notifications.notify(user.organisationId, [w.preparedBy], { title: `${e.number} ${w.ref} returned`, body: input.note, link: `/internalaudit/workpapers/${id.toHexString()}`, module: 'internalaudit' });
    }
    await this.audit.record(user, `internalaudit.workpaper.${input.action.toLowerCase()}`, 'iaWorkpaper', id, { ref: w.ref, note: input.note });
    return this.getWorkpaper(user, id);
  }

  /** Datasets of every module, as the auditor may read them for testing. */
  dataCatalogue(user: AuthUser) {
    return catalogue(auditReader(user));
  }

  /**
   * Pulls the transactions to test from another module (any BI dataset, filtered) into the working paper,
   * kept as they were at that moment; sampling then picks from these rows. Read-only and logged.
   */
  async pullPopulation(user: AuthUser, id: Id, input: { dataset: string; filters: Filter[]; columns?: string[]; valueField?: string }) {
    const { w } = await this.paper(user, id);
    if (w.status === 'REVIEWED') throw new BadRequestException('The working paper is reviewed; reopen it by editing first');
    const result = await runQuery(this.db as never, auditReader(user), { dataset: input.dataset, filters: input.filters, columns: input.columns, limit: 5000 });
    if (input.valueField && !result.columns.some((c) => c.key === input.valueField && (c.type === 'money' || c.type === 'number'))) throw new BadRequestException('The value field must be an amount among the columns');
    const total = input.valueField ? result.rows.reduce((t, r) => t + (Number(r[input.valueField!]) || 0), 0) : undefined;
    const population = { dataset: result.dataset.key, label: result.dataset.label, filters: input.filters, columns: result.columns, valueField: input.valueField, count: result.rows.length, total, rows: result.rows, truncated: result.truncated, pulledBy: user.id, pulledAt: new Date() };
    await this.db.workpapers.updateOne({ _id: id }, { population, $unset: { sample: 1 } });
    await this.audit.record(user, 'internalaudit.workpaper.population', 'iaWorkpaper', id, { dataset: input.dataset, filters: input.filters, count: result.rows.length, total });
    return { ...population, rows: population.rows.slice(0, 50) };
  }

  async drawSample(user: AuthUser, id: Id, input: { population?: number; size?: number; confidence?: number; tolerableRate?: number; method: 'RANDOM' | 'SYSTEMATIC' | 'MONETARY'; values?: number[]; seed?: number }) {
    const { w } = await this.paper(user, id);
    if (w.status === 'REVIEWED') throw new BadRequestException('The working paper is reviewed; reopen it by editing first');
    // A pulled population supplies the count and, for monetary-unit sampling, the values.
    const pulled = w.population?.count ? w.population : null;
    if (!input.population && !pulled) throw new BadRequestException('Give the population size or pull the transactions first');
    if (pulled) {
      input = { ...input, population: pulled.count!, values: input.method === 'MONETARY' ? (pulled.rows as Record<string, unknown>[]).map((r) => Math.max(0, Number(r[pulled.valueField ?? '']) || 0)) : input.values };
      if (input.method === 'MONETARY' && !pulled.valueField) throw new BadRequestException('Pull the population with a value field for monetary-unit sampling');
    }
    const size = input.size ?? (input.confidence && input.tolerableRate ? sampleSize(input.confidence, input.tolerableRate) : 0);
    if (!size) throw new BadRequestException('Give a sample size, or a confidence level and tolerable error rate');
    const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
    const items = drawSample({ population: input.population!, size, method: input.method, seed, values: input.values });
    const sample = { population: input.population!, size: items.length, method: input.method, seed, items, populationValue: input.values?.reduce((t, v) => t + v, 0), drawnBy: user.id, drawnAt: new Date() };
    await this.db.workpapers.updateOne({ _id: id }, { sample });
    await this.audit.record(user, 'internalaudit.workpaper.sample', 'iaWorkpaper', id, { method: input.method, population: input.population, size: items.length, seed });
    return { ...sample, selected: pulled ? items.map((n) => ({ item: n, ...(pulled.rows as Record<string, unknown>[])[n - 1] })) : undefined };
  }

  // The report -------------------------------------------------------------------------------------

  async saveReport(user: AuthUser, id: Id, input: { summary: string; conclusion: string; opinion: 'SATISFACTORY' | 'NEEDS_IMPROVEMENT' | 'UNSATISFACTORY' }) {
    const e = await this.load(user, id);
    assertCanWork(user, e);
    if (e.status !== 'REPORTING') throw new BadRequestException('Move the engagement to reporting first (every working paper reviewed)');
    if (!['NONE', 'DRAFT'].includes(e.report?.status ?? 'NONE')) throw new BadRequestException('The report is already with the reviewers; ask for it back first');
    await this.db.engagements.updateOne({ _id: id }, { 'report.status': 'DRAFT', 'report.summary': input.summary, 'report.conclusion': input.conclusion, 'report.opinion': input.opinion, 'report.draftedBy': user.id, 'report.draftedAt': new Date(), 'report.returnNote': null });
    await this.audit.record(user, 'internalaudit.report.draft', 'iaEngagement', id, { opinion: input.opinion });
    return this.get(user, id);
  }

  /**
   * The sign-off cycle: an audit manager reviews the draft, the head of internal audit approves it, then
   * it is issued to management. Nobody signs a stage for a report they drafted, and either signer can
   * send it back with a note.
   */
  async reportStep(user: AuthUser, id: Id, input: { action: 'REVIEW' | 'APPROVE' | 'ISSUE' | 'RETURN'; note?: string }) {
    const e = await this.load(user, id);
    const r = e.report ?? { status: 'NONE' };
    const now = new Date();
    const own = r.draftedBy?.equals(user.id);
    let set: Record<string, unknown>;
    if (input.action === 'REVIEW') {
      if (!can(user, P.MANAGE)) throw new ForbiddenException('An audit manager reviews reports');
      if (r.status !== 'DRAFT') throw new BadRequestException('There is no draft to review');
      if (own) throw new ForbiddenException('Someone other than the drafter must review the report');
      set = { 'report.status': 'REVIEWED', 'report.reviewedBy': user.id, 'report.reviewedAt': now };
    } else if (input.action === 'APPROVE') {
      if (!can(user, P.REPORT_APPROVE)) throw new ForbiddenException('The head of internal audit approves reports');
      if (r.status !== 'REVIEWED') throw new BadRequestException('The report must be reviewed first');
      if (own || r.reviewedBy?.equals(user.id)) throw new ForbiddenException('The approver must be someone other than the drafter and the reviewer');
      set = { 'report.status': 'APPROVED', 'report.approvedBy': user.id, 'report.approvedAt': now };
    } else if (input.action === 'ISSUE') {
      if (!can(user, P.REPORT_APPROVE)) throw new ForbiddenException('The head of internal audit issues reports');
      if (r.status !== 'APPROVED') throw new BadRequestException('The report must be approved first');
      const findings = await this.db.findings.find({ engagementId: id, status: { $ne: 'NOT_ACCEPTED' } }).lean();
      const missing = findings.filter((f) => !f.ownerId || !f.dueDate || !f.recommendation);
      if (missing.length) throw new BadRequestException(`Give ${missing.map((f) => f.ref).join(', ')} a recommendation, an action owner and a due date`);
      set = { 'report.status': 'ISSUED', 'report.issuedAt': now, status: 'ISSUED' };
    } else {
      if (!['REVIEWED', 'APPROVED', 'DRAFT'].includes(r.status ?? '') || !isManager(user)) throw new BadRequestException('Nothing to send back');
      if (!input.note) throw new BadRequestException('Say what needs changing');
      set = { 'report.status': 'DRAFT', 'report.returnNote': input.note, 'report.reviewedBy': null, 'report.reviewedAt': null, 'report.approvedBy': null, 'report.approvedAt': null };
    }
    await this.db.engagements.updateOne({ _id: id, 'report.status': r.status }, set);
    await this.audit.record(user, `internalaudit.report.${input.action.toLowerCase()}`, 'iaEngagement', id, { note: input.note });
    if (input.action === 'ISSUE') await this.afterIssue(user, e);
    else if (input.action === 'RETURN' && r.draftedBy) await this.notifications.notify(user.organisationId, [r.draftedBy], { title: `${e.number} report sent back`, body: input.note, link: link(id), module: 'internalaudit' });
    return this.get(user, id);
  }

  /** On issue: findings become agreed actions for their owners, and the area counts as audited. */
  private async afterIssue(user: AuthUser, e: EngagementDoc) {
    const findings = await this.db.findings.find({ engagementId: e._id, status: 'DRAFT' }).lean();
    for (const f of findings) {
      await this.db.findings.updateOne({ _id: f._id }, { status: f.accepted === false ? 'NOT_ACCEPTED' : 'AGREED', originalDueDate: f.originalDueDate ?? f.dueDate });
    }
    const owners = [...new Map(findings.filter((f) => f.ownerId && f.accepted !== false).map((f) => [f.ownerId!.toHexString(), f.ownerId!])).values()];
    await this.notifications.notify(user.organisationId, owners, { title: `Audit report ${e.number} issued: actions for you`, body: `${e.title}. See your agreed actions and their due dates.`, link: '/internalaudit/actions', module: 'internalaudit', email: true });
    if (e.universeId) await this.db.universe.updateOne({ _id: e.universeId }, { lastAuditedAt: new Date() });
  }

  /** The report as a PDF, or as a Word document. */
  async reportFile(user: AuthUser, id: Id, format: 'pdf' | 'doc' | 'pptx') {
    const e = await this.load(user, id);
    const st = e.report?.status ?? 'NONE';
    if (st === 'NONE') throw new BadRequestException('No report drafted yet');
    if (st !== 'ISSUED' && !isManager(user) && !onTeam(user, e)) throw new NotFoundException('Engagement not found');
    const [findings, org, people] = await Promise.all([
      // A draft report shows the draft findings; an issued one only those carried into it.
      this.db.findings.find({ engagementId: id, ...(st === 'ISSUED' && { status: { $ne: 'DRAFT' } }) }).sort({ ref: 1 }).lean(),
      this.db.organisations.findById(user.organisationId, { name: 1, address: 1, phone: 1, email: 1, kraPin: 1 }).lean(),
      this.db.users.find({ _id: { $in: [e.report?.draftedBy, e.report?.reviewedBy, e.report?.approvedBy, e.leadId].filter(Boolean) } }, { name: 1 }).lean(),
    ]);
    const name = (uid?: Id | null) => (uid ? (people.find((p) => p._id.equals(uid))?.name ?? '') : '');
    await this.audit.record(user, 'internalaudit.report.download', 'iaEngagement', id, { format });
    const opinion = (e.report?.opinion ?? '').replace('_', ' ').toLowerCase();
    const ratingCount = RATINGS.map((r) => `${r.toLowerCase()} ${findings.filter((f) => f.rating === r).length}`).join(', ');
    const sections = [
      { heading: 'Executive summary', text: e.report?.summary ?? '' },
      { heading: 'Objectives', text: e.objectives ?? '' },
      { heading: 'Scope', text: e.scope ?? '' },
      { heading: 'Overall opinion', text: `${opinion ? opinion[0].toUpperCase() + opinion.slice(1) : ''}. ${e.report?.conclusion ?? ''}`.trim() },
      ...findings.map((f) => ({
        heading: `${f.ref} ${f.title} (${f.rating.toLowerCase()} risk)`,
        text: [
          ['Condition', f.condition],
          ['Criteria', f.criteria],
          ['Cause', f.cause],
          ['Effect', f.effect],
          ['Recommendation', f.recommendation],
          ['Management response', f.response],
          ['Agreed action', f.action ? `${f.action} — ${f.ownerName ?? ''}, by ${day(f.dueDate)}` : ''],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
      })),
    ].filter((s) => s.text);
    const title = 'Internal Audit Report';
    const fileBase = `${e.number}-report`;
    if (format === 'doc') {
      const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1{font-size:18pt}h2{font-size:13pt;margin-top:16pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px;text-align:left}</style></head><body>
<p>${esc(org?.name ?? '')}</p><h1>${esc(title)}: ${esc(e.title)}</h1><p>${esc(e.number)} · ${st === 'ISSUED' ? `Issued ${day(e.report?.issuedAt)}` : `${st} — not final`}</p>
<table><tr><th>Ref</th><th>Finding</th><th>Rating</th><th>Owner</th><th>Due</th></tr>${findings.map((f) => `<tr><td>${esc(f.ref)}</td><td>${esc(f.title)}</td><td>${f.rating}</td><td>${esc(f.ownerName ?? '')}</td><td>${day(f.dueDate)}</td></tr>`).join('')}</table>
${sections.map((s) => `<h2>${esc(s.heading)}</h2>${s.text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}`).join('\n')}
<h2>Sign-off</h2><p>Prepared by ${esc(name(e.report?.draftedBy))} (${day(e.report?.draftedAt)}); reviewed by ${esc(name(e.report?.reviewedBy))} (${day(e.report?.reviewedAt)}); approved by ${esc(name(e.report?.approvedBy))} (${day(e.report?.approvedAt)}).</p></body></html>`;
      return new Response(html, { headers: { 'content-type': 'application/msword', 'content-disposition': `attachment; filename="${fileBase}.doc"` } });
    }
    if (format === 'pptx') {
      const colour: Record<string, string> = { CRITICAL: '991B1B', HIGH: 'DC2626', MEDIUM: 'D97706', LOW: '059669' };
      const deck = pptx(`${title}: ${e.title}`, [
        { title: e.title, subtitle: `${title} · ${e.number} · ${st === 'ISSUED' ? `issued ${day(e.report?.issuedAt)}` : `${st.toLowerCase()}, not final`}`, bullets: [`Overall opinion: ${opinion || 'not given'}`, `Findings: ${findings.length} (${ratingCount})`, `Lead auditor: ${name(e.leadId)}`, ...(e.scope ? [`Scope: ${e.scope}`] : [])], note: org?.name ?? '' },
        ...(e.report?.summary ? [{ title: 'Executive summary', bullets: e.report.summary.split(/\n+/).filter(Boolean) }] : []),
        { title: 'Findings by risk rating', bars: RATINGS.map((r) => ({ label: r[0] + r.slice(1).toLowerCase(), value: findings.filter((f) => f.rating === r).length, colour: colour[r] })) },
        { title: 'Findings and agreed actions', table: { head: ['Ref', 'Finding', 'Rating', 'Owner', 'Due'], rows: findings.map((f) => [f.ref, f.title, f.rating.toLowerCase(), f.ownerName ?? '', day(f.dueDate)]) } },
        ...findings.map((f) => ({ title: `${f.ref} ${f.title}`, subtitle: `${f.rating.toLowerCase()} risk`, bullets: [['Condition', f.condition], ['Cause', f.cause], ['Effect', f.effect], ['Recommendation', f.recommendation], ['Management response', f.response], ['Agreed action', f.action ? `${f.action} (${f.ownerName ?? ''}, by ${day(f.dueDate)})` : '']].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`) })),
        { title: 'Sign-off', bullets: [`Prepared by ${name(e.report?.draftedBy)} (${day(e.report?.draftedAt)})`, `Reviewed by ${name(e.report?.reviewedBy)} (${day(e.report?.reviewedAt)})`, `Approved by ${name(e.report?.approvedBy)} (${day(e.report?.approvedAt)})`] },
      ]);
      return new Response(new Uint8Array(deck), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'content-disposition': `attachment; filename="${fileBase}.pptx"` } });
    }
    const pdf = await renderDocumentPdf({
      title,
      number: e.number,
      date: e.report?.issuedAt ?? new Date(),
      stamp: st === 'ISSUED' ? null : `DRAFT (${st.toLowerCase()})`,
      issuer: { name: org?.name ?? '', address: org?.address ?? '', contact: [org?.phone, org?.email].filter(Boolean).join(' · '), taxId: org?.kraPin ?? '', branch: 'Internal Audit' },
      party: { heading: 'Engagement', name: e.title, lines: [e.area ?? '', `${day(e.start)} to ${day(e.end)}`].filter(Boolean) },
      facts: [
        ['Type', e.kind.toLowerCase()],
        ['Lead auditor', name(e.leadId)],
        ['Findings', `${findings.length} (${ratingCount})`],
        ['Opinion', opinion],
      ],
      tables: findings.length
        ? [{ heading: 'Findings and agreed actions', columns: [{ label: 'Ref', width: 0.08 }, { label: 'Finding', width: 0.42 }, { label: 'Rating', width: 0.12 }, { label: 'Action owner', width: 0.22 }, { label: 'Due', width: 0.16 }], rows: findings.map((f) => [f.ref, f.title, f.rating.toLowerCase(), f.ownerName ?? '', day(f.dueDate)]) }]
        : [],
      sections,
      signatures: [
        { role: 'Prepared by', name: name(e.report?.draftedBy), date: e.report?.draftedAt ?? null, note: 'Signed electronically' },
        { role: 'Reviewed by', name: name(e.report?.reviewedBy), date: e.report?.reviewedAt ?? null, note: e.report?.reviewedAt ? 'Signed electronically' : undefined },
        { role: 'Approved by', name: name(e.report?.approvedBy), date: e.report?.approvedAt ?? null, note: e.report?.approvedAt ? 'Signed electronically' : undefined },
      ],
      footer: 'Confidential: prepared for management and the audit committee.',
    });
    return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${fileBase}.pdf"` } });
  }

  /** Everyone who opened, changed, signed or downloaded anything on the engagement. */
  async accessLog(user: AuthUser, id: Id) {
    const e = await this.load(user, id);
    if (!isManager(user)) throw new ForbiddenException('Audit managers see the access log');
    const [papers, findings] = await Promise.all([this.db.workpapers.find({ engagementId: id }, { ref: 1 }).lean(), this.db.findings.find({ engagementId: id }, { ref: 1 }).lean()]);
    const refOf = new Map<string, string>([[e._id.toHexString(), e.number], ...papers.map((p) => [p._id.toHexString(), p.ref] as [string, string]), ...findings.map((f) => [f._id.toHexString(), f.ref] as [string, string])]);
    const rows = await this.db.audit.find({ organisationId: user.organisationId, entityId: { $in: [e._id, ...papers.map((p) => p._id), ...findings.map((f) => f._id)] } }).sort({ createdAt: -1 }).limit(2000).lean();
    const users = await this.db.users.find({ _id: { $in: rows.map((r) => r.userId).filter(Boolean) } }, { name: 1 }).lean();
    return rows.map((r) => ({ at: r.createdAt, who: users.find((u) => r.userId && u._id.equals(r.userId))?.name ?? 'System', action: r.action.replace('internalaudit.', ''), what: refOf.get(r.entityId?.toHexString() ?? '') ?? '', kind: r.action.endsWith('.view') || r.action.endsWith('.download') ? 'VIEW' : 'CHANGE', ip: r.ip ?? '' }));
  }
}
