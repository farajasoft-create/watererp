import { z } from 'zod';
import { PERMISSIONS } from '../common/permissions';
import { zBool, zDate, zId } from '../common/validation';
import { PARTY_TYPES } from '../database/schemas';
import { route } from '../http/router';
import { ReportFilters } from '../modules/reports/reports.service';

const Filters = z.object({
  entityId: zId,
  branchIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)))
    .pipe(z.array(zId)),
  departmentId: zId.optional(),
  costCentreId: zId.optional(),
  projectId: zId.optional(),
});

const RangeQuery = Filters.extend({ from: zDate, to: zDate });
const AsOfQuery = Filters.extend({ asOf: zDate });

const filtersOf = (q: z.infer<typeof Filters>): ReportFilters => ({
  entityId: q.entityId,
  branchIds: q.branchIds,
  departmentId: q.departmentId,
  costCentreId: q.costCentreId,
  projectId: q.projectId,
});

const permissions = [PERMISSIONS.REPORTS_VIEW];

export const reportsRoutes = [
  route({
    method: 'GET',
    path: '/reports/trial-balance',
    permissions,
    query: RangeQuery,
    handler: ({ s, user, query: q }) => s.reports.trialBalance(user, filtersOf(q), q.from, q.to),
  }),
  route({
    method: 'GET',
    path: '/reports/account-activity',
    permissions,
    query: RangeQuery.extend({ accountId: zId }),
    handler: ({ s, user, query: q }) => s.reports.accountActivity(user, filtersOf(q), q.accountId, q.from, q.to),
  }),
  route({
    method: 'GET',
    path: '/reports/profit-and-loss',
    permissions,
    query: RangeQuery.extend({ byBranch: zBool.optional() }),
    handler: ({ s, user, query: q }) => s.reports.profitAndLoss(user, filtersOf(q), q.from, q.to, q.byBranch ?? false),
  }),
  route({
    method: 'GET',
    path: '/reports/balance-sheet',
    permissions,
    query: AsOfQuery,
    handler: ({ s, user, query: q }) => s.reports.balanceSheet(user, filtersOf(q), q.asOf),
  }),
  route({
    method: 'GET',
    path: '/reports/changes-in-net-assets',
    permissions,
    query: RangeQuery,
    handler: ({ s, user, query: q }) => s.reports.changesInNetAssets(user, filtersOf(q), q.from, q.to),
  }),
  route({
    method: 'GET',
    path: '/reports/dashboard',
    permissions,
    query: AsOfQuery,
    handler: ({ s, user, query: q }) => s.reports.dashboard(user, filtersOf(q), q.asOf),
  }),
  route({
    method: 'GET',
    path: '/reports/aging',
    permissions,
    query: z.object({ entityId: zId, partyType: z.enum(PARTY_TYPES), asOf: zDate }),
    handler: ({ s, user, query: q }) => s.subledgerReports.aging(user, q.partyType, q.entityId, q.asOf),
  }),
  route({
    method: 'GET',
    path: '/reports/statement',
    permissions,
    query: z.object({ entityId: zId, partyType: z.enum(PARTY_TYPES), partyId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query: q }) => s.subledgerReports.statement(user, q.partyType, q.partyId, q.entityId, q.from, q.to),
  }),
  route({
    method: 'GET',
    path: '/reports/subledger-control',
    permissions,
    query: z.object({ entityId: zId }),
    handler: ({ s, user, query: q }) => s.subledgerReports.controlCheck(user, q.entityId),
  }),
  route({
    method: 'GET',
    path: '/reports/tax',
    permissions,
    query: z.object({ entityId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query: q }) => s.tax.report(user, q.entityId, q.from, q.to),
  }),
];
