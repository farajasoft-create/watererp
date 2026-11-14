import { z } from 'zod';
import { parseId, zBool, zDate, zId, zPage } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { CIRCULAR_KINDS } from './circulars.service';
import { route } from './route';
import { ASSET_CONDITIONS, ASSET_KINDS, CHANNELS, PRIORITIES, TICKET_STATUSES } from './schemas';

const text = (max: number) => z.string().trim().max(max);
const Range = z.object({ from: zDate, to: zDate, format: z.enum(['json', 'csv']).default('json') });

const AssetBody = z.object({
  tag: text(40).min(1),
  description: text(200).min(2),
  kind: z.enum(ASSET_KINDS).default('OTHER'),
  make: text(80).optional(),
  model: text(80).optional(),
  serialNo: text(80).optional(),
  location: text(120).optional(),
  condition: z.enum(ASSET_CONDITIONS).default('GOOD'),
});
const ConsumableBody = z.object({ code: text(20).min(1).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'), name: text(120).min(2), unit: text(20).min(1).default('each'), reorderLevel: z.number().min(0).max(1_000_000).default(0), active: z.boolean().optional() });

const helpdeskRoutes = [
  // Anyone in the organisation: raise, follow, talk about, confirm or reopen their own requests.
  route({ method: 'GET', path: '/helpdesk/categories', handler: ({ s, user }) => s.helpdesk.categories(user) }),
  route({ method: 'GET', path: '/helpdesk/mine', handler: ({ s, user }) => s.helpdesk.mine(user) }),
  route({ method: 'GET', path: '/assets/mine', handler: ({ s, user }) => s.assets.mine(user) }),
  route({
    method: 'POST',
    path: '/helpdesk/tickets',
    rateLimit: 30,
    body: z.object({
      categoryId: zId,
      priority: z.enum(PRIORITIES).optional(),
      subject: text(150).min(3),
      description: text(5000).optional(),
      location: text(120).optional(),
      phone: text(20).optional(),
      department: text(80).optional(),
      assetTag: text(40).optional(),
      requesterId: zId.optional(),
      channel: z.enum(CHANNELS).optional(),
    }),
    handler: ({ s, user, body }) => s.helpdesk.create(user, body),
  }),
  route({ method: 'GET', path: '/helpdesk/tickets/:id', handler: ({ s, user, params }) => s.helpdesk.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/helpdesk/tickets/:id/comments',
    status: 200,
    body: z.object({ body: text(5000).min(1), internal: z.boolean().optional() }),
    handler: ({ s, user, params, body }) => s.helpdesk.comment(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/helpdesk/tickets/:id/confirm',
    status: 200,
    body: z.object({ rating: z.number().int().min(1).max(5), feedback: text(1000).optional() }),
    handler: ({ s, user, params, body }) => s.helpdesk.confirm(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/reopen', status: 200, body: z.object({ reason: text(1000).min(3) }), handler: ({ s, user, params, body }) => s.helpdesk.reopen(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/cancel', status: 200, body: z.object({ reason: text(500).optional() }), handler: ({ s, user, params, body }) => s.helpdesk.cancel(user, parseId(params.id), body.reason) }),

  // The service desk.
  route({
    method: 'GET',
    path: '/helpdesk/tickets',
    permissions: [P.HELPDESK_WORK],
    query: z.object({ status: z.enum(TICKET_STATUSES).optional(), open: zBool.optional(), mine: zBool.optional(), unassigned: zBool.optional(), overdue: zBool.optional(), categoryId: zId.optional(), priority: z.enum(PRIORITIES).optional(), assignedTo: zId.optional(), search: text(100).optional(), ...zPage }),
    handler: ({ s, user, query }) => s.helpdesk.list(user, query),
  }),
  route({ method: 'GET', path: '/helpdesk/agents', permissions: [P.HELPDESK_WORK], handler: ({ s, user }) => s.helpdesk.agents(user.organisationId) }),
  route({
    method: 'POST',
    path: '/helpdesk/tickets/:id/assign',
    permissions: [P.HELPDESK_WORK],
    status: 200,
    body: z.object({ assigneeId: zId, note: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.helpdesk.assign(user, parseId(params.id), body.assigneeId, body.note),
  }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/start', permissions: [P.HELPDESK_WORK], status: 200, handler: ({ s, user, params }) => s.helpdesk.start(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/hold', permissions: [P.HELPDESK_WORK], status: 200, body: z.object({ reason: text(500).min(3) }), handler: ({ s, user, params, body }) => s.helpdesk.hold(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/resume', permissions: [P.HELPDESK_WORK], status: 200, handler: ({ s, user, params }) => s.helpdesk.resume(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/helpdesk/tickets/:id/resolve', permissions: [P.HELPDESK_WORK], status: 200, body: z.object({ resolution: text(2000).min(3) }), handler: ({ s, user, params, body }) => s.helpdesk.resolve(user, parseId(params.id), body.resolution) }),
  route({
    method: 'POST',
    path: '/helpdesk/tickets/:id/priority',
    permissions: [P.HELPDESK_WORK],
    status: 200,
    body: z.object({ priority: z.enum(PRIORITIES), reason: text(500).min(3) }),
    handler: ({ s, user, params, body }) => s.helpdesk.changePriority(user, parseId(params.id), body.priority, body.reason),
  }),
  route({ method: 'POST', path: '/helpdesk/housekeeping', permissions: [P.HELPDESK_MANAGE], status: 200, handler: ({ s, user }) => s.helpdesk.housekeeping(user.organisationId) }),
  route({ method: 'GET', path: '/helpdesk/settings', permissions: [P.HELPDESK_MANAGE], handler: ({ s, user }) => s.helpdesk.settings(user) }),
  route({
    method: 'PUT',
    path: '/helpdesk/settings',
    permissions: [P.HELPDESK_MANAGE],
    body: z.object({ sla: z.array(z.object({ priority: z.enum(PRIORITIES), respond: z.number().positive().max(720), resolve: z.number().positive().max(2160) })).max(4), autoCloseDays: z.number().int().min(1).max(30), emailRequester: z.boolean() }),
    handler: ({ s, user, body }) => s.helpdesk.saveSettings(user, body),
  }),
  route({
    method: 'POST',
    path: '/helpdesk/categories',
    permissions: [P.HELPDESK_MANAGE],
    body: z.object({ code: text(20).min(2).regex(/^[A-Za-z0-9_]+$/, 'Letters, digits and _ only'), name: text(80).min(2), defaultAssignee: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.helpdesk.saveCategory(user, null, body),
  }),
  route({
    method: 'PUT',
    path: '/helpdesk/categories/:id',
    permissions: [P.HELPDESK_MANAGE],
    body: z.object({ code: text(20).min(2).regex(/^[A-Za-z0-9_]+$/, 'Letters, digits and _ only'), name: text(80).min(2), defaultAssignee: zId.nullable().optional(), active: z.boolean().optional() }),
    handler: ({ s, user, params, body }) => s.helpdesk.saveCategory(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/helpdesk/report',
    permissions: [P.REPORTS_VIEW],
    query: Range,
    handler: ({ s, user, query }) => (query.format === 'csv' ? s.helpdesk.ticketsCsv(user, query.from, query.to) : s.helpdesk.report(user, query.from, query.to)),
  }),
];

const assetRoutes = [
  route({
    method: 'GET',
    path: '/assets',
    permissions: [P.ASSETS_VIEW],
    query: z.object({ status: z.enum(['IN_STORE', 'ISSUED', 'UNDER_REPAIR', 'DISPOSED']).optional(), holderId: zId.optional(), search: text(100).optional(), format: z.enum(['json', 'csv']).default('json') }),
    handler: ({ s, user, query }) => (query.format === 'csv' ? s.assets.holdingsCsv(user) : s.assets.list(user, query)),
  }),
  route({ method: 'GET', path: '/assets/:id', permissions: [P.ASSETS_VIEW], handler: ({ s, user, params }) => s.assets.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/assets', permissions: [P.ASSETS_MANAGE], body: AssetBody, handler: ({ s, user, body }) => s.assets.save(user, null, body) }),
  route({ method: 'PUT', path: '/assets/:id', permissions: [P.ASSETS_MANAGE], body: AssetBody, handler: ({ s, user, params, body }) => s.assets.save(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/assets/:id/issue',
    permissions: [P.ASSETS_MANAGE],
    status: 200,
    body: z.object({ holderId: zId, department: text(80).optional(), condition: z.enum(ASSET_CONDITIONS).optional(), note: text(500).optional(), date: zDate.optional() }),
    handler: ({ s, user, params, body }) => s.assets.issue(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/assets/:id/return',
    permissions: [P.ASSETS_MANAGE],
    status: 200,
    body: z.object({ condition: z.enum(ASSET_CONDITIONS), note: text(500).optional(), toRepair: z.boolean().optional() }),
    handler: ({ s, user, params, body }) => s.assets.takeBack(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/assets/:id/status',
    permissions: [P.ASSETS_MANAGE],
    status: 200,
    body: z.object({ status: z.enum(['IN_STORE', 'UNDER_REPAIR', 'DISPOSED']), note: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.assets.setStatus(user, parseId(params.id), body.status, body.note),
  }),
  route({ method: 'GET', path: '/consumables', permissions: [P.ASSETS_VIEW], handler: ({ s, user }) => s.assets.consumables(user) }),
  route({ method: 'POST', path: '/consumables', permissions: [P.ASSETS_MANAGE], body: ConsumableBody, handler: ({ s, user, body }) => s.assets.saveConsumable(user, null, body) }),
  route({ method: 'PUT', path: '/consumables/:id', permissions: [P.ASSETS_MANAGE], body: ConsumableBody, handler: ({ s, user, params, body }) => s.assets.saveConsumable(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/consumables/:id/moves', permissions: [P.ASSETS_VIEW], handler: ({ s, user, params }) => s.assets.moves(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/consumables/:id/moves',
    permissions: [P.ASSETS_MANAGE],
    body: z.object({ kind: z.enum(['RECEIPT', 'ISSUE', 'ADJUSTMENT']), quantity: z.number().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'Enter a quantity'), toId: zId.nullable().optional(), department: text(80).optional(), reference: text(80).optional(), date: zDate.optional() }),
    handler: ({ s, user, params, body }) => s.assets.move(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/admin-report', permissions: [P.REPORTS_VIEW], query: Range, handler: ({ s, user, query }) => s.assets.report(user, query.from, query.to) }),
];

const CircularBody = z.object({
  kind: z.enum(CIRCULAR_KINDS).default('MEMO'),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(20000),
  reference: z.string().trim().max(80).optional(),
  documentIds: z.array(zId).max(20).default([]),
  audience: z.enum(['ALL', 'USERS', 'MODULE']).default('ALL'),
  audienceUserIds: z.array(zId).max(1000).default([]),
  audienceModule: z.string().trim().max(20).optional(),
  approverId: zId.nullable().optional(),
  requiresAck: z.boolean().default(false),
  actionBy: zDate.nullable().optional(),
});

// Memos, notices and circulars: everyone reads and acknowledges what was sent to them; issuers draft and send.
const circularRoutes = [
  route({ method: 'GET', path: '/circulars', query: z.object({ box: z.enum(['inbox', 'sent', 'all']).default('inbox') }), handler: ({ s, user, query }) => s.circulars.list(user, query.box) }),
  route({ method: 'GET', path: '/circulars/:id', handler: ({ s, user, params }) => s.circulars.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/circulars', permissions: [P.CIRCULARS_ISSUE], body: CircularBody, handler: ({ s, user, body }) => s.circulars.create(user, body) }),
  route({ method: 'PUT', path: '/circulars/:id', permissions: [P.CIRCULARS_ISSUE], body: CircularBody, handler: ({ s, user, params, body }) => s.circulars.update(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/circulars/:id/send', permissions: [P.CIRCULARS_ISSUE], status: 200, handler: ({ s, user, params }) => s.circulars.send(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/circulars/:id/approve', status: 200, body: z.object({ approve: z.boolean(), comment: z.string().trim().max(1000).optional() }), handler: ({ s, user, params, body }) => s.circulars.approve(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/circulars/:id/acknowledge', status: 200, body: z.object({ comment: z.string().trim().max(1000).optional() }), handler: ({ s, user, params, body }) => s.circulars.acknowledge(user, parseId(params.id), body.comment) }),
  route({ method: 'POST', path: '/circulars/:id/forward', status: 200, body: z.object({ userId: zId, minute: z.string().trim().min(2).max(1000) }), handler: ({ s, user, params, body }) => s.circulars.forward(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/circulars/:id/recall', status: 200, body: z.object({ reason: z.string().trim().min(3).max(500) }), handler: ({ s, user, params, body }) => s.circulars.recall(user, parseId(params.id), body.reason) }),
];

export const ictRoutes = [...helpdeskRoutes, ...assetRoutes, ...circularRoutes];
