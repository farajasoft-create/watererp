import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { CASE_KINDS, CASE_OUTCOMES, CASE_STATUSES } from '../schemas';
import { route } from '../route';

const text = (max: number) => z.string().trim().max(max);
const PersonalChanges = z
  .object({
    phone: text(20).optional(),
    email: z.string().trim().email().max(200).optional(),
    address: text(300).optional(),
    nextOfKin: z.object({ name: text(100).optional(), phone: text(20).optional(), relationship: text(40).optional() }).optional(),
    dependants: z.array(z.object({ name: text(120).min(1), relationship: text(40).min(1), dateOfBirth: zDate.nullable().optional() })).max(30).optional(),
    qualifications: z.array(z.object({ level: text(60).min(1), title: text(200).min(1), institution: text(200).optional(), year: z.number().int().min(1950).max(2100).nullable().optional() })).max(30).optional(),
  })
  .strict();
const BankChanges = z
  .object({
    payMethod: z.enum(['BANK', 'MPESA']).optional(),
    bank: z.object({ name: text(100).optional(), branch: text(100).optional(), accountNo: text(40).optional(), accountName: text(150).optional() }).optional(),
    mpesaPhone: text(20).optional(),
  })
  .strict();

export const relationsRoutes = [
  // Self-service
  route({ method: 'GET', path: '/me/changes', permissions: [P.SELF], handler: ({ s, user }) => s.relations.myChanges(user) }),
  route({ method: 'GET', path: '/me/colleagues', permissions: [P.SELF], handler: ({ s, user }) => s.relations.colleagues(user) }),
  route({ method: 'POST', path: '/me/changes/personal', permissions: [P.SELF], body: PersonalChanges, handler: ({ s, user, body }) => s.relations.requestChange(user, { kind: 'PERSONAL', changes: body }) }),
  route({ method: 'POST', path: '/me/changes/bank', permissions: [P.SELF], body: BankChanges, handler: ({ s, user, body }) => s.relations.requestChange(user, { kind: 'BANK', changes: body }) }),
  route({
    method: 'POST',
    path: '/me/grievances',
    permissions: [P.SELF],
    body: z.object({ against: text(200).optional(), category: text(80).min(1), description: text(5000).min(10, 'Describe the grievance'), incidentDate: zDate.nullable().optional() }),
    handler: ({ s, user, body }) => s.relations.raiseGrievance(user, body),
  }),

  // HR
  route({ method: 'GET', path: '/change-requests', permissions: [P.EMPLOYEE_MANAGE], query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }), handler: ({ s, user, query }) => s.relations.changes(user, query.status) }),
  route({
    method: 'POST',
    path: '/change-requests/:id/decide',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ approve: z.boolean(), note: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.relations.decideChange(user, parseId(params.id), body.approve, body.note),
  }),
  route({
    method: 'POST',
    path: '/leave/:id/recall',
    permissions: [P.LEAVE_APPROVE],
    status: 200,
    body: z.object({ returnDate: zDate, reason: text(500).min(3, 'Give the reason') }),
    handler: ({ s, user, params, body }) => s.leave.recall(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/cases',
    permissions: [P.CASES_MANAGE],
    query: z.object({ kind: z.enum(CASE_KINDS).optional(), status: z.enum(CASE_STATUSES).optional(), employeeId: zId.optional() }),
    handler: ({ s, user, query }) => s.relations.cases(user, query),
  }),
  route({
    method: 'POST',
    path: '/cases',
    permissions: [P.CASES_MANAGE],
    body: z.object({ kind: z.enum(CASE_KINDS), employeeId: zId, against: text(200).optional(), category: text(80).min(1), description: text(5000).min(3), incidentDate: zDate.nullable().optional() }),
    handler: ({ s, user, body }) => s.relations.openCase(user, body),
  }),
  route({
    method: 'POST',
    path: '/cases/:id/steps',
    permissions: [P.CASES_MANAGE],
    status: 200,
    body: z.object({
      action: z.enum(['SHOW_CAUSE', 'RESPONSE', 'HEARING', 'DECISION', 'APPEAL', 'APPEAL_DECISION', 'CLOSE', 'NOTE']),
      note: text(5000).optional(),
      dueDate: zDate.nullable().optional(),
      outcome: z.enum(CASE_OUTCOMES).optional(),
      appealDecision: z.enum(['UPHELD', 'VARIED', 'OVERTURNED']).optional(),
    }),
    handler: ({ s, user, params, body }) => s.relations.step(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/clearances', permissions: [P.EMPLOYEE_VIEW], query: z.object({ status: z.enum(['OPEN', 'CLEARED']).optional() }), handler: ({ s, user, query }) => s.relations.clearances(user, query.status) }),
  route({
    method: 'POST',
    path: '/employees/:id/clearance',
    permissions: [P.EMPLOYEE_MANAGE],
    body: z.object({ lastDay: zDate, reason: text(300).min(1), sections: z.array(text(40).min(1)).max(12).optional() }),
    handler: ({ s, user, params, body }) => s.relations.startClearance(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/clearances/:id/sections',
    permissions: [P.EMPLOYEE_VIEW],
    status: 200,
    body: z.object({ section: z.string().trim().min(1).max(40), cleared: z.boolean(), owed: zDecimal.optional().transform((d) => d?.toFixed()), note: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.relations.clear(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/clearances/:id/exit-interview',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ reasonForLeaving: text(500).min(1), wouldRecommend: z.boolean().optional(), comments: text(5000).optional() }),
    handler: ({ s, user, params, body }) => s.relations.exitInterview(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/clearances/:id/complete', permissions: [P.EMPLOYEE_MANAGE], status: 200, handler: ({ s, user, params }) => s.relations.complete(user, parseId(params.id)) }),
];

