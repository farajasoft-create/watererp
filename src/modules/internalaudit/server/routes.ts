import { z } from 'zod';
import { parseId, zBool, zDate, zDecimal, zId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { FILTER_OPS } from '@/modules/bi/server/engine';
import { route } from './route';
import { ENGAGEMENT_KINDS, RATINGS } from './schemas';

const text = (max: number) => z.string().trim().max(max);
const score = z.number().int().min(1).max(5);
const code = text(20).min(1).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');

const AreaBody = z.object({ code, name: text(150).min(2), kind: z.enum(['DEPARTMENT', 'PROCESS', 'SYSTEM', 'PROJECT', 'BRANCH', 'OTHER']).default('PROCESS'), owner: text(120).optional(), ownerId: zId.nullable().optional(), description: text(2000).optional(), impact: score, likelihood: score, lastAuditedAt: zDate.nullable().optional(), active: z.boolean().optional() });
const RiskBody = z.object({
  code,
  title: text(200).min(3),
  category: z.enum(['STRATEGIC', 'OPERATIONAL', 'FINANCIAL', 'COMPLIANCE', 'ICT', 'FRAUD', 'REPUTATIONAL']).default('OPERATIONAL'),
  universeId: zId.nullable().optional(),
  owner: text(120).optional(),
  cause: text(2000).optional(),
  consequence: text(2000).optional(),
  impact: score,
  likelihood: score,
  controls: text(3000).optional(),
  residualImpact: score,
  residualLikelihood: score,
  treatment: z.enum(['ACCEPT', 'REDUCE', 'TRANSFER', 'AVOID']).default('REDUCE'),
  reviewDate: zDate.nullable().optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});
const ProgrammeBody = z.object({ name: text(150).min(3), area: text(120).optional(), objective: text(2000).optional(), procedures: z.array(z.object({ ref: text(12).min(1), title: text(200).min(2), steps: text(4000).optional() })).max(100), active: z.boolean().optional() });
const FindingBody = z.object({
  ref: text(12).min(1),
  title: text(200).min(3),
  condition: text(5000).optional(),
  criteria: text(5000).optional(),
  cause: text(5000).optional(),
  effect: text(5000).optional(),
  rating: z.enum(RATINGS).default('MEDIUM'),
  recommendation: text(5000).optional(),
  workpaperId: zId.nullable().optional(),
  ownerId: zId.nullable().optional(),
  dueDate: zDate.nullable().optional(),
});
const EngagementBody = z.object({
  title: text(200).min(3),
  kind: z.enum(ENGAGEMENT_KINDS).default('ASSURANCE'),
  universeId: zId.nullable().optional(),
  planId: zId.nullable().optional(),
  planItemId: zId.nullable().optional(),
  objectives: text(5000).optional(),
  scope: text(5000).optional(),
  start: zDate.nullable().optional(),
  end: zDate.nullable().optional(),
  leadId: zId,
  team: z.array(zId).max(20).default([]),
  restricted: z.boolean().optional(),
  budgetHours: z.number().min(0).max(10000).optional(),
  programmeId: zId.nullable().optional(),
});
const Register = z.object({ status: z.enum(['AGREED', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'NOT_ACCEPTED']).optional(), rating: z.enum(RATINGS).optional(), overdue: zBool.optional(), engagementId: zId.optional(), ownerId: zId.optional(), format: z.enum(['json', 'csv']).default('json') });

const planningRoutes = [
  route({ method: 'GET', path: '/settings', permissions: [P.VIEW], handler: ({ s, user }) => s.planning.settings(user) }),
  route({ method: 'PUT', path: '/settings', permissions: [P.PLAN_MANAGE], body: z.object({ hourlyRate: zDecimal, remindDays: z.number().int().min(1).max(90), escalateDays: z.number().int().min(1).max(365) }), handler: ({ s, user, body }) => s.planning.saveSettings(user, body) }),
  route({ method: 'GET', path: '/universe', permissions: [P.VIEW], handler: ({ s, user }) => s.planning.universe(user) }),
  route({ method: 'POST', path: '/universe', permissions: [P.PLAN_MANAGE], body: AreaBody, handler: ({ s, user, body }) => s.planning.saveArea(user, null, body) }),
  route({ method: 'PUT', path: '/universe/:id', permissions: [P.PLAN_MANAGE], body: AreaBody, handler: ({ s, user, params, body }) => s.planning.saveArea(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/risks', permissions: [P.VIEW], query: z.object({ universeId: zId.optional(), status: z.enum(['OPEN', 'CLOSED']).optional() }), handler: ({ s, user, query }) => s.planning.risks(user, query) }),
  route({ method: 'GET', path: '/risks/heat-map', permissions: [P.VIEW], handler: ({ s, user }) => s.planning.heatMap(user) }),
  route({ method: 'POST', path: '/risks', permissions: [P.PLAN_MANAGE], body: RiskBody, handler: ({ s, user, body }) => s.planning.saveRisk(user, null, body) }),
  route({ method: 'PUT', path: '/risks/:id', permissions: [P.PLAN_MANAGE], body: RiskBody, handler: ({ s, user, params, body }) => s.planning.saveRisk(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/programmes', permissions: [P.WORK], handler: ({ s, user }) => s.planning.programmes(user) }),
  route({ method: 'POST', path: '/programmes', permissions: [P.PLAN_MANAGE], body: ProgrammeBody, handler: ({ s, user, body }) => s.planning.saveProgramme(user, null, body) }),
  route({ method: 'PUT', path: '/programmes/:id', permissions: [P.PLAN_MANAGE], body: ProgrammeBody, handler: ({ s, user, params, body }) => s.planning.saveProgramme(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/plans', permissions: [P.VIEW], handler: ({ s, user }) => s.planning.plans(user) }),
  route({ method: 'GET', path: '/plans/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.planning.plan(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/plans',
    permissions: [P.PLAN_MANAGE],
    body: z.object({ year: text(12).min(4), title: text(150).min(3), availableHours: z.number().min(0).max(100000).default(0), fromUniverse: z.boolean().default(true) }),
    handler: ({ s, user, body }) => s.planning.createPlan(user, body),
  }),
  route({
    method: 'PUT',
    path: '/plans/:id/items',
    permissions: [P.PLAN_MANAGE],
    body: z.object({
      title: text(150).min(3).optional(),
      availableHours: z.number().min(0).max(100000).optional(),
      items: z.array(z.object({ id: zId.optional(), universeId: zId.nullable().optional(), title: text(200).min(3), kind: z.enum(ENGAGEMENT_KINDS).default('ASSURANCE'), quarter: z.number().int().min(1).max(4), start: zDate.nullable().optional(), end: zDate.nullable().optional(), hours: z.number().min(0).max(10000), cost: zDecimal.optional(), leadId: zId.nullable().optional() })).max(300),
    }),
    handler: ({ s, user, params, body }) => s.planning.saveItems(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/plans/:id/submit', permissions: [P.PLAN_MANAGE], status: 200, handler: ({ s, user, params }) => s.planning.submitPlan(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/plans/:id/decide', permissions: [P.PLAN_APPROVE], status: 200, body: z.object({ approve: z.boolean(), note: text(2000).optional() }), handler: ({ s, user, params, body }) => s.planning.decidePlan(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/calendar', permissions: [P.VIEW], query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), handler: ({ s, user, query }) => s.planning.calendar(user, query.year) }),
  route({ method: 'GET', path: '/dashboard', permissions: [P.VIEW], query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), handler: ({ s, user, query }) => s.dashboard.dashboard(user, query.year) }),
];

const engagementRoutes = [
  route({ method: 'GET', path: '/engagements', permissions: [P.VIEW], query: z.object({ status: text(20).optional(), year: z.coerce.number().int().optional(), mine: zBool.optional() }), handler: ({ s, user, query }) => s.engagements.list(user, query) }),
  route({ method: 'POST', path: '/engagements', permissions: [P.MANAGE], body: EngagementBody, handler: ({ s, user, body }) => s.engagements.create(user, body) }),
  route({ method: 'GET', path: '/engagements/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.engagements.get(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/engagements/:id',
    permissions: [P.WORK],
    body: EngagementBody.pick({ title: true, objectives: true, scope: true, start: true, end: true, budgetHours: true, restricted: true, team: true, leadId: true }).partial(),
    handler: ({ s, user, params, body }) => s.engagements.update(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/engagements/:id/status', permissions: [P.WORK], status: 200, body: z.object({ status: z.enum(['FIELDWORK', 'REPORTING', 'CLOSED', 'CANCELLED']), note: text(1000).optional() }), handler: ({ s, user, params, body }) => s.engagements.setStatus(user, parseId(params.id), body.status, body.note) }),
  route({ method: 'POST', path: '/engagements/:id/tasks', permissions: [P.WORK], body: z.object({ title: text(200).min(3), assigneeId: zId, due: zDate.nullable().optional() }), handler: ({ s, user, params, body }) => s.engagements.addTask(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/engagements/:id/tasks/:taskId', permissions: [P.WORK], status: 200, body: z.object({ done: z.boolean() }), handler: ({ s, user, params, body }) => s.engagements.completeTask(user, parseId(params.id), parseId(params.taskId), body.done) }),
  route({ method: 'POST', path: '/engagements/:id/time', permissions: [P.WORK], body: z.object({ date: zDate, hours: z.number().min(0.25).max(16), activity: z.enum(['PLANNING', 'FIELDWORK', 'REVIEW', 'REPORTING', 'FOLLOW_UP', 'TRAVEL']), note: text(500).optional() }), handler: ({ s, user, params, body }) => s.engagements.logTime(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/engagements/:id/costs', permissions: [P.WORK], body: z.object({ date: zDate, description: text(200).min(2), amount: zDecimal.refine((v) => v.gt(0), 'Must be more than zero') }), handler: ({ s, user, params, body }) => s.engagements.addCost(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/engagements/:id/workpapers', permissions: [P.WORK], body: z.object({ ref: text(12).min(1), title: text(200).min(2), procedure: text(4000).optional(), confidential: z.boolean().optional() }), handler: ({ s, user, params, body }) => s.engagements.createWorkpaper(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/engagements/:id/findings', permissions: [P.WORK], body: FindingBody, handler: ({ s, user, params, body }) => s.findings.create(user, parseId(params.id), body) }),
  route({ method: 'PUT', path: '/engagements/:id/report', permissions: [P.WORK], body: z.object({ summary: text(10000).min(10), conclusion: text(5000).min(3), opinion: z.enum(['SATISFACTORY', 'NEEDS_IMPROVEMENT', 'UNSATISFACTORY']) }), handler: ({ s, user, params, body }) => s.engagements.saveReport(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/engagements/:id/report/:action', permissions: [P.WORK], status: 200, body: z.object({ note: text(2000).optional() }), handler: ({ s, user, params, body }) => s.engagements.reportStep(user, parseId(params.id), { action: z.enum(['REVIEW', 'APPROVE', 'ISSUE', 'RETURN']).parse(params.action.toUpperCase()), note: body.note }) }),
  route({ method: 'GET', path: '/engagements/:id/report.pdf', permissions: [P.VIEW], handler: ({ s, user, params }) => s.engagements.reportFile(user, parseId(params.id), 'pdf') }),
  route({ method: 'GET', path: '/engagements/:id/report.doc', permissions: [P.VIEW], handler: ({ s, user, params }) => s.engagements.reportFile(user, parseId(params.id), 'doc') }),
  route({ method: 'GET', path: '/engagements/:id/report.pptx', permissions: [P.VIEW], handler: ({ s, user, params }) => s.engagements.reportFile(user, parseId(params.id), 'pptx') }),
  route({ method: 'GET', path: '/engagements/:id/access-log', permissions: [P.MANAGE], handler: ({ s, user, params }) => s.engagements.accessLog(user, parseId(params.id)) }),

  route({ method: 'GET', path: '/workpapers/:id', permissions: [P.WORK], handler: ({ s, user, params }) => s.engagements.getWorkpaper(user, parseId(params.id)) }),
  route({ method: 'PATCH', path: '/workpapers/:id', permissions: [P.WORK], body: z.object({ title: text(200).min(2).optional(), procedure: text(4000).optional(), content: text(100000).optional(), conclusion: text(5000).optional(), confidential: z.boolean().optional() }), handler: ({ s, user, params, body }) => s.engagements.saveWorkpaper(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/workpapers/:id/sign', permissions: [P.WORK], status: 200, body: z.object({ action: z.enum(['PREPARE', 'REVIEW', 'RETURN']), note: text(2000).optional() }), handler: ({ s, user, params, body }) => s.engagements.signWorkpaper(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/workpapers/:id/evidence', permissions: [P.WORK], status: 200, body: z.object({ documentIds: z.array(zId).min(1).max(20) }), handler: ({ s, user, params, body }) => s.engagements.attachEvidence(user, parseId(params.id), body.documentIds) }),
  route({
    method: 'POST',
    path: '/workpapers/:id/sample',
    permissions: [P.WORK],
    status: 200,
    body: z.object({ population: z.number().int().min(1).max(10_000_000).optional(), size: z.number().int().min(1).max(5000).optional(), confidence: z.number().min(50).max(99.9).optional(), tolerableRate: z.number().min(0.5).max(50).optional(), method: z.enum(['RANDOM', 'SYSTEMATIC', 'MONETARY']), values: z.array(z.number()).max(20000).optional(), seed: z.number().int().min(0).max(2 ** 31).optional() }),
    handler: ({ s, user, params, body }) => s.engagements.drawSample(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/data/catalogue', permissions: [P.DATA], handler: ({ s, user }) => s.engagements.dataCatalogue(user) }),
  route({
    method: 'POST',
    path: '/workpapers/:id/population',
    permissions: [P.WORK, P.DATA],
    status: 200,
    body: z.object({
      dataset: z.string().trim().min(1).max(60),
      filters: z.array(z.object({ field: z.string().max(60), op: z.enum(FILTER_OPS), value: z.unknown().optional(), to: z.unknown().optional() })).max(20).default([]),
      columns: z.array(z.string().max(60)).max(30).optional(),
      valueField: z.string().max(60).optional(),
    }),
    handler: ({ s, user, params, body }) => s.engagements.pullPopulation(user, parseId(params.id), body as never),
  }),
];

const findingRoutes = [
  // Action owners need no role in the module: these check that the finding is theirs.
  route({ method: 'GET', path: '/actions/mine', handler: ({ s, user }) => s.findings.mine(user) }),
  route({ method: 'GET', path: '/findings/:id', handler: ({ s, user, params }) => s.findings.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/findings/:id/respond', status: 200, body: z.object({ accepted: z.boolean(), response: text(5000).min(3), action: text(5000).optional(), dueDate: zDate.nullable().optional() }), handler: ({ s, user, params, body }) => s.findings.respond(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/findings/:id/progress', status: 200, body: z.object({ note: text(5000).min(3), implemented: z.boolean().default(false), documentIds: z.array(zId).max(20).default([]) }), handler: ({ s, user, params, body }) => s.findings.progress(user, parseId(params.id), body) }),

  route({ method: 'PATCH', path: '/findings/:id', permissions: [P.WORK], body: FindingBody.partial(), handler: ({ s, user, params, body }) => s.findings.update(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/findings/:id/verify', permissions: [P.WORK], status: 200, body: z.object({ verified: z.boolean(), note: text(2000).min(3) }), handler: ({ s, user, params, body }) => s.findings.verify(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/findings/:id/extend', permissions: [P.MANAGE], status: 200, body: z.object({ dueDate: zDate, reason: text(1000).min(3) }), handler: ({ s, user, params, body }) => s.findings.extend(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/recommendations', permissions: [P.VIEW], query: Register, handler: ({ s, user, query }) => (query.format === 'csv' ? s.findings.registerCsv(user, query) : s.findings.register(user, query)) }),
  route({ method: 'POST', path: '/housekeeping', permissions: [P.MANAGE], status: 200, handler: ({ s, user }) => s.findings.housekeeping(user.organisationId) }),
];

export const internalauditRoutes = [...planningRoutes, ...engagementRoutes, ...findingRoutes];
