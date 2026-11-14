import { z } from 'zod';
import { AUTH_COOKIE, SESSION_SECONDS } from './auth';
import { escapeRegex, parseId, zDate, zId, zPage } from './common/validation';
import { route } from './http/route';
import { CORE_PERMISSIONS as P } from './manifest';
import { platformOpenApi } from './openapi';
import { workflowRoutes } from './routes-workflow';

const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false';
const optionalText = (max: number) => z.string().trim().max(max).optional();

const UserBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  phone: optionalText(20),
  isAdmin: z.boolean().optional(),
  access: z.array(z.object({ module: z.string().trim().min(1).max(20), role: z.string().trim().min(1).max(40), scope: z.array(zId).max(200).optional() })).max(50).optional(),
  active: z.boolean().optional(),
});

const authRoutes = [
  route({
    method: 'POST',
    path: '/auth/login',
    public: true,
    rateLimit: 10,
    status: 200,
    body: z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }),
    handler: async ({ s, body, ip, setCookie }) => {
      const result = await s.users.login(body.email, body.password, ip);
      if ('twoFactorRequired' in result) return result;
      setCookie(AUTH_COOKIE, result.token, { maxAge: SESSION_SECONDS, secure });
      return result.user;
    },
  }),
  route({
    method: 'POST',
    path: '/auth/login/2fa',
    public: true,
    rateLimit: 10,
    status: 200,
    body: z.object({ ticket: z.string().min(10).max(2000), code: z.string().trim().min(6).max(12) }),
    handler: async ({ s, body, ip, setCookie }) => {
      const { token, user } = await s.users.loginTwoFactor(body.ticket, body.code, ip);
      setCookie(AUTH_COOKIE, token, { maxAge: SESSION_SECONDS, secure });
      return user;
    },
  }),
  route({ method: 'POST', path: '/auth/2fa/setup', status: 200, handler: ({ s, user }) => s.users.setupTwoFactor(user) }),
  route({
    method: 'POST',
    path: '/auth/2fa/enable',
    status: 200,
    body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
    handler: async ({ s, user, body, setCookie }) => {
      const { recoveryCodes, token } = await s.users.enableTwoFactor(user, body.code);
      setCookie(AUTH_COOKIE, token, { maxAge: SESSION_SECONDS, secure });
      return { recoveryCodes };
    },
  }),
  route({ method: 'POST', path: '/auth/2fa/disable', status: 200, body: z.object({ password: z.string().min(1), code: z.string().trim().regex(/^\d{6}$/) }), handler: ({ s, user, body }) => s.users.disableTwoFactor(user, body.password, body.code) }),
  // Single sign-on with the organisation's identity provider (OpenID Connect).
  route({
    method: 'GET',
    path: '/auth/sso/start',
    public: true,
    rateLimit: 30,
    query: z.object({ org: z.string().trim().min(1).max(20), next: z.string().max(300).optional() }),
    handler: async ({ s, query, req }) => Response.redirect(await s.sso.start(query.org, new URL(req.url).origin, query.next), 302),
  }),
  route({
    method: 'GET',
    path: '/auth/sso/callback',
    public: true,
    rateLimit: 30,
    query: z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(4000) }),
    handler: async ({ s, query, req, ip }) => {
      const origin = new URL(req.url).origin;
      const { token, next } = await s.sso.callback(query.code, query.state, origin, ip);
      const res = new Response(null, { status: 302, headers: { location: `${origin}${next}` } });
      res.headers.append('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
      return res;
    },
  }),
  route({
    method: 'POST',
    path: '/auth/logout',
    public: true,
    status: 200,
    handler: ({ setCookie }) => {
      setCookie(AUTH_COOKIE, '', { maxAge: 0, secure });
      return { ok: true };
    },
  }),
  route({
    method: 'POST',
    path: '/auth/logout-everywhere',
    status: 200,
    handler: async ({ s, user, setCookie }) => {
      await s.users.logoutEverywhere(user);
      setCookie(AUTH_COOKIE, '', { maxAge: 0, secure });
      return { ok: true };
    },
  }),
  route({ method: 'GET', path: '/auth/me', handler: ({ s, user }) => s.users.me(user.id) }),
  route({
    method: 'POST',
    path: '/auth/password',
    status: 200,
    body: z.object({ current: z.string().min(1), next: z.string().min(10, 'Use at least 10 characters').max(200) }),
    handler: async ({ s, user, body, setCookie }) => {
      const { token } = await s.users.changePassword(user, body.current, body.next);
      setCookie(AUTH_COOKIE, token, { maxAge: SESSION_SECONDS, secure });
      return { ok: true };
    },
  }),
];

