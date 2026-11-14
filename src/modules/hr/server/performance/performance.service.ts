import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, sum, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope, scopeFilter } from '../access';
import { fullName, HrDb as Db, hrSettings } from '../db';
import { AppraisalDoc, BSC_PERSPECTIVES, RECOMMENDATIONS, TRAINING_KINDS, TrainingDoc } from '../schemas';

type Id = Types.ObjectId;
type Perspective = (typeof BSC_PERSPECTIVES)[number];
type Notify = (organisationId: Id, userIds: Id[], n: { title: string; body?: string; link?: string }) => Promise<void>;

/** Weighted score (0-100) from 1-5 ratings. */
const scoreOf = (targets: { weight: number; rating?: number | null }[]) => Math.round(targets.reduce((a, t) => a + ((t.rating ?? 0) / 5) * t.weight, 0) * 100) / 100;
const gradeOf = (score: number) => (score >= 90 ? 'Outstanding' : score >= 75 ? 'Very good' : score >= 60 ? 'Good' : score >= 50 ? 'Fair' : 'Poor');

/**
 * Performance and development: balanced-scorecard appraisals (targets agreed with the employee,
 * self-rated, rated by the supervisor, appealable) and the training plan — courses, workshops,
 * mentorship and coaching — costed against the year's training budget, with needs carried over from
 * appraisals and each participant's attendance and evaluation.
 */
export class PerformanceService {
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

  /** HR may act on anyone in scope; a supervisor only on the people who report to them. */
  private async assertAppraiser(user: AuthUser, employee: { _id: Id; managerId?: Id | null; departmentId?: Id | null }) {
    if (hasPermission(user, P.EMPLOYEE_MANAGE)) return assertInScope(user, employee.departmentId);
    const manager = employee.managerId ? await this.db.employees.findById(employee.managerId, { userId: 1 }).lean() : null;
    if (!manager?.userId?.equals(user.id)) throw new ForbiddenException('Only HR or the employee’s supervisor can do this');
  }

  // ----- Cycles and appraisals ---------------------------------------------------------------------

  cycles(user: AuthUser) {
    return this.db.appraisalCycles.find({ organisationId: user.organisationId }).sort({ from: -1 }).lean();
  }

  async saveCycle(user: AuthUser, input: { name: string; from: Date; to: Date }) {
    if (input.to <= input.from) throw new BadRequestException('The cycle must end after it starts');
    const [doc] = await this.db.appraisalCycles.create([{ ...input, organisationId: user.organisationId }]);
    await this.audit.record(user, 'hr.appraisal.cycle', 'hrAppraisalCycle', doc._id, { name: input.name });
    return doc.toObject();
  }

  async closeCycle(user: AuthUser, id: Id) {
    const res = await this.db.appraisalCycles.updateOne({ _id: id, organisationId: user.organisationId }, { status: 'CLOSED' });
    if (!res.matchedCount) throw new NotFoundException('Cycle not found');
    await this.audit.record(user, 'hr.appraisal.cycle_close', 'hrAppraisalCycle', id, {});
    return { closed: true };
  }

