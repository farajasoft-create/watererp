import { z } from 'zod';
import { hasPermission } from '../common/auth';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, zDate, zDecimal, zId } from '../common/validation';
import { WORKFLOW_DOCUMENT_TYPES } from '../database/platform.schemas';
import { route } from '../http/router';

const RuleBody = z.object({
  name: z.string().trim().min(1).max(200),
  documentType: z.enum(WORKFLOW_DOCUMENT_TYPES),
  priority: z.number().int().min(0).max(10_000).default(100),
  entityId: zId.nullable().default(null),
  branchIds: z.array(zId).default([]),
  minAmount: zDecimal.nullable().default(null),
  maxAmount: zDecimal.nullable().default(null),
  steps: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        approverType: z.enum(['PERMISSION', 'ROLE', 'USER']),
        roleId: zId.nullable().optional(),
        userId: zId.nullable().optional(),
        requiredApprovals: z.number().int().min(1).max(10).default(1),
      }),
    )
    .min(1)
    .max(10),
  slaHours: z.number().int().min(1).max(24 * 60).nullable().default(null),
  escalateToUserId: zId.nullable().default(null),
  escalateToRoleId: zId.nullable().default(null),
  isActive: z.boolean().default(true),
});

export const workflowRoutes = [
  route({ method: 'GET', path: '/approvals/inbox', handler: ({ s, user }) => s.workflow.inbox(user) }),
  route({
    method: 'GET',
    path: '/approvals',
    permissions: [P.WORKFLOW_MANAGE],
    query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), documentType: z.enum(WORKFLOW_DOCUMENT_TYPES).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    handler: ({ s, user, query }) => s.workflow.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/approvals/history',
    query: z.object({ documentType: z.enum(WORKFLOW_DOCUMENT_TYPES), documentId: zId }),
    handler: ({ s, user, query }) => s.workflow.history(user, query.documentType, query.documentId),
  }),
  route({
    method: 'GET',
    path: '/approvals/stats',
    permissions: [P.WORKFLOW_MANAGE],
    query: z.object({ since: zDate.optional() }),
    handler: ({ s, user, query }) => s.workflow.stats(user, query.since ?? new Date(Date.now() - 90 * 86_400_000)),
  }),

  route({ method: 'GET', path: '/approval-rules', permissions: [P.WORKFLOW_MANAGE], handler: ({ s, user }) => s.workflow.listRules(user) }),
  route({ method: 'POST', path: '/approval-rules', permissions: [P.WORKFLOW_MANAGE], body: RuleBody, handler: ({ s, user, body }) => s.workflow.createRule(user, body) }),
  route({ method: 'PATCH', path: '/approval-rules/:id', permissions: [P.WORKFLOW_MANAGE], body: RuleBody, handler: ({ s, user, body, params }) => s.workflow.updateRule(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/approval-rules/:id', permissions: [P.WORKFLOW_MANAGE], handler: ({ s, user, params }) => s.workflow.deleteRule(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/approval-rules/simulate',
    permissions: [P.WORKFLOW_MANAGE],
    query: z.object({ documentType: z.enum(WORKFLOW_DOCUMENT_TYPES), entityId: zId.optional(), branchId: zId.optional(), amount: zDecimal.optional() }),
    handler: ({ s, user, query }) => s.workflow.simulate(user, query),
  }),

  route({ method: 'GET', path: '/delegations', handler: ({ s, user }) => s.workflow.listDelegations(user, hasPermission(user, P.WORKFLOW_MANAGE)) }),
  route({
    method: 'POST',
    path: '/delegations',
    body: z.object({
      fromUserId: zId.optional(),
      toUserId: zId,
      startDate: zDate,
      endDate: zDate,
      documentTypes: z.array(z.enum(WORKFLOW_DOCUMENT_TYPES)).default([]),
      reason: z.string().trim().max(500).optional(),
    }),
    handler: ({ s, user, body }) => s.workflow.createDelegation(user, body, hasPermission(user, P.WORKFLOW_MANAGE)),
  }),
  route({ method: 'POST', path: '/delegations/:id/end', status: 200, handler: ({ s, user, params }) => s.workflow.endDelegation(user, parseId(params.id), hasPermission(user, P.WORKFLOW_MANAGE)) }),

  route({ method: 'GET', path: '/notifications', query: z.object({ unread: z.enum(['true', 'false']).optional() }), handler: ({ s, user, query }) => s.workflow.notifications(user, query.unread === 'true') }),
  route({
    method: 'POST',
    path: '/notifications/read',
    status: 200,
    body: z.object({ ids: z.union([z.array(zId).max(200), z.literal('all')]) }),
    handler: ({ s, user, body }) => s.workflow.markRead(user, body.ids),
  }),

  /** Names only, so approval rules and delegations can be set up without user-administration rights. */
  route({
    method: 'GET',
    path: '/directory',
    handler: async ({ s, user }) => {
      const [users, roles] = await Promise.all([
        s.db.users.find({ organisationId: user.organisationId, isActive: true, isServiceAccount: { $ne: true } }, { name: 1 }).sort({ name: 1 }).lean(),
        s.db.roles.find({ organisationId: user.organisationId }, { name: 1 }).sort({ name: 1 }).lean(),
      ]);
      return { users: users.map((u) => ({ id: u._id, name: u.name })), roles: roles.map((r) => ({ id: r._id, name: r.name })) };
    },
  }),
];
