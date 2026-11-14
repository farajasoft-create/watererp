import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope, scopeFilter } from '../access';
import { fullName, HrDb as Db } from '../db';
import { CASE_KINDS, CASE_OUTCOMES, CaseDoc, CLEARANCE_SECTIONS, ClearanceDoc } from '../schemas';

type Id = Types.ObjectId;
type Notify = (organisationId: Id, userIds: Id[], n: { title: string; body?: string; link?: string }) => Promise<void>;

/** What an employee may change about themselves (subject to HR approval). */
const PERSONAL_FIELDS = ['phone', 'email', 'address', 'nextOfKin', 'dependants', 'qualifications'] as const;
const BANK_FIELDS = ['payMethod', 'bank', 'mpesaPhone'] as const;

/**
 * Staff relations: employees' requests to change their own records (approved by HR), disciplinary
 * cases and grievances with every step recorded, and exit clearance — each section clears the leaver,
 * the exit interview is recorded, and the clearance certificate issued.
 */
export class RelationsService {
  notify: Notify = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async self(user: AuthUser) {
    const e = await this.db.employees.findOne({ organisationId: user.organisationId, userId: user.id }).lean();
    if (!e) throw new NotFoundException('Your login is not linked to an employee record yet; ask HR to link it');
    return e;
  }

  private async employee(user: AuthUser, id: Id) {
    const e = await this.db.employees.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    return e;
  }

  /** HR managers and officers, who are told about requests from staff. */
  private async hrUsers(organisationId: Id) {
    const users = await this.db.users.find({ organisationId, active: true, access: { $elemMatch: { module: 'hr', role: { $in: ['HR_MANAGER', 'HR_OFFICER', 'FULL'] } } } }, { _id: 1 }).lean();
    return users.map((u) => u._id);
  }

  // ----- Self-service change requests -------------------------------------------------------------

  async requestChange(user: AuthUser, input: { kind: 'PERSONAL' | 'BANK'; changes: Record<string, unknown> }) {
    const e = await this.self(user);
    const allowed: readonly string[] = input.kind === 'PERSONAL' ? PERSONAL_FIELDS : BANK_FIELDS;
    const keys = Object.keys(input.changes).filter((k) => input.changes[k] !== undefined);
    if (!keys.length) throw new BadRequestException('Nothing to change');
    const bad = keys.find((k) => !allowed.includes(k));
    if (bad) throw new BadRequestException(`${bad} cannot be changed this way`);
    if (await this.db.changeRequests.exists({ organisationId: user.organisationId, employeeId: e._id, kind: input.kind, status: 'PENDING' })) throw new BadRequestException('You already have a change of this kind awaiting approval');
    const before = Object.fromEntries(keys.map((k) => [k, (e as Record<string, unknown>)[k] ?? null]));
    const [doc] = await this.db.changeRequests.create([{ organisationId: user.organisationId, employeeId: e._id, kind: input.kind, changes: input.changes, before, requestedBy: user.id }]);
    await this.audit.record(user, 'hr.self.change_request', 'hrChangeRequest', doc._id, { kind: input.kind, fields: keys });
    await this.notify(user.organisationId, await this.hrUsers(user.organisationId), { title: `${fullName(e)} asked to update their ${input.kind === 'BANK' ? 'bank' : 'personal'} details`, link: '/hr/relations' });
    return doc.toObject();
  }

  /** Active colleagues in the employee's department, to hand work over to. */
  async colleagues(user: AuthUser) {
    const e = await this.self(user);
    const rows = await this.db.employees.find({ organisationId: user.organisationId, status: 'ACTIVE', departmentId: e.departmentId, _id: { $ne: e._id } }, { firstName: 1, lastName: 1, otherNames: 1, jobTitle: 1 }).sort({ firstName: 1 }).limit(300).lean();
    return rows.map((x) => ({ id: x._id, name: fullName(x), jobTitle: x.jobTitle ?? '' }));
  }

  async myChanges(user: AuthUser) {
    const e = await this.self(user);
    return this.db.changeRequests.find({ organisationId: user.organisationId, employeeId: e._id }).sort({ createdAt: -1 }).limit(20).lean();
  }

