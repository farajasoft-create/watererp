import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { openPortal } from '@/platform/common/branding';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { dec } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope } from '../access';
import { HrDb as Db } from '../db';
import { EmployeesService } from '../employees/employees.service';
import { ApplicationDoc, QUALIFICATION_LEVELS, VacancyDoc } from '../schemas';

type Id = Types.ObjectId;
type Level = (typeof QUALIFICATION_LEVELS)[number];
const levelRank = (l: string | null | undefined) => (l ? QUALIFICATION_LEVELS.indexOf(l as Level) : -1);

/** What a new starter needs, and who sees to it. */
export const ONBOARDING_TASKS: { task: string; owner: string }[] = [
  { task: 'Letter of appointment issued and acceptance received', owner: 'HR' },
  { task: 'Personnel file opened with certificates, ID and appointment letter', owner: 'HR' },
  { task: 'Bank, KRA PIN, NSSF and SHA details captured', owner: 'Payroll' },
  { task: 'Office space and working tools assigned', owner: 'Department' },
  { task: 'ICT account and email address created', owner: 'ICT' },
  { task: 'Staff ID card issued', owner: 'HR' },
  { task: 'Induction completed', owner: 'HR' },
];

export interface VacancyInput {
  title: string;
  departmentId: Id;
  jobGroupId?: Id | null;
  positions: number;
  employmentType: 'PERMANENT' | 'CONTRACT' | 'CASUAL' | 'INTERN';
  description?: string;
  requirements?: string;
  minimumLevel?: Level | null;
  minimumExperience?: number;
  closingDate: Date;
  internalOnly?: boolean;
  establishmentNote?: string;
  panel?: Id[];
  shortlistOfficers?: Id[];
}

export interface ApplicationInput {
  name: string;
  email: string;
  phone: string;
  nationalId: string;
  gender?: 'MALE' | 'FEMALE' | null;
  dateOfBirth?: Date | null;
  county?: string;
  disability?: boolean;
  highestLevel: Level;
  qualifications?: { level: string; title: string; institution?: string; year?: number | null }[];
  experienceYears: number;
  coverLetter?: string;
}

/**
 * Recruitment: a vacancy is raised against the establishment, approved by someone else and published
 * on the public jobs page; applications are shortlisted against the minimum requirements, the panel
 * scores those interviewed, and appointing the best opens the employee's record and personnel file with
 * the onboarding checklist.
 */
export class RecruitmentService {
  /** Email and SMS to an applicant or candidate; wired in the container. */
  tell: (organisationId: Id, to: { email: string; phone: string }, subject: string, text: string, purpose: string, sourceId?: Id) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  private async vacancy(user: AuthUser, id: Id) {
    const v = (await this.db.vacancies.findOne({ _id: id, organisationId: user.organisationId }).lean()) as VacancyDoc | null;
    if (!v) throw new NotFoundException('Vacancy not found');
    assertInScope(user, v.departmentId);
    return v;
  }

  async list(user: AuthUser, status?: string) {
    const rows = await this.db.vacancies.find({ organisationId: user.organisationId, ...(status && { status }) }).sort({ createdAt: -1 }).limit(300).lean();
    const counts = await this.db.applications.aggregate<{ _id: { v: Id; s: string }; n: number }>([{ $match: { organisationId: user.organisationId, vacancyId: { $in: rows.map((r) => r._id) } } }, { $group: { _id: { v: '$vacancyId', s: '$status' }, n: { $sum: 1 } } }]);
    return rows.map((v) => {
      const mine = counts.filter((c) => c._id.v.equals(v._id));
      return { ...v, applications: mine.reduce((a, c) => a + c.n, 0), shortlisted: mine.filter((c) => ['SHORTLISTED', 'INTERVIEWED', 'APPOINTED'].includes(c._id.s)).reduce((a, c) => a + c.n, 0), appointed: mine.find((c) => c._id.s === 'APPOINTED')?.n ?? 0 };
    });
  }

  async get(user: AuthUser, id: Id) {
    const v = await this.vacancy(user, id);
    const [applications, room] = await Promise.all([this.db.applications.find({ organisationId: user.organisationId, vacancyId: v._id }).sort({ createdAt: 1 }).lean(), this.vacantPosts(user.organisationId, v)]);
    return { ...v, vacantPosts: room, applications: applications.map((a) => ({ ...a, averageScore: average(a) })) };
  }

