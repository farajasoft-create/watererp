import { z } from 'zod';
import { BadRequestException } from './common/errors';
import { parseId, zBool, zDate, zId, zPage } from './common/validation';
import { route } from './http/route';
import { CORE_PERMISSIONS as P } from './manifest';
import { TASK_STATUSES } from './workflow-schemas';

const optionalText = (max: number) => z.string().trim().max(max).optional();

const documentRoutes = [
  route({
    method: 'GET',
    path: '/documents',
    query: z.object({ module: optionalText(20), entity: optionalText(40), entityId: zId.optional(), category: optionalText(40), search: optionalText(80), ...zPage }),
    handler: ({ s, user, query }) => s.documents.list(user, query),
  }),
  /** The file is the request body; its details go in the query string (name, module, entity, entityId, category, tags). */
  route({
    method: 'POST',
    path: '/documents',
    raw: true,
    handler: ({ s, user, req }) => {
      const q = new URL(req.url).searchParams;
      const name = q.get('name')?.trim();
      if (!name) throw new BadRequestException('Give the file name (?name=)');
      const id = (k: string) => (q.get(k) ? parseId(q.get(k)!) : null);
      return s.documents.upload(user, req, {
        name: name.slice(0, 200),
        module: q.get('module') || null,
        entity: q.get('entity') || null,
        entityId: id('entityId'),
        category: q.get('category')?.slice(0, 40) || undefined,
        tags: q.get('tags')?.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
        description: q.get('description')?.slice(0, 500) || undefined,
        access: (['ORGANISATION', 'MODULE', 'RESTRICTED'] as const).find((a) => a === q.get('access')) ?? undefined,
        replaces: id('replaces'),
      });
    },
  }),
  route({ method: 'GET', path: '/documents/:id/download', handler: ({ s, user, params, ip }) => s.documents.download(user, parseId(params.id), ip) }),
  route({ method: 'GET', path: '/documents/:id/versions', handler: ({ s, user, params }) => s.documents.versions(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/documents/:id/trail', handler: ({ s, user, params }) => s.documents.trail(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/documents/:id',
    body: z.object({ name: optionalText(200), category: optionalText(40), tags: z.array(z.string().trim().max(40)).max(20).optional(), description: optionalText(500), access: z.enum(['ORGANISATION', 'MODULE', 'RESTRICTED']).optional(), sharedWith: z.array(zId).max(100).optional() }),
    handler: ({ s, user, params, body }) => s.documents.update(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/documents/:id/delete', status: 200, body: z.object({ reason: z.string().trim().min(3).max(300) }), handler: ({ s, user, params, body }) => s.documents.remove(user, parseId(params.id), body.reason) }),
];

const notificationRoutes = [
  route({ method: 'GET', path: '/notifications', query: z.object({ unread: zBool.optional() }), handler: ({ s, user, query }) => s.notifications.list(user, query.unread) }),
  route({ method: 'POST', path: '/notifications/read', status: 200, body: z.object({ ids: z.array(zId).max(200).optional() }), handler: ({ s, user, body }) => s.notifications.markRead(user, body.ids) }),
];

const taskRoutes = [
  route({
    method: 'GET',
    path: '/tasks',
    query: z.object({ view: z.enum(['mine', 'created', 'all']).default('mine'), status: z.enum(TASK_STATUSES).optional(), overdue: zBool.optional() }),
    handler: ({ s, user, query }) => s.tasks.list(user, query),
  }),
  route({ method: 'GET', path: '/tasks/analytics', query: z.object({ from: zDate, to: zDate }), handler: ({ s, user, query }) => s.tasks.analytics(user, query.from, new Date(query.to.getTime() + 86_400_000)) }),
  route({
    method: 'POST',
    path: '/tasks',
    body: z.object({ title: z.string().trim().min(3).max(200), description: optionalText(2000), assignedTo: zId, dueAt: zDate.nullable().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(), module: optionalText(20), link: optionalText(300), department: optionalText(80), escalateTo: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.tasks.create(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/tasks/:id',
    body: z.object({ status: z.enum(TASK_STATUSES).optional(), comment: optionalText(1000), assignedTo: zId.optional(), dueAt: zDate.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.tasks.update(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/tasks/escalate', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.tasks.escalate(user.organisationId) }),
];

const Step = z.object({ name: z.string().trim().min(1).max(80), roles: z.array(z.string().trim().max(40)).max(20).optional(), userIds: z.array(zId).max(50).optional(), minAmount: z.number().min(0).optional(), parallel: z.boolean().optional() });

const approvalRoutes = [
  route({ method: 'GET', path: '/approvals/inbox', handler: ({ s, user }) => s.approvals.inbox(user) }),
  route({ method: 'GET', path: '/approvals/rules', permissions: [P.SETTINGS_MANAGE], query: z.object({ module: optionalText(20) }), handler: ({ s, user, query }) => s.approvals.listRules(user, query.module) }),
  route({
    method: 'PUT',
    path: '/approvals/rules',
    permissions: [P.SETTINGS_MANAGE],
    status: 200,
    body: z.object({ module: z.string().trim().min(2).max(20), docType: z.string().trim().min(2).max(40), name: optionalText(120), steps: z.array(Step).min(1).max(10), active: z.boolean().default(true) }),
    handler: ({ s, user, body }) => s.approvals.saveRule(user, body),
  }),
  route({
    method: 'GET',
    path: '/approvals/for',
    query: z.object({ module: z.string().max(20), docType: z.string().max(40), docId: zId }),
    handler: ({ s, user, query }) => s.approvals.forDocument(user, query.module, query.docType, query.docId),
  }),
  /** The user's own signing keys and certificates (the private key stays on their device). */
  route({ method: 'GET', path: '/signing-keys', handler: ({ s, user }) => s.approvals.signingKeys(user) }),
  route({ method: 'POST', path: '/signing-keys', body: z.object({ label: z.string().trim().min(2).max(80), pem: z.string().trim().min(50).max(10_000) }), handler: ({ s, user, body }) => s.approvals.addSigningKey(user, body) }),
  route({ method: 'DELETE', path: '/signing-keys/:id', handler: ({ s, user, params }) => s.approvals.revokeSigningKey(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/approvals/:id', handler: ({ s, user, params }) => s.approvals.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/approvals/:id/decide',
    status: 200,
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED', 'RETURNED']), note: optionalText(500), signatureImage: z.string().max(200_000).nullable().optional(), certificate: z.object({ keyId: zId, signature: z.string().max(4000) }).nullable().optional() }),
    handler: ({ s, user, params, body }) => s.approvals.decide(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/approvals/decide-many',
    status: 200,
    body: z.object({ ids: z.array(zId).min(1).max(100), decision: z.enum(['APPROVED', 'REJECTED', 'RETURNED']), note: optionalText(500) }),
    handler: ({ s, user, body }) => s.approvals.decideMany(user, body.ids, body),
  }),
  route({ method: 'POST', path: '/approvals/:id/cancel', status: 200, handler: ({ s, user, params }) => s.approvals.cancel(user, parseId(params.id)) }),
];

export const workflowRoutes = [...documentRoutes, ...notificationRoutes, ...taskRoutes, ...approvalRoutes];