const settingsRoutes = [
  route({ method: 'GET', path: '/settings', permissions: [P.SETTINGS_MANAGE], handler: ({ s, user }) => s.organisation.get(user) }),
  route({
    method: 'PATCH',
    path: '/settings/general',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ name: z.string().trim().min(1).max(150), address: optionalText(300), phone: optionalText(50), email: optionalText(100), kraPin: optionalText(20), currency: z.string().trim().length(3).optional() }),
    handler: ({ s, user, body }) => s.organisation.updateGeneral(user, body),
  }),
  route({ method: 'GET', path: '/modules', handler: ({ s, user }) => s.organisation.listModules(user) }),
  route({
    method: 'PUT',
    path: '/settings/modules',
    permissions: [P.SETTINGS_MANAGE],
    status: 200,
    body: z.object({ modules: z.array(z.string().trim().min(1).max(20)).max(50) }),
    handler: ({ s, user, body }) => s.organisation.setModules(user, body.modules),
  }),
  route({
    method: 'PATCH',
    path: '/settings/ledger',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ enabled: z.boolean(), baseUrl: optionalText(300), apiKey: optionalText(300), entityId: optionalText(24), branchId: optionalText(24), mode: z.enum(['DRAFT', 'SUBMIT', 'POST']).default('SUBMIT') }),
    handler: ({ s, user, body }) => s.organisation.updateLedger(user, body),
  }),
  route({
    method: 'POST',
    path: '/settings/ledger/lookup',
    permissions: [P.SETTINGS_MANAGE],
    status: 200,
    body: z.object({ baseUrl: optionalText(300), apiKey: optionalText(300), entityId: optionalText(24) }),
    handler: ({ s, user, body }) => s.ledger.remote.lookup(user.organisationId, body),
  }),
  /** Postable ledger accounts, for every module's account-mapping screen. */
  route({ method: 'GET', path: '/ledger/accounts', handler: ({ s, user }) => s.ledger.accounts(user.organisationId) }),
  route({
    method: 'PATCH',
    path: '/settings/sms',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ provider: z.enum(['NONE', 'AFRICASTALKING']), username: optionalText(100), apiKey: optionalText(200), senderId: optionalText(11) }),
    handler: ({ s, user, body }) => s.organisation.updateSms(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/email',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ enabled: z.boolean(), host: optionalText(200), port: z.number().int().min(1).max(65535).default(587), secure: z.boolean().default(false), username: optionalText(200), password: optionalText(200), from: optionalText(200) }),
    handler: ({ s, user, body }) => s.organisation.updateEmail(user, body),
  }),
  route({ method: 'POST', path: '/settings/email/test', permissions: [P.SETTINGS_MANAGE], status: 200, body: z.object({ to: z.string().trim().email() }), handler: ({ s, user, body }) => s.email.send(user.organisationId, body.to, 'FarajaSoft test email', 'If you can read this, outgoing email works.', 'core:test') }),
  route({ method: 'GET', path: '/emails', permissions: [P.SETTINGS_MANAGE], query: z.object({ status: z.string().optional() }), handler: ({ s, user, query }) => s.email.list(user.organisationId, query.status) }),
  route({ method: 'POST', path: '/emails/deliver', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.email.deliverDue(user.organisationId) }),
  route({
    method: 'PATCH',
    path: '/settings/security',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({
      requireTwoFactor: z.enum(['NONE', 'ADMINS', 'ALL']),
      sso: z.object({ enabled: z.boolean(), issuer: optionalText(300), clientId: optionalText(300), clientSecret: optionalText(500), domains: z.array(z.string().trim().max(100)).max(20).default([]) }),
    }),
    handler: ({ s, user, body }) => s.organisation.updateSecurity(user, body),
  }),
  route({ method: 'GET', path: '/sms', permissions: [P.SETTINGS_MANAGE], query: z.object({ status: z.string().optional() }), handler: ({ s, user, query }) => s.sms.list(user.organisationId, query.status) }),
  route({ method: 'POST', path: '/sms/deliver', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.sms.deliverDue(user.organisationId) }),
];

