import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { routes } from '../../src/modules/finance/core/routes';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Security sweep: a signed-in user with no permissions calls every route, with the ids of real records,
 * and must be refused everywhere except self-service and reference data. A second organisation's user
 * must never reach the first organisation's records.
 */

const PASSWORD = 'Password1234';

/** Routes any signed-in user may use: their own account, reference data, their own inbox. */
const ALLOWED = new Set([
  'PATCH /auth/preferences',
  'POST /auth/logout-all',
  'POST /auth/change-password',
  'GET /auth/me',
  'POST /auth/mfa/setup',
  'POST /auth/mfa/enable',
  'POST /auth/mfa/disable',
  'POST /auth/mfa/recovery-codes',
  'GET /auth/sessions',
  'POST /auth/sessions/:id/revoke',
  'GET /organisation',
  'GET /entities',
  'GET /branches',
  'GET /dimensions',
  'GET /currencies',
  'GET /exchange-rates',
  'GET /exchange-rates/lookup',
  'GET /accounts',
  'GET /accounts/:id',
  'GET /fiscal-years',
  'GET /tax-codes',
  'GET /expense-categories',
  'GET /webhooks/events',
  'GET /approvals/inbox',
  'GET /approvals/history',
  'GET /delegations',
  'POST /delegations',
  'GET /notifications',
  'POST /notifications/read',
  'GET /directory',
  'GET /ai/status',
  // Filtered row by row to the records the caller may see (empty for this user).
  'GET /attachments/search',
]);

