import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope, scopeFilter } from '../access';
import { fullName, HrDb as Db } from '../db';
import { CAREER_EVENT_KINDS, CareerEventDoc, JobGroupDoc } from '../schemas';

type Id = Types.ObjectId;
type Kind = (typeof CAREER_EVENT_KINDS)[number];
const period = (d: Date) => d.toISOString().slice(0, 7);
const addYears = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()));

export interface JobGroupInput {
  code: string;
  name: string;
  rank: number;
  notches: Decimal[];
  allowances: { code: string; name: string; amount: Decimal; taxable: boolean }[];
  active: boolean;
}

export interface CareerEventInput {
  employeeId: Id;
  kind: Kind;
  effectiveDate: Date;
  endDate?: Date | null;
  departmentId?: Id | null;
  jobGroupId?: Id | null;
  notch?: number | null;
  jobTitle?: string;
  station?: string;
  basicSalary?: Decimal | null;
  actingAllowance?: Decimal | null;
  secondedTo?: string;
  reason: string;
}

/**
 * Organisation structure and careers: job groups with salary scales and grade allowances, the staff
 * establishment (authorised posts) against staff in post, and career events — promotions, transfers,
 * secondments, acting appointments, salary changes and annual increments — requested by HR, approved
 * by someone else, applied to the employee and kept as the job and salary history.
 */
