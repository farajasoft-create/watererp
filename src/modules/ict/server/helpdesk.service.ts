import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { escapeRegex } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { PERMISSIONS as P } from '../manifest';
import { ensureCategories, IctDb as Db, ictSettings } from './db';
import { CHANNELS, DEFAULT_SLA, OPEN_STATUSES, PRIORITIES, TICKET_STATUSES, TicketDoc } from './schemas';

type Id = Types.ObjectId;
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof TICKET_STATUSES)[number];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OPEN = [...OPEN_STATUSES] as string[];
const LINK = (id: Id) => `/ict/tickets/${id.toHexString()}`;

export interface TicketInput {
  categoryId: Id;
  priority?: Priority;
  subject: string;
  description?: string;
  location?: string;
  phone?: string;
  department?: string;
  assetTag?: string;
  /** Officers logging a call or walk-in for someone else. */
  requesterId?: Id;
  channel?: (typeof CHANNELS)[number];
}

const isAgent = (user: AuthUser) => hasPermission(user, P.HELPDESK_WORK);
const isManager = (user: AuthUser) => hasPermission(user, P.HELPDESK_MANAGE);
const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / HOUR;

/**
 * The IT help desk: anyone raises a request and gets a ticket number at once (in the app and by email);
 * each category can route to an officer; priority sets the time to respond and to resolve; officers
 * work, hold and resolve tickets with a full history; the requester confirms and rates the fix or
 * reopens it. Missed deadlines escalate to the ICT manager, and the reports measure all of it.
 */
