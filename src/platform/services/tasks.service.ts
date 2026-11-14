import { Types } from 'mongoose';
import { AuthUser } from '../auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../common/errors';
import { Db } from '../db';
import { TASK_STATUSES } from '../workflow-schemas';
import { AuditService } from './audit.service';
import { NotificationsService } from './notifications.service';

type Status = (typeof TASK_STATUSES)[number];
const HOUR = 3_600_000;

/**
 * Tasks between people and departments: assigned with a deadline, notified, escalated when late, and
 * measured (completion rate and turnaround) for management.
 */
export class TasksService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(user: AuthUser, q: { view: 'mine' | 'created' | 'all'; status?: Status; overdue?: boolean }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.view === 'mine') filter.assignedTo = user.id;
    if (q.view === 'created') filter.createdBy = user.id;
    if (q.view === 'all' && !user.isAdmin) filter.$or = [{ assignedTo: user.id }, { createdBy: user.id }, { escalateTo: user.id }];
    if (q.status) filter.status = q.status;
    if (q.overdue) Object.assign(filter, { status: { $in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { $lt: new Date() } });
    const tasks = await this.db.tasks.find(filter).sort({ status: 1, dueAt: 1 }).limit(500).lean();
    const users = await this.db.users.find({ _id: { $in: tasks.flatMap((t) => [t.assignedTo, t.createdBy]) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return tasks.map((t) => ({ ...t, assignedName: names.get(t.assignedTo.toHexString()), createdName: names.get(t.createdBy.toHexString()), overdue: ['OPEN', 'IN_PROGRESS'].includes(t.status) && Boolean(t.dueAt && t.dueAt < new Date()) }));
  }

  /** Raised by a person, or by a module for someone to act on (system tasks pass `createdBy` themselves). */
  async create(user: AuthUser, input: { title: string; description?: string; assignedTo: Types.ObjectId; dueAt?: Date | null; priority?: 'LOW' | 'NORMAL' | 'HIGH'; module?: string; link?: string; department?: string; escalateTo?: Types.ObjectId | null }) {
    const assignee = await this.db.users.findOne({ _id: input.assignedTo, organisationId: user.organisationId, active: true }, { _id: 1 }).lean();
    if (!assignee) throw new BadRequestException('Pick an active user');
    const task = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, 'core:task', session);
      const [t] = await this.db.tasks.create([{ ...input, organisationId: user.organisationId, number: `TSK-${String(seq).padStart(5, '0')}`, createdBy: user.id, escalateTo: input.escalateTo ?? user.id }], { session });
      await this.audit.record(user, 'task.create', 'task', t._id, { title: input.title }, session);
      return t.toObject();
    });
    await this.notifications.notify(user.organisationId, [input.assignedTo], { title: `New task ${task.number}: ${task.title}`, body: input.dueAt ? `Due ${input.dueAt.toISOString().slice(0, 10)}` : undefined, link: '/tasks', module: input.module, email: true });
    return task;
  }

  async update(user: AuthUser, id: Types.ObjectId, input: { status?: Status; comment?: string; assignedTo?: Types.ObjectId; dueAt?: Date | null }) {
    const t = await this.db.tasks.findOne({ _id: id, organisationId: user.organisationId });
    if (!t) throw new NotFoundException('Task not found');
    const involved = [t.assignedTo, t.createdBy, t.escalateTo].some((x) => x?.equals(user.id));
    if (!involved && !user.isAdmin) throw new ForbiddenException('The task is not yours');
    if (input.assignedTo && !t.createdBy.equals(user.id) && !user.isAdmin) throw new ForbiddenException('Only whoever raised the task can reassign it');
    if (input.status) {
      t.status = input.status;
      if (input.status === 'IN_PROGRESS' && !t.startedAt) t.startedAt = new Date();
      if (input.status === 'DONE') t.completedAt = new Date();
    }
    if (input.assignedTo) t.assignedTo = input.assignedTo;
    if (input.dueAt !== undefined) t.dueAt = input.dueAt ?? undefined;
    if (input.comment) t.comments.push({ at: new Date(), by: user.id, text: input.comment });
    await t.save();
    await this.audit.record(user, 'task.update', 'task', id, input);
    const others = [t.assignedTo, t.createdBy].filter((x) => !x.equals(user.id));
    if (input.status === 'DONE' || input.comment || input.assignedTo) {
      await this.notifications.notify(user.organisationId, others, { title: `${t.number} ${input.status === 'DONE' ? 'done' : 'updated'}: ${t.title}`, body: input.comment, link: '/tasks' });
    }
    return t.toObject();
  }

  /** Late tasks are escalated once to whoever raised them (or the escalation contact). */
  async escalate(organisationId: Types.ObjectId, now = new Date()) {
    const late = await this.db.tasks.find({ organisationId, status: { $in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { $lt: now }, escalatedAt: null }).lean();
    for (const t of late) {
      await this.db.tasks.updateOne({ _id: t._id }, { escalatedAt: now });
      await this.notifications.notify(organisationId, [t.escalateTo ?? t.createdBy], { title: `Overdue: ${t.number} ${t.title}`, body: `Was due ${t.dueAt!.toISOString().slice(0, 10)}`, link: '/tasks', email: true });
    }
    return { escalated: late.length };
  }

  /** Completion and turnaround by assignee for a period. */
  async analytics(user: AuthUser, from: Date, to: Date) {
    const tasks = await this.db.tasks.find({ organisationId: user.organisationId, createdAt: { $gte: from, $lt: to } }).lean();
    const users = await this.db.users.find({ _id: { $in: tasks.map((t) => t.assignedTo) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    const by = new Map<string, { name: string; total: number; done: number; onTime: number; hours: number[] }>();
    for (const t of tasks) {
      const k = t.assignedTo.toHexString();
      const row = by.get(k) ?? { name: names.get(k) ?? '—', total: 0, done: 0, onTime: 0, hours: [] };
      row.total++;
      if (t.status === 'DONE' && t.completedAt) {
        row.done++;
        if (!t.dueAt || t.completedAt <= t.dueAt) row.onTime++;
        row.hours.push((t.completedAt.getTime() - (t.createdAt as Date).getTime()) / HOUR);
      }
      by.set(k, row);
    }
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'DONE').length,
      overdue: tasks.filter((t) => ['OPEN', 'IN_PROGRESS'].includes(t.status) && t.dueAt && t.dueAt < new Date()).length,
      byAssignee: [...by.values()].map((r) => ({ name: r.name, total: r.total, done: r.done, onTimePercent: r.done ? Math.round((r.onTime / r.done) * 1000) / 10 : null, avgTurnaroundHours: avg(r.hours) })),
    };
  }
}
