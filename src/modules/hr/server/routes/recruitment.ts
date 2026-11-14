import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zId } from '@/platform/common/validation';
import { EMPLOYMENT_TYPES, QUALIFICATION_LEVELS, VACANCY_STATUSES } from '../schemas';
import { route } from '../route';
import { APPLICANT_COOKIE } from '../recruitment/applicants.service';

const VacancyBody = z.object({
  title: z.string().trim().min(1).max(150),
  departmentId: zId,
  jobGroupId: zId.nullable().optional(),
  positions: z.number().int().min(1).max(500).default(1),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('PERMANENT'),
  description: z.string().trim().max(10000).optional(),
  requirements: z.string().trim().max(10000).optional(),
  minimumLevel: z.enum(QUALIFICATION_LEVELS).nullable().optional(),
  minimumExperience: z.number().int().min(0).max(50).default(0),
  closingDate: zDate,
  internalOnly: z.boolean().default(false),
  establishmentNote: z.string().trim().max(1000).optional(),
  panel: z.array(zId).max(15).optional(),
  shortlistOfficers: z.array(zId).max(15).optional(),
});

const ApplicationBody = z.object({
  name: z.string().trim().min(3).max(150),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(9).max(20),
  nationalId: z.string().trim().min(5).max(20),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  dateOfBirth: zDate.nullable().optional(),
  county: z.string().trim().max(60).optional(),
  disability: z.boolean().optional(),
  highestLevel: z.enum(QUALIFICATION_LEVELS),
  qualifications: z
    .array(z.object({ level: z.string().trim().min(1).max(60), title: z.string().trim().min(1).max(200), institution: z.string().trim().max(200).optional(), year: z.number().int().min(1950).max(2100).nullable().optional() }))
    .max(15)
    .optional(),
  experienceYears: z.number().int().min(0).max(60),
  coverLetter: z.string().trim().max(5000).optional(),
});

const text = (max: number) => z.string().trim().max(max);
const Password = z.string().min(8, 'At least 8 characters').max(100);
const Code = z.object({ applicantId: zId, code: z.string().trim().regex(/^\d{6}$/, 'Six digits') });
const Profile = z.object({
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  dateOfBirth: zDate.nullable().optional(),
  county: text(60).optional(),
  disability: z.boolean().optional(),
  highestLevel: z.enum(QUALIFICATION_LEVELS).nullable().optional(),
  experienceYears: z.number().int().min(0).max(60).optional(),
  qualifications: z.array(z.object({ level: text(60).min(1), title: text(200).min(1), institution: text(200).optional(), year: z.number().int().min(1950).max(2100).nullable().optional() })).max(15).optional(),
  experience: z.array(z.object({ employer: text(200).min(1), position: text(150).min(1), from: zDate.nullable().optional(), to: zDate.nullable().optional(), duties: text(2000).optional() })).max(20).optional(),
  professional: z.array(z.object({ body: text(200).min(1), membershipNo: text(60).optional(), year: z.number().int().min(1950).max(2100).nullable().optional() })).max(15).optional(),
  referees: z.array(z.object({ name: text(150).min(2), position: text(150).optional(), phone: text(20).optional(), email: text(200).optional() })).max(5).optional(),
  summary: text(3000).optional(),
});
const secure = (req: Request) => new URL(req.url).protocol === 'https:';
const SESSION_SECONDS = 2 * 60 * 60;

