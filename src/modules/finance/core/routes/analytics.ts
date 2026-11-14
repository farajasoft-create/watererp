import { z } from 'zod';
import { PERMISSIONS as P } from '../common/permissions';
import { zDate, zDecimal, zId } from '../common/validation';
import { route } from '../http/router';

const today = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export const analyticsRoutes = [
  route({
    method: 'GET',
    path: '/analytics/executive',
    permissions: [P.ANALYTICS_VIEW],
    query: z.object({ entityId: zId, asOf: zDate.optional() }),
    handler: ({ s, user, query }) => s.analytics.executive(user, query.entityId, query.asOf ?? today()),
  }),
  route({
    method: 'GET',
    path: '/analytics/cash-forecast',
    permissions: [P.ANALYTICS_VIEW],
    query: z.object({ entityId: zId, weeks: z.coerce.number().int().min(4).max(26).optional(), minimumCash: zDecimal.optional() }),
    handler: ({ s, user, query }) => s.analytics.forecast(user, query.entityId, { weeks: query.weeks, minimumCash: query.minimumCash }),
  }),
  /** The forecast under what-if assumptions, next to the base case. */
  route({
    method: 'POST',
    path: '/analytics/cash-forecast/scenario',
    status: 200,
    permissions: [P.ANALYTICS_VIEW],
    body: z.object({
      entityId: zId,
      weeks: z.number().int().min(4).max(26).optional(),
      minimumCash: zDecimal.optional(),
      delayDays: z.number().int().min(-60).max(180).optional(),
      receiptsPercent: z.number().min(-100).max(200).optional(),
      paymentsPercent: z.number().min(-100).max(200).optional(),
      items: z.array(z.object({ date: zDate, amount: zDecimal, description: z.string().trim().max(200).default('') })).max(50).default([]),
    }),
    handler: async ({ s, user, body }) => {
      const { entityId, weeks, minimumCash, ...scenario } = body;
      const [base, adjusted] = await Promise.all([s.analytics.forecast(user, entityId, { weeks, minimumCash }), s.analytics.forecast(user, entityId, { weeks, minimumCash, scenario })]);
      return { base, scenario: adjusted };
    },
  }),
  route({
    method: 'GET',
    path: '/analytics/exceptions',
    permissions: [P.ANALYTICS_VIEW],
    query: z.object({ entityId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query }) => s.analytics.exceptions(user, query.entityId, query.from, query.to),
  }),
  route({
    method: 'GET',
    path: '/reports/cash-flow',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query }) => s.analytics.cashFlow(user, query.entityId, query.from, query.to),
  }),
  route({
    method: 'GET',
    path: '/reports/pack',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM') }),
    handler: async ({ s, user, query }) => {
      const pack = await s.pack.build(user, query.entityId, query.month);
      await s.audit.log(user, { action: 'report.pack', recordType: 'LegalEntity', recordId: query.entityId, summary: `Generated the ${query.month} management pack` });
      return pack;
    },
  }),
  route({
    method: 'GET',
    path: '/analytics/warehouse',
    permissions: [P.ANALYTICS_VIEW],
    handler: async ({ s, user }) => (await s.db.warehouseState.findOne({ organisationId: user.organisationId }).lean()) ?? { facts: 0, lastRefreshedAt: null },
  }),
  route({
    method: 'POST',
    path: '/analytics/warehouse/refresh',
    status: 200,
    permissions: [P.ANALYTICS_VIEW],
    rateLimit: 6,
    body: z.object({ full: z.boolean().default(false) }),
    handler: ({ s, user, body }) => s.warehouse.refresh(user.organisationId, { full: body.full }),
  }),
];
