import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { EventBus } from '@/platform/events';
import { AuditService } from '@/platform/services/audit.service';
import { WaterDb as Db } from '../db';
import { WORK_PRIORITIES, WORK_STATUSES, WORK_TYPES } from '../ops-schemas';

type WorkType = (typeof WORK_TYPES)[number];
type Status = (typeof WORK_STATUSES)[number];
type Priority = (typeof WORK_PRIORITIES)[number];

const HOUR = 3_600_000;
/** Hours to finish a job by priority, unless a due date is given. */
const DUE_HOURS: Record<Priority, number> = { EMERGENCY: 4, URGENT: 24, NORMAL: 72, LOW: 168 };
const ACTIVE: Status[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

export interface WorkOrderInput {
  type: WorkType;
  priority?: Priority;
  title: string;
  description?: string;
  ticketId?: Types.ObjectId | null;
  customerId?: Types.ObjectId | null;
  facilityId?: Types.ObjectId | null;
  featureId?: Types.ObjectId | null;
  planId?: Types.ObjectId | null;
  assetRef?: string;
  zoneId?: Types.ObjectId | null;
  location?: string;
  gps?: { lat: number; lng: number } | null;
  assignedTo?: Types.ObjectId[];
  dueAt?: Date | null;
  checklist?: string[];
}

export interface CompletionInput {
  findings: string;
  labourHours?: Decimal;
  materials?: { itemCode?: string; description: string; quantity: Decimal; unitCost?: Decimal }[];
  checklist?: { item: string; done: boolean }[];
  gps?: { lat: number; lng: number } | null;
}

/**
 * Field jobs (job cards): leak and burst repairs, connections, meter work, preventive and corrective
 * maintenance of the network, plant, electro-mechanical equipment and vehicles. Jobs are dispatched to
 * field staff's phones, carry a deadline, and record findings, labour and the spare parts used.
 */
export class WorksService {
  /** Wired in the container: a job raised from a ticket resolves the ticket when it is done. */
  onCompleted: (user: AuthUser, job: { _id: Types.ObjectId; ticketId?: Types.ObjectId | null; findings?: string | null; number: string }) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async list(user: AuthUser, q: { status?: Status; active?: boolean; mine?: boolean; type?: WorkType; overdue?: boolean; search?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    else if (q.active) filter.status = { $in: ACTIVE };
    if (q.mine) filter.assignedTo = user.id;
    if (q.type) filter.type = q.type;
    if (q.overdue) Object.assign(filter, { status: { $in: ACTIVE }, dueAt: { $lt: new Date() } });
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { title: rx }, { location: rx }, { assetRef: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.workOrders
        .find(filter, { history: 0 })
        .sort({ dueAt: 1, createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.workOrders.countDocuments(filter),
    ]);
    const users = await this.db.users.find({ _id: { $in: items.flatMap((w) => w.assignedTo) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return { items: items.map((w) => ({ ...w, assignedNames: w.assignedTo.map((id) => names.get(id.toHexString()) ?? '—'), overdue: ACTIVE.includes(w.status as Status) && Boolean(w.dueAt && w.dueAt < new Date()) })), total, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const job = await this.db.workOrders.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!job) throw new NotFoundException('Job not found');
    const ids = [...job.assignedTo, ...job.history.map((h) => h.by).filter(Boolean)] as Types.ObjectId[];
    const [users, customer, facility, ticket] = await Promise.all([
      this.db.users.find({ _id: { $in: ids } }, { name: 1 }).lean(),
      job.customerId ? this.db.customers.findById(job.customerId, { accountNo: 1, name: 1, phone: 1 }).lean() : null,
      job.facilityId ? this.db.facilities.findById(job.facilityId, { code: 1, name: 1 }).lean() : null,
      job.ticketId ? this.db.tickets.findById(job.ticketId, { number: 1, subject: 1 }).lean() : null,
    ]);
    return { ...job, names: Object.fromEntries(users.map((u) => [u._id.toHexString(), u.name])), customer, facility, ticket };
  }

  async create(user: AuthUser, input: WorkOrderInput) {
    const priority = input.priority ?? 'NORMAL';
    const job = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, 'water:work-order', session);
      const assigned = input.assignedTo ?? [];
      const [w] = await this.db.workOrders.create(
        [
          {
            ...input,
            organisationId: user.organisationId,
            number: `WO-${String(seq).padStart(6, '0')}`,
            priority,
            status: assigned.length ? 'ASSIGNED' : 'OPEN',
            assignedTo: assigned,
            dueAt: input.dueAt ?? new Date(Date.now() + DUE_HOURS[priority] * HOUR),
            checklist: (input.checklist ?? []).map((item) => ({ item, done: false })),
            createdBy: user.id,
            history: [{ at: new Date(), by: user.id, action: 'CREATED', status: assigned.length ? 'ASSIGNED' : 'OPEN' }],
          },
        ],
        { session },
      );
      await this.audit.record(user, 'water.work-order.create', 'workOrder', w._id, { number: w.number, type: w.type }, session);
      return w.toObject();
    });
    return job;
  }

  /** A field job for a ticket, carrying its customer, place and urgency. */
  async fromTicket(user: AuthUser, ticketId: Types.ObjectId) {
    const t = await this.db.tickets.findOne({ _id: ticketId, organisationId: user.organisationId }).lean();
    if (!t) throw new NotFoundException('Ticket not found');
    const type: WorkType = t.category === 'BURST' ? 'BURST_REPAIR' : t.category === 'LEAK' ? 'LEAK_REPAIR' : t.category === 'METER' ? 'METER_REPLACEMENT' : t.category === 'SEWER' ? 'SEWER_UNBLOCKING' : t.category === 'RECONNECTION' ? 'RECONNECTION' : t.category === 'NEW_CONNECTION' ? 'NEW_CONNECTION' : 'INSPECTION';
    return this.create(user, { type, priority: t.priority as Priority, title: `${t.number}: ${t.subject}`, description: t.description ?? undefined, ticketId: t._id, customerId: t.customerId, zoneId: t.zoneId, location: t.location ?? undefined, gps: t.gps?.lat ? { lat: t.gps.lat, lng: t.gps.lng! } : null, dueAt: t.slaDueAt ?? null, assignedTo: t.assignedTo ? [t.assignedTo] : [] });
  }

  private async step(user: AuthUser, id: Types.ObjectId, from: Status[], set: Record<string, unknown>, action: string, note?: string, fieldOnly = false) {
    const job = await this.db.workOrders.findOne({ _id: id, organisationId: user.organisationId });
    if (!job) throw new NotFoundException('Job not found');
    if (fieldOnly && !user.permissions.includes('water.works.manage') && !job.assignedTo.some((a) => a.equals(user.id))) throw new ForbiddenException('The job is not assigned to you');
    if (!from.includes(job.status as Status)) throw new BadRequestException(`The job is ${job.status.toLowerCase().replace('_', ' ')}`);
    job.set(set);
    job.history.push({ at: new Date(), by: user.id, action, note, status: job.status });
    await job.save();
    await this.audit.record(user, `water.work-order.${action.toLowerCase()}`, 'workOrder', id, { note });
    return job;
  }

  async assign(user: AuthUser, id: Types.ObjectId, assignedTo: Types.ObjectId[], note?: string) {
    const n = await this.db.users.countDocuments({ _id: { $in: assignedTo }, organisationId: user.organisationId, active: true });
    if (n !== assignedTo.length || !n) throw new BadRequestException('Pick active users');
    return (await this.step(user, id, ['OPEN', 'ASSIGNED', 'ON_HOLD'], { assignedTo, status: 'ASSIGNED' }, 'ASSIGNED', note)).toObject();
  }

  async start(user: AuthUser, id: Types.ObjectId) {
    return (await this.step(user, id, ['OPEN', 'ASSIGNED', 'ON_HOLD'], { status: 'IN_PROGRESS', startedAt: new Date() }, 'STARTED', undefined, true)).toObject();
  }

  async hold(user: AuthUser, id: Types.ObjectId, note: string) {
    return (await this.step(user, id, ['ASSIGNED', 'IN_PROGRESS'], { status: 'ON_HOLD' }, 'ON_HOLD', note, true)).toObject();
  }

  /** The field team reports the job done with findings, labour and materials. */
  async complete(user: AuthUser, id: Types.ObjectId, input: CompletionInput) {
    const materials = (input.materials ?? []).map((m) => ({ itemCode: m.itemCode, description: m.description, quantity: toD128(m.quantity), unitCost: toD128(m.unitCost ?? 0) }));
    const cost = (input.materials ?? []).reduce((s, m) => s.plus(m.quantity.times(m.unitCost ?? 0)), new Decimal(0));
    const job = await this.step(
      user,
      id,
      ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'OPEN'],
      { status: 'DONE', completedAt: new Date(), findings: input.findings, labourHours: toD128(input.labourHours ?? 0), materials, materialsCost: toD128(cost), ...(input.checklist && { checklist: input.checklist }), ...(input.gps && { completionGps: input.gps }) },
      'COMPLETED',
      input.findings,
      true,
    );
    await this.events.emit(user.organisationId, 'water.work-order.completed', { workOrderId: job._id, number: job.number, materials: (input.materials ?? []).map((m) => ({ itemCode: m.itemCode, description: m.description, quantity: m.quantity.toFixed() })) });
    await this.onCompleted(user, job.toObject());
    return job.toObject();
  }

  /** A supervisor checks the work and closes the card (or sends it back). */
  async close(user: AuthUser, id: Types.ObjectId, input: { accept: boolean; note?: string }) {
    return input.accept
      ? (await this.step(user, id, ['DONE'], { status: 'CLOSED', closedAt: new Date() }, 'CLOSED', input.note)).toObject()
      : (await this.step(user, id, ['DONE'], { status: 'IN_PROGRESS', completedAt: null }, 'RETURNED', input.note ?? 'Sent back for rework')).toObject();
  }

  async cancel(user: AuthUser, id: Types.ObjectId, note: string) {
    return (await this.step(user, id, ACTIVE, { status: 'CANCELLED' }, 'CANCELLED', note)).toObject();
  }

  // Preventive maintenance --------------------------------------------------------------------

  listPlans(user: AuthUser) {
    return this.db.maintenancePlans.find({ organisationId: user.organisationId }).sort({ nextDue: 1 }).lean();
  }

  async savePlan(user: AuthUser, input: { name: string; facilityId?: Types.ObjectId | null; featureId?: Types.ObjectId | null; assetRef?: string; frequencyDays: number; leadDays?: number; nextDue: Date; checklist?: string[]; assignedTo?: Types.ObjectId[]; estimatedHours?: Decimal; active?: boolean }, id?: Types.ObjectId) {
    const doc = { ...input, estimatedHours: toD128(input.estimatedHours ?? 0) };
    const saved = id ? await this.db.maintenancePlans.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, doc, { new: true }).lean() : (await this.db.maintenancePlans.create([{ ...doc, organisationId: user.organisationId }]))[0].toObject();
    if (!saved) throw new NotFoundException('Plan not found');
    await this.audit.record(user, 'water.maintenance-plan.save', 'maintenancePlan', saved._id, { name: input.name });
    return saved;
  }

  /** Raises the job for every plan coming due within its lead time, and moves the plan to its next date. */
  async raiseDue(user: AuthUser, today = new Date()) {
    const plans = await this.db.maintenancePlans.find({ organisationId: user.organisationId, active: true }).lean();
    const raised: string[] = [];
    for (const p of plans) {
      if (p.nextDue.getTime() - (p.leadDays ?? 7) * 86_400_000 > today.getTime()) continue;
      const open = await this.db.workOrders.exists({ organisationId: user.organisationId, planId: p._id, status: { $in: ACTIVE } });
      if (open) continue;
      const job = await this.create(user, { type: 'PREVENTIVE', title: p.name, planId: p._id, facilityId: p.facilityId, featureId: p.featureId, assetRef: p.assetRef ?? undefined, dueAt: p.nextDue, checklist: p.checklist, assignedTo: p.assignedTo });
      await this.db.maintenancePlans.updateOne({ _id: p._id }, { nextDue: new Date(p.nextDue.getTime() + p.frequencyDays * 86_400_000) });
      raised.push(job.number);
    }
    return { raised };
  }

  /** Jobs done on time, average turnaround and cost by type, for the period. */
  async stats(user: AuthUser, from: Date, to: Date) {
    const done = await this.db.workOrders.find({ organisationId: user.organisationId, completedAt: { $gte: from, $lt: to } }, { type: 1, createdAt: 1, completedAt: 1, dueAt: 1, materialsCost: 1, labourHours: 1 }).lean();
    const open = await this.db.workOrders.countDocuments({ organisationId: user.organisationId, status: { $in: ACTIVE } });
    const overdue = await this.db.workOrders.countDocuments({ organisationId: user.organisationId, status: { $in: ACTIVE }, dueAt: { $lt: new Date() } });
    const byType: Record<string, { jobs: number; onTime: number; hours: number; cost: Decimal }> = {};
    for (const j of done) {
      const t = (byType[j.type] ??= { jobs: 0, onTime: 0, hours: 0, cost: new Decimal(0) });
      t.jobs++;
      if (!j.dueAt || j.completedAt! <= j.dueAt) t.onTime++;
      t.hours += (j.completedAt!.getTime() - (j.createdAt as Date).getTime()) / HOUR;
      t.cost = t.cost.plus(dec(j.materialsCost));
    }
    return {
      open,
      overdue,
      completed: done.length,
      onTimePercent: done.length ? Math.round((done.filter((j) => !j.dueAt || j.completedAt! <= j.dueAt).length / done.length) * 1000) / 10 : null,
      byType: Object.entries(byType).map(([type, t]) => ({ type, jobs: t.jobs, onTimePercent: Math.round((t.onTime / t.jobs) * 1000) / 10, avgHours: Math.round((t.hours / t.jobs) * 10) / 10, materialsCost: t.cost.toFixed(2) })),
    };
  }
}