export const recruitmentRoutes = [
  route({ method: 'GET', path: '/vacancies', permissions: [P.EMPLOYEE_VIEW], query: z.object({ status: z.enum(VACANCY_STATUSES).optional() }), handler: ({ s, user, query }) => s.recruitment.list(user, query.status) }),
  route({ method: 'GET', path: '/vacancies/:id', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user, params }) => s.recruitment.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/vacancies', permissions: [P.EMPLOYEE_MANAGE], body: VacancyBody, handler: ({ s, user, body }) => s.recruitment.save(user, null, body) }),
  route({ method: 'PATCH', path: '/vacancies/:id', permissions: [P.EMPLOYEE_MANAGE], body: VacancyBody, handler: ({ s, user, params, body }) => s.recruitment.save(user, parseId(params.id), body) }),
  ...(['submit', 'approve', 'reject', 'publish', 'close', 'cancel'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/vacancies/:id/${action}`,
      permissions: [action === 'approve' || action === 'reject' ? P.CAREER_APPROVE : P.EMPLOYEE_MANAGE],
      status: 200,
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      handler: ({ s, user, params, body }) => s.recruitment.act(user, parseId(params.id), action, body.reason),
    }),
  ),
  route({ method: 'POST', path: '/vacancies/:id/applications', permissions: [P.EMPLOYEE_MANAGE], body: ApplicationBody, handler: ({ s, user, params, body }) => s.recruitment.record(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/vacancies/:id/shortlist',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ interviewAt: zDate.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.recruitment.shortlist(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/applications/:id/score',
    permissions: [P.EMPLOYEE_VIEW],
    status: 200,
    body: z.object({ score: z.number().min(0).max(100), comment: z.string().trim().max(1000).optional() }),
    handler: ({ s, user, params, body }) => s.recruitment.score(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/applications/:id/appoint',
    permissions: [P.CAREER_APPROVE],
    body: z.object({ hireDate: zDate, jobTitle: z.string().trim().max(100).optional(), notch: z.number().int().min(1).max(60).nullable().optional(), employeeNo: z.string().trim().max(20).optional() }),
    handler: ({ s, user, params, body }) => s.recruitment.appoint(user, parseId(params.id), body),
  }),
  route({
    method: 'PATCH',
    path: '/employees/:id/onboarding/:taskId',
    permissions: [P.EMPLOYEE_MANAGE],
    body: z.object({ done: z.boolean(), note: z.string().trim().max(300).optional() }),
    handler: ({ s, user, params, body }) => s.recruitment.onboardingTask(user, parseId(params.id), parseId(params.taskId), body),
  }),
  route({
    method: 'GET',
    path: '/people',
    permissions: [P.EMPLOYEE_MANAGE],
    handler: async ({ core, user }) =>
      (await core.db.users.find({ organisationId: user.organisationId, active: true, 'access.module': 'hr' }, { name: 1 }).sort({ name: 1 }).limit(500).lean()).map((u) => ({ id: u._id, name: u.name })),
  }),
  route({ method: 'GET', path: '/reports/recruitment', permissions: [P.REPORTS_VIEW], query: z.object({ from: zDate, to: zDate }), handler: ({ s, user, query }) => s.recruitment.report(user, query) }),

  // The public jobs page.
  route({ method: 'GET', path: '/jobs/:org', public: true, rateLimit: 60, handler: ({ s, params }) => s.recruitment.openings(params.org) }),
  route({ method: 'POST', path: '/jobs/:org/:id/apply', public: true, rateLimit: 10, body: ApplicationBody, handler: ({ s, params, body }) => s.recruitment.apply(params.org, parseId(params.id), body) }),
  route({
    method: 'GET',
    path: '/jobs/:org/status',
    public: true,
    rateLimit: 20,
    query: z.object({ reference: z.string().trim().min(3).max(40), nationalId: z.string().trim().min(5).max(20) }),
    handler: ({ s, params, query }) => s.recruitment.status(params.org, query.reference, query.nationalId),
  }),
  // Selection beyond the automatic shortlist.
  route({ method: 'GET', path: '/vacancies/:id/longlist', permissions: [P.EMPLOYEE_VIEW], query: z.object({ format: z.enum(['json', 'csv']).default('json') }), handler: ({ s, user, params, query }) => s.recruitment.longlist(user, parseId(params.id), query.format) }),
  route({ method: 'POST', path: '/applications/:id/shortlist', permissions: [P.EMPLOYEE_VIEW], status: 200, body: z.object({ shortlist: z.boolean(), note: text(500).min(3) }), handler: ({ s, user, params, body }) => s.recruitment.decideShortlist(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/vacancies/:id/invite', permissions: [P.EMPLOYEE_MANAGE], status: 200, body: z.object({ interviewAt: z.coerce.date(), venue: text(200).min(2), note: text(500).optional() }), handler: ({ s, user, params, body }) => s.recruitment.invite(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/applications/:id/select', permissions: [P.EMPLOYEE_MANAGE], status: 200, handler: ({ s, user, params }) => s.recruitment.select(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/applications/:id/offer', permissions: [P.CAREER_APPROVE], status: 200, body: z.object({ reportBy: zDate, note: text(500).optional() }), handler: ({ s, user, params, body }) => s.recruitment.approveOffer(user, parseId(params.id), body) }),

  // Induction programmes.
  route({ method: 'GET', path: '/inductions', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.induction.list(user) }),
  route({ method: 'GET', path: '/inductions/new-starters', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.induction.newStarters(user) }),
  route({ method: 'GET', path: '/inductions/:id', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user, params }) => s.induction.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/inductions',
    permissions: [P.EMPLOYEE_MANAGE],
    body: z.object({ title: text(150).min(3), startDate: zDate, endDate: zDate, venue: text(200).optional(), participants: z.array(zId).max(500).default([]), sessions: z.array(z.object({ date: zDate.nullable().optional(), time: text(20).optional(), topic: text(200).min(2), departmentId: zId.nullable().optional(), facilitator: text(150).optional() })).max(100).default([]) }),
    handler: ({ s, user, body }) => s.induction.create(user, body),
  }),
  route({ method: 'POST', path: '/inductions/:id/participants', permissions: [P.EMPLOYEE_MANAGE], status: 200, body: z.object({ employeeIds: z.array(zId).min(1).max(500) }), handler: ({ s, user, params, body }) => s.induction.addParticipants(user, parseId(params.id), body.employeeIds) }),
  route({ method: 'POST', path: '/inductions/:id/sessions', permissions: [P.EMPLOYEE_VIEW], status: 200, body: z.object({ date: zDate.nullable().optional(), time: text(20).optional(), topic: text(200).min(2), departmentId: zId.nullable().optional(), facilitator: text(150).optional() }), handler: ({ s, user, params, body }) => s.induction.addSession(user, parseId(params.id), body) }),
  route({ method: 'PUT', path: '/inductions/:id/attendance', permissions: [P.EMPLOYEE_MANAGE], body: z.object({ rows: z.array(z.object({ employeeId: zId, attended: z.boolean() })).max(500) }), handler: ({ s, user, params, body }) => s.induction.attendance(user, parseId(params.id), body.rows) }),
  route({ method: 'POST', path: '/inductions/:id/status', permissions: [P.EMPLOYEE_MANAGE], status: 200, body: z.object({ status: z.enum(['COMPLETED', 'CANCELLED']) }), handler: ({ s, user, params, body }) => s.induction.setStatus(user, parseId(params.id), body.status) }),
  route({ method: 'POST', path: '/inductions/remind', permissions: [P.EMPLOYEE_MANAGE], status: 200, handler: ({ s, user }) => s.induction.remindDue(user.organisationId) }),

  // Applicant accounts on the public jobs page (their own session, never a staff one).
  route({ method: 'POST', path: '/jobs/:org/account/register', public: true, rateLimit: 5, status: 200, body: z.object({ name: text(150).min(3), email: z.string().trim().email().max(200), phone: text(20).min(9), nationalId: text(20).min(5), password: Password }), handler: ({ s, params, body }) => s.applicants.register(params.org, body) }),
  route({
    method: 'POST',
    path: '/jobs/:org/account/verify',
    public: true,
    rateLimit: 10,
    status: 200,
    body: Code,
    handler: async ({ s, params, body, req, setCookie }) => {
      const r = await s.applicants.verifyRegistration(params.org, body);
      setCookie(APPLICANT_COOKIE, r.token, { maxAge: SESSION_SECONDS, httpOnly: true, secure: secure(req) });
      return { name: r.name };
    },
  }),
  route({ method: 'POST', path: '/jobs/:org/account/login', public: true, rateLimit: 10, status: 200, body: z.object({ email: z.string().trim().email(), password: z.string().max(100) }), handler: ({ s, params, body }) => s.applicants.login(params.org, body) }),
  route({
    method: 'POST',
    path: '/jobs/:org/account/login/verify',
    public: true,
    rateLimit: 10,
    status: 200,
    body: Code,
    handler: async ({ s, params, body, req, setCookie }) => {
      const r = await s.applicants.verifyLogin(params.org, body);
      setCookie(APPLICANT_COOKIE, r.token, { maxAge: SESSION_SECONDS, httpOnly: true, secure: secure(req) });
      return { name: r.name };
    },
  }),
  route({ method: 'POST', path: '/jobs/:org/account/logout', public: true, status: 200, handler: ({ req, setCookie }) => { setCookie(APPLICANT_COOKIE, '', { maxAge: 0, httpOnly: true, secure: secure(req) }); return { ok: true }; } }),
  route({ method: 'POST', path: '/jobs/:org/account/forgot', public: true, rateLimit: 5, status: 200, body: z.object({ email: z.string().trim().email() }), handler: ({ s, params, body }) => s.applicants.forgot(params.org, body.email) }),
  route({ method: 'POST', path: '/jobs/:org/account/reset', public: true, rateLimit: 10, status: 200, body: Code.extend({ password: Password }), handler: ({ s, params, body }) => s.applicants.reset(params.org, body) }),
  route({ method: 'GET', path: '/jobs/:org/account/me', public: true, rateLimit: 60, handler: ({ s, params, req }) => s.applicants.me(req, params.org) }),
  route({ method: 'PUT', path: '/jobs/:org/account/profile', public: true, rateLimit: 30, body: z.object({ name: text(150).min(3).optional(), phone: text(20).min(9).optional(), profile: Profile }), handler: ({ s, params, req, body }) => s.applicants.saveProfile(req, params.org, body) }),
  route({ method: 'POST', path: '/jobs/:org/account/deactivate', public: true, rateLimit: 5, status: 200, body: z.object({ password: z.string().max(100) }), handler: async ({ s, params, req, body, setCookie }) => { const r = await s.applicants.deactivate(req, params.org, body.password); setCookie(APPLICANT_COOKIE, '', { maxAge: 0, httpOnly: true, secure: secure(req) }); return r; } }),
  route({
    method: 'POST',
    path: '/jobs/:org/account/apply/:id',
    public: true,
    rateLimit: 10,
    body: z.object({ coverLetter: text(5000).optional() }),
    handler: async ({ s, params, req, body }) => s.recruitment.applyAsApplicant(await s.applicants.current(req, params.org), params.org, parseId(params.id), body.coverLetter),
  }),
];
