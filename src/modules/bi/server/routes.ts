import { z } from 'zod';
import { parseId, zDate, zId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { AGGS, BUCKETS, FILTER_OPS } from './engine';
import { EXPORT_FORMATS } from './exports';
import { route } from './route';
import { CHARTS, FREQUENCIES } from './schemas';

const key = z.string().trim().min(1).max(60);
const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const Filter = z.object({ field: key, op: z.enum(FILTER_OPS), value: z.union([scalar, z.array(scalar).max(200)]).optional(), to: scalar.optional() });
const Spec = z.object({
  dataset: key,
  filters: z.array(Filter).max(30).default([]),
  columns: z.array(key).max(40).optional(),
  groupBy: z.array(z.object({ field: key, bucket: z.enum(BUCKETS).optional() })).max(3).optional(),
  measures: z.array(z.object({ field: key.optional(), agg: z.enum(AGGS), label: z.string().trim().max(80).optional() })).max(10).optional(),
  pivot: z.boolean().optional(),
  sort: z.object({ key, dir: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});
const ReportBody = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).optional(), folder: z.string().trim().max(60).optional(), spec: Spec, chart: z.enum(CHARTS).default('table'), note: z.string().trim().max(300).optional() });
const Share = z.object({ everyone: z.boolean().default(false), sharedWith: z.array(zId).max(500).default([]) });
const Extra = z.object({ filters: z.array(Filter).max(10).default([]) });
const DashboardBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional(),
  featured: z.boolean().optional(),
  refreshSeconds: z.number().int().min(30).max(86_400).default(300),
  tiles: z.array(z.object({ reportId: zId, title: z.string().trim().max(120).optional(), chart: z.enum(CHARTS).nullable().optional(), width: z.number().int().min(1).max(3).default(1) })).max(40),
});

export const biRoutes = [
  route({ method: 'GET', path: '/datasets', permissions: [P.VIEW], handler: ({ s, user }) => s.reports.catalogue(user) }),
  route({ method: 'POST', path: '/query', permissions: [P.VIEW], status: 200, body: Spec, handler: ({ s, user, body }) => s.reports.query(user, body) }),
  route({ method: 'POST', path: '/query/drill', permissions: [P.VIEW], status: 200, body: z.object({ spec: Spec, values: z.record(scalar) }), handler: ({ s, user, body }) => s.reports.drill(user, body.spec, body.values) }),
  route({ method: 'POST', path: '/query/export', permissions: [P.VIEW], status: 200, body: z.object({ spec: Spec, format: z.enum(EXPORT_FORMATS), title: z.string().trim().min(1).max(120).default('Report') }), handler: ({ s, user, body }) => s.reports.exportAdhoc(user, body.spec, body.format, body.title) }),

  route({ method: 'GET', path: '/reports', permissions: [P.VIEW], handler: ({ s, user }) => s.reports.list(user) }),
  route({ method: 'POST', path: '/reports', permissions: [P.BUILD], body: ReportBody, handler: ({ s, user, body }) => s.reports.create(user, body) }),
  route({ method: 'GET', path: '/reports/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.reports.get(user, parseId(params.id)) }),
  route({ method: 'PUT', path: '/reports/:id', permissions: [P.BUILD], body: ReportBody, handler: ({ s, user, params, body }) => s.reports.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/reports/:id', permissions: [P.BUILD], handler: ({ s, user, params }) => s.reports.archive(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/reports/:id/run', permissions: [P.VIEW], status: 200, body: Extra, handler: ({ s, user, params, body }) => s.reports.run(user, parseId(params.id), body.filters) }),
  route({ method: 'POST', path: '/reports/:id/export', permissions: [P.VIEW], status: 200, body: Extra.extend({ format: z.enum(EXPORT_FORMATS) }), handler: ({ s, user, params, body }) => s.reports.export(user, parseId(params.id), body.format, body.filters) }),
  route({ method: 'GET', path: '/reports/:id/export/:format', permissions: [P.VIEW], handler: ({ s, user, params }) => s.reports.export(user, parseId(params.id), z.enum(EXPORT_FORMATS).parse(params.format)) }),
  route({ method: 'GET', path: '/reports/:id/versions/:version', permissions: [P.VIEW], handler: ({ s, user, params }) => s.reports.versionSpec(user, parseId(params.id), Number(params.version)) }),
  route({ method: 'POST', path: '/reports/:id/rollback', permissions: [P.BUILD], status: 200, body: z.object({ version: z.number().int().min(1) }), handler: ({ s, user, params, body }) => s.reports.rollback(user, parseId(params.id), body.version) }),
  route({ method: 'PUT', path: '/reports/:id/share', permissions: [P.BUILD], body: Share, handler: ({ s, user, params, body }) => s.reports.share(user, parseId(params.id), body) }),
  route({
    method: 'PUT',
    path: '/reports/:id/schedule',
    permissions: [P.BUILD],
    body: z.object({ frequency: z.enum(FREQUENCIES).nullable(), hour: z.number().int().min(0).max(23).default(7), recipients: z.array(zId).max(100).default([]), emails: z.array(z.string().trim().toLowerCase().email()).max(50).default([]) }),
    handler: ({ s, user, params, body }) => s.reports.schedule(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/reports/:id/access-log', permissions: [P.VIEW], handler: ({ s, user, params }) => s.reports.accessLog(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/schedules/run', permissions: [P.ADMIN], status: 200, handler: ({ s, user }) => s.reports.deliverDue(user.organisationId) }),

  route({ method: 'GET', path: '/dashboards', permissions: [P.VIEW], handler: ({ s, user }) => s.dashboards.list(user) }),
  route({ method: 'POST', path: '/dashboards', permissions: [P.BUILD], body: DashboardBody, handler: ({ s, user, body }) => s.dashboards.save(user, null, body) }),
  route({ method: 'PUT', path: '/dashboards/:id', permissions: [P.BUILD], body: DashboardBody, handler: ({ s, user, params, body }) => s.dashboards.save(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/dashboards/:id', permissions: [P.BUILD], handler: ({ s, user, params }) => s.dashboards.remove(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/dashboards/:id/run', permissions: [P.VIEW], handler: ({ s, user, params }) => s.dashboards.run(user, parseId(params.id)) }),
  route({ method: 'PUT', path: '/dashboards/:id/share', permissions: [P.BUILD], body: Share, handler: ({ s, user, params, body }) => s.dashboards.share(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/dashboards/:id/export/:format', permissions: [P.VIEW], handler: ({ s, user, params }) => s.dashboards.export(user, parseId(params.id), z.enum(['xls', 'doc']).parse(params.format)) }),

  route({ method: 'GET', path: '/analytics/turnaround', permissions: [P.ADMIN], query: z.object({ from: zDate, to: zDate }), handler: ({ s, user, query }) => s.analytics.turnaround(user, query.from, query.to) }),
  route({ method: 'GET', path: '/analytics/customer-risk', permissions: [P.VIEW], handler: ({ s, user }) => s.analytics.customerRisk(user) }),
  route({ method: 'GET', path: '/analytics/customer-segments', permissions: [P.VIEW], query: z.object({ k: z.coerce.number().int().min(2).max(8).default(4) }), handler: ({ s, user, query }) => s.analytics.customerSegments(user, query.k) }),
];
