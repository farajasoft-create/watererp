import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope, departmentScope } from '../access';
import { fullName, HrDb as Db } from '../db';

type Id = Types.ObjectId;
const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

export interface InductionInput {
  title: string;
  startDate: Date;
  endDate: Date;
  venue?: string;
  participants: Id[];
  sessions: { date?: Date | null; time?: string; topic: string; departmentId?: Id | null; facilitator?: string }[];
}

/**
 * Induction programmes for new staff: HR sets the dates, venue and who attends; user departments add
 * their own sessions; participants are alerted by SMS and email when added and the day before; and
 * attending completes the induction step of their onboarding.
 */
export class InductionService {
  /** Email, SMS and in-app notice to an employee; wired in the container. */
  alert: (organisationId: Id, employee: { email?: string | null; phone?: string | null; userId?: Id | null }, subject: string, text: string, sourceId: Id) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Staff hired in the last 90 days whose induction is not yet done: who to invite. */
  async newStarters(user: AuthUser) {
    const since = new Date(Date.now() - 90 * DAY);
    const rows = await this.db.employees.find({ organisationId: user.organisationId, status: 'ACTIVE', hireDate: { $gte: since }, ...(departmentScope(user).length && { departmentId: { $in: departmentScope(user) } }) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, departmentId: 1, hireDate: 1, onboarding: 1, jobTitle: 1 }).lean();
    return rows
      .filter((e) => !(e.onboarding ?? []).some((t) => /induction/i.test(t.task) && t.done))
      .map((e) => ({ id: e._id, employeeNo: e.employeeNo, name: fullName(e), jobTitle: e.jobTitle, hireDate: e.hireDate, departmentId: e.departmentId }));
  }

  async list(user: AuthUser) {
    return this.db.inductions.find({ organisationId: user.organisationId }).sort({ startDate: -1 }).limit(100).lean();
  }