  /** Authorised posts still vacant for the vacancy's department and job group (null: no establishment set). */
  private async vacantPosts(organisationId: Id, v: Pick<VacancyDoc, 'departmentId' | 'jobGroupId'>) {
    if (!v.jobGroupId) return null;
    const posts = await this.db.establishment.find({ organisationId, departmentId: v.departmentId, jobGroupId: v.jobGroupId }).lean();
    if (!posts.length) return null;
    const inPost = await this.db.employees.countDocuments({ organisationId, departmentId: v.departmentId, jobGroupId: v.jobGroupId, status: { $ne: 'TERMINATED' } });
    return Math.max(posts.reduce((a, p) => a + p.authorised, 0) - inPost, 0);
  }

  async save(user: AuthUser, id: Id | null, input: VacancyInput) {
    assertInScope(user, input.departmentId);
    if (!(await this.db.departments.exists({ _id: input.departmentId, organisationId: user.organisationId }))) throw new BadRequestException('Department not found');
    if (input.jobGroupId && !(await this.db.jobGroups.exists({ _id: input.jobGroupId, organisationId: user.organisationId }))) throw new BadRequestException('Job group not found');
    if (input.positions < 1) throw new BadRequestException('Advertise at least one position');
    const fields = { ...input, jobGroupId: input.jobGroupId ?? null, minimumLevel: input.minimumLevel ?? null, panel: input.panel ?? [], shortlistOfficers: input.shortlistOfficers ?? [] };
    if (!id) {
      const number = `VAC-${String(await this.db.next(user.organisationId, 'hr:vacancy')).padStart(4, '0')}`;
      const [doc] = await this.db.vacancies.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }]);
      await this.audit.record(user, 'hr.vacancy.create', 'hrVacancy', doc._id, { number, title: input.title });
      return doc.toObject();
    }
    const before = await this.vacancy(user, id);
    if (!['DRAFT', 'REJECTED', 'PUBLISHED'].includes(before.status)) throw new BadRequestException(`A ${before.status.toLowerCase()} vacancy cannot be edited`);
    // Once advertised only the text, closing date and panel may change.
    const update = before.status === 'PUBLISHED' ? { description: input.description, requirements: input.requirements, closingDate: input.closingDate, panel: fields.panel, shortlistOfficers: fields.shortlistOfficers } : { ...fields, status: 'DRAFT' };
    const doc = await this.db.vacancies.findOneAndUpdate({ _id: id, status: before.status }, update, { new: true }).lean();
    await this.audit.record(user, 'hr.vacancy.update', 'hrVacancy', id, { number: before.number });
    return doc;
  }

  /** submit → approve (another person; checked against vacant posts) → publish → close; or reject/cancel. */
  async act(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject' | 'publish' | 'close' | 'cancel', reason?: string) {
    const v = await this.vacancy(user, id);
    const set = (from: string[], to: Record<string, unknown>) => this.db.vacancies.findOneAndUpdate({ _id: v._id, status: { $in: from } }, to, { new: true }).lean();
    let after;
    if (action === 'submit') after = await set(['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedAt: new Date() });
    else if (action === 'approve' || action === 'reject') {
      if (!hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('You may not approve vacancies');
      if (v.createdBy.equals(user.id)) throw new ForbiddenException('Someone other than the requester must decide');
      if (action === 'reject') {
        if (!reason?.trim()) throw new BadRequestException('Give the reason');
        after = await set(['SUBMITTED'], { status: 'REJECTED', rejectionReason: reason });
      } else {
        const room = await this.vacantPosts(user.organisationId, v);
        if (room !== null && v.positions > room && !v.establishmentNote.trim()) throw new BadRequestException(`Only ${room} authorised post${room === 1 ? ' is' : 's are'} vacant; explain the extra positions in the establishment note`);
        after = await set(['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() });
      }
    } else if (action === 'publish') {
      if (v.closingDate < new Date(new Date().toISOString().slice(0, 10))) throw new BadRequestException('The closing date has passed');
      after = await set(['APPROVED'], { status: 'PUBLISHED', publishedAt: new Date() });
    } else if (action === 'close') after = await set(['PUBLISHED'], { status: 'CLOSED' });
    else after = await set(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED', 'CLOSED'], { status: 'CANCELLED' });
    if (!after) throw new BadRequestException(`A ${v.status.toLowerCase()} vacancy cannot be ${action === 'submit' ? 'submitted' : `${action}${action.endsWith('e') ? 'd' : 'ed'}`}`);
    await this.audit.record(user, `hr.vacancy.${action}`, 'hrVacancy', v._id, { number: v.number, reason });
    return after;
  }

  // ----- The public jobs page ---------------------------------------------------------------------

  private async org(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase(), modules: 'hr' }, { name: 1 }).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  /** Open, public vacancies of an organisation. */
  async openings(code: string) {
    const org = await this.org(code);
    const branding = await openPortal(this.db.connection, org._id, 'jobs');
    const today = new Date(new Date().toISOString().slice(0, 10));
    const rows = await this.db.vacancies.find({ organisationId: org._id, status: 'PUBLISHED', internalOnly: false, closingDate: { $gte: today } }).sort({ closingDate: 1 }).lean();
    const departments = await this.db.departments.find({ organisationId: org._id }, { name: 1 }).lean();
    return {
      organisation: org.name,
      branding,
      vacancies: rows.map((v) => ({ id: v._id, number: v.number, title: v.title, department: departments.find((d) => d._id.equals(v.departmentId))?.name ?? '', positions: v.positions, employmentType: v.employmentType, description: v.description, requirements: v.requirements, minimumLevel: v.minimumLevel, minimumExperience: v.minimumExperience, closingDate: v.closingDate })),
    };
  }

  /** An application from the jobs page; one per person (ID number) per vacancy. */
  async apply(code: string, vacancyId: Id, input: ApplicationInput) {
    const org = await this.org(code);
    await openPortal(this.db.connection, org._id, 'jobs');
    const v = await this.db.vacancies.findOne({ _id: vacancyId, organisationId: org._id, status: 'PUBLISHED', internalOnly: false }).lean();
    if (!v) throw new NotFoundException('This vacancy is not open');
    if (v.closingDate < new Date(new Date().toISOString().slice(0, 10))) throw new BadRequestException('Applications for this vacancy have closed');
    return this.receive(org._id, v as VacancyDoc, input, null);
  }

  /** HR records an application received on paper or by email. */
  async record(user: AuthUser, vacancyId: Id, input: ApplicationInput) {
    const v = await this.vacancy(user, vacancyId);
    if (!['PUBLISHED', 'CLOSED'].includes(v.status)) throw new BadRequestException('The vacancy is not advertised');
    return this.receive(user.organisationId, v, input, user);
  }

  private async receive(organisationId: Id, v: VacancyDoc, input: ApplicationInput, user: AuthUser | null, extra: { applicantId?: Id; archivedProfile?: unknown } = {}) {
    const reference = `${v.number}-${String(await this.db.next(organisationId, `hr:application:${v._id}`)).padStart(4, '0')}`;
    try {
      const [doc] = await this.db.applications.create([{ ...input, ...extra, email: input.email.toLowerCase(), organisationId, vacancyId: v._id, reference }]);
      if (user) await this.audit.record(user, 'hr.application.record', 'hrApplication', doc._id, { reference });
      const summary = `Vacancy: ${v.title} (${v.number}). Name: ${input.name}. ID: ${input.nationalId}. Highest level: ${input.highestLevel}. Experience: ${input.experienceYears} years. Tracking number: ${reference}. Keep it to follow your application.`;
      await this.tell(organisationId, { email: input.email, phone: input.phone }, `Application received: ${reference}`, summary, 'hr:application:received', doc._id);
      await this.db.applications.updateOne({ _id: doc._id }, { $push: { notices: { at: new Date(), kind: 'RECEIVED', email: true, sms: true } } });
      return { reference, status: doc.status };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('You have already applied for this vacancy');
      throw err;
    }
  }

  /** Where an applicant's application stands, by reference and ID number. */
  async status(code: string, reference: string, nationalId: string) {
    const org = await this.org(code);
    const a = await this.db.applications.findOne({ organisationId: org._id, reference: reference.toUpperCase(), nationalId }, { status: 1, interviewAt: 1, vacancyId: 1 }).lean();
    if (!a) throw new NotFoundException('No application matches that reference and ID number');
    const v = await this.db.vacancies.findById(a.vacancyId, { title: 1 }).lean();
    return { vacancy: v?.title ?? '', status: a.status === 'NOT_SHORTLISTED' ? 'REGRET' : a.status, interviewAt: a.status === 'SHORTLISTED' ? a.interviewAt : null };
  }

  // ----- Selection --------------------------------------------------------------------------------

  /**
   * Shortlists applications that meet the vacancy's minimum qualification and experience and regrets
   * the rest. Re-running after the deadline catches late entries; decisions already taken are kept.
   */
  async shortlist(user: AuthUser, id: Id, input: { interviewAt?: Date | null }) {
    const v = await this.vacancy(user, id);
    if (v.status !== 'CLOSED') throw new BadRequestException('Close the vacancy before shortlisting');
    const pending = await this.db.applications.find({ organisationId: user.organisationId, vacancyId: v._id, status: 'RECEIVED' }).lean();
    let shortlisted = 0;
    for (const a of pending) {
      const gaps = [levelRank(a.highestLevel) < levelRank(v.minimumLevel) && `below ${v.minimumLevel}`, a.experienceYears < (v.minimumExperience ?? 0) && `under ${v.minimumExperience} years' experience`].filter(Boolean);
      await this.db.applications.updateOne({ _id: a._id, status: 'RECEIVED' }, { status: gaps.length ? 'NOT_SHORTLISTED' : 'SHORTLISTED', shortlistNote: gaps.join('; '), ...(!gaps.length && { shortlistedAt: new Date(), ...(input.interviewAt && { interviewAt: input.interviewAt }) }) });
      if (!gaps.length) shortlisted++;
    }
    await this.audit.record(user, 'hr.vacancy.shortlist', 'hrVacancy', v._id, { shortlisted, regretted: pending.length - shortlisted });
    return { shortlisted, notShortlisted: pending.length - shortlisted };
  }

  /** A panel member's interview score (out of 100) for a shortlisted candidate. */
  async score(user: AuthUser, applicationId: Id, input: { score: number; comment?: string }) {
    const a = (await this.db.applications.findOne({ _id: applicationId, organisationId: user.organisationId }).lean()) as ApplicationDoc | null;
    if (!a) throw new NotFoundException('Application not found');
    const v = await this.vacancy(user, a.vacancyId);
    if (!v.panel.some((p) => p.equals(user.id))) throw new ForbiddenException('Only the interview panel scores candidates');
    if (!['SHORTLISTED', 'INTERVIEWED'].includes(a.status)) throw new BadRequestException('Only shortlisted candidates are interviewed');
    if (input.score < 0 || input.score > 100) throw new BadRequestException('Scores are out of 100');
    const me = await this.db.users.findById(user.id, { name: 1 }).lean();
    const scores = [...a.scores.filter((s) => !s.userId.equals(user.id)), { userId: user.id, name: me?.name ?? '', score: input.score, comment: input.comment ?? '', at: new Date() }];
    await this.db.applications.updateOne({ _id: a._id }, { scores, status: 'INTERVIEWED' });
    await this.audit.record(user, 'hr.application.score', 'hrApplication', a._id, { reference: a.reference, score: input.score });
    return { ...a, scores, status: 'INTERVIEWED', averageScore: average({ scores }) };
  }

  /**
   * Appoints a candidate: creates the employee (on the vacancy's grade, first notch) with their
   * qualifications and the onboarding checklist, regrets the others once all positions are filled.
   */
  async appoint(user: AuthUser, applicationId: Id, input: { hireDate: Date; jobTitle?: string; notch?: number | null; employeeNo?: string }) {
    const a = (await this.db.applications.findOne({ _id: applicationId, organisationId: user.organisationId }).lean()) as ApplicationDoc | null;
    if (!a) throw new NotFoundException('Application not found');
    const v = await this.vacancy(user, a.vacancyId);
    if (!['INTERVIEWED', 'SELECTED', 'OFFERED'].includes(a.status)) throw new BadRequestException('Only interviewed candidates can be appointed');
    if (!hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('You may not make appointments');
    const appointed = await this.db.applications.countDocuments({ vacancyId: v._id, status: 'APPOINTED' });
    if (appointed >= v.positions) throw new BadRequestException('All positions on this vacancy are filled');
    const [first, ...rest] = a.name.trim().split(/\s+/);
    const group = v.jobGroupId ? await this.db.jobGroups.findById(v.jobGroupId).lean() : null;
    const pay = group?.notches.length && hasPermission(user, P.SALARY_MANAGE) ? { basicSalary: dec(0), payMethod: 'BANK' as const, exempt: { paye: false, nssf: false, shif: false, ahl: false }, jobGroupId: group._id, notch: input.notch ?? 1 } : undefined;
    const employee = await this.employees.create(
      user,
      {
        employeeNo: input.employeeNo,
        firstName: first,
        lastName: rest.pop() ?? first,
        otherNames: rest.join(' ') || undefined,
        gender: a.gender ?? null,
        dateOfBirth: a.dateOfBirth ?? null,
        nationalId: a.nationalId,
        phone: a.phone,
        email: a.email,
        departmentId: v.departmentId,
        jobTitle: input.jobTitle ?? v.title,
        employmentType: v.employmentType as 'PERMANENT',
        hireDate: input.hireDate,
        qualifications: a.qualifications.map((q) => ({ level: q.level, title: q.title, institution: q.institution ?? undefined, year: q.year ?? null })),
      },
      pay,
    );
    await this.db.employees.updateOne({ _id: employee._id }, { $set: { applicationId: a._id, onboarding: ONBOARDING_TASKS.map((t) => ({ ...t, done: false })) } });
    await this.db.applications.updateOne({ _id: a._id }, { status: 'APPOINTED', employeeId: employee._id });
    if (appointed + 1 >= v.positions) {
      await this.db.applications.updateMany({ vacancyId: v._id, status: { $in: ['RECEIVED', 'SHORTLISTED', 'INTERVIEWED', 'SELECTED'] } }, { status: 'REGRET' });
      await this.db.vacancies.updateOne({ _id: v._id }, { status: 'FILLED' });
    }
    await this.audit.record(user, 'hr.application.appoint', 'hrApplication', a._id, { reference: a.reference, employeeNo: employee.employeeNo });
    return { employeeId: employee._id, employeeNo: employee.employeeNo };
  }

  /** Ticks off (or reopens) a new starter's onboarding task. */
  async onboardingTask(user: AuthUser, employeeId: Id, taskId: Id, input: { done: boolean; note?: string }) {
    const e = await this.db.employees.findOne({ _id: employeeId, organisationId: user.organisationId }, { departmentId: 1, onboarding: 1 }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    assertInScope(user, e.departmentId);
    const res = await this.db.employees.updateOne(
      { _id: e._id, 'onboarding._id': taskId },
      { $set: { 'onboarding.$.done': input.done, 'onboarding.$.doneBy': input.done ? user.id : null, 'onboarding.$.doneAt': input.done ? new Date() : null, 'onboarding.$.note': input.note ?? '' } },
    );
    if (!res.matchedCount) throw new NotFoundException('Task not found');
    await this.audit.record(user, 'hr.onboarding.task', 'hrEmployee', e._id, { taskId, done: input.done });
    return (await this.db.employees.findById(e._id, { onboarding: 1 }).lean())!.onboarding;
  }

  /** A registered applicant applies with their saved profile, which is archived with the application. */
  async applyAsApplicant(applicant: { _id: Id; organisationId: Id; name: string; email: string; phone: string; nationalId: string; profile?: Record<string, unknown> | null }, code: string, vacancyId: Id, coverLetter?: string) {
    const org = await this.org(code);
    if (!applicant.organisationId.equals(org._id)) throw new NotFoundException('Account not found');
    const v = await this.db.vacancies.findOne({ _id: vacancyId, organisationId: org._id, status: 'PUBLISHED', internalOnly: false }).lean();
    if (!v) throw new NotFoundException('This vacancy is not open');
    if (v.closingDate < new Date(new Date().toISOString().slice(0, 10))) throw new BadRequestException('Applications for this vacancy have closed');
    const p = (applicant.profile ?? {}) as { gender?: 'MALE' | 'FEMALE' | null; dateOfBirth?: Date | null; county?: string; disability?: boolean; highestLevel?: Level | null; experienceYears?: number; qualifications?: ApplicationInput['qualifications'] };
    if (!p.highestLevel) throw new BadRequestException('Add your highest qualification to your profile first');
    const input: ApplicationInput = { name: applicant.name, email: applicant.email, phone: applicant.phone, nationalId: applicant.nationalId, gender: p.gender ?? null, dateOfBirth: p.dateOfBirth ?? null, county: p.county ?? '', disability: Boolean(p.disability), highestLevel: p.highestLevel, qualifications: (p.qualifications ?? []).map((q) => ({ level: q.level, title: q.title, institution: q.institution ?? undefined, year: q.year ?? null })), experienceYears: p.experienceYears ?? 0, coverLetter };
    return this.receive(org._id, v as VacancyDoc, input, null, { applicantId: applicant._id, archivedProfile: { ...p, name: applicant.name, email: applicant.email, phone: applicant.phone, nationalId: applicant.nationalId, archivedAt: new Date() } });
  }

  /** The long list: every application with what the applicant gave (kept as it was when they applied). */
  async longlist(user: AuthUser, id: Id, format: 'json' | 'csv') {
    const v = await this.vacancy(user, id);
    const rows = await this.db.applications.find({ organisationId: user.organisationId, vacancyId: v._id }).sort({ reference: 1 }).lean();
    await this.audit.record(user, 'hr.vacancy.longlist', 'hrVacancy', v._id, { format, applications: rows.length });
    if (format === 'json') return rows.map((a) => ({ ...a, averageScore: average(a) }));
    return csvResponse(`longlist-${v.number}.csv`, [
      ['Tracking number', 'Name', 'ID number', 'Gender', 'County', 'Disability', 'Highest level', 'Experience (years)', 'Qualifications', 'Phone', 'Email', 'Status', 'Shortlist note', 'Average score', 'Received'],
      ...rows.map((a) => [a.reference, a.name, a.nationalId, a.gender ?? '', a.county, a.disability ? 'Yes' : 'No', a.highestLevel, a.experienceYears, a.qualifications.map((q) => `${q.level} ${q.title}${q.institution ? ` (${q.institution})` : ''}`).join('; '), a.phone, a.email, a.status, a.shortlistNote, average(a) ?? '', (a.createdAt as Date).toISOString().slice(0, 10)]),
    ]);
  }

  /** An appointed shortlisting officer (or an HR approver) shortlists or drops an applicant by hand. */
  async decideShortlist(user: AuthUser, applicationId: Id, input: { shortlist: boolean; note: string }) {
    const a = await this.db.applications.findOne({ _id: applicationId, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Application not found');
    const v = await this.vacancy(user, a.vacancyId);
    const officer = (v.shortlistOfficers ?? []).some((o) => o.equals(user.id));
    if (!officer && !hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('Only the appointed shortlisting officers decide this');
    if (!['RECEIVED', 'SHORTLISTED', 'NOT_SHORTLISTED'].includes(a.status)) throw new BadRequestException('The application is past shortlisting');
    await this.db.applications.updateOne({ _id: a._id }, { status: input.shortlist ? 'SHORTLISTED' : 'NOT_SHORTLISTED', shortlistNote: input.note, shortlistedBy: user.id, shortlistedAt: input.shortlist ? new Date() : null });
    await this.audit.record(user, 'hr.application.shortlist', 'hrApplication', a._id, { reference: a.reference, shortlist: input.shortlist, note: input.note });
    return this.db.applications.findById(a._id).lean();
  }

  /** Invites every shortlisted candidate not yet invited to the interview, by email and SMS. */
  async invite(user: AuthUser, id: Id, input: { interviewAt: Date; venue: string; note?: string }) {
    const v = await this.vacancy(user, id);
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    const rows = await this.db.applications.find({ organisationId: user.organisationId, vacancyId: v._id, status: 'SHORTLISTED', invitedAt: null }).lean();
    const when = input.interviewAt.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'full', timeStyle: 'short' });
    for (const a of rows) {
      await this.tell(user.organisationId, a, `${org?.name ?? ''}: interview invitation for ${v.title}`, `Dear ${a.name}, you are shortlisted for ${v.title} (${a.reference}). Interview: ${when} at ${input.venue}. Bring your national ID and original certificates.${input.note ? ` ${input.note}` : ''}`, 'hr:application:invite', a._id);
      await this.db.applications.updateOne({ _id: a._id }, { invitedAt: new Date(), interviewAt: input.interviewAt, interviewVenue: input.venue, $push: { notices: { at: new Date(), kind: 'INVITED', email: true, sms: true } } });
    }
    await this.audit.record(user, 'hr.vacancy.invite', 'hrVacancy', v._id, { invited: rows.length, interviewAt: input.interviewAt });
    return { invited: rows.length };
  }

  /** HR selects the successful candidate from the interview results; an approver then sends the offer. */
  async select(user: AuthUser, applicationId: Id) {
    const a = await this.db.applications.findOne({ _id: applicationId, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Application not found');
    await this.vacancy(user, a.vacancyId);
    if (a.status !== 'INTERVIEWED') throw new BadRequestException('Select from interviewed candidates');
    await this.db.applications.updateOne({ _id: a._id }, { status: 'SELECTED', selectedBy: user.id });
    await this.audit.record(user, 'hr.application.select', 'hrApplication', a._id, { reference: a.reference, averageScore: average(a) });
    return this.db.applications.findById(a._id).lean();
  }

  /** Approves the selection (someone other than who selected) and sends the offer by email and SMS. */
  async approveOffer(user: AuthUser, applicationId: Id, input: { reportBy: Date; note?: string }) {
    const a = await this.db.applications.findOne({ _id: applicationId, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Application not found');
    const v = await this.vacancy(user, a.vacancyId);
    if (!hasPermission(user, P.CAREER_APPROVE)) throw new ForbiddenException('You may not approve appointments');
    if (a.status !== 'SELECTED') throw new BadRequestException('Select the candidate first');
    if (a.selectedBy?.equals(user.id)) throw new ForbiddenException('Someone other than who selected the candidate must approve the offer');
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    await this.tell(user.organisationId, a, `${org?.name ?? ''}: offer of appointment, ${v.title}`, `Dear ${a.name}, we are pleased to offer you the position of ${v.title} (${a.reference}). Please report to Human Resources by ${input.reportBy.toISOString().slice(0, 10)} with your national ID, KRA PIN, NSSF and SHA numbers, bank details and original certificates.${input.note ? ` ${input.note}` : ''}`, 'hr:application:offer', a._id);
    await this.db.applications.updateOne({ _id: a._id }, { status: 'OFFERED', offerApprovedBy: user.id, offeredAt: new Date(), reportBy: input.reportBy, $push: { notices: { at: new Date(), kind: 'OFFER', email: true, sms: true } } });
    await this.audit.record(user, 'hr.application.offer', 'hrApplication', a._id, { reference: a.reference, reportBy: input.reportBy });
    return this.db.applications.findById(a._id).lean();
  }

  /** Recruitment report: applications by stage, gender, disability and county for each vacancy. */
  async report(user: AuthUser, q: { from: Date; to: Date }) {
    const vacancies = await this.db.vacancies.find({ organisationId: user.organisationId, createdAt: { $gte: q.from, $lte: new Date(q.to.getTime() + 86_400_000) } }).sort({ createdAt: 1 }).lean();
    const apps = await this.db.applications.find({ organisationId: user.organisationId, vacancyId: { $in: vacancies.map((v) => v._id) } }, { vacancyId: 1, status: 1, gender: 1, disability: 1, county: 1, shortlistedAt: 1, scores: 1 }).lean();
    const count = (list: typeof apps, f: (a: (typeof apps)[number]) => boolean) => list.filter(f).length;
    return vacancies.map((v) => {
      const mine = apps.filter((a) => a.vacancyId.equals(v._id));
      const counties = new Map<string, number>();
      for (const a of mine) if (a.county) counties.set(a.county, (counties.get(a.county) ?? 0) + 1);
      return {
        id: v._id,
        number: v.number,
        title: v.title,
        status: v.status,
        positions: v.positions,
        applications: mine.length,
        shortlisted: count(mine, (a) => !!a.shortlistedAt),
        interviewed: count(mine, (a) => a.scores.length > 0),
        appointed: count(mine, (a) => a.status === 'APPOINTED'),
        female: count(mine, (a) => a.gender === 'FEMALE'),
        male: count(mine, (a) => a.gender === 'MALE'),
        withDisability: count(mine, (a) => !!a.disability),
        counties: Object.fromEntries(counties),
      };
    });
  }
}

function average(a: { scores: { score: number }[] }) {
  return a.scores.length ? Math.round((a.scores.reduce((s, x) => s + x.score, 0) / a.scores.length) * 100) / 100 : null;
}