  async changes(user: AuthUser, status = 'PENDING') {
    const rows = await this.db.changeRequests.find({ organisationId: user.organisationId, status }).sort({ createdAt: -1 }).limit(200).lean();
    const people = await this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) }, ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean();
    const canBank = hasPermission(user, P.SALARY_VIEW);
    return rows
      .filter((r) => people.some((p) => p._id.equals(r.employeeId)))
      .map((r) => {
        const p = people.find((x) => x._id.equals(r.employeeId))!;
        const hidden = r.kind === 'BANK' && !canBank;
        return { ...r, changes: hidden ? null : r.changes, before: hidden ? null : r.before, employee: { id: p._id, employeeNo: p.employeeNo, name: fullName(p) } };
      });
  }

  async decideChange(user: AuthUser, id: Id, approve: boolean, note?: string) {
    const r = await this.db.changeRequests.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Change request not found');
    if (r.status !== 'PENDING') throw new BadRequestException('This request has been decided');
    if (r.kind === 'BANK' && !hasPermission(user, P.SALARY_MANAGE)) throw new ForbiddenException('Bank details changes need payroll approval');
    const e = await this.employee(user, r.employeeId);
    if (e.userId?.equals(user.id)) throw new ForbiddenException('Someone else must approve changes to your own record');
    if (!approve && !note?.trim()) throw new BadRequestException('Give the reason');
    const res = await this.db.changeRequests.updateOne({ _id: r._id, status: 'PENDING' }, { status: approve ? 'APPROVED' : 'REJECTED', decidedBy: user.id, decidedAt: new Date(), note: note ?? '' });
    if (!res.modifiedCount) throw new BadRequestException('This request has been decided');
    if (approve) await this.db.employees.updateOne({ _id: e._id }, { $set: r.changes as Record<string, unknown> });
    await this.audit.record(user, approve ? 'hr.self.change_approve' : 'hr.self.change_reject', 'hrChangeRequest', r._id, { employee: e.employeeNo, kind: r.kind, note });
    if (e.userId) await this.notify(user.organisationId, [e.userId], { title: `Your ${r.kind === 'BANK' ? 'bank' : 'personal'} details change was ${approve ? 'approved' : 'not approved'}`, body: note, link: '/hr/me' });
    return this.db.changeRequests.findById(r._id).lean();
  }

  // ----- Disciplinary cases and grievances -------------------------------------------------------------

  async cases(user: AuthUser, q: { kind?: string; status?: string; employeeId?: Id }) {
    const rows = await this.db.cases.find({ organisationId: user.organisationId, ...(q.kind && { kind: q.kind }), ...(q.status && { status: q.status }), ...(q.employeeId && { employeeId: q.employeeId }) }).sort({ createdAt: -1 }).limit(300).lean();
    const people = await this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) }, ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean();
    return rows.filter((r) => people.some((p) => p._id.equals(r.employeeId))).map((r) => ({ ...r, employee: (() => { const p = people.find((x) => x._id.equals(r.employeeId))!; return { id: p._id, employeeNo: p.employeeNo, name: fullName(p) }; })() }));
  }

  private async loadCase(user: AuthUser, id: Id) {
    const c = (await this.db.cases.findOne({ _id: id, organisationId: user.organisationId }).lean()) as CaseDoc | null;
    if (!c) throw new NotFoundException('Case not found');
    await this.employee(user, c.employeeId);
    return c;
  }

  async openCase(user: AuthUser, input: { kind: (typeof CASE_KINDS)[number]; employeeId: Id; against?: string; category: string; description: string; incidentDate?: Date | null }) {
    const e = await this.employee(user, input.employeeId);
    const number = `${input.kind === 'DISCIPLINARY' ? 'DC' : 'GR'}-${String(await this.db.next(user.organisationId, `hr:case:${input.kind}`)).padStart(4, '0')}`;
    const name = await this.name(user);
    const [doc] = await this.db.cases.create([
      { organisationId: user.organisationId, number, kind: input.kind, employeeId: e._id, against: input.against ?? '', category: input.category, description: input.description, incidentDate: input.incidentDate ?? null, openedBy: user.id, steps: [{ action: 'OPENED', at: new Date(), by: user.id, byName: name, note: input.description }] },
    ]);
    await this.audit.record(user, 'hr.case.open', 'hrCase', doc._id, { number, kind: input.kind, employee: e.employeeNo });
    return doc.toObject();
  }

  private async name(user: AuthUser) {
    return (await this.db.users.findById(user.id, { name: 1 }).lean())?.name ?? '';
  }

  /**
   * Moves a case on. Disciplinary: show-cause letter (with a reply date) → hearing → decision → appeal →
   * closed. Grievances: hearing → decision (resolved or not upheld) → appeal → closed. Every step is kept.
   */
  async step(user: AuthUser, id: Id, input: { action: 'SHOW_CAUSE' | 'RESPONSE' | 'HEARING' | 'DECISION' | 'APPEAL' | 'APPEAL_DECISION' | 'CLOSE' | 'NOTE'; note?: string; dueDate?: Date | null; outcome?: (typeof CASE_OUTCOMES)[number]; appealDecision?: 'UPHELD' | 'VARIED' | 'OVERTURNED' }) {
    const c = await this.loadCase(user, id);
    if (c.status === 'CLOSED' && input.action !== 'NOTE') throw new BadRequestException('The case is closed');
    const set: Record<string, unknown> = {};
    switch (input.action) {
      case 'SHOW_CAUSE':
        if (c.kind !== 'DISCIPLINARY' || c.status !== 'OPEN') throw new BadRequestException('A show-cause letter is issued on a newly opened disciplinary case');
        if (!input.dueDate) throw new BadRequestException('Give the date the reply is due');
        set.status = 'SHOW_CAUSE';
        break;
      case 'RESPONSE':
        if (c.status !== 'SHOW_CAUSE') throw new BadRequestException('There is no show-cause letter awaiting a reply');
        break;
      case 'HEARING':
        if (!['OPEN', 'SHOW_CAUSE'].includes(c.status)) throw new BadRequestException('A hearing comes before the decision');
        if (!input.dueDate) throw new BadRequestException('Give the hearing date');
        set.status = 'HEARING';
        break;
      case 'DECISION': {
        if (!['HEARING', 'SHOW_CAUSE'].includes(c.status)) throw new BadRequestException('Hold the hearing (or receive the show-cause reply) before deciding');
        const ok = c.kind === 'GRIEVANCE' ? ['RESOLVED', 'NOT_UPHELD'] : CASE_OUTCOMES.filter((o) => !['RESOLVED', 'NOT_UPHELD'].includes(o));
        if (!input.outcome || !ok.includes(input.outcome)) throw new BadRequestException(`Choose the outcome: ${ok.join(', ')}`);
        set.status = 'DECIDED';
        set.outcome = input.outcome;
        set.outcomeNote = input.note ?? '';
        break;
      }
      case 'APPEAL':
        if (c.status !== 'DECIDED') throw new BadRequestException('Only a decided case can be appealed');
        if (!input.note?.trim()) throw new BadRequestException('Give the grounds of appeal');
        set.status = 'APPEALED';
        set['appeal.lodgedAt'] = new Date();
        set['appeal.grounds'] = input.note;
        break;
      case 'APPEAL_DECISION':
        if (c.status !== 'APPEALED' || !input.appealDecision) throw new BadRequestException('Record the appeal decision on an appealed case');
        set.status = 'CLOSED';
        set['appeal.decision'] = input.appealDecision;
        set['appeal.decidedAt'] = new Date();
        set['appeal.note'] = input.note ?? '';
        if (input.appealDecision === 'OVERTURNED') set.outcome = c.kind === 'GRIEVANCE' ? 'RESOLVED' : 'NO_ACTION';
        else if (input.appealDecision === 'VARIED') {
          if (!input.outcome) throw new BadRequestException('Give the varied outcome');
          set.outcome = input.outcome;
        }
        break;
      case 'CLOSE':
        if (!['DECIDED'].includes(c.status)) throw new BadRequestException('Decide the case before closing it');
        set.status = 'CLOSED';
        break;
      case 'NOTE':
        if (!input.note?.trim()) throw new BadRequestException('Write the note');
        break;
    }
    const entry = { action: input.action, at: new Date(), by: user.id, byName: await this.name(user), note: input.note ?? '', ...(input.dueDate && { dueDate: input.dueDate }) };
    const res = await this.db.cases.updateOne({ _id: c._id, status: c.status }, { $set: set, $push: { steps: entry } });
    if (!res.modifiedCount) throw new BadRequestException('The case was changed by someone else; reload');
    await this.audit.record(user, `hr.case.${input.action.toLowerCase()}`, 'hrCase', c._id, { number: c.number, outcome: input.outcome });
    return this.db.cases.findById(c._id).lean();
  }

  /** An employee raises a grievance from self-service. */
  async raiseGrievance(user: AuthUser, input: { against?: string; category: string; description: string; incidentDate?: Date | null }) {
    const e = await this.self(user);
    const number = `GR-${String(await this.db.next(user.organisationId, 'hr:case:GRIEVANCE')).padStart(4, '0')}`;
    const [doc] = await this.db.cases.create([
      { organisationId: user.organisationId, number, kind: 'GRIEVANCE', employeeId: e._id, against: input.against ?? '', category: input.category, description: input.description, incidentDate: input.incidentDate ?? null, openedBy: user.id, steps: [{ action: 'OPENED', at: new Date(), by: user.id, byName: fullName(e), note: input.description }] },
    ]);
    await this.audit.record(user, 'hr.case.grievance', 'hrCase', doc._id, { number });
    await this.notify(user.organisationId, await this.hrUsers(user.organisationId), { title: `Grievance ${number} raised`, link: '/hr/relations' });
    return { number, status: doc.status };
  }

  // ----- Exit clearance --------------------------------------------------------------------------------

  async startClearance(user: AuthUser, employeeId: Id, input: { lastDay: Date; reason: string; sections?: string[] }) {
    const e = await this.employee(user, employeeId);
    const sections = input.sections?.length ? input.sections : [...CLEARANCE_SECTIONS];
    try {
      const [doc] = await this.db.clearances.create([{ organisationId: user.organisationId, employeeId: e._id, lastDay: input.lastDay, reason: input.reason, items: sections.map((section) => ({ section })), startedBy: user.id }]);
      await this.audit.record(user, 'hr.clearance.start', 'hrClearance', doc._id, { employee: e.employeeNo, lastDay: input.lastDay });
      return doc.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('Clearance has already started for this employee');
      throw err;
    }
  }

  async clearances(user: AuthUser, status?: string) {
    const rows = await this.db.clearances.find({ organisationId: user.organisationId, ...(status && { status }) }).sort({ lastDay: -1 }).limit(200).lean();
    const people = await this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) }, ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, jobTitle: 1 }).lean();
    return rows.filter((r) => people.some((p) => p._id.equals(r.employeeId))).map((r) => {
      const p = people.find((x) => x._id.equals(r.employeeId))!;
      return { ...r, employee: { id: p._id, employeeNo: p.employeeNo, name: fullName(p), jobTitle: p.jobTitle } };
    });
  }

  private async loadClearance(user: AuthUser, id: Id) {
    const c = (await this.db.clearances.findOne({ _id: id, organisationId: user.organisationId }).lean()) as ClearanceDoc | null;
    if (!c) throw new NotFoundException('Clearance not found');
    await this.employee(user, c.employeeId);
    return c;
  }

  /** A section clears the leaver (or records what they still owe, which blocks the certificate). */
  async clear(user: AuthUser, id: Id, input: { section: string; cleared: boolean; owed?: string; note?: string }) {
    const c = await this.loadClearance(user, id);
    if (c.status === 'CLEARED') throw new BadRequestException('Clearance is complete');
    const i = c.items.findIndex((x) => x.section === input.section);
    if (i < 0) throw new BadRequestException(`${input.section} is not on this clearance`);
    if (input.cleared && input.owed && dec(input.owed).gt(0)) throw new BadRequestException('Clear the section only once nothing is owed');
    const name = await this.name(user);
    await this.db.clearances.updateOne(
      { _id: c._id },
      { $set: { [`items.${i}.cleared`]: input.cleared, [`items.${i}.owed`]: toD128(input.owed ?? 0), [`items.${i}.note`]: input.note ?? '', [`items.${i}.clearedBy`]: input.cleared ? user.id : null, [`items.${i}.clearedByName`]: input.cleared ? name : '', [`items.${i}.clearedAt`]: input.cleared ? new Date() : null } },
    );
    await this.audit.record(user, 'hr.clearance.section', 'hrClearance', c._id, { section: input.section, cleared: input.cleared, owed: input.owed });
    return this.db.clearances.findById(c._id).lean();
  }

  async exitInterview(user: AuthUser, id: Id, input: { reasonForLeaving: string; wouldRecommend?: boolean; comments?: string }) {
    const c = await this.loadClearance(user, id);
    await this.db.clearances.updateOne({ _id: c._id }, { $set: { exitInterview: { ...input, conductedAt: new Date(), by: user.id } } });
    await this.audit.record(user, 'hr.clearance.exit_interview', 'hrClearance', c._id, {});
    return this.db.clearances.findById(c._id).lean();
  }

  /** Completes clearance once every section has cleared and the exit interview is on file. */
  async complete(user: AuthUser, id: Id) {
    const c = await this.loadClearance(user, id);
    const open = c.items.filter((x) => !x.cleared).map((x) => x.section);
    if (open.length) throw new BadRequestException(`Still to clear: ${open.join(', ')}`);
    if (!c.exitInterview?.conductedAt) throw new BadRequestException('Record the exit interview first');
    await this.db.clearances.updateOne({ _id: c._id, status: 'OPEN' }, { status: 'CLEARED', clearedAt: new Date() });
    await this.audit.record(user, 'hr.clearance.complete', 'hrClearance', c._id, {});
    return this.db.clearances.findById(c._id).lean();
  }
}