export class StructureService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ----- Job groups ----------------------------------------------------------------------------

  jobGroups(user: AuthUser) {
    return this.db.jobGroups.find({ organisationId: user.organisationId }).sort({ rank: -1, code: 1 }).lean();
  }

  async saveJobGroup(user: AuthUser, id: Id | null, input: JobGroupInput) {
    for (let i = 1; i < input.notches.length; i++) if (input.notches[i].lt(input.notches[i - 1])) throw new BadRequestException('Notches must rise up the scale');
    if (input.notches.some((n) => n.lt(0))) throw new BadRequestException('Notch amounts cannot be negative');
    const codes = new Set<string>();
    for (const a of input.allowances) {
      if (codes.has(a.code)) throw new BadRequestException(`Allowance ${a.code} is listed twice`);
      codes.add(a.code);
    }
    const fields = { ...input, code: input.code.trim().toUpperCase(), notches: input.notches.map((n) => toD128(n)), allowances: input.allowances.map((a) => ({ ...a, code: a.code.toUpperCase(), amount: toD128(a.amount) })) };
    try {
      const doc = id
        ? await this.db.jobGroups.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean()
        : (await this.db.jobGroups.create([{ ...fields, organisationId: user.organisationId }]))[0].toObject();
      if (!doc) throw new NotFoundException('Job group not found');
      await this.audit.record(user, id ? 'hr.jobgroup.update' : 'hr.jobgroup.create', 'hrJobGroup', doc._id, { code: fields.code, notches: input.notches.map((n) => n.toFixed(2)) });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Job group ${fields.code} already exists`);
      throw err;
    }
  }

  /** Pay at a notch of a job group's scale, or null when the group has no scale. */
  static scalePay(group: Pick<JobGroupDoc, 'notches'> | null | undefined, notch: number | null | undefined) {
    if (!group?.notches.length || !notch) return null;
    if (notch < 1 || notch > group.notches.length) throw new BadRequestException(`The scale has notches 1 to ${group.notches.length}`);
    return dec(group.notches[notch - 1] as never);
  }

  // ----- Establishment -------------------------------------------------------------------------

  async saveEstablishment(user: AuthUser, rows: { departmentId: Id; jobGroupId: Id; designation: string; authorised: number }[]) {
    const ops = rows.map((r) => ({
      updateOne: {
        filter: { organisationId: user.organisationId, departmentId: r.departmentId, jobGroupId: r.jobGroupId, designation: r.designation.trim() },
        update: { $set: { authorised: r.authorised } },
        upsert: true,
      },
    }));
    if (ops.length) await this.db.establishment.bulkWrite(ops);
    await this.db.establishment.deleteMany({ organisationId: user.organisationId, authorised: 0 });
    await this.audit.record(user, 'hr.establishment.update', 'hrEstablishment', null, { rows: rows.length });
    return this.establishment(user);
  }

  /**
   * Authorised posts against staff in post, by department and job group: vacancies, over-establishment
   * and acting appointments. Staff with a grade that has no authorised post show as unestablished.
   */
  async establishment(user: AuthUser) {
    const org = user.organisationId;
    const [posts, groups, departments, staff, acting] = await Promise.all([
      this.db.establishment.find({ organisationId: org }).lean(),
      this.db.jobGroups.find({ organisationId: org }).lean(),
      this.db.departments.find({ organisationId: org }).lean(),
      this.db.employees.find({ organisationId: org, status: { $ne: 'TERMINATED' }, ...scopeFilter(user) }, { departmentId: 1, jobGroupId: 1 }).lean(),
      this.db.careerEvents.find({ organisationId: org, kind: 'ACTING', status: 'APPROVED', $or: [{ endDate: null }, { endDate: { $gte: new Date() } }] }, { to: 1 }).lean(),
    ]);
    const key = (d: unknown, g: unknown) => `${d ?? ''}|${g ?? ''}`;
    const inPost = new Map<string, number>();
    for (const e of staff) inPost.set(key(e.departmentId, e.jobGroupId), (inPost.get(key(e.departmentId, e.jobGroupId)) ?? 0) + 1);
    const actingBy = new Map<string, number>();
    for (const a of acting) actingBy.set(key(a.to.departmentId, a.to.jobGroupId), (actingBy.get(key(a.to.departmentId, a.to.jobGroupId)) ?? 0) + 1);
    const authorised = new Map<string, { designations: string[]; count: number }>();
    for (const p of posts) {
      const k = key(p.departmentId, p.jobGroupId);
      const cur = authorised.get(k) ?? { designations: [], count: 0 };
      cur.designations.push(`${p.designation} (${p.authorised})`);
      cur.count += p.authorised;
      authorised.set(k, cur);
    }
    const keys = new Set([...authorised.keys(), ...inPost.keys()]);
    const rows = [...keys].map((k) => {
      const [d, g] = k.split('|');
      const dept = departments.find((x) => x._id.toHexString() === d);
      const group = groups.find((x) => x._id.toHexString() === g);
      const a = authorised.get(k)?.count ?? 0;
      const n = inPost.get(k) ?? 0;
      return { departmentId: dept?._id ?? null, department: dept?.name ?? 'No department', jobGroupId: group?._id ?? null, jobGroup: group?.code ?? 'No job group', rank: group?.rank ?? -1, designations: authorised.get(k)?.designations ?? [], authorised: a, inPost: n, vacant: Math.max(a - n, 0), over: Math.max(n - a, 0), acting: actingBy.get(k) ?? 0 };
    });
    rows.sort((x, y) => x.department.localeCompare(y.department) || y.rank - x.rank);
    const total = (k: 'authorised' | 'inPost' | 'vacant' | 'over') => rows.reduce((s, r) => s + r[k], 0);
    return { rows, totals: { authorised: total('authorised'), inPost: total('inPost'), vacant: total('vacant'), over: total('over') } };
  }

  // ----- Career events -------------------------------------------------------------------------

  async history(user: AuthUser, employeeId: Id) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    const events = await this.db.careerEvents.find({ organisationId: user.organisationId, employeeId }).sort({ effectiveDate: -1, createdAt: -1 }).lean();
    return events.map((ev) => (hasPermission(user, P.SALARY_VIEW) ? ev : { ...ev, from: { ...ev.from, basicSalary: null }, to: { ...ev.to, basicSalary: null }, actingAllowance: null }));
  }

  async pending(user: AuthUser) {
    const events = await this.db.careerEvents.find({ organisationId: user.organisationId, status: 'PENDING' }).sort({ effectiveDate: 1 }).lean();
    const employees = await this.db.employees.find({ _id: { $in: events.map((e) => e.employeeId) }, ...scopeFilter(user) }, { firstName: 1, lastName: 1, otherNames: 1, employeeNo: 1 }).lean();
    return events.filter((e) => employees.some((x) => x._id.equals(e.employeeId))).map((e) => {
      const emp = employees.find((x) => x._id.equals(e.employeeId))!;
      return { ...e, employee: { id: emp._id, employeeNo: emp.employeeNo, name: fullName(emp) } };
    });
  }

  async request(user: AuthUser, input: CareerEventInput) {
    const e = await this.db.employees.findOne({ _id: input.employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    if (e.status === 'TERMINATED') throw new BadRequestException('The employee has left');
    assertInScope(user, e.departmentId);
    if (await this.db.careerEvents.exists({ organisationId: user.organisationId, employeeId: e._id, status: 'PENDING' })) throw new BadRequestException('A change for this employee is already awaiting approval');
    const touchesPay = input.basicSalary !== undefined || input.notch !== undefined || input.jobGroupId !== undefined || input.actingAllowance !== undefined;
    if (touchesPay && !hasPermission(user, P.SALARY_MANAGE) && input.kind !== 'TRANSFER') throw new ForbiddenException('You may not change pay');
    if (['ACTING', 'SECONDMENT'].includes(input.kind) && !input.endDate) throw new BadRequestException('Give the end date of the acting appointment or secondment');
    if (input.endDate && input.endDate <= input.effectiveDate) throw new BadRequestException('The end date must be after the start');
    if (input.kind === 'SECONDMENT' && !input.secondedTo?.trim()) throw new BadRequestException('Say where the employee is seconded to');
    if (input.kind === 'ACTING' && !input.actingAllowance) throw new BadRequestException('Give the acting allowance');
    if (input.departmentId) assertInScope(user, input.departmentId);

    const from = { departmentId: e.departmentId ?? null, jobGroupId: e.jobGroupId ?? null, notch: e.notch ?? null, jobTitle: e.jobTitle ?? '', station: e.station ?? '', basicSalary: e.basicSalary ?? null };
    const to = { ...from };
    if (input.departmentId !== undefined) to.departmentId = input.departmentId;
    if (input.jobTitle !== undefined) to.jobTitle = input.jobTitle;
    if (input.station !== undefined) to.station = input.station;
    // An acting appointment is to a post: grade and title change only while acting, so pay stays put.
    if (input.kind !== 'ACTING') {
      if (input.jobGroupId !== undefined) to.jobGroupId = input.jobGroupId;
      if (input.notch !== undefined) to.notch = input.notch;
    }
    const group = to.jobGroupId ? await this.db.jobGroups.findOne({ _id: to.jobGroupId, organisationId: user.organisationId }).lean() : null;
    if (to.jobGroupId && !group) throw new BadRequestException('Job group not found');
    if (input.kind === 'INCREMENT') {
      if (!group?.notches.length || !from.notch) throw new BadRequestException('Increments need the employee on a job group scale');
      if (from.notch >= group.notches.length) throw new BadRequestException('The employee is at the top of the scale');
      to.notch = from.notch + 1;
    }
    if (input.kind === 'PROMOTION' || input.kind === 'DEMOTION') {
      const before = from.jobGroupId ? await this.db.jobGroups.findById(from.jobGroupId).lean() : null;
      if (!group || (before && (input.kind === 'PROMOTION' ? group.rank <= before.rank : group.rank >= before.rank))) throw new BadRequestException(`A ${input.kind.toLowerCase()} moves the employee to a ${input.kind === 'PROMOTION' ? 'higher' : 'lower'} job group`);
      if (to.notch === from.notch && from.jobGroupId && !input.notch) to.notch = 1;
    }
    const pay = input.kind === 'ACTING' ? null : StructureService.scalePay(group, to.notch);
    if (input.basicSalary !== undefined && input.basicSalary !== null) to.basicSalary = toD128(input.basicSalary);
    else if (pay) to.basicSalary = toD128(pay);
    if (input.kind === 'SALARY_CHANGE' && input.basicSalary == null) throw new BadRequestException('Give the new basic salary');
    if (input.kind === 'TRANSFER' && String(to.departmentId) === String(from.departmentId) && to.station === from.station) throw new BadRequestException('A transfer changes the department or duty station');

    const [doc] = await this.db.careerEvents.create([
      {
        organisationId: user.organisationId,
        employeeId: e._id,
        kind: input.kind,
        effectiveDate: input.effectiveDate,
        endDate: input.endDate ?? null,
        from,
        to,
        actingAllowance: input.actingAllowance ? toD128(input.actingAllowance) : null,
        secondedTo: input.secondedTo ?? '',
        reason: input.reason,
        requestedBy: user.id,
      },
    ]);
    await this.audit.record(user, 'hr.career.request', 'hrCareerEvent', doc._id, { employee: e.employeeNo, kind: input.kind, reason: input.reason });
    return doc.toObject();
  }

  /** Approves (applying it to the employee) or rejects a career event; the requester cannot decide. */
  async decide(user: AuthUser, id: Id, approve: boolean, note?: string) {
    const ev = (await this.db.careerEvents.findOne({ _id: id, organisationId: user.organisationId }).lean()) as CareerEventDoc | null;
    if (!ev) throw new NotFoundException('Career event not found');
    if (ev.status !== 'PENDING') throw new BadRequestException('This change has already been decided');
    if (ev.requestedBy.equals(user.id)) throw new ForbiddenException('Someone other than the requester must decide');
    const e = await this.db.employees.findOne({ _id: ev.employeeId, organisationId: user.organisationId }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    if (!approve) {
      if (!note?.trim()) throw new BadRequestException('Give the reason');
      await this.db.careerEvents.updateOne({ _id: ev._id, status: 'PENDING' }, { status: 'REJECTED', decidedBy: user.id, decidedAt: new Date(), decisionNote: note });
      await this.audit.record(user, 'hr.career.reject', 'hrCareerEvent', ev._id, { note });
      return this.db.careerEvents.findById(ev._id).lean();
    }
    return this.db.transaction(async (session) => {
      const res = await this.db.careerEvents.updateOne({ _id: ev._id, status: 'PENDING' }, { status: 'APPROVED', decidedBy: user.id, decidedAt: new Date(), decisionNote: note ?? '' }, { session });
      if (!res.modifiedCount) throw new BadRequestException('This change has already been decided');
      let payItemId: Id | null = null;
      if (ev.kind === 'ACTING') {
        // Paid as an allowance for the months of the acting appointment; the substantive post is unchanged.
        const [item] = await this.db.payItems.create(
          [{ organisationId: user.organisationId, employeeId: e._id, kind: 'EARNING', code: 'ACTING', name: `Acting allowance${ev.to.jobTitle ? ` (${ev.to.jobTitle})` : ''}`, amount: ev.actingAllowance, taxable: true, fromPeriod: period(ev.effectiveDate), toPeriod: period(ev.endDate!), active: true }],
          { session },
        );
        payItemId = item._id;
      } else {
        const group = ev.to.jobGroupId ? await this.db.jobGroups.findById(ev.to.jobGroupId).session(session).lean() : null;
        const set: Record<string, unknown> = { departmentId: ev.to.departmentId, jobGroupId: ev.to.jobGroupId, notch: ev.to.notch, jobTitle: ev.to.jobTitle, station: ev.to.station };
        if (ev.to.basicSalary !== null && ev.to.basicSalary !== undefined) set.basicSalary = ev.to.basicSalary;
        if (['PROMOTION', 'INCREMENT', 'DEMOTION'].includes(ev.kind) && group?.notches.length) set.nextIncrementDate = addYears(ev.effectiveDate, 1);
        await this.db.employees.updateOne({ _id: e._id }, { $set: set }, { session });
      }
      if (payItemId) await this.db.careerEvents.updateOne({ _id: ev._id }, { payItemId }, { session });
      await this.audit.record(user, 'hr.career.approve', 'hrCareerEvent', ev._id, { employee: e.employeeNo, kind: ev.kind }, session);
      return this.db.careerEvents.findById(ev._id).session(session).lean();
    });
  }

  /**
   * Employees due an annual increment by `asOf`: on a scale, below its top notch, with the increment date
   * reached (the anniversary of appointment when none has been set).
   */
  async incrementsDue(user: AuthUser, asOf: Date) {
    const staff = await this.db.employees.find({ organisationId: user.organisationId, status: 'ACTIVE', jobGroupId: { $ne: null }, notch: { $ne: null }, ...scopeFilter(user) }).lean();
    const groups = await this.db.jobGroups.find({ organisationId: user.organisationId }).lean();
    const pending = new Set((await this.db.careerEvents.find({ organisationId: user.organisationId, status: 'PENDING' }, { employeeId: 1 }).lean()).map((p) => p.employeeId.toHexString()));
    return staff
      .map((e) => {
        const g = groups.find((x) => x._id.equals(e.jobGroupId!));
        if (!g?.notches.length || e.notch! >= g.notches.length) return null;
        let due = e.nextIncrementDate ?? null;
        if (!due) {
          due = addYears(e.hireDate, 1);
          while (addYears(due, 1) <= asOf) due = addYears(due, 1);
        }
        if (due > asOf) return null;
        return {
          employeeId: e._id,
          employeeNo: e.employeeNo,
          name: fullName(e),
          jobGroup: g.code,
          notch: e.notch,
          nextNotch: e.notch! + 1,
          dueDate: due,
          currentPay: hasPermission(user, P.SALARY_VIEW) ? (e.basicSalary ?? null) : null,
          newPay: hasPermission(user, P.SALARY_VIEW) ? dec(g.notches[e.notch!] as never) : null,
          pending: pending.has(e._id.toHexString()),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  /** Raises increment requests for the employees chosen from the due list (approved like any change). */
  async requestIncrements(user: AuthUser, input: { employeeIds: Id[]; effectiveDate: Date }) {
    const due = await this.incrementsDue(user, input.effectiveDate);
    const created = [];
    for (const id of input.employeeIds) {
      const d = due.find((x) => x.employeeId.equals(id));
      if (!d || d.pending) continue;
      created.push(await this.request(user, { employeeId: id, kind: 'INCREMENT', effectiveDate: input.effectiveDate, reason: `Annual increment due ${d.dueDate.toISOString().slice(0, 10)}` }));
    }
    return { requested: created.length };
  }

  /** Contracts ending within `days`, for renewal or separation. */
  async contractsEnding(user: AuthUser, days: number) {
    const until = new Date(Date.now() + days * 86_400_000);
    const rows = await this.db.employees.find({ organisationId: user.organisationId, status: 'ACTIVE', contractEndDate: { $ne: null, $lte: until }, ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, contractEndDate: 1, jobTitle: 1, departmentId: 1 }).sort({ contractEndDate: 1 }).lean();
    return rows.map((e) => ({ employeeId: e._id, employeeNo: e.employeeNo, name: fullName(e), jobTitle: e.jobTitle, contractEndDate: e.contractEndDate, ended: e.contractEndDate! < new Date() }));
  }
}

