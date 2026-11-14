import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { BSC_PERSPECTIVES, RECOMMENDATIONS, TRAINING_KINDS } from '../schemas';
import { route } from '../route';

const Ratings = z.array(z.object({ targetId: zId, rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() })).min(1).max(30);
const year = z.coerce.number().int().min(2000).max(2100);
const TrainingBody = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(TRAINING_KINDS).default('TRAINING'),
  provider: z.string().trim().max(200).optional(),
  startDate: zDate,
  endDate: zDate,
  cost: zDecimal.default('0'),
  mentorId: zId.nullable().optional(),
  participantIds: z.array(zId).min(1).max(500),
  needs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

export const performanceRoutes = [
  route({ method: 'GET', path: '/appraisal-cycles', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.performance.cycles(user) }),
  route({ method: 'POST', path: '/appraisal-cycles', permissions: [P.EMPLOYEE_MANAGE], body: z.object({ name: z.string().trim().min(1).max(100), from: zDate, to: zDate }), handler: ({ s, user, body }) => s.performance.saveCycle(user, body) }),
  route({ method: 'POST', path: '/appraisal-cycles/:id/close', permissions: [P.EMPLOYEE_MANAGE], status: 200, handler: ({ s, user, params }) => s.performance.closeCycle(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/appraisal-cycles/:id/appraisals', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user, params }) => s.performance.appraisals(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/appraisal-cycles/:id/report', permissions: [P.REPORTS_VIEW], handler: ({ s, user, params }) => s.performance.cycleReport(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/appraisals/targets',
    permissions: [P.EMPLOYEE_VIEW],
    status: 200,
    body: z.object({
      cycleId: zId,
      employeeId: zId,
      targets: z.array(z.object({ perspective: z.enum(BSC_PERSPECTIVES), objective: z.string().trim().min(1).max(300), measure: z.string().trim().max(300).optional(), target: z.string().trim().max(200).optional(), weight: z.number().int().min(1).max(100) })).min(1).max(30),
    }),
    handler: ({ s, user, body }) => s.performance.setTargets(user, body),
  }),
  route({
    method: 'POST',
    path: '/appraisals/:id/review',
    permissions: [P.EMPLOYEE_VIEW],
    status: 200,
    body: z.object({ ratings: Ratings, comment: z.string().trim().max(2000).optional(), recommendation: z.enum(RECOMMENDATIONS).default('NONE'), trainingNeeds: z.array(z.string().trim().max(200)).max(10).optional() }),
    handler: ({ s, user, params, body }) => s.performance.review(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/appraisals/:id/appeal-decision',
    permissions: [P.CAREER_APPROVE],
    status: 200,
    body: z.object({ decision: z.string().trim().min(3).max(1000), ratings: Ratings.optional() }),
    handler: ({ s, user, params, body }) => s.performance.decideAppeal(user, parseId(params.id), body),
  }),

  route({ method: 'GET', path: '/me/appraisals', permissions: [P.SELF], handler: ({ s, user }) => s.performance.mine(user) }),
  route({ method: 'POST', path: '/me/appraisals/:id/agree', permissions: [P.SELF], status: 200, handler: ({ s, user, params }) => s.performance.agree(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/me/appraisals/:id/self-review', permissions: [P.SELF], status: 200, body: z.object({ ratings: Ratings }), handler: ({ s, user, params, body }) => s.performance.selfReview(user, parseId(params.id), body.ratings) }),
  route({ method: 'POST', path: '/me/appraisals/:id/accept', permissions: [P.SELF], status: 200, handler: ({ s, user, params }) => s.performance.accept(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/me/appraisals/:id/appeal', permissions: [P.SELF], status: 200, body: z.object({ grounds: z.string().trim().min(10, 'Explain the grounds').max(2000) }), handler: ({ s, user, params, body }) => s.performance.appeal(user, parseId(params.id), body.grounds) }),
  route({ method: 'GET', path: '/me/trainings', permissions: [P.SELF], handler: ({ s, user }) => s.performance.myTrainings(user) }),
  route({
    method: 'POST',
    path: '/me/trainings/:id/evaluate',
    permissions: [P.SELF],
    status: 200,
    body: z.object({ rating: z.number().int().min(1).max(5), feedback: z.string().trim().max(2000).optional() }),
    handler: ({ s, user, params, body }) => s.performance.evaluate(user, parseId(params.id), body),
  }),

  route({ method: 'GET', path: '/trainings', permissions: [P.EMPLOYEE_VIEW], query: z.object({ year }), handler: ({ s, user, query }) => s.performance.trainings(user, query.year) }),
  route({ method: 'POST', path: '/trainings', permissions: [P.EMPLOYEE_MANAGE], body: TrainingBody, handler: ({ s, user, body }) => s.performance.saveTraining(user, null, body) }),
  route({ method: 'PATCH', path: '/trainings/:id', permissions: [P.EMPLOYEE_MANAGE], body: TrainingBody, handler: ({ s, user, params, body }) => s.performance.saveTraining(user, parseId(params.id), body) }),
  ...(['approve', 'complete', 'cancel'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/trainings/:id/${action}`,
      permissions: [action === 'approve' ? P.CAREER_APPROVE : P.EMPLOYEE_MANAGE],
      status: 200,
      body: z.object({ attended: z.array(zId).max(500).optional() }),
      handler: ({ s, user, params, body }) => s.performance.actTraining(user, parseId(params.id), action, body.attended),
    }),
  ),
  route({ method: 'GET', path: '/training-budget', permissions: [P.EMPLOYEE_VIEW], query: z.object({ year }), handler: ({ s, user, query }) => s.performance.budget(user, query.year) }),
  route({ method: 'PUT', path: '/training-budget', permissions: [P.SETTINGS_MANAGE], status: 200, body: z.object({ year, amount: zDecimal }), handler: ({ s, user, body }) => s.performance.setBudget(user, body.year, body.amount) }),
  route({ method: 'GET', path: '/training-needs', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.performance.openNeeds(user) }),
];
