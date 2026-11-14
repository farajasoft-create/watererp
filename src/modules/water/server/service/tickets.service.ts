import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { escapeRegex } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { EmailService } from '@/platform/services/email.service';
import { SmsService } from '@/platform/services/sms.service';
import { WaterDb as Db, waterSettings } from '../db';
import { DEFAULT_SLA_HOURS, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES } from '../service-schemas';

const HOUR = 3_600_000;
type Category = (typeof TICKET_CATEGORIES)[number];
type Channel = (typeof TICKET_CHANNELS)[number];
type Priority = (typeof TICKET_PRIORITIES)[number];
type Status = (typeof TICKET_STATUSES)[number];

export interface TicketInput {
  category: Category;
  channel: Channel;
  priority?: Priority;
  customerId?: Types.ObjectId | null;
  accountNo?: string;
  name?: string;
  phone?: string;
  email?: string;
  subject: string;
  description?: string;
  zoneId?: Types.ObjectId | null;
  location?: string;
  gps?: { lat: number; lng: number } | null;
  externalRef?: string;
}

/** Who raised it: a signed-in officer, or an outside channel (USSD, SMS, call centre, the portal). */
export type Actor = AuthUser | { organisationId: Types.ObjectId; id?: undefined; ip?: null };

const OPEN_STATUSES: Status[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'];

/** Words that point to a complaint category, for messages that arrive without one (SMS, email). */
const CATEGORY_WORDS: [Category, RegExp][] = [
  ['BURST', /\bburst|pipe (has )?broke|gushing|flooding\b/i],
  ['SEWER', /\bsewer|sewage|manhole|blocked drain|choo\b/i],
  ['LEAK', /\bleak|leaking|dripping|kuvuja\b/i],
  ['NO_WATER', /\bno water|hakuna maji|dry tap|without water|water (is )?off\b/i],
  ['LOW_PRESSURE', /\blow pressure|weak flow|trickl/i],
  ['WATER_QUALITY', /\bdirty|brown|smell|colou?r|muddy|taste|contaminat/i],
  ['METER', /\bmeter\b/i],
  ['BILLING', /\bbill|invoice|overcharg|charged|statement|balance|payment|paid\b/i],
  ['RECONNECTION', /\breconnect/i],
  ['NEW_CONNECTION', /\bnew connection|connect me|apply for (a )?connection/i],
  ['ILLEGAL_CONNECTION', /\billegal|stealing water|bypass/i],
  ['STAFF_CONDUCT', /\brude|bribe|staff|officer was/i],
];

/** The likeliest category for a free-text complaint, or OTHER. */
export function guessCategory(text: string): Category {
  return CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'OTHER';
}

/** Net promoter score: % promoters (9–10) less % detractors (0–6). */
export function netPromoterScore(scores: number[]) {
  if (!scores.length) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 1000) / 10;
}

/** Emergencies get a quarter of the normal time, urgent jobs half. */
export function slaDue(createdAt: Date, hours: number, priority: Priority): Date {
  const factor = priority === 'EMERGENCY' ? 0.25 : priority === 'URGENT' ? 0.5 : 1;
  return new Date(createdAt.getTime() + hours * factor * HOUR);
}

/**
 * Complaints, incidents (leaks, bursts, no water) and service requests from every channel, with a
 * reference number sent to the customer by SMS, a resolution deadline per category, escalation when
 * it passes, and the customer's confirmation and rating when it is closed.
 */