export class HelpdeskService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Settings ---------------------------------------------------------------------------------------

  async settings(user: AuthUser) {
    await ensureCategories(this.db, user.organisationId);
    const [s, categories] = await Promise.all([ictSettings(this.db, user.organisationId), this.db.categories.find({ organisationId: user.organisationId }).sort({ name: 1 }).lean()]);
    return { ...s, categories };
  }

  async saveSettings(user: AuthUser, input: { sla: { priority: Priority; respond: number; resolve: number }[]; autoCloseDays: number; emailRequester: boolean }) {
    for (const r of input.sla) if (r.respond > r.resolve) throw new BadRequestException(`${r.priority}: the response time cannot be longer than the resolution time`);
    const sla = PRIORITIES.map((p) => input.sla.find((r) => r.priority === p) ?? { priority: p, ...DEFAULT_SLA[p] });
    await ictSettings(this.db, user.organisationId);
    await this.db.ictSettings.updateOne({ organisationId: user.organisationId }, { sla, autoCloseDays: input.autoCloseDays, emailRequester: input.emailRequester });
    await this.audit.record(user, 'ict.settings.update', 'ictSettings', null, { sla, autoCloseDays: input.autoCloseDays });
    return this.settings(user);
  }

  async categories(user: AuthUser) {
    await ensureCategories(this.db, user.organisationId);
    return this.db.categories.find({ organisationId: user.organisationId, active: true }, { code: 1, name: 1 }).sort({ name: 1 }).lean();
  }

  async saveCategory(user: AuthUser, id: Id | null, input: { code: string; name: string; defaultAssignee?: Id | null; active?: boolean }) {
    if (input.defaultAssignee) await this.assertAgent(user.organisationId, input.defaultAssignee);
    const fields = { code: input.code.toUpperCase(), name: input.name, defaultAssignee: input.defaultAssignee ?? null, ...(input.active !== undefined && { active: input.active }) };
    try {
      const doc = id
        ? await this.db.categories.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean()
        : (await this.db.categories.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Category not found');
      await this.audit.record(user, id ? 'ict.category.update' : 'ict.category.create', 'ictCategory', doc._id, fields);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new BadRequestException(`There is already a category ${fields.code}`);
      throw err;
    }
  }

  /** Users who can be given tickets: help desk officers and managers, and administrators. */
  async agents(organisationId: Id) {
    const users = await this.db.users
      .find({ organisationId, active: { $ne: false }, $or: [{ isAdmin: true }, { access: { $elemMatch: { module: 'ict', role: { $in: ['MANAGER', 'AGENT'] } } } }] }, { name: 1, email: 1, isAdmin: 1, access: 1 })
      .sort({ name: 1 })
      .lean();
    return users.map((u) => ({ _id: u._id, name: u.name, email: u.email, manager: Boolean(u.isAdmin) || u.access?.some((a) => a.module === 'ict' && a.role === 'MANAGER') }));
  }

  private async assertAgent(organisationId: Id, userId: Id) {
    const agent = (await this.agents(organisationId)).find((a) => a._id.equals(userId));
    if (!agent) throw new BadRequestException('Tickets can only go to help desk officers');
    return agent;
  }

  private async managers(organisationId: Id) {
    return (await this.agents(organisationId)).filter((a) => a.manager).map((a) => a._id);
  }

  // Tickets ----------------------------------------------------------------------------------------

  private async deadlines(organisationId: Id, priority: Priority, from: Date) {
    const s = await ictSettings(this.db, organisationId);
    const sla = s.sla.find((r) => r.priority === priority) ?? { ...DEFAULT_SLA[priority] };
    return { respondBy: new Date(from.getTime() + (sla.respond ?? DEFAULT_SLA[priority].respond) * HOUR), resolveBy: new Date(from.getTime() + (sla.resolve ?? DEFAULT_SLA[priority].resolve) * HOUR) };
  }

  private async tell(organisationId: Id, userIds: (Id | null | undefined)[], n: { title: string; body?: string; link: string }, email = false) {
    const ids = userIds.filter((x): x is Id => Boolean(x));
    if (!ids.length) return;
    const s = email ? await ictSettings(this.db, organisationId) : null;
    await this.notifications.notify(organisationId, ids, { ...n, module: 'ict', email: Boolean(s?.emailRequester) });
  }

  async create(user: AuthUser, input: TicketInput) {
    const org = user.organisationId;
    await ensureCategories(this.db, org);
    const category = await this.db.categories.findOne({ _id: input.categoryId, organisationId: org, active: true }).lean();
    if (!category) throw new BadRequestException('Choose a category');
    let requester: { _id: Id; name: string; email: string } = { _id: user.id, name: user.name, email: user.email };
    if (input.requesterId && !input.requesterId.equals(user.id)) {
      if (!isAgent(user)) throw new ForbiddenException('Only help desk officers can log a request for someone else');
      const r = await this.db.users.findOne({ _id: input.requesterId, organisationId: org }, { name: 1, email: 1 }).lean();
      if (!r) throw new NotFoundException('Requester not found');
      requester = { _id: r._id, name: r.name, email: r.email };
    }
    const priority = input.priority ?? 'MEDIUM';
    const now = new Date();
    const { respondBy, resolveBy } = await this.deadlines(org, priority, now);
    const assignee = category.defaultAssignee ? (await this.agents(org)).find((a) => a._id.equals(category.defaultAssignee!)) : null;
    const ticket = await this.db.transaction(async (session) => {
      const seq = await this.db.next(org, 'ict:ticket', session);
      const [t] = await this.db.tickets.create(
        [
          {
            organisationId: org,
            number: `HD-${String(seq).padStart(5, '0')}`,
            createdAt: now,
            channel: input.requesterId && !input.requesterId.equals(user.id) ? (input.channel ?? 'PHONE') : (input.channel ?? 'PORTAL'),
            requesterId: requester._id,
            requesterName: requester.name,
            requesterEmail: requester.email,
            department: input.department,
            location: input.location,
            phone: input.phone,
            categoryId: category._id,
            category: category.name,
            priority,
            subject: input.subject,
            description: input.description,
            assetTag: input.assetTag?.toUpperCase(),
            status: assignee ? 'ASSIGNED' : 'OPEN',
            assignedTo: assignee?._id ?? null,
            assignedName: assignee?.name,
            respondBy,
            resolveBy,
            history: [
              { at: now, by: user.id, byName: user.name, action: 'RAISED', note: requester._id.equals(user.id) ? undefined : `Logged by ${user.name} for ${requester.name}` },
              ...(assignee ? [{ at: now, by: null, byName: 'System', action: 'ASSIGNED', note: `Routed to ${assignee.name} (${category.name})` }] : []),
            ],
          },
        ],
        { session },
      );
      await this.audit.record(user, 'ict.ticket.create', 'ictTicket', t._id, { number: t.number, category: category.code, priority }, session);
      return t.toObject();
    });
    // Acknowledgement to the requester with the ticket number and when to expect a response.
    await this.tell(org, [requester._id], { title: `${ticket.number} received: ${ticket.subject}`, body: `Your IT request is logged as ${ticket.number} (${priority.toLowerCase()} priority). Expect a response by ${respondBy.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, link: LINK(ticket._id) }, true);
    const desk = assignee ? [assignee._id] : await this.managers(org);
    await this.tell(org, desk, { title: `New ${priority.toLowerCase()} ticket ${ticket.number}`, body: `${requester.name}: ${ticket.subject}`, link: LINK(ticket._id) });
    return ticket;
  }

  private visibleTo(user: AuthUser, t: TicketDoc) {
    if (isAgent(user)) return t;
    if (!t.requesterId.equals(user.id)) throw new NotFoundException('Ticket not found');
    return { ...t, comments: (t.comments ?? []).filter((c) => !c.internal) };
  }

  async get(user: AuthUser, id: Id) {
    const t = await this.db.tickets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!t) throw new NotFoundException('Ticket not found');
    const out = this.visibleTo(user, t);
    const related = t.assetTag && isAgent(user) ? await this.db.tickets.find({ organisationId: user.organisationId, assetTag: t.assetTag, _id: { $ne: t._id } }, { number: 1, subject: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(10).lean() : [];
    return { ...out, overdue: OPEN.includes(t.status) && t.resolveBy && t.resolveBy < new Date(), related };
  }

  /** The signed-in user's own requests. */
  mine(user: AuthUser) {
    return this.db.tickets.find({ organisationId: user.organisationId, requesterId: user.id }, { comments: 0, history: 0 }).sort({ createdAt: -1 }).limit(200).lean();
  }

  async list(user: AuthUser, q: { status?: Status; open?: boolean; mine?: boolean; unassigned?: boolean; overdue?: boolean; categoryId?: Id; priority?: Priority; assignedTo?: Id; search?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    else if (q.open || q.overdue) filter.status = { $in: OPEN };
    if (q.mine) filter.assignedTo = user.id;
    else if (q.assignedTo) filter.assignedTo = q.assignedTo;
    if (q.unassigned) filter.assignedTo = null;
    if (q.overdue) filter.resolveBy = { $lt: new Date() };
    if (q.categoryId) filter.categoryId = q.categoryId;
    if (q.priority) filter.priority = q.priority;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { subject: rx }, { requesterName: rx }, { assetTag: rx }, { department: rx }];
    }
    const [items, total, counts] = await Promise.all([
      this.db.tickets
        .find(filter, { comments: 0, history: 0 })
        .sort({ status: 1, resolveBy: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.tickets.countDocuments(filter),
      this.db.tickets.aggregate<{ _id: string; n: number }>([{ $match: { organisationId: user.organisationId, status: { $in: OPEN } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const now = new Date();
    const overdue = await this.db.tickets.countDocuments({ organisationId: user.organisationId, status: { $in: OPEN }, resolveBy: { $lt: now } });
    const unassigned = await this.db.tickets.countDocuments({ organisationId: user.organisationId, status: { $in: OPEN }, assignedTo: null });
    return { items: items.map((t) => ({ ...t, overdue: OPEN.includes(t.status) && t.resolveBy && t.resolveBy < now })), total, page: q.page, pageSize: q.pageSize, counts: { ...Object.fromEntries(counts.map((c) => [c._id, c.n])), overdue, unassigned } };
  }

  private async load(user: AuthUser, id: Id) {
    const t = await this.db.tickets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }

  /** Applies a change only if the ticket is still in one of `from`; records it in the history and audit log. */
  private async move(user: AuthUser, t: TicketDoc, from: readonly string[], set: Record<string, unknown>, action: string, note?: string) {
    if (!from.includes(t.status)) throw new BadRequestException(`The ticket is ${t.status.toLowerCase().replace('_', ' ')}`);
    const now = new Date();
    const updated = await this.db.tickets
      .findOneAndUpdate({ _id: t._id, status: t.status }, { ...set, $push: { history: { at: now, by: user.id, byName: user.name, action, note } } }, { new: true })
      .lean();
    if (!updated) throw new BadRequestException('The ticket was changed by someone else; reload it');
    await this.audit.record(user, `ict.ticket.${action.toLowerCase()}`, 'ictTicket', t._id, { number: t.number, note });
    return updated;
  }

  /** The first thing an officer does that the requester can see counts as the response. */
  private responded(t: TicketDoc) {
    return t.firstResponseAt ? {} : { firstResponseAt: new Date() };
  }

  async assign(user: AuthUser, id: Id, assigneeId: Id, note?: string) {
    const t = await this.load(user, id);
    if (!isManager(user) && !assigneeId.equals(user.id)) throw new ForbiddenException('Only the ICT manager can give tickets to others; you can take one yourself');
    const agent = await this.assertAgent(user.organisationId, assigneeId);
    const updated = await this.move(user, t, OPEN, { assignedTo: agent._id, assignedName: agent.name, ...(t.status === 'OPEN' && { status: 'ASSIGNED' }) }, 'ASSIGNED', `To ${agent.name}${note ? `: ${note}` : ''}`);
    if (!agent._id.equals(user.id)) await this.tell(user.organisationId, [agent._id], { title: `${t.number} assigned to you`, body: `${t.priority} · ${t.subject}`, link: LINK(t._id) });
    return updated;
  }

  private assertWorker(user: AuthUser, t: TicketDoc) {
    if (!isAgent(user)) throw new ForbiddenException('Only help desk officers can do that');
    if (t.assignedTo && !t.assignedTo.equals(user.id) && !isManager(user)) throw new ForbiddenException(`${t.number} is with ${t.assignedName}`);
  }

  async start(user: AuthUser, id: Id) {
    const t = await this.load(user, id);
    this.assertWorker(user, t);
    const updated = await this.move(user, t, ['OPEN', 'ASSIGNED', 'REOPENED'], { status: 'IN_PROGRESS', ...this.responded(t), ...(!t.assignedTo && { assignedTo: user.id, assignedName: user.name }) }, 'STARTED');
    await this.tell(user.organisationId, [t.requesterId], { title: `${t.number}: ${user.name} is working on it`, link: LINK(t._id) });
    return updated;
  }

  async hold(user: AuthUser, id: Id, reason: string) {
    const t = await this.load(user, id);
    this.assertWorker(user, t);
    const updated = await this.move(user, t, ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'], { status: 'ON_HOLD', onHoldSince: new Date(), ...this.responded(t) }, 'ON_HOLD', reason);
    await this.tell(user.organisationId, [t.requesterId], { title: `${t.number} is on hold`, body: reason, link: LINK(t._id) }, true);
    return updated;
  }

  /** Back from hold: the resolution deadline moves on by the time it waited. */
  async resume(user: AuthUser, id: Id) {
    const t = await this.load(user, id);
    this.assertWorker(user, t);
    const waited = t.onHoldSince ? Date.now() - t.onHoldSince.getTime() : 0;
    return this.move(user, t, ['ON_HOLD'], { status: 'IN_PROGRESS', onHoldSince: null, $inc: { onHoldMinutes: Math.round(waited / 60_000) }, ...(t.resolveBy && { resolveBy: new Date(t.resolveBy.getTime() + waited) }) }, 'RESUMED');
  }

  async resolve(user: AuthUser, id: Id, resolution: string) {
    const t = await this.load(user, id);
    this.assertWorker(user, t);
    const updated = await this.move(user, t, OPEN, { status: 'RESOLVED', resolution, resolvedAt: new Date(), onHoldSince: null, ...this.responded(t), ...(!t.assignedTo && { assignedTo: user.id, assignedName: user.name }) }, 'RESOLVED', resolution);
    await this.tell(user.organisationId, [t.requesterId], { title: `${t.number} resolved`, body: `${resolution}\n\nPlease confirm it is fixed and rate the service, or reopen it if not.`, link: LINK(t._id) }, true);
    return updated;
  }

  async changePriority(user: AuthUser, id: Id, priority: Priority, reason: string) {
    const t = await this.load(user, id);
    this.assertWorker(user, t);
    const { respondBy, resolveBy } = await this.deadlines(user.organisationId, priority, t.createdAt as Date);
    return this.move(user, t, OPEN, { priority, respondBy, resolveBy }, 'PRIORITY', `${t.priority} → ${priority}: ${reason}`);
  }

  async comment(user: AuthUser, id: Id, input: { body: string; internal?: boolean }) {
    const t = await this.load(user, id);
    const agent = isAgent(user);
    if (!agent && !t.requesterId.equals(user.id)) throw new NotFoundException('Ticket not found');
    if (['CLOSED', 'CANCELLED'].includes(t.status)) throw new BadRequestException('The ticket is closed');
    const internal = agent && Boolean(input.internal);
    const fromDesk = agent && !t.requesterId.equals(user.id);
    await this.db.tickets.updateOne({ _id: t._id }, { $push: { comments: { at: new Date(), by: user.id, byName: user.name, body: input.body, internal } }, ...(fromDesk && !internal && this.responded(t)) });
    if (!internal) {
      const to = fromDesk ? [t.requesterId] : [t.assignedTo ?? null, ...(t.assignedTo ? [] : await this.managers(user.organisationId))];
      await this.tell(user.organisationId, to, { title: `${t.number}: new message from ${user.name}`, body: input.body.slice(0, 300), link: LINK(t._id) }, fromDesk);
    }
    return this.get(user, id);
  }

  /** The requester confirms the fix (closing the ticket) with a rating, or reopens it. */
  async confirm(user: AuthUser, id: Id, input: { rating: number; feedback?: string }) {
    const t = await this.load(user, id);
    if (!t.requesterId.equals(user.id)) {
      if (!isAgent(user)) throw new NotFoundException('Ticket not found');
      throw new ForbiddenException('Only the person who raised the ticket can confirm it');
    }
    return this.move(user, t, ['RESOLVED'], { status: 'CLOSED', closedAt: new Date(), rating: input.rating, feedback: input.feedback }, 'CLOSED', `Confirmed fixed, rated ${input.rating}/5${input.feedback ? `: ${input.feedback}` : ''}`);
  }

  async reopen(user: AuthUser, id: Id, reason: string) {
    const t = await this.load(user, id);
    if (!t.requesterId.equals(user.id) && !isAgent(user)) throw new NotFoundException('Ticket not found');
    const s = await ictSettings(this.db, user.organisationId);
    const sla = s.sla.find((r) => r.priority === t.priority) ?? DEFAULT_SLA[t.priority as Priority];
    const updated = await this.move(user, t, ['RESOLVED', 'CLOSED'], { status: 'REOPENED', resolvedAt: null, closedAt: null, rating: null, resolveBy: new Date(Date.now() + (sla.resolve ?? 24) * HOUR), $inc: { reopenCount: 1 } }, 'REOPENED', reason);
    await this.tell(user.organisationId, t.assignedTo ? [t.assignedTo] : await this.managers(user.organisationId), { title: `${t.number} reopened`, body: reason, link: LINK(t._id) });
    return updated;
  }

  async cancel(user: AuthUser, id: Id, reason?: string) {
    const t = await this.load(user, id);
    if (!t.requesterId.equals(user.id) && !isManager(user)) {
      if (!isAgent(user)) throw new NotFoundException('Ticket not found');
      throw new ForbiddenException('Only the requester or the ICT manager can withdraw a ticket');
    }
    return this.move(user, t, ['OPEN', 'ASSIGNED'], { status: 'CANCELLED', closedAt: new Date() }, 'CANCELLED', reason);
  }

  /**
   * Run every few minutes: tickets past their response or resolution deadline are escalated to the
   * ICT manager (again when twice as late), and resolved tickets nobody confirmed are closed.
   */
  async housekeeping(organisationId: Id, now = new Date()) {
    const s = await ictSettings(this.db, organisationId);
    const late = await this.db.tickets
      .find({ organisationId, status: { $in: OPEN }, $or: [{ resolveBy: { $lt: now } }, { firstResponseAt: null, respondBy: { $lt: now } }] }, { number: 1, subject: 1, createdAt: 1, respondBy: 1, resolveBy: 1, firstResponseAt: 1, escalationLevel: 1, assignedTo: 1, status: 1, onHoldSince: 1 })
      .lean();
    const managers = await this.managers(organisationId);
    let escalated = 0;
    for (const t of late) {
      if (t.status === 'ON_HOLD') continue;
      const created = (t.createdAt as Date).getTime();
      const resolveLate = t.resolveBy && t.resolveBy < now;
      const twiceLate = resolveLate && now.getTime() - created > 2 * (t.resolveBy!.getTime() - created);
      const level = twiceLate ? 2 : 1;
      if (level <= (t.escalationLevel ?? 0)) continue;
      const why = resolveLate ? `not resolved by ${t.resolveBy!.toISOString().slice(0, 16).replace('T', ' ')}` : 'no response yet';
      await this.db.tickets.updateOne({ _id: t._id }, { escalationLevel: level, escalatedAt: now, $push: { history: { at: now, by: null, byName: 'System', action: 'ESCALATED', note: `Level ${level}: ${why}` } } });
      await this.tell(organisationId, [...managers, t.assignedTo], { title: `${t.number} escalated (level ${level})`, body: `${t.subject}: ${why}`, link: LINK(t._id) }, level === 2);
      escalated++;
    }
    const closeBefore = new Date(now.getTime() - (s.autoCloseDays ?? 3) * DAY);
    const stale = await this.db.tickets.find({ organisationId, status: 'RESOLVED', resolvedAt: { $lt: closeBefore } }, { _id: 1 }).lean();
    if (stale.length) {
      await this.db.tickets.updateMany(
        { _id: { $in: stale.map((x) => x._id) }, status: 'RESOLVED' },
        { status: 'CLOSED', closedAt: now, $push: { history: { at: now, by: null, byName: 'System', action: 'CLOSED', note: `No reply from the requester in ${s.autoCloseDays} days` } } },
      );
    }
    return { escalated, closed: stale.length };
  }

  // Reports ----------------------------------------------------------------------------------------

  /**
   * Help desk performance for a period: tickets raised and resolved, response and resolution times
   * against the deadlines, by category, priority and officer, satisfaction, and the open backlog by age.
   */
  async report(user: AuthUser, from: Date, to: Date) {
    const org = user.organisationId;
    const end = new Date(to.getTime() + DAY);
    const [raised, resolved, open] = await Promise.all([
      this.db.tickets.find({ organisationId: org, createdAt: { $gte: from, $lt: end } }, { comments: 0, history: 0 }).lean(),
      this.db.tickets.find({ organisationId: org, resolvedAt: { $gte: from, $lt: end } }, { comments: 0, history: 0 }).lean(),
      this.db.tickets.find({ organisationId: org, status: { $in: OPEN } }, { createdAt: 1, resolveBy: 1, priority: 1 }).lean(),
    ]);
    const now = new Date();
    const resolveHours = (t: (typeof resolved)[number]) => Math.max(hours(t.createdAt as Date, t.resolvedAt!) - (t.onHoldMinutes ?? 0) / 60, 0);
    const metResolve = (t: (typeof resolved)[number]) => Boolean(t.resolveBy && t.resolvedAt! <= t.resolveBy);
    const responded = raised.filter((t) => t.firstResponseAt);
    const metRespond = responded.filter((t) => t.respondBy && t.firstResponseAt! <= t.respondBy);
    const rated = resolved.filter((t) => t.rating);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const group = <K extends string>(key: (t: (typeof resolved)[number]) => K) => {
      const out = new Map<K, { raised: number; resolved: number; hours: number[]; met: number; ratings: number[] }>();
      const row = (k: K) => out.get(k) ?? out.set(k, { raised: 0, resolved: 0, hours: [], met: 0, ratings: [] }).get(k)!;
      for (const t of raised) row(key(t)).raised++;
      for (const t of resolved) {
        const r = row(key(t));
        r.resolved++;
        r.hours.push(resolveHours(t));
        if (metResolve(t)) r.met++;
        if (t.rating) r.ratings.push(t.rating);
      }
      return [...out.entries()].map(([k, r]) => ({ key: k, raised: r.raised, resolved: r.resolved, avgResolveHours: avg(r.hours), slaMetPct: pct(r.met, r.resolved), avgRating: avg(r.ratings) })).sort((a, b) => b.raised + b.resolved - (a.raised + a.resolved));
    };
    const ageBand = (d: Date) => {
      const days = (now.getTime() - d.getTime()) / DAY;
      return days < 1 ? 'Under a day' : days < 3 ? '1–3 days' : days < 7 ? '3–7 days' : days < 30 ? '1–4 weeks' : 'Over a month';
    };
    const bands = ['Under a day', '1–3 days', '3–7 days', '1–4 weeks', 'Over a month'];
    return {
      from,
      to,
      raised: raised.length,
      resolved: resolved.length,
      reopened: resolved.filter((t) => (t.reopenCount ?? 0) > 0).length,
      open: open.length,
      overdue: open.filter((t) => t.resolveBy && t.resolveBy < now).length,
      responseSlaPct: pct(metRespond.length, responded.length),
      resolutionSlaPct: pct(resolved.filter(metResolve).length, resolved.length),
      avgResponseHours: avg(responded.map((t) => hours(t.createdAt as Date, t.firstResponseAt!))),
      avgResolveHours: avg(resolved.map(resolveHours)),
      satisfaction: { rated: rated.length, average: avg(rated.map((t) => t.rating!)), satisfiedPct: pct(rated.filter((t) => t.rating! >= 4).length, rated.length) },
      byCategory: group((t) => (t.category ?? 'Other') as string),
      byPriority: group((t) => t.priority as string),
      byOfficer: group((t) => (t.assignedName ?? 'Unassigned') as string),
      byChannel: group((t) => t.channel as string),
      backlog: bands.map((b) => ({ age: b, count: open.filter((t) => ageBand(t.createdAt as Date) === b).length })),
    };
  }

  async ticketsCsv(user: AuthUser, from: Date, to: Date) {
    const rows = await this.db.tickets.find({ organisationId: user.organisationId, createdAt: { $gte: from, $lt: new Date(to.getTime() + DAY) } }, { comments: 0, history: 0 }).sort({ createdAt: 1 }).lean();
    const ts = (d?: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '');
    return csvResponse(`helpdesk-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`, [
      ['Ticket', 'Raised', 'Channel', 'Requester', 'Department', 'Category', 'Priority', 'Subject', 'Asset', 'Status', 'Officer', 'Respond by', 'First response', 'Resolve by', 'Resolved', 'Closed', 'Met deadline', 'Rating', 'Resolution'],
      ...rows.map((t) => [t.number, ts(t.createdAt as Date), t.channel, t.requesterName, t.department, t.category, t.priority, t.subject, t.assetTag, t.status, t.assignedName, ts(t.respondBy), ts(t.firstResponseAt), ts(t.resolveBy), ts(t.resolvedAt), ts(t.closedAt), t.resolvedAt ? (t.resolveBy && t.resolvedAt <= t.resolveBy ? 'Yes' : 'No') : '', t.rating ?? '', t.resolution]),
    ]);
  }
}
