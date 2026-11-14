import { z } from 'zod';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, zDate, zId } from '../common/validation';
import { route } from '../http/router';
import { layout } from '../modules/communication/email.service';
import { TEMPLATE_KEYS } from '../modules/communication/email-templates';

const Template = z.object({ subject: z.string().trim().min(3).max(200), intro: z.string().trim().max(1000), body: z.string().trim().max(5000), footer: z.string().trim().max(500) });

const today = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const scimUser = z
  .object({
    userName: z.string().max(300).optional(),
    externalId: z.string().max(300).optional(),
    active: z.boolean().optional(),
    displayName: z.string().max(300).optional(),
    name: z.object({ formatted: z.string().max(300).optional(), givenName: z.string().max(200).optional(), familyName: z.string().max(200).optional() }).partial().optional(),
    emails: z.array(z.object({ value: z.string().max(300).optional(), primary: z.boolean().optional(), type: z.string().max(50).optional() })).max(20).optional(),
    phoneNumbers: z.array(z.object({ value: z.string().max(50).optional(), primary: z.boolean().optional(), type: z.string().max(50).optional() })).max(20).optional(),
  })
  .passthrough();

/** SCIM 2.0 endpoints for identity providers (bearer token; see ScimService). */
const scim = [
  route({ method: 'GET', path: '/organisation/scim', permissions: [P.ORG_MANAGE], handler: ({ s, user }) => s.scim.settings(user) }),
  route({
    method: 'PATCH',
    path: '/organisation/scim',
    permissions: [P.ORG_MANAGE, P.USERS_MANAGE],
    body: z.object({ enabled: z.boolean(), defaultRoleIds: z.array(zId).max(20), rotateToken: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.scim.configure(user, body),
  }),
  route({ method: 'GET', path: '/scim/v2/ServiceProviderConfig', public: true, handler: ({ s }) => s.scim.serviceProviderConfig() }),
  route({
    method: 'GET',
    path: '/scim/v2/Users',
    public: true,
    rateLimit: 600,
    query: z.object({ filter: z.string().max(300).optional(), startIndex: z.coerce.number().int().min(1).optional(), count: z.coerce.number().int().min(0).optional() }),
    handler: ({ s, req, query }) => s.scim.list(req.headers.get('authorization'), query),
  }),
  route({ method: 'GET', path: '/scim/v2/Users/:id', public: true, rateLimit: 600, handler: ({ s, req, params }) => s.scim.get(req.headers.get('authorization'), params.id) }),
  route({ method: 'POST', path: '/scim/v2/Users', public: true, rateLimit: 300, body: scimUser, handler: ({ s, req, body }) => s.scim.create(req.headers.get('authorization'), body) }),
  route({ method: 'PUT', path: '/scim/v2/Users/:id', public: true, rateLimit: 300, status: 200, body: scimUser, handler: ({ s, req, params, body }) => s.scim.replace(req.headers.get('authorization'), params.id, body) }),
  route({
    method: 'PATCH',
    path: '/scim/v2/Users/:id',
    public: true,
    rateLimit: 300,
    body: z.object({ Operations: z.array(z.object({ op: z.string().max(20), path: z.string().max(200).optional(), value: z.unknown().optional() })).max(50) }).passthrough(),
    handler: ({ s, req, params, body }) => s.scim.patch(req.headers.get('authorization'), params.id, body),
  }),
  route({
    method: 'DELETE',
    path: '/scim/v2/Users/:id',
    public: true,
    rateLimit: 300,
    handler: async ({ s, req, params }) => {
      await s.scim.remove(req.headers.get('authorization'), params.id);
      return new Response(null, { status: 204 });
    },
  }),
];

export const communicationRoutes = [
  // Editable wording of the procurement emails (RFQ, LPO, remittance advice).
  route({ method: 'GET', path: '/email-templates', permissions: [P.PROCUREMENT_MANAGE], handler: ({ s, user }) => s.emailTemplates.list(user) }),
  route({ method: 'PATCH', path: '/email-templates/:key', permissions: [P.PROCUREMENT_MANAGE], body: Template, handler: ({ s, user, params, body }) => s.emailTemplates.save(user, z.enum(TEMPLATE_KEYS).parse(params.key), body) }),
  route({ method: 'POST', path: '/email-templates/:key/preview', permissions: [P.PROCUREMENT_MANAGE], body: Template, handler: ({ s, params, body }) => s.emailTemplates.preview(z.enum(TEMPLATE_KEYS).parse(params.key), body) }),
  route({ method: 'DELETE', path: '/email-templates/:key', permissions: [P.PROCUREMENT_MANAGE], handler: ({ s, user, params }) => s.emailTemplates.reset(user, z.enum(TEMPLATE_KEYS).parse(params.key)) }),
  ...scim,
  route({
    method: 'GET',
    path: '/emails',
    permissions: [P.USERS_MANAGE],
    query: z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    handler: async ({ s, user, query }) => ({ driver: s.email.driverName, items: await s.email.log(user.organisationId, query) }),
  }),
  route({
    method: 'POST',
    path: '/emails/test',
    permissions: [P.USERS_MANAGE],
    rateLimit: 5,
    handler: async ({ s, user }) => {
      const body = layout({ title: 'Test email from FarajaSoft', intro: `Hello ${user.name},`, paragraphs: ['If you can read this, email delivery is working.'] });
      const id = await s.email.enqueue({ organisationId: user.organisationId, to: [user.email], subject: 'FarajaSoft test email', ...body, category: 'test' });
      await s.email.deliverDue({ organisationId: user.organisationId, limit: 5 });
      return s.db.emails.findById(id, { status: 1, lastError: 1, provider: 1 }).lean();
    },
  }),

  route({ method: 'GET', path: '/report-subscriptions', permissions: [P.REPORTS_VIEW], handler: ({ s, user }) => s.notificationEmails.list(user) }),
  route({
    method: 'PATCH',
    path: '/report-subscriptions',
    permissions: [P.ORG_MANAGE],
    body: z.object({ entityId: zId, userIds: z.array(zId).max(50), dayOfMonth: z.number().int().min(1).max(28).default(5), isActive: z.boolean().default(true) }),
    handler: ({ s, user, body }) => s.notificationEmails.upsert(user, body),
  }),

  route({ method: 'GET', path: '/organisation/sso', permissions: [P.ORG_MANAGE], handler: ({ s, user }) => s.sso.settings(user) }),
  route({
    method: 'PATCH',
    path: '/organisation/sso',
    permissions: [P.ORG_MANAGE],
    body: z.object({
      enabled: z.boolean(),
      protocol: z.enum(['OIDC', 'SAML']).optional(),
      label: z.string().trim().max(60).optional(),
      saml: z.object({ entryPoint: z.string().trim().max(500), idpIssuer: z.string().trim().max(500).optional(), idpCert: z.string().max(10000) }).optional(),
      issuer: z.string().trim().max(500).default(''),
      clientId: z.string().trim().max(500).default(''),
      clientSecret: z.string().max(2000).nullable().optional(),
      allowedDomains: z.array(z.string().trim().max(200)).max(20),
      allowPasswordLogin: z.boolean(),
    }),
    handler: ({ s, user, body }) => s.sso.update(user, body),
  }),

  route({
    method: 'POST',
    path: '/collections/:customerId/send-reminder',
    status: 200,
    permissions: [P.AR_MANAGE],
    rateLimit: 30,
    body: z.object({ entityId: zId, asOf: zDate.optional(), to: z.string().trim().email().optional() }),
    handler: ({ s, user, params, body }) => s.collections.sendReminder(user, body.entityId, parseId(params.customerId), body.asOf ?? today(), body.to),
  }),
  route({
    method: 'POST',
    path: '/collections/:customerId/sms-reminder',
    status: 200,
    permissions: [P.AR_MANAGE],
    rateLimit: 30,
    body: z.object({ entityId: zId, asOf: zDate.optional(), to: z.string().trim().max(20).optional() }),
    handler: ({ s, user, params, body }) => s.collections.smsReminder(user, body.entityId, parseId(params.customerId), body.asOf ?? today(), body.to),
  }),

  // ----- Text messages (Africa's Talking) -------------------------------------------------------
  route({ method: 'GET', path: '/organisation/sms', permissions: [P.AR_VIEW], handler: ({ s, user }) => s.sms.settings(user.organisationId) }),
  route({
    method: 'PATCH',
    path: '/organisation/sms',
    permissions: [P.ORG_MANAGE],
    body: z.object({ enabled: z.boolean(), paymentConfirmations: z.boolean().default(true), approvalAlerts: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.sms.updateSettings(user, body),
  }),
  route({
    method: 'GET',
    path: '/sms',
    permissions: [P.USERS_MANAGE],
    query: z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    handler: async ({ s, user, query }) => ({ driver: s.sms.driverName, items: await s.sms.log(user.organisationId, query) }),
  }),
  route({
    method: 'POST',
    path: '/sms/test',
    permissions: [P.ORG_MANAGE],
    rateLimit: 5,
    body: z.object({ to: z.string().trim().min(9).max(20) }),
    handler: async ({ s, user, body }) => {
      const id = await s.sms.enqueue({ organisationId: user.organisationId, to: body.to, message: 'FarajaSoft test message: text messages are working.', category: 'test' });
      await s.sms.deliverDue({ organisationId: user.organisationId, limit: 5 });
      return s.db.sms.findById(id, { status: 1, lastError: 1, provider: 1, cost: 1 }).lean();
    },
  }),
  route({
    method: 'POST',
    path: '/invoices/:id/sms',
    permissions: [P.AR_MANAGE],
    rateLimit: 30,
    body: z.object({ to: z.string().trim().max(20).optional() }),
    handler: async ({ s, user, params, body }) => {
      const res = await s.portal.smsDocument(user, parseId(params.id), body);
      await s.sms.deliverDue({ organisationId: user.organisationId, limit: 5 });
      return res;
    },
  }),
];