  async appraisals(user: AuthUser, cycleId: Id) {
    const rows = await this.db.appraisals.find({ organisationId: user.organisationId, cycleId, ...scopeFilter(user) }).lean();
    const people = await this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, jobTitle: 1 }).lean();
    return rows.map((r) => {
      const p = people.find((x) => x._id.equals(r.employeeId));
      return { ...r, employee: p ? { id: p._id, employeeNo: p.employeeNo, name: fullName(p), jobTitle: p.jobTitle } : null };
    });
  }

  private async load(user: AuthUser, id: Id) {
    const a = (await this.db.appraisals.findOne({ _id: id, organisationId: user.organisationId }).lean()) as AppraisalDoc | null;
    if (!a) throw new NotFoundException('Appraisal not found');
    return a;
  }

  /** The supervisor (or HR) sets the weighted targets for the cycle; the weights add up to 100. */
  async setTargets(user: AuthUser, input: { cycleId: Id; employeeId: Id; targets: { perspective: Perspective; objective: string; measure?: string; target?: string; weight: number }[] }) {
    const cycle = await this.db.appraisalCycles.findOne({ _id: input.cycleId, organisationId: user.organisationId }).lean();
    if (!cycle) throw new NotFoundException('Cycle not found');
    if (cycle.status !== 'OPEN') throw new BadRequestException('The cycle is closed');
    const e = await this.db.employees.findOne({ _id: input.employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    await this.assertAppraiser(user, e);
    if (!input.targets.length) throw new BadRequestException('Set at least one target');
    if (input.targets.reduce((a, t) => a + t.weight, 0) !== 100) throw new BadRequestException('Target weights must add up to 100');
    const missing = BSC_PERSPECTIVES.filter((p) => !input.targets.some((t) => t.perspective === p));
    if (missing.length) throw new BadRequestException(`Every perspective needs a target; missing: ${missing.join(', ')}`);
    const existing = await this.db.appraisals.findOne({ organisationId: user.organisationId, cycleId: cycle._id, employeeId: e._id }).lean();
    if (existing && existing.status !== 'TARGETS_SET') throw new BadRequestException('The targets have been agreed; they can no longer change');
    const doc = await this.db.appraisals.findOneAndUpdate(
      { organisationId: user.organisationId, cycleId: cycle._id, employeeId: e._id },
      { $set: { departmentId: e.departmentId ?? null, appraiserId: user.id, targets: input.targets, status: 'TARGETS_SET' } },
      { upsert: true, new: true },
    ).lean();
    await this.audit.record(user, 'hr.appraisal.targets', 'hrAppraisal', doc!._id, { employee: e.employeeNo, targets: input.targets.length });
    if (e.userId) await this.notify(user.organisationId, [e.userId], { title: `Your ${cycle.name} targets are ready to agree`, link: '/hr/me' });
    return doc;
  }

  async mine(user: AuthUser) {
    const e = await this.self(user);
    const rows = await this.db.appraisals.find({ organisationId: user.organisationId, employeeId: e._id }).sort({ createdAt: -1 }).limit(10).lean();
    const cycles = await this.db.appraisalCycles.find({ _id: { $in: rows.map((r) => r.cycleId) } }, { name: 1 }).lean();
    return rows.map((r) => ({ ...r, cycle: cycles.find((c) => c._id.equals(r.cycleId))?.name ?? '' }));
  }

  private async own(user: AuthUser, id: Id) {
    const e = await this.self(user);
    const a = await this.load(user, id);
    if (!a.employeeId.equals(e._id)) throw new NotFoundException('Appraisal not found');
    return a;
  }

  async agree(user: AuthUser, id: Id) {
    const a = await this.own(user, id);
    if (a.status !== 'TARGETS_SET') throw new BadRequestException('Nothing to agree');
    await this.db.appraisals.updateOne({ _id: a._id, status: 'TARGETS_SET' }, { status: 'AGREED', agreedAt: new Date() });
    await this.audit.record(user, 'hr.appraisal.agree', 'hrAppraisal', a._id, {});
    return this.load(user, id);
  }

  async selfReview(user: AuthUser, id: Id, ratings: { targetId: Id; rating: number; comment?: string }[]) {
    const a = await this.own(user, id);
    if (a.status !== 'AGREED') throw new BadRequestException('Agree the targets before rating yourself');
    const targets = this.rate(a, ratings, 'self');
    await this.db.appraisals.updateOne({ _id: a._id, status: 'AGREED' }, { targets, status: 'SELF_REVIEWED', selfReviewedAt: new Date() });
    await this.audit.record(user, 'hr.appraisal.self', 'hrAppraisal', a._id, {});
    await this.notify(user.organisationId, [a.appraiserId], { title: 'An appraisal is ready for your review', link: '/hr/performance' });
    return this.load(user, id);
  }

  private rate(a: AppraisalDoc, ratings: { targetId: Id; rating: number; comment?: string }[], who: 'self' | 'supervisor') {
    for (const t of a.targets) if (!ratings.some((r) => r.targetId.equals(t._id))) throw new BadRequestException(`Rate "${t.objective}"`);
    if (ratings.some((r) => r.rating < 1 || r.rating > 5 || !Number.isInteger(r.rating))) throw new BadRequestException('Ratings are whole numbers from 1 to 5');
    return a.targets.map((t) => {
      const r = ratings.find((x) => x.targetId.equals(t._id))!;
      const base = { _id: t._id, perspective: t.perspective, objective: t.objective, measure: t.measure, target: t.target, weight: t.weight, selfRating: t.selfRating, selfComment: t.selfComment, rating: t.rating, comment: t.comment };
      return who === 'self' ? { ...base, selfRating: r.rating, selfComment: r.comment ?? '' } : { ...base, rating: r.rating, comment: r.comment ?? '' };
    });
  }

  /** The supervisor's ratings, overall comment, recommendation and the training the employee needs. */
  async review(user: AuthUser, id: Id, input: { ratings: { targetId: Id; rating: number; comment?: string }[]; comment?: string; recommendation: (typeof RECOMMENDATIONS)[number]; trainingNeeds?: string[] }) {
    const a = await this.load(user, id);
    const e = (await this.db.employees.findById(a.employeeId).lean())!;
    await this.assertAppraiser(user, e);
    if (e.userId?.equals(user.id)) throw new ForbiddenException('You cannot review your own appraisal');
    if (a.status !== 'SELF_REVIEWED') throw new BadRequestException('The employee has not rated themselves yet');
    const targets = this.rate(a, input.ratings, 'supervisor');
    const score = scoreOf(targets);
    await this.db.appraisals.updateOne(
      { _id: a._id, status: 'SELF_REVIEWED' },
      { targets, status: 'REVIEWED', reviewedAt: new Date(), score, grade: gradeOf(score), supervisorComment: input.comment ?? '', recommendation: input.recommendation, trainingNeeds: (input.trainingNeeds ?? []).map((t) => t.trim()).filter(Boolean) },
    );
    await this.audit.record(user, 'hr.appraisal.review', 'hrAppraisal', a._id, { employee: e.employeeNo, score });
    if (e.userId) await this.notify(user.organisationId, [e.userId], { title: `Your appraisal is complete: ${score}% (${gradeOf(score)})`, body: 'You may accept it or appeal within the cycle.', link: '/hr/me' });
    return this.load(user, id);
  }

  async accept(user: AuthUser, id: Id) {
    const a = await this.own(user, id);
    if (a.status !== 'REVIEWED') throw new BadRequestException('There is no review to accept');
    await this.db.appraisals.updateOne({ _id: a._id, status: 'REVIEWED' }, { status: 'CLOSED' });
    return this.load(user, id);
  }

  async appeal(user: AuthUser, id: Id, grounds: string) {
    const a = await this.own(user, id);
    if (a.status !== 'REVIEWED') throw new BadRequestException('Only a reviewed appraisal can be appealed');
    await this.db.appraisals.updateOne({ _id: a._id, status: 'REVIEWED' }, { status: 'APPEALED', appeal: { grounds, lodgedAt: new Date(), originalScore: a.score } });
    await this.audit.record(user, 'hr.appraisal.appeal', 'hrAppraisal', a._id, { grounds });
    return this.load(user, id);
  }

  /** HR decides an appeal, optionally changing ratings; the score is worked out again and the appraisal closed. */
  async decideAppeal(user: AuthUser, id: Id, input: { decision: string; ratings?: { targetId: Id; rating: number; comment?: string }[] }) {
    if (!hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('You may not decide appraisal appeals');
    const a = await this.load(user, id);
    if (a.status !== 'APPEALED') throw new BadRequestException('There is no appeal to decide');
    const e = (await this.db.employees.findById(a.employeeId).lean())!;
    assertInScope(user, e.departmentId);
    if (a.appraiserId.equals(user.id)) throw new ForbiddenException('The appraiser cannot decide the appeal');
    const targets = input.ratings?.length ? this.rate(a, input.ratings, 'supervisor') : a.targets;
    const score = scoreOf(targets);
    await this.db.appraisals.updateOne({ _id: a._id, status: 'APPEALED' }, { targets, score, grade: gradeOf(score), status: 'CLOSED', 'appeal.decision': input.decision, 'appeal.decidedBy': user.id, 'appeal.decidedAt': new Date() });
    await this.audit.record(user, 'hr.appraisal.appeal_decide', 'hrAppraisal', a._id, { from: a.score, to: score });
    if (e.userId) await this.notify(user.organisationId, [e.userId], { title: `Your appraisal appeal was decided: ${score}%`, body: input.decision, link: '/hr/me' });
    return this.load(user, id);
  }

  /** Cycle summary: completion, average score and grade spread by department; rewards and needs. */
  async cycleReport(user: AuthUser, cycleId: Id) {
    const rows = await this.appraisals(user, cycleId);
    const departments = await this.db.departments.find({ organisationId: user.organisationId }, { name: 1 }).lean();
    const scored = rows.filter((r) => r.score !== null && r.score !== undefined);
    const byDept = new Map<string, { department: string; appraisals: number; scored: number; total: number }>();
    for (const r of rows) {
      const k = String(r.departmentId);
      const cur = byDept.get(k) ?? { department: departments.find((d) => d._id.equals(r.departmentId ?? undefined))?.name ?? 'No department', appraisals: 0, scored: 0, total: 0 };
      cur.appraisals++;
      if (r.score != null) {
        cur.scored++;
        cur.total += r.score;
      }
      byDept.set(k, cur);
    }
    const grades: Record<string, number> = {};
    for (const r of scored) grades[r.grade] = (grades[r.grade] ?? 0) + 1;
    return {
      appraisals: rows.length,
      completed: rows.filter((r) => ['REVIEWED', 'CLOSED', 'APPEALED'].includes(r.status)).length,
      averageScore: scored.length ? Math.round((scored.reduce((a, r) => a + r.score!, 0) / scored.length) * 100) / 100 : null,
      grades,
      departments: [...byDept.values()].map((d) => ({ department: d.department, appraisals: d.appraisals, averageScore: d.scored ? Math.round((d.total / d.scored) * 100) / 100 : null })),
      recommendations: scored.filter((r) => r.recommendation !== 'NONE').map((r) => ({ employee: r.employee, recommendation: r.recommendation, score: r.score })),
      trainingNeeds: rows.flatMap((r) => r.trainingNeeds.map((need) => ({ employee: r.employee, need }))),
    };
  }

  // ----- Training ------------------------------------------------------------------------------------

  async trainings(user: AuthUser, year: number) {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year + 1, 0, 1));
    return this.db.trainings.find({ organisationId: user.organisationId, startDate: { $gte: from, $lt: to } }).sort({ startDate: 1 }).lean();
  }

  async saveTraining(user: AuthUser, id: Id | null, input: { title: string; kind: (typeof TRAINING_KINDS)[number]; provider?: string; startDate: Date; endDate: Date; cost: Decimal; mentorId?: Id | null; participantIds: Id[]; needs?: string[] }) {
    if (input.endDate < input.startDate) throw new BadRequestException('The training ends before it starts');
    if (['MENTORSHIP', 'COACHING'].includes(input.kind) && !input.mentorId) throw new BadRequestException('Choose the mentor or coach');
    const people = await this.db.employees.find({ organisationId: user.organisationId, _id: { $in: input.participantIds }, status: 'ACTIVE' }, { departmentId: 1 }).lean();
    if (people.length !== new Set(input.participantIds.map(String)).size) throw new BadRequestException('Participants must be active employees');
    for (const p of people) assertInScope(user, p.departmentId);
    const participants = people.map((p) => ({ employeeId: p._id, departmentId: p.departmentId ?? null }));
    const fields = { title: input.title, kind: input.kind, provider: input.provider ?? '', startDate: input.startDate, endDate: input.endDate, cost: toD128(input.cost), mentorId: input.mentorId ?? null, participants, needs: input.needs ?? [] };
    if (!id) {
      const [doc] = await this.db.trainings.create([{ ...fields, organisationId: user.organisationId, createdBy: user.id }]);
      await this.audit.record(user, 'hr.training.create', 'hrTraining', doc._id, { title: input.title, cost: input.cost.toFixed(2) });
      return doc.toObject();
    }
    const doc = await this.db.trainings.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'PLANNED' }, fields, { new: true }).lean();
    if (!doc) throw new BadRequestException('Only planned trainings can be edited');
    await this.audit.record(user, 'hr.training.update', 'hrTraining', id, { title: input.title });
    return doc;
  }

  /**
   * Approves a planned training against what is left of the year's budget (another person than its
   * author), completes it with attendance, or cancels it.
   */
  async actTraining(user: AuthUser, id: Id, action: 'approve' | 'complete' | 'cancel', attended?: Id[]) {
    const t = (await this.db.trainings.findOne({ _id: id, organisationId: user.organisationId }).lean()) as TrainingDoc | null;
    if (!t) throw new NotFoundException('Training not found');
    if (action === 'approve') {
      if (!hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('You may not approve training');
      if (t.createdBy.equals(user.id)) throw new ForbiddenException('Someone other than its author must approve the training');
      if (t.status !== 'PLANNED') throw new BadRequestException('Only planned training can be approved');
      const budget = await this.budget(user, t.startDate.getUTCFullYear());
      if (budget.budget && dec(t.cost as never).gt(budget.remaining)) throw new BadRequestException(`Only ${budget.remaining.toFixed(2)} of the ${budget.year} training budget is left; this costs ${dec(t.cost as never).toFixed(2)}`);
      await this.db.trainings.updateOne({ _id: t._id, status: 'PLANNED' }, { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() });
      const users = await this.db.employees.find({ _id: { $in: t.participants.map((p) => p.employeeId) }, userId: { $ne: null } }, { userId: 1 }).lean();
      await this.notify(user.organisationId, users.map((u) => u.userId!), { title: `You are booked on ${t.title}, ${t.startDate.toISOString().slice(0, 10)}`, link: '/hr/me' });
    } else if (action === 'complete') {
      if (t.status !== 'APPROVED') throw new BadRequestException('Only approved training can be completed');
      const present = new Set((attended ?? t.participants.map((p) => p.employeeId)).map(String));
      const participants = t.participants.map((p) => ({ ...p, attended: present.has(String(p.employeeId)) }));
      await this.db.trainings.updateOne({ _id: t._id, status: 'APPROVED' }, { status: 'COMPLETED', participants });
    } else {
      if (t.status === 'COMPLETED') throw new BadRequestException('Completed training cannot be cancelled');
      await this.db.trainings.updateOne({ _id: t._id }, { status: 'CANCELLED' });
    }
    await this.audit.record(user, `hr.training.${action}`, 'hrTraining', t._id, {});
    return this.db.trainings.findById(t._id).lean();
  }

  /** A participant's evaluation of a completed training. */
  async evaluate(user: AuthUser, id: Id, input: { rating: number; feedback?: string }) {
    const e = await this.self(user);
    const t = await this.db.trainings.findOne({ _id: id, organisationId: user.organisationId, status: 'COMPLETED', 'participants.employeeId': e._id }).lean();
    if (!t) throw new NotFoundException('Training not found');
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new BadRequestException('Rate it from 1 to 5');
    await this.db.trainings.updateOne({ _id: t._id, 'participants.employeeId': e._id }, { $set: { 'participants.$.rating': input.rating, 'participants.$.feedback': input.feedback ?? '' } });
    return { saved: true };
  }

  async setBudget(user: AuthUser, year: number, amount: Decimal) {
    const s = await hrSettings(this.db, user.organisationId);
    const budgets = [...(s.trainingBudgets ?? []).filter((b) => b.year !== year), { year, amount: toD128(amount) }];
    await this.db.hrSettings.updateOne({ organisationId: user.organisationId }, { trainingBudgets: budgets });
    await this.audit.record(user, 'hr.training.budget', 'hrSettings', null, { year, amount: amount.toFixed(2) });
    return this.budget(user, year);
  }

  /** The year's training budget against approved and completed training, by department. */
  async budget(user: AuthUser, year: number) {
    const s = await hrSettings(this.db, user.organisationId);
    const budget = (s.trainingBudgets ?? []).find((b) => b.year === year);
    const rows = (await this.trainings(user, year)).filter((t) => ['APPROVED', 'COMPLETED'].includes(t.status));
    const committed = sum(rows.map((t) => dec(t.cost as never)));
    const departments = await this.db.departments.find({ organisationId: user.organisationId }, { name: 1 }).lean();
    const byDept = new Map<string, Decimal>();
    for (const t of rows) {
      const share = t.participants.length ? dec(t.cost as never).div(t.participants.length) : new Decimal(0);
      for (const p of t.participants) {
        const name = departments.find((d) => d._id.equals(p.departmentId ?? undefined))?.name ?? 'No department';
        byDept.set(name, (byDept.get(name) ?? new Decimal(0)).plus(share));
      }
    }
    const amount = budget ? dec(budget.amount as never) : null;
    const evaluations = rows.flatMap((t) => t.participants.filter((p) => p.rating)).map((p) => p.rating!);
    return {
      year,
      budget: amount,
      committed,
      remaining: amount ? amount.minus(committed) : new Decimal(0),
      byDepartment: [...byDept.entries()].map(([department, cost]) => ({ department, cost: cost.toDecimalPlaces(2) })),
      trainings: rows.length,
      averageEvaluation: evaluations.length ? Math.round((evaluations.reduce((a, b) => a + b, 0) / evaluations.length) * 10) / 10 : null,
    };
  }

  /** Training needs from appraisals not yet covered by planned or approved training for that employee. */
  async openNeeds(user: AuthUser) {
    const appraisals = await this.db.appraisals.find({ organisationId: user.organisationId, 'trainingNeeds.0': { $exists: true }, ...scopeFilter(user) }, { employeeId: 1, trainingNeeds: 1 }).lean();
    const trainings = await this.db.trainings.find({ organisationId: user.organisationId, status: { $ne: 'CANCELLED' } }, { participants: 1, needs: 1 }).lean();
    const people = await this.db.employees.find({ _id: { $in: appraisals.map((a) => a.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean();
    return appraisals.flatMap((a) =>
      a.trainingNeeds
        .filter((need) => !trainings.some((t) => t.participants.some((p) => p.employeeId.equals(a.employeeId)) && t.needs.some((n) => n.toLowerCase() === need.toLowerCase())))
        .map((need) => {
          const p = people.find((x) => x._id.equals(a.employeeId));
          return { employeeId: a.employeeId, employee: p ? `${p.employeeNo} · ${fullName(p)}` : '', need };
        }),
    );
  }

  async myTrainings(user: AuthUser) {
    const e = await this.self(user);
    const rows = await this.db.trainings.find({ organisationId: user.organisationId, 'participants.employeeId': e._id, status: { $ne: 'CANCELLED' } }).sort({ startDate: -1 }).limit(30).lean();
    return rows.map((t) => ({ id: t._id, title: t.title, kind: t.kind, provider: t.provider, startDate: t.startDate, endDate: t.endDate, status: t.status, me: t.participants.find((p) => p.employeeId.equals(e._id)) }));
  }
}