const userRoutes = [
  /** The roles each installed module offers, for the user screen. */
  route({
    method: 'GET',
    path: '/roles',
    handler: async ({ s, user }) =>
      (await s.users.manifestsFor(user.organisationId)).map((m) => ({
        module: m.key,
        name: m.name,
        scope: m.scope ?? null,
        permissions: Object.values(m.permissions),
        roles: Object.entries(m.roles).map(([key, r]) => ({ key, label: r.label, description: r.description, permissions: r.permissions, custom: !s.manifests.find((x) => x.key === m.key)?.roles[key] })),
      })),
  }),
  /** API keys for other systems, issued to a (service) user and carrying that user's roles. */
  route({ method: 'GET', path: '/users/:id/api-keys', permissions: [P.USERS_MANAGE], handler: ({ s, user, params }) => s.users.apiKeys(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/users/:id/api-keys', permissions: [P.USERS_MANAGE], body: z.object({ label: z.string().trim().min(2).max(80), days: z.number().int().min(1).max(730).nullable().optional() }), handler: ({ s, user, params, body }) => s.users.createApiKey(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/users/:id/api-keys/:key', permissions: [P.USERS_MANAGE], handler: ({ s, user, params }) => s.users.revokeApiKey(user, parseId(params.id), parseId(params.key)) }),
  /** OpenAPI 3.1 description of every module's API, generated from the routes the server runs. */
  route({
    method: 'GET',
    path: '/openapi.json',
    public: true,
    handler: async ({ req }) => {
      const { allRoutes } = await import('./api');
      return platformOpenApi(allRoutes(), `${new URL(req.url).origin}/api/v1`);
    },
  }),
  /** Data subject requests (DPA 2019): every record held about a person, across all modules; audited. */
  route({
    method: 'POST',
    path: '/privacy/subject-search',
    permissions: [P.AUDIT_VIEW],
    status: 200,
    body: z.object({ email: z.string().trim().max(200).optional(), phone: z.string().trim().max(20).optional(), idNumber: z.string().trim().max(20).optional(), kraPin: z.string().trim().max(11).optional(), reason: z.string().trim().min(5).max(500) }),
    handler: ({ s, user, body }) => s.privacy.search(user, body),
  }),
  /** The organisation's own roles: any mix of a module's permissions, changed without a release. */
  route({ method: 'GET', path: '/roles/custom', permissions: [P.USERS_MANAGE], handler: ({ s, user }) => s.users.customRoles(user) }),
  route({
    method: 'PUT',
    path: '/roles/custom',
    permissions: [P.USERS_MANAGE],
    body: z.object({ module: z.string().trim().min(2).max(20), key: z.string().trim().min(2).max(30), label: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional(), permissions: z.array(z.string().trim().max(80)).max(200) }),
    handler: ({ s, user, body }) => s.users.saveCustomRole(user, body),
  }),
  route({ method: 'DELETE', path: '/roles/custom/:module/:key', permissions: [P.USERS_MANAGE], handler: ({ s, user, params }) => s.users.deleteCustomRole(user, params.module, params.key) }),
  route({ method: 'GET', path: '/users', permissions: [P.USERS_MANAGE], handler: ({ s, user }) => s.users.list(user) }),
  /** Names of the organisation's active users (optionally those with a role in one module), for assigning work. */
  route({
    method: 'GET',
    path: '/users/directory',
    query: z.object({ module: z.string().trim().max(20).optional() }),
    handler: async ({ s, user, query }) => {
      const rows = await s.db.users
        .find({ organisationId: user.organisationId, active: true, ...(query.module && { $or: [{ isAdmin: true }, { 'access.module': query.module }] }) }, { name: 1, email: 1 })
        .sort({ name: 1 })
        .limit(1000)
        .lean();
      return rows.map((u) => ({ id: u._id, name: u.name, email: u.email }));
    },
  }),
  route({
    method: 'POST',
    path: '/users',
    permissions: [P.USERS_MANAGE],
    body: UserBody.extend({ password: z.string().min(10, 'Use at least 10 characters').max(200) }),
    handler: ({ s, user, body }) => s.users.create(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/users/:id',
    permissions: [P.USERS_MANAGE],
    body: UserBody.extend({ password: z.string().min(10, 'Use at least 10 characters').max(200).optional() }),
    handler: ({ s, user, params, body }) => s.users.update(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/users/:id/reset-2fa', permissions: [P.USERS_MANAGE], status: 200, handler: ({ s, user, params }) => s.users.resetTwoFactor(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/audit',
    permissions: [P.AUDIT_VIEW],
    query: z.object({ entity: z.string().optional(), entityId: zId.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.audit.list(user.organisationId, query),
  }),
  /** The data warehouse: dated facts from every module, snapshotted daily by the scheduler or on demand. */
  route({ method: 'POST', path: '/warehouse/snapshot', permissions: [P.SETTINGS_MANAGE], status: 200, body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), handler: ({ s, user, body }) => s.warehouse.snapshot(user.organisationId, user.modules, body.date) }),
  route({ method: 'GET', path: '/warehouse/facts', permissions: [P.AUDIT_VIEW], query: z.object({ metric: z.string().max(60).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional() }), handler: ({ s, user, query }) => s.warehouse.facts(user, query) }),
  /** Who opened records and downloaded files, in every module. */
  route({
    method: 'GET',
    path: '/access-log',
    permissions: [P.AUDIT_VIEW],
    query: z.object({ userId: zId.optional(), module: z.string().trim().max(20).optional(), kind: z.enum(['VIEW', 'DOWNLOAD']).optional(), from: zDate.optional(), to: zDate.optional(), search: z.string().trim().max(100).optional() }),
    handler: async ({ s, user, query }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (query.userId) filter.userId = query.userId;
      if (query.module) filter.module = query.module;
      if (query.kind) filter.kind = query.kind;
      if (query.from || query.to) filter.at = { ...(query.from && { $gte: query.from }), ...(query.to && { $lt: new Date(query.to.getTime() + 86_400_000) }) };
      if (query.search) filter.path = new RegExp(escapeRegex(query.search), 'i');
      const rows = await s.db.accessLogs.find(filter).sort({ at: -1 }).limit(500).lean();
      const names = new Map((await s.db.users.find({ _id: { $in: [...new Set(rows.map((r) => String(r.userId)))] } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
      return rows.map((r) => ({ ...r, user: names.get(String(r.userId)) ?? '' }));
    },
  }),
];

const health = route({
  method: 'GET',
  path: '/health',
  public: true,
  handler: async ({ s }) => {
    await s.db.connection.db!.admin().ping();
    return { status: 'ok', time: new Date(), modules: s.manifests.map((m) => m.key) };
  },
});

export const coreRoutes = [health, ...authRoutes, ...settingsRoutes, ...userRoutes, ...workflowRoutes];
