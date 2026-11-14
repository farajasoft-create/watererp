import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zId, zPage } from '@/platform/common/validation';
import { LEAVE_STATUSES } from '../schemas';
import { route } from '../route';

const LeaveBody = z.object({ leaveTypeId: zId, startDate: zDate, endDate: zDate, reason: z.string().trim().max(500).optional(), handoverTo: zId.nullable().optional(), handoverNotes: z.string().trim().max(2000).optional() });
const year = z.coerce.number().int().min(2000).max(2100);

export const leaveRoutes = [
  route({
    method: 'GET',
    path: '/leave',
    permissions: [P.LEAVE_VIEW],
    query: z.object({ status: z.enum(LEAVE_STATUSES).optional(), employeeId: zId.optional(), from: zDate.optional(), to: zDate.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.leave.list(user, query),
  }),
  route({ method: 'GET', path: '/leave/days', permissions: [], query: z.object({ from: zDate, to: zDate }), handler: async ({ s, user, query }) => ({ days: await s.leave.days(user.organisationId, query.from, query.to) }) }),
  route({ method: 'POST', path: '/leave', permissions: [P.LEAVE_APPROVE], body: LeaveBody.extend({ employeeId: zId }), handler: ({ s, user, body }) => s.leave.request(user, body) }),
  route({
    method: 'POST',
    path: '/leave/:id/review',
    permissions: [P.LEAVE_APPROVE],
    status: 200,
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.leave.review(user, parseId(params.id), body.decision, body.note),
  }),
  route({ method: 'POST', path: '/leave/:id/cancel', permissions: [P.LEAVE_APPROVE], status: 200, handler: ({ s, user, params }) => s.leave.cancel(user, parseId(params.id), false) }),
  route({
    method: 'POST',
    path: '/leave/adjustments',
    permissions: [P.LEAVE_MANAGE],
    body: z.object({ employeeId: zId, leaveTypeId: zId, year, days: z.number().min(-366).max(366), kind: z.enum(['OPENING', 'ADJUSTMENT', 'ENCASHMENT']), reason: z.string().trim().min(1).max(300) }),
    handler: ({ s, user, body }) => s.leave.adjust(user, body),
  }),
  route({ method: 'POST', path: '/leave/carry-forward', permissions: [P.LEAVE_MANAGE], status: 200, body: z.object({ year }), handler: ({ s, user, body }) => s.leave.carryForward(user, body.year) }),
];

/** An employee's own records; nobody else's are reachable from here. */
export const selfRoutes = [
  route({ method: 'GET', path: '/me', permissions: [P.SELF], handler: ({ s, user }) => s.self.me(user) }),
  route({ method: 'GET', path: '/me/payslips/:id', permissions: [P.SELF], handler: ({ s, user, params }) => s.self.payslip(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/me/p9', permissions: [P.SELF], query: z.object({ year }), handler: ({ s, user, query }) => s.self.p9(user, query.year) }),
  route({ method: 'POST', path: '/me/leave', permissions: [P.SELF], body: LeaveBody, handler: ({ s, user, body }) => s.self.applyForLeave(user, body) }),
  route({ method: 'POST', path: '/me/leave/:id/cancel', permissions: [P.SELF], status: 200, handler: ({ s, user, params }) => s.self.cancelLeave(user, parseId(params.id)) }),
];