export class TicketsService {
  /** Wired in the container: raise a field job for a ticket (leaks, bursts, meter faults). */
  createWorkOrder: (user: AuthUser, ticketId: Types.ObjectId) => Promise<{ _id: Types.ObjectId; number: string }> = async () => {
    throw new BadRequestException('Field jobs are not available');
  };

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly email?: EmailService,
  ) {}

  private async orgName(organisationId: Types.ObjectId) {
    return (await this.db.organisations.findById(organisationId, { name: 1 }).lean())?.name ?? 'Water';
  }

  async list(user: AuthUser, q: { status?: Status; open?: boolean; category?: Category; assignedTo?: Types.ObjectId; mine?: boolean; overdue?: boolean; customerId?: Types.ObjectId; search?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    else if (q.open) filter.status = { $in: OPEN_STATUSES };
    if (q.category) filter.category = q.category;
    if (q.assignedTo) filter.assignedTo = q.assignedTo;
    if (q.mine) filter.assignedTo = user.id;
    if (q.customerId) filter.customerId = q.customerId;
    if (q.overdue) Object.assign(filter, { status: { $in: OPEN_STATUSES }, slaDueAt: { $lt: new Date() } });
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { accountNo: rx }, { name: rx }, { phone: rx }, { subject: rx }, { location: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.tickets
        .find(filter, { history: 0 })
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.tickets.countDocuments(filter),
    ]);
    const users = await this.db.users.find({ _id: { $in: items.map((t) => t.assignedTo).filter(Boolean) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return { items: items.map((t) => ({ ...t, assignedName: t.assignedTo ? (names.get(t.assignedTo.toHexString()) ?? null) : null, overdue: OPEN_STATUSES.includes(t.status as Status) && Boolean(t.slaDueAt && t.slaDueAt < new Date()) })), total, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const ticket = await this.db.tickets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!ticket) throw new NotFoundException('Ticket not found');
    const userIds = [ticket.assignedTo, ...ticket.history.map((h) => h.by)].filter(Boolean) as Types.ObjectId[];
    const users = await this.db.users.find({ _id: { $in: userIds } }, { name: 1 }).lean();
    const names = Object.fromEntries(users.map((u) => [u._id.toHexString(), u.name]));
    return { ...ticket, names };
  }

  /** Records a ticket and texts the reference to the customer. Used by every channel. */
  async create(actor: Actor, input: TicketInput) {
    const organisationId = actor.organisationId;
    if (input.externalRef) {
      const existing = await this.db.tickets.findOne({ organisationId, externalRef: input.externalRef }).lean();
      if (existing) return existing;
    }
    let customer = null;
    if (input.customerId) customer = await this.db.customers.findOne({ _id: input.customerId, organisationId }, { accountNo: 1, name: 1, phone: 1, email: 1, zoneId: 1, location: 1, gps: 1 }).lean();
    else if (input.accountNo) customer = await this.db.customers.findOne({ organisationId, accountNo: input.accountNo.trim().toUpperCase() }, { accountNo: 1, name: 1, phone: 1, email: 1, zoneId: 1, location: 1, gps: 1 }).lean();
    if (input.customerId && !customer) throw new NotFoundException('Customer not found');
    const settings = await waterSettings(this.db, organisationId);
    const hours = Number((settings.service?.slaHours as Record<string, number> | undefined)?.[input.category]) || DEFAULT_SLA_HOURS[input.category];
    const priority = input.priority ?? (input.category === 'BURST' || input.category === 'SEWER' ? 'URGENT' : 'NORMAL');
    const now = new Date();
    const ticket = await this.db.transaction(async (session) => {
      const seq = await this.db.next(organisationId, 'water:ticket', session);
      const [t] = await this.db.tickets.create(
        [
          {
            organisationId,
            number: `TKT-${String(seq).padStart(6, '0')}`,
            category: input.category,
            channel: input.channel,
            priority,
            customerId: customer?._id ?? null,
            accountNo: customer?.accountNo ?? input.accountNo,
            name: input.name ?? customer?.name,
            phone: input.phone ?? customer?.phone,
            email: input.email ?? customer?.email,
            subject: input.subject,
            description: input.description,
            zoneId: input.zoneId ?? customer?.zoneId ?? null,
            location: input.location ?? customer?.location,
            gps: input.gps ?? customer?.gps ?? undefined,
            slaDueAt: slaDue(now, hours, priority),
            createdAt: now,
            externalRef: input.externalRef,
            createdBy: actor.id ?? null,
            history: [{ at: now, by: actor.id ?? null, action: 'CREATED', status: 'OPEN', note: `Via ${input.channel.toLowerCase().replace('_', ' ')}` }],
          },
        ],
        { session },
      );
      await this.audit.record(actor, 'water.ticket.create', 'ticket', t._id, { number: t.number, category: t.category, channel: t.channel }, session);
      return t.toObject();
    });
    // Routing: the most specific rule for the category and zone sends the ticket straight to an officer.
    const rules = (settings.service?.routing ?? []) as { category?: string | null; zoneId?: Types.ObjectId | null; assignTo: Types.ObjectId }[];
    const zone = ticket.zoneId as Types.ObjectId | null;
    const rule =
      rules.find((r) => r.category === ticket.category && r.zoneId && zone && r.zoneId.equals(zone)) ??
      rules.find((r) => r.category === ticket.category && !r.zoneId) ??
      rules.find((r) => !r.category && r.zoneId && zone && r.zoneId.equals(zone));
    if (rule) {
      const officer = await this.db.users.findOne({ _id: rule.assignTo, organisationId, active: true }, { name: 1 }).lean();
      if (officer) {
        await this.db.tickets.updateOne({ _id: ticket._id, status: 'OPEN' }, { assignedTo: officer._id, status: 'ASSIGNED', $push: { history: { at: new Date(), by: null, action: 'ROUTED', status: 'ASSIGNED', note: `Routed to ${officer.name} by the ${rule.category ? rule.category.toLowerCase().replace(/_/g, ' ') : 'zone'} rule` } } });
        Object.assign(ticket, { assignedTo: officer._id, status: 'ASSIGNED' });
        await this.notifyAssignee(organisationId, officer._id, ticket.number, ticket.subject);
      }
    }
    const phone = ticket.phone;
    if (phone) {
      await this.sms.queue(organisationId, phone, `${await this.orgName(organisationId)}: We have received your report (${ticket.category.toLowerCase().replace(/_/g, ' ')}). Your reference is ${ticket.number}. We aim to resolve it by ${ticket.slaDueAt!.toISOString().slice(0, 16).replace('T', ' ')}.`, 'water:ticket', ticket._id);
      await this.sms.deliverDue(organisationId);
    }
    if (ticket.email && this.email) {
      await this.email.queue(organisationId, ticket.email, `Your report ${ticket.number}`, `We have received your report "${ticket.subject}". Your reference is ${ticket.number}; we aim to resolve it by ${ticket.slaDueAt!.toISOString().slice(0, 16).replace('T', ' ')}.`, 'water:ticket', ticket._id);
      await this.email.deliverDue(organisationId);
    }
    return ticket;
  }

  /** Wired in the container: an in-app notice to the officer a ticket is routed to. */
  notifyAssignee: (organisationId: Types.ObjectId, userId: Types.ObjectId, number: string, subject: string) => Promise<void> = async () => undefined;

  private async move(user: AuthUser, id: Types.ObjectId, allowed: Status[], update: Record<string, unknown>, action: string, note?: string) {
    const ticket = await this.db.tickets.findOne({ _id: id, organisationId: user.organisationId });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (!allowed.includes(ticket.status as Status)) throw new BadRequestException(`The ticket is ${ticket.status.toLowerCase().replace('_', ' ')}`);
    ticket.set(update);
    if (!ticket.firstResponseAt && action !== 'COMMENT') ticket.firstResponseAt = new Date();
    ticket.history.push({ at: new Date(), by: user.id, action, note, status: ticket.status });
    await ticket.save();
    await this.audit.record(user, `water.ticket.${action.toLowerCase()}`, 'ticket', id, { note, ...update });
    return ticket.toObject();
  }

  async assign(user: AuthUser, id: Types.ObjectId, assignedTo: Types.ObjectId, note?: string) {
    const assignee = await this.db.users.findOne({ _id: assignedTo, organisationId: user.organisationId, active: true }, { name: 1 }).lean();
    if (!assignee) throw new BadRequestException('Pick an active user');
    return this.move(user, id, ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'], { assignedTo, status: 'ASSIGNED' }, 'ASSIGNED', note ?? `To ${assignee.name}`);
  }

  start(user: AuthUser, id: Types.ObjectId, note?: string) {
    return this.move(user, id, ['OPEN', 'ASSIGNED', 'REOPENED'], { status: 'IN_PROGRESS' }, 'STARTED', note);
  }

  comment(user: AuthUser, id: Types.ObjectId, note: string) {
    return this.move(user, id, [...TICKET_STATUSES], {}, 'COMMENT', note);
  }

  async resolve(user: AuthUser, id: Types.ObjectId, resolution: string) {
    const t = await this.move(user, id, ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'], { status: 'RESOLVED', resolution, resolvedAt: new Date() }, 'RESOLVED', resolution);
    if (t.phone) {
      await this.sms.queue(user.organisationId, t.phone, `${await this.orgName(user.organisationId)}: Your report ${t.number} has been resolved: ${resolution}`.slice(0, 300), 'water:ticket-resolved', t._id);
      await this.sms.deliverDue(user.organisationId);
    }
    return t;
  }

  close(user: AuthUser, id: Types.ObjectId, input: { customerConfirmed: boolean; satisfaction?: number | null; recommend?: number | null; note?: string }) {
    return this.move(user, id, ['RESOLVED'], { status: 'CLOSED', closedAt: new Date(), customerConfirmed: input.customerConfirmed, satisfaction: input.satisfaction ?? null, recommend: input.recommend ?? null }, 'CLOSED', input.note);
  }

  reopen(user: AuthUser, id: Types.ObjectId, note: string) {
    return this.move(user, id, ['RESOLVED', 'CLOSED'], { status: 'REOPENED', resolvedAt: null, closedAt: null }, 'REOPENED', note);
  }

  /** The customer's own feedback (portal or SMS): confirms and rates, or reopens. */
  async customerFeedback(organisationId: Types.ObjectId, id: Types.ObjectId, input: { confirmed: boolean; satisfaction?: number | null; recommend?: number | null; note?: string }) {
    const ticket = await this.db.tickets.findOne({ _id: id, organisationId });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') throw new BadRequestException('The ticket is not resolved yet');
    if (input.confirmed) ticket.set({ status: 'CLOSED', closedAt: ticket.closedAt ?? new Date(), customerConfirmed: true, satisfaction: input.satisfaction ?? null, recommend: input.recommend ?? null });
    else ticket.set({ status: 'REOPENED', resolvedAt: null, closedAt: null });
    ticket.history.push({ at: new Date(), by: null, action: input.confirmed ? 'CUSTOMER_CONFIRMED' : 'REOPENED', note: input.note ?? (input.confirmed ? 'Confirmed by the customer' : 'The customer says it is not sorted'), status: ticket.status });
    await ticket.save();
    return ticket.toObject();
  }

  async linkWorkOrder(user: AuthUser, id: Types.ObjectId) {
    const ticket = await this.db.tickets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.workOrderId) throw new BadRequestException('A field job is already raised for this ticket');
    const job = await this.createWorkOrder(user, id);
    await this.db.tickets.updateOne({ _id: id }, { workOrderId: job._id, ...(ticket.status === 'OPEN' && { status: 'IN_PROGRESS' }), $push: { history: { at: new Date(), by: user.id, action: 'WORK_ORDER', note: `Field job ${job.number}`, status: ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status } } });
    return job;
  }

  /**
   * Escalates tickets past their deadline one level (1 = supervisor, 2 = manager, 3 = managing director)
   * each time a further deadline period passes, and closes resolved tickets the customer never answered.
   * Run from the scheduler (or the "Run checks" button).
   */
  async housekeeping(organisationId: Types.ObjectId, now = new Date()) {
    const settings = await waterSettings(this.db, organisationId);
    const overdue = await this.db.tickets.find({ organisationId, status: { $in: OPEN_STATUSES }, slaDueAt: { $lt: now } }, { slaDueAt: 1, createdAt: 1, escalationLevel: 1 }).lean();
    let escalated = 0;
    for (const t of overdue) {
      const allowed = t.slaDueAt!.getTime() - (t.createdAt as Date).getTime();
      const level = Math.min(3, 1 + Math.floor((now.getTime() - t.slaDueAt!.getTime()) / Math.max(allowed, HOUR)));
      if (level > (t.escalationLevel ?? 0)) {
        await this.db.tickets.updateOne({ _id: t._id }, { escalationLevel: level, escalatedAt: now, $push: { history: { at: now, by: null, action: 'ESCALATED', note: `Past its deadline: escalated to level ${level}` } } });
        escalated++;
      }
    }
    const closeBefore = new Date(now.getTime() - (settings.service?.autoCloseDays ?? 7) * 24 * HOUR);
    const closed = await this.db.tickets.updateMany(
      { organisationId, status: 'RESOLVED', resolvedAt: { $lt: closeBefore } },
      { status: 'CLOSED', closedAt: now, $push: { history: { at: now, by: null, action: 'AUTO_CLOSED', note: 'No reply from the customer', status: 'CLOSED' } } },
    );
    return { escalated, closed: closed.modifiedCount };
  }

  /** Volumes, deadlines met, response and resolution times and satisfaction, for the period. */
  async stats(user: AuthUser, from: Date, to: Date) {
    const match = { organisationId: user.organisationId, createdAt: { $gte: from, $lt: to } };
    const [byCategory, byChannel, byStatus, resolved, openOverdue] = await Promise.all([
      this.db.tickets.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      this.db.tickets.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$channel', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      this.db.tickets.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      this.db.tickets
        .find({ ...match, resolvedAt: { $ne: null } }, { createdAt: 1, resolvedAt: 1, slaDueAt: 1, firstResponseAt: 1, satisfaction: 1, recommend: 1 })
        .lean(),
      this.db.tickets.countDocuments({ organisationId: user.organisationId, status: { $in: OPEN_STATUSES }, slaDueAt: { $lt: new Date() } }),
    ]);
    const total = byStatus.reduce((s, r) => s + r.n, 0);
    const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / HOUR;
    const withinSla = resolved.filter((t) => t.slaDueAt && t.resolvedAt! <= t.slaDueAt).length;
    const rated = resolved.filter((t) => t.satisfaction);
    const responded = resolved.filter((t) => t.firstResponseAt);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
    return {
      total,
      resolved: resolved.length,
      openOverdue,
      slaCompliancePercent: resolved.length ? Math.round((withinSla / resolved.length) * 1000) / 10 : null,
      avgResolutionHours: avg(resolved.map((t) => hours(t.createdAt as Date, t.resolvedAt!))),
      avgFirstResponseHours: avg(responded.map((t) => hours(t.createdAt as Date, t.firstResponseAt!))),
      csat: avg(rated.map((t) => t.satisfaction!)),
      csatResponses: rated.length,
      nps: netPromoterScore(resolved.filter((t) => t.recommend !== null && t.recommend !== undefined).map((t) => t.recommend!)),
      npsResponses: resolved.filter((t) => t.recommend !== null && t.recommend !== undefined).length,
      byCategory,
      byChannel,
      byStatus,
    };
  }
}