  async get(user: AuthUser, id: Id) {
    const i = await this.db.inductions.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!i) throw new NotFoundException('Induction programme not found');
    const [people, departments] = await Promise.all([
      this.db.employees.find({ _id: { $in: i.participants.map((p) => p.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, jobTitle: 1, departmentId: 1 }).lean(),
      this.db.departments.find({ organisationId: user.organisationId }, { name: 1 }).lean(),
    ]);
    const dept = (d?: Id | null) => (d ? (departments.find((x) => x._id.equals(d))?.name ?? '') : 'HR');
    return {
      ...i,
      sessions: [...i.sessions].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0) || (a.time ?? '').localeCompare(b.time ?? '')).map((s) => ({ ...s, department: dept(s.departmentId) })),
      participants: i.participants.map((p) => {
        const e = people.find((x) => x._id.equals(p.employeeId));
        return { ...p, employeeNo: e?.employeeNo ?? '', name: e ? fullName(e) : '', jobTitle: e?.jobTitle ?? '', department: dept(e?.departmentId) };
      }),
    };
  }

  private async notify(organisationId: Id, induction: { _id: Id; title: string; startDate: Date; endDate: Date; venue?: string | null }, employeeIds: Id[], reminder = false) {
    const people = await this.db.employees.find({ _id: { $in: employeeIds } }, { email: 1, phone: 1, userId: 1, firstName: 1 }).lean();
    const text = `${reminder ? 'Reminder: ' : ''}you are booked on "${induction.title}" from ${day(induction.startDate)} to ${day(induction.endDate)}${induction.venue ? ` at ${induction.venue}` : ''}. Please attend every session; HR coordinates the programme.`;
    for (const e of people) await this.alert(organisationId, e, reminder ? 'Induction starts tomorrow' : 'Induction programme', `Dear ${e.firstName}, ${text}`, induction._id);
    const field = reminder ? 'participants.$[p].remindedAt' : 'participants.$[p].notifiedAt';
    await this.db.inductions.updateOne({ _id: induction._id }, { $set: { [field]: new Date() } }, { arrayFilters: [{ 'p.employeeId': { $in: employeeIds } }] });
  }

  async create(user: AuthUser, input: InductionInput) {
    if (!hasPermission(user, P.EMPLOYEE_MANAGE)) throw new ForbiddenException('HR sets up induction programmes');
    if (input.endDate < input.startDate) throw new BadRequestException('The end is before the start');
    const count = await this.db.employees.countDocuments({ organisationId: user.organisationId, _id: { $in: input.participants } });
    if (count !== input.participants.length) throw new BadRequestException('Participant not found');
    const [doc] = await this.db.inductions.create([{ organisationId: user.organisationId, title: input.title, startDate: input.startDate, endDate: input.endDate, venue: input.venue, sessions: input.sessions.map((s) => ({ ...s, contributedBy: user.id })), participants: input.participants.map((employeeId) => ({ employeeId })), createdBy: user.id }]);
    await this.audit.record(user, 'hr.induction.create', 'hrInduction', doc._id, { title: input.title, participants: input.participants.length });
    if (input.participants.length) await this.notify(user.organisationId, doc, input.participants);
    return this.get(user, doc._id);
  }

  async addParticipants(user: AuthUser, id: Id, employeeIds: Id[]) {
    if (!hasPermission(user, P.EMPLOYEE_MANAGE)) throw new ForbiddenException('HR manages participants');
    const i = await this.get(user, id);
    const fresh = employeeIds.filter((e) => !i.participants.some((p) => p.employeeId.equals(e)));
    if (fresh.length) {
      await this.db.inductions.updateOne({ _id: id }, { $push: { participants: { $each: fresh.map((employeeId) => ({ employeeId })) } } });
      await this.notify(user.organisationId, i, fresh);
    }
    return this.get(user, id);
  }

  /** A user department adds its session (a line manager for their own department, or HR for any). */
  async addSession(user: AuthUser, id: Id, input: InductionInput['sessions'][number]) {
    const i = await this.get(user, id);
    if (i.status !== 'PLANNED') throw new BadRequestException('The programme is finished');
    if (!hasPermission(user, P.EMPLOYEE_MANAGE)) {
      if (!input.departmentId) throw new ForbiddenException('Say which department the session is from');
      if (!departmentScope(user).length) throw new ForbiddenException('Only HR or a department\'s line manager adds sessions');
      assertInScope(user, input.departmentId);
    }
    if (input.date && (input.date < new Date(day(i.startDate)) || input.date > i.endDate)) throw new BadRequestException('The session falls outside the programme dates');
    await this.db.inductions.updateOne({ _id: id }, { $push: { sessions: { ...input, contributedBy: user.id } } });
    await this.audit.record(user, 'hr.induction.session', 'hrInduction', id, { topic: input.topic });
    return this.get(user, id);
  }

  /** Attendance; attending completes the employee's induction step, and the programme can be closed. */
  async attendance(user: AuthUser, id: Id, rows: { employeeId: Id; attended: boolean }[]) {
    if (!hasPermission(user, P.EMPLOYEE_MANAGE)) throw new ForbiddenException('HR records attendance');
    await this.get(user, id);
    for (const r of rows) {
      await this.db.inductions.updateOne({ _id: id, 'participants.employeeId': r.employeeId }, { $set: { 'participants.$.attended': r.attended } });
      if (r.attended) {
        const e = await this.db.employees.findById(r.employeeId, { onboarding: 1 }).lean();
        const task = (e?.onboarding ?? []).find((t) => /induction/i.test(t.task));
        if (task) await this.db.employees.updateOne({ _id: r.employeeId, 'onboarding._id': task._id }, { $set: { 'onboarding.$.done': true, 'onboarding.$.doneBy': user.id, 'onboarding.$.doneAt': new Date() } });
      }
    }
    await this.audit.record(user, 'hr.induction.attendance', 'hrInduction', id, { rows: rows.length });
    return this.get(user, id);
  }

  async setStatus(user: AuthUser, id: Id, status: 'COMPLETED' | 'CANCELLED') {
    if (!hasPermission(user, P.EMPLOYEE_MANAGE)) throw new ForbiddenException('HR closes programmes');
    await this.get(user, id);
    await this.db.inductions.updateOne({ _id: id, status: 'PLANNED' }, { status });
    await this.audit.record(user, `hr.induction.${status.toLowerCase()}`, 'hrInduction', id, {});
    return this.get(user, id);
  }

  /** Daily: reminds participants the day before a programme starts. */
  async remindDue(organisationId: Id, now = new Date()) {
    const tomorrow = new Date(day(new Date(now.getTime() + DAY)));
    const due = await this.db.inductions.find({ organisationId, status: 'PLANNED', startDate: { $gte: tomorrow, $lt: new Date(tomorrow.getTime() + DAY) } }).lean();
    let reminded = 0;
    for (const i of due) {
      const ids = i.participants.filter((p) => !p.remindedAt).map((p) => p.employeeId);
      if (ids.length) await this.notify(organisationId, i, ids, true);
      reminded += ids.length;
    }
    return { reminded };
  }
}
