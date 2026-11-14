import { createRouter, route } from '../http/router';
import { authRoutes } from './auth';
import { commercialRoutes } from './commercial';
import { groupRoutes } from './group';
import { operationsRoutes } from './operations';
import { ledgerRoutes } from './ledger';
import { organisationRoutes } from './organisation';
import { platformRoutes } from './platform';
import { workflowRoutes } from './workflow';
import { analyticsRoutes } from './analytics';
import { attachmentRoutes } from './attachments';
import { automationRoutes } from './automation';
import { communicationRoutes } from './communication';
import { gettingPaidRoutes } from './getting-paid';
import { moneyRoutes } from './money';
import { complianceRoutes } from './compliance';
import { reportsRoutes } from './reports';
import { setupRoutes } from './setup';
import { usersRoutes } from './users';

const health = route({
  method: 'GET',
  path: '/health',
  public: true,
  handler: async ({ s }) => {
    await s.db.connection.db!.admin().ping();
    return { status: 'ok', time: new Date() };
  },
});

/**
 * Inside the platform, sign-in, passwords, sessions, single sign-on and user provisioning belong to
 * the platform; finance keeps only the caller's profile and preferences.
 */
const PLATFORM_OWNED = /^\/(auth\/(?!me$|preferences$)|scim\/|organisation\/(sso|scim)$|users\/:id\/(invite|mfa\/reset|sessions\/revoke)$)/;
const standalone = process.env.FINANCE_STANDALONE === 'true';

export const allRoutes = [health, ...authRoutes, ...organisationRoutes, ...usersRoutes, ...setupRoutes, ...ledgerRoutes, ...reportsRoutes, ...commercialRoutes, ...groupRoutes, ...operationsRoutes, ...platformRoutes, ...workflowRoutes, ...analyticsRoutes, ...attachmentRoutes, ...automationRoutes, ...communicationRoutes, ...gettingPaidRoutes, ...moneyRoutes, ...complianceRoutes];

export const routes = standalone ? allRoutes : allRoutes.filter((r) => !PLATFORM_OWNED.test(r.path));

/** The whole REST API (/api/v1/*) as one fetch handler, mounted by the Next.js catch-all route. */
export const handleApi = createRouter(routes, standalone ? '/api/v1' : '/api/v1/finance');