describe('Authorization sweep (e2e)', () => {
  let owner: string;
  let nobody: string;
  let outsider: string;
  const ids: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Authz E2E', adminName: 'Owner', email: 'owner@authz.test', password: PASSWORD, entityCode: 'KE', entityName: 'Authz Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    const entity = (await as(owner).get('/entities').expect(200)).body[0].id;
    const branch = (await as(owner).get('/branches').expect(200)).body[0].id;
    const acc: Record<string, string> = {};
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    // A role with no permissions at all.
    const role = await as(owner).post('/roles', { name: 'Nothing', description: 'No permissions', permissions: [] }).expect(201);
    await as(owner).post('/users', { name: 'Nobody', email: 'nobody@authz.test', password: PASSWORD, roleIds: [role.body.id] }).expect(201);
    nobody = await login('nobody@authz.test');

    // Real records for every kind of id a route takes.
    const customer = (await as(owner).post('/customers', { code: 'C1', name: 'Customer', currency: 'KES' }).expect(201)).body.id;
    const supplier = (await as(owner).post('/suppliers', { code: 'S1', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
    const invoice = (await as(owner).post('/invoices', { entityId: entity, branchId: branch, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-10', lines: [{ description: 'x', accountId: acc['4100'], quantity: '1', unitPrice: '100' }] }).expect(201)).body.id;
    const journal = (await as(owner).post('/journals', { entityId: entity, branchId: branch, journalDate: '2026-03-10', description: 'x', lines: [{ accountId: acc['6200'], debit: '10' }, { accountId: acc['1120'], credit: '10' }] }).expect(201)).body.id;
    const bank = (await as(owner).post('/bank-accounts', { entityId: entity, branchId: branch, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    const { db } = await getServices();
    const period = (await db.periods.findOne({ entityId: entity }).lean())!._id.toString();
    Object.assign(ids, { entity, branch, customer, supplier, invoice, journal, bank, period, role: role.body.id, account: acc['6200'] });

    // A second organisation: its admin must not reach the first one's records either.
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Other Org', adminName: 'Outsider', email: 'owner@other.test', password: PASSWORD, entityCode: 'UG', entityName: 'Other', country: 'Uganda', functionalCurrency: 'UGX', fiscalYearStart: '2026-01-01' })
      .expect(201);
    outsider = other.body.token;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  /** Fills a route's path parameters with real ids, chosen by what the path is about. */
  const fill = (path: string) =>
    path.replace(/:(\w+)/g, (_, name: string) => {
      if (name === 'secret' || name === 'token') return 'not-a-real-secret-0000000000000';
      if (name === 'code') return 'USD';
      if (/customer/i.test(name)) return ids.customer;
      if (path.startsWith('/suppliers')) return ids.supplier;
      if (path.startsWith('/customers')) return ids.customer;
      if (path.startsWith('/invoices')) return ids.invoice;
      if (path.startsWith('/journals')) return ids.journal;
      if (path.startsWith('/bank-accounts')) return ids.bank;
      if (path.startsWith('/periods')) return ids.period;
      if (path.startsWith('/roles')) return ids.role;
      if (path.startsWith('/accounts')) return ids.account;
      if (path.startsWith('/entities')) return ids.entity;
      if (path.startsWith('/branches')) return ids.branch;
      return ids.invoice;
    });
  const query = `?entityId=${'{entity}'}&from=2026-01-01&to=2026-12-31&asOf=2026-12-31`;

  it('refuses a user without permissions everywhere except self-service and reference data', async () => {
    const leaks: string[] = [];
    const statuses: Record<number, number> = {};
    // These end the caller's own sessions (or change their sign-in); they are self-service and would
    // sign the sweep out part-way.
    const ending = new Set(['POST /auth/logout-all', 'POST /auth/change-password', 'POST /auth/sessions/:id/revoke', 'POST /auth/mfa/disable', 'POST /auth/mfa/enable']);
    for (const r of routes) {
      if (r.public || r.path.startsWith('/cron') || ending.has(`${r.method} ${r.path}`)) continue;
      const key = `${r.method} ${r.path}`;
      const url = `/api/v1${fill(r.path)}${r.method === 'GET' ? query.replace('{entity}', ids.entity) : ''}`;
      const req = r.method === 'GET' ? api().get(url) : r.method === 'DELETE' ? api().delete(url) : r.method === 'PATCH' ? api().patch(url).send({}) : api().post(url).send({});
      const res = await req.set('Authorization', `Bearer ${nobody}`);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status < 300 && !ALLOWED.has(key)) leaks.push(`${key} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    // The sweep really reached the permission checks: signed in throughout, refused for lack of rights.
    expect(statuses[401] ?? 0).toBe(0);
    expect(statuses[403]).toBeGreaterThan(200);
  }, 120_000);

  it('refuses well-formed creates and approvals without the permission', async () => {
    const attempts: [string, object][] = [
      ['/customers', { code: 'X1', name: 'X', currency: 'KES' }],
      ['/suppliers', { code: 'X2', name: 'X', currency: 'KES' }],
      ['/invoices', { entityId: ids.entity, branchId: ids.branch, kind: 'SALES_INVOICE', partyId: ids.customer, date: '2026-03-10', lines: [{ description: 'x', accountId: ids.account, quantity: '1', unitPrice: '1' }] }],
      ['/payments', { entityId: ids.entity, kind: 'RECEIPT', partyId: ids.customer, date: '2026-03-10', bankAccountId: ids.bank, amount: '1' }],
      ['/journals', { entityId: ids.entity, branchId: ids.branch, journalDate: '2026-03-10', description: 'x', lines: [{ accountId: ids.account, debit: '1' }, { accountId: ids.account, credit: '1' }] }],
      [`/journals/${ids.journal}/submit`, {}],
      [`/invoices/${ids.invoice}/submit`, {}],
      ['/users', { name: 'Y', email: 'y@authz.test', password: PASSWORD, roleIds: [] }],
      ['/roles', { name: 'Escalate', permissions: ['org.manage'] }],
    ];
    for (const [url, body] of attempts) {
      const res = await as(nobody).post(url, body);
      expect([url, res.status]).toEqual([url, 403]);
    }
  });

  it('never returns stored secrets, even to the administrator', async () => {
    const { db } = await getServices();
    const { encryptSecret } = await import('../../src/modules/finance/core/common/totp');
    // Every kind of secret the system stores.
    const gl = await as(owner).post('/accounts', { code: '1140', name: 'M-Pesa', accountClass: 'ASSET', accountType: 'BANK', parentId: (await db.accounts.findOne({ code: '1100' }).lean())!._id.toString() }).expect(201);
    const mpesa = (await as(owner).post('/bank-accounts', { entityId: ids.entity, branchId: ids.branch, name: 'M-Pesa', type: 'MOBILE_MONEY', glAccountId: gl.body.id }).expect(201)).body.id;
    await api().patch(`/api/v1/bank-accounts/${mpesa}/mpesa`).set('Authorization', `Bearer ${owner}`).send({ enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'SECRET-consumer-key', consumerSecret: 'SECRET-consumer-secret', passkey: 'SECRET-passkey' }).expect(200);
    await api().patch(`/api/v1/bank-accounts/${mpesa}/mpesa/payouts`).set('Authorization', `Bearer ${owner}`).send({ enabled: true, shortCode: '600111', initiatorName: 'api', securityCredential: 'SECRET-security-credential' }).expect(200);
    await db.organisations.updateOne({}, { 'settings.sso.clientSecret': encryptSecret('SECRET-sso-client') });
    await db.bankAccounts.updateMany({}, { 'card.enabled': true, 'card.secretKey': encryptSecret('SECRET-card-key'), 'card.webhookSecret': encryptSecret('SECRET-card-hook'), 'feed.secretKey': encryptSecret('SECRET-feed-key'), 'feed.pushTokenHash': 'SECRET-feed-token-hash' });
    const service = await as(owner).post('/service-accounts', { name: 'Integration', roleIds: [ids.role] }).expect(201);
    const key = (await as(owner).post(`/service-accounts/${service.body.id}/keys`, { name: 'k' }).expect(201)).body;
    const plainKey = String(key.key ?? key.token ?? key.apiKey ?? '');
    const owners = await db.users.find({}, { passwordHash: 1 }).lean();

    const needles = ['SECRET-', ...(plainKey ? [plainKey] : []), ...owners.map((u) => u.passwordHash).filter(Boolean)];
    const fields = ['"passwordHash"', '"tokenHash"', '"cmcKey"', '"consumerKey"', '"consumerSecret"', '"passkey"', '"securityCredential"', '"clientSecret"', '"recoveryCodes"', '"pendingSecret"', '"hash"', '"secretKey"', '"webhookSecret"', '"pushTokenHash"'];
    const found: string[] = [];
    for (const r of routes) {
      if (r.public || r.method !== 'GET' || r.path.startsWith('/cron')) continue;
      const path = r.path.includes('/bank-accounts/:id') ? r.path.replace(':id', mpesa) : fill(r.path);
      const res = await as(owner).get(`${path}${query.replace('{entity}', ids.entity)}`);
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
      for (const n of needles) if (text.includes(n)) found.push(`${r.path} contains a secret value`);
      // A field may appear only as "[redacted]" (the audit trail records that it changed).
      for (const f of fields) if (text.replaceAll(`${f}:"[redacted]"`, '').includes(f)) found.push(`${r.path} has field ${f}`);
    }
    expect(found).toEqual([]);
  }, 120_000);

  it('never lets another organisation reach these records', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      // Only routes that take a record id (a currency code is the caller's own setting).
      if (r.public || r.path.startsWith('/cron') || !r.path.includes(':') || r.path.includes(':code')) continue;
      const key = `${r.method} ${r.path}`;
      const url = `/api/v1${fill(r.path)}${r.method === 'GET' ? query.replace('{entity}', ids.entity) : ''}`;
      const req = r.method === 'GET' ? api().get(url) : r.method === 'DELETE' ? api().delete(url) : r.method === 'PATCH' ? api().patch(url).send({}) : api().post(url).send({});
      const res = await req.set('Authorization', `Bearer ${outsider}`);
      // A success with nothing in it reveals nothing; anything else is a leak.
      const body = res.body as unknown;
      const empty = body === null || body === undefined || body === '' || (Array.isArray(body) && !body.length) || (typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as { items?: unknown[] }).items) && !(body as { items: unknown[] }).items.length);
      if (res.status < 300 && !(r.method === 'GET' && empty)) leaks.push(`${key} → ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
    }
    // And lists scoped by the first organisation's entity return nothing of it.
    const lists = ['/invoices?kind=SALES_INVOICE', '/journals', '/customers', '/payments?kind=RECEIPT'];
    for (const l of lists) {
      const res = await as(outsider).get(`${l}${l.includes('?') ? '&' : '?'}entityId=${ids.entity}`);
      const body = res.body as { items?: unknown[] } | unknown[];
      const items = Array.isArray(body) ? body : (body?.items ?? []);
      if (res.status < 300 && items.length) leaks.push(`${l} returned ${items.length} records`);
    }
    expect(leaks).toEqual([]);
  }, 120_000);
});
