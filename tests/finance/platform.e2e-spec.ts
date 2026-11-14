import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 5: API keys and service accounts, idempotency, OpenAPI, webhooks with a
 * transactional outbox, bulk import and export, the approval workflow engine (multi-step, delegation,
 * escalation, notifications), analytics (warehouse, executive dashboard, cash flow, forecast,
 * exceptions) and non-controlling interests on consolidation.
 */

const PASSWORD = 'Password1234';

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

describe('Enterprise platform (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let manager: string;
  let ownerId: string;
  let managerId: string;
  let ke: string;
  let hq: string;
  const acc: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  // A local webhook receiver; responds 500 while `failing` is set.
  let server: Server;
  let hookUrl: string;
  let failing = false;
  const received: Received[] = [];

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    delete: (url: string) => api().delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const journal = (amount: string, overrides: Record<string, unknown> = {}, debit = '6200', credit = '1120') => ({
    entityId: ke,
    branchId: hq,
    journalDate: '2026-03-15',
    description: `Journal ${amount}`,
    lines: [
      { accountId: acc[debit], debit: amount },
      { accountId: acc[credit], credit: amount },
    ],
    ...overrides,
  });
  async function submitJournal(body: object) {
    const created = await as(preparer).post('/journals', body).expect(201);
    await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
    return created.body.id as string;
  }
  async function postJournal(body: object) {
    const id = await submitJournal(body);
    await as(reviewer).post(`/journals/${id}/approve`, { post: true }).expect(201);
    return id;
  }
  const cron = () => api().get('/api/v1/cron/run').set('Authorization', `Bearer ${process.env.CRON_SECRET}`);

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-cron-secret-0123456789';
    await createTestApp();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = failing ? 500 : 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Platform E2E', adminName: 'Owner', email: 'owner@platform.test', password: PASSWORD, entityCode: 'KE', entityName: 'Platform Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ownerId = (await as(owner).get('/auth/me').expect(200)).body.id;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const r of (await as(owner).get('/roles').expect(200)).body) roleIds[r.name] = r.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@platform.test', password: PASSWORD, roleIds: [roleIds['Accountant']] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@platform.test', password: PASSWORD, roleIds: [roleIds['Finance Reviewer']] }).expect(201);
    managerId = (await as(owner).post('/users', { name: 'Manager', email: 'mgr@platform.test', password: PASSWORD, roleIds: [roleIds['Branch Manager']] }).expect(201)).body.id;
    preparer = await login('prep@platform.test');
    reviewer = await login('rev@platform.test');
    manager = await login('mgr@platform.test');
  });

  afterAll(async () => {
    server.close();
    await closeTestApp();
  });

  describe('API keys and service accounts', () => {
    let accountId: string;
    let keyId: string;
    let key: string;

    it('issues a key to a service account that acts under its roles', async () => {
      accountId = (await as(owner).post('/service-accounts', { name: 'ERP connector', roleIds: [roleIds['Accountant']] }).expect(201)).body.id;
      const issued = await as(owner).post(`/service-accounts/${accountId}/keys`, { name: 'Production' }).expect(201);
      key = issued.body.key;
      keyId = issued.body.id;
      expect(key).toMatch(/^fsk_/);
      expect(issued.body.hash).toBeUndefined();
      const listed = await as(owner).get('/service-accounts').expect(200);
      expect(listed.body[0].keys[0]).toMatchObject({ prefix: key.slice(0, 12) });
      expect(JSON.stringify(listed.body)).not.toContain(key);

      await as(key).get('/accounts').expect(200);
      const created = await as(key).post('/journals', journal('250')).expect(201);
      expect(created.body.source).toBe('API');
      // Accountants cannot approve, and neither can their service account.
      await as(key).post(`/journals/${created.body.id}/approve`).expect(403);
    });

    it('keeps service accounts out of the user list and away from password sign-in', async () => {
      const users = await as(owner).get('/users').expect(200);
      expect(users.body.some((u: { name: string }) => u.name === 'ERP connector')).toBe(false);
      const account = (await as(owner).get('/service-accounts').expect(200)).body[0];
      await api().post('/api/v1/auth/login').send({ email: account.email, password: PASSWORD }).expect(401);
    });

    it('refuses roles that could take over the tenant', async () => {
      const res = await as(owner).post('/service-accounts', { name: 'Too powerful', roleIds: [roleIds['Administrator']] }).expect(400);
      expect(res.body.message).toMatch(/cannot hold/);
    });

    it('rejects revoked keys', async () => {
      await as(owner).post(`/api-keys/${keyId}/revoke`).expect(201);
      await as(key).get('/accounts').expect(401);
    });

    it('requires integrations.manage', async () => {
      await as(preparer).get('/service-accounts').expect(403);
    });
  });

  describe('idempotency and API description', () => {
    it('replays a retried write instead of running it twice', async () => {
      const body = { code: 'IDEM', name: 'Idempotent Ltd', currency: 'KES' };
      const first = await as(preparer).post('/customers', body).set('Idempotency-Key', 'cust-001').expect(201);
      const second = await as(preparer).post('/customers', body).set('Idempotency-Key', 'cust-001').expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      const reused = await as(preparer).post('/customers', { ...body, name: 'Different' }).set('Idempotency-Key', 'cust-001').expect(422);
      expect(reused.body.message).toMatch(/different request/);
    });

    it('lets a failed request be retried with the same key', async () => {
      await as(preparer).post('/customers', { code: 'RETRY', name: 'Retry Ltd', currency: 'XXX' }).set('Idempotency-Key', 'cust-002').expect(400);
      await as(preparer).post('/customers', { code: 'RETRY', name: 'Retry Ltd', currency: 'XXX' }).set('Idempotency-Key', 'cust-002').expect(400);
    });

    it('publishes an OpenAPI description generated from the routes', async () => {
      const res = await api().get('/api/v1/openapi.json').expect(200);
      expect(res.body.openapi).toBe('3.1.0');
      const create = res.body.paths['/journals'].post;
      expect(create.requestBody.content['application/json'].schema.properties.lines.type).toBe('array');
      expect(create['x-permissions']).toEqual(['journal.create']);
      expect(res.body.paths['/invoices/{id}/approve']).toBeDefined();
      expect(res.body.paths['/cron/run']).toBeUndefined();
    });
  });

  describe('webhooks', () => {
    let endpointId: string;
    let secret: string;

    it('signs and delivers events from committed changes only', async () => {
      const created = await as(owner).post('/webhooks', { url: hookUrl, events: ['journal.*'], description: 'ERP' }).expect(201);
      endpointId = created.body.id;
      secret = created.body.secret;
      expect(secret).toMatch(/^whsec_/);
      expect((await as(owner).get('/webhooks').expect(200)).body[0].secret).toBeUndefined();

      // A rejected request writes nothing, so it queues nothing.
      await as(preparer).post('/journals', journal('100', { lines: [{ accountId: acc['6200'], debit: '100' }, { accountId: acc['1120'], credit: '90' }] })).expect(400);
      const { db } = await getServices();
      expect(await db.webhookDeliveries.countDocuments({ endpointId })).toBe(0);

      await postJournal(journal('400'));
      const due = await db.webhookDeliveries.find({ endpointId }).lean();
      expect(due.map((d) => d.eventType).sort()).toEqual(['journal.approve', 'journal.create', 'journal.post', 'journal.submit']);

      const run = await cron().expect(200);
      expect(run.body.webhooks.sent).toBe(4);
      expect(received).toHaveLength(4);
      const posted = received.find((r) => r.headers['x-farajasoft-event'] === 'journal.post')!;
      const [t, v1] = String(posted.headers['x-farajasoft-signature']).split(',');
      const expected = createHmac('sha256', secret).update(`${t.slice(2)}.${posted.body}`).digest('hex');
      expect(v1.slice(3)).toBe(expected);
      expect(JSON.parse(posted.body)).toMatchObject({ type: 'journal.post', data: { recordType: 'Journal' } });
    });

    it('retries failed deliveries with back-off and records the outcome', async () => {
      failing = true;
      await postJournal(journal('500'));
      await cron().expect(200);
      const { db } = await getServices();
      const pending = await db.webhookDeliveries.find({ endpointId, status: 'PENDING' }).lean();
      expect(pending.length).toBe(4);
      expect(pending.every((d) => d.attempts === 1 && d.lastStatusCode === 500 && d.nextAttemptAt > new Date())).toBe(true);
      failing = false;
      const redelivered = await as(owner).post(`/webhooks/deliveries/${pending[0]._id}/redeliver`).expect(200);
      expect(redelivered.body.status).toBe('SUCCEEDED');
      const log = await as(owner).get(`/webhooks/deliveries?endpointId=${endpointId}`).expect(200);
      expect(log.body[0].event.type).toMatch(/^journal\./);
    });

    it('sends test events and lists the catalogue', async () => {
      const res = await as(owner).post(`/webhooks/${endpointId}/test`).expect(200);
      expect(res.body.status).toBe('SUCCEEDED');
      const events = await as(preparer).get('/webhooks/events').expect(200);
      expect(events.body.map((e: { type: string }) => e.type)).toContain('document.approve');
      await as(owner).post('/webhooks', { url: hookUrl, events: ['no.such.event'] }).expect(400);
    });

    it('protects the cron endpoint', async () => {
      await api().get('/api/v1/cron/run').set('Authorization', 'Bearer wrong').expect(401);
    });

    it('stops sending after the endpoint is deleted', async () => {
      await as(owner).delete(`/webhooks/${endpointId}`).expect(200);
      const before = received.length;
      await postJournal(journal('600'));
      await cron().expect(200);
      expect(received.length).toBe(before);
    });
  });

  describe('bulk import and export', () => {
    it('exports customers as CSV in the import format', async () => {
      const res = await api().get('/api/v1/export/customers').set('Authorization', `Bearer ${preparer}`).expect(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      expect(res.body).toMatch(/^code,name,legalName/);
      expect(res.body).toContain('IDEM,Idempotent Ltd');
    });

    it('validates a file in a dry run, then imports it row by row', async () => {
      const csv = ['code,name,currency,paymentTermsDays,defaultAccount,email', 'IDEM,Idempotent Limited,KES,45,4100,ap@idem.test', 'NEWCO,New Co,KES,30,4100,', 'BADCO,Bad Co,KES,thirty,4100,'].join('\n');
      const dry = await as(preparer).post('/import/customers', { csv, dryRun: true }).expect(200);
      expect(dry.body).toMatchObject({ dryRun: true, rows: 3, created: 1, updated: 1, errors: 1 });
      expect(dry.body.results[2]).toMatchObject({ row: 4, action: 'error' });
      expect(dry.body.results[2].message).toMatch(/whole number/);
      expect((await as(preparer).get('/customers').expect(200)).body.some((c: { code: string }) => c.code === 'NEWCO')).toBe(false);

      const real = await as(preparer).post('/import/customers', { csv, dryRun: false }).expect(200);
      expect(real.body).toMatchObject({ created: 1, updated: 1, errors: 1 });
      const customers = (await as(preparer).get('/customers').expect(200)).body;
      expect(customers.find((c: { code: string }) => c.code === 'IDEM')).toMatchObject({ name: 'Idempotent Limited', paymentTermsDays: 45 });
      expect(customers.find((c: { code: string }) => c.code === 'NEWCO').defaultAccountId).toBe(acc['4100']);
    });

    it('rejects unknown columns and unknown references', async () => {
      await as(preparer).post('/import/customers', { csv: 'code,name,currency,colour\nX,X,KES,red', dryRun: true }).expect(400);
      const res = await as(preparer).post('/import/customers', { csv: 'code,name,currency,defaultAccount\nY,Y,KES,9999', dryRun: true }).expect(200);
      expect(res.body.results[0].message).toMatch(/Unknown account 9999/);
    });

    it('exports ledger detail for BI tools', async () => {
      const res = await as(owner).get(`/export/ledger?format=json&entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('accountCode');
      await as(preparer).get('/export/ledger?format=json').expect(400);
    });
  });

  describe('approval workflow', () => {
    let ruleId: string;

    it('routes large journals through sequential steps', async () => {
      ruleId = (
        await as(owner)
          .post('/approval-rules', {
            name: 'Large journals',
            documentType: 'JOURNAL',
            minAmount: '1000000',
            steps: [
              { name: 'Finance review', approverType: 'ROLE', roleId: roleIds['Finance Reviewer'] },
              { name: 'Director sign-off', approverType: 'USER', userId: ownerId },
            ],
          })
          .expect(201)
      ).body.id;
      const sim = await as(owner).get(`/approval-rules/simulate?documentType=JOURNAL&amount=2000000`).expect(200);
      expect(sim.body.rule.name).toBe('Large journals');

      const id = await submitJournal(journal('2000000'));
      const inbox = await as(reviewer).get('/approvals/inbox').expect(200);
      expect(inbox.body.find((r: { documentId: string }) => r.documentId === id)).toMatchObject({ stepName: 'Finance review', stepNumber: 1, stepCount: 2 });
      // The owner is not on step 1.
      expect((await as(owner).get('/approvals/inbox').expect(200)).body.some((r: { documentId: string }) => r.documentId === id)).toBe(false);
      await as(owner).post(`/journals/${id}/approve`).expect(403);

      const first = await as(reviewer).post(`/journals/${id}/approve`, { comment: 'Checked' }).expect(201);
      expect(first.body.status).toBe('SUBMITTED');
      expect(first.body.approval).toMatchObject({ stepNumber: 2, stepName: 'Director sign-off' });
      await as(reviewer).post(`/journals/${id}/approve`).expect(403);
      const notes = await as(owner).get('/notifications').expect(200);
      expect(notes.body.items[0].title).toMatch(/awaits your approval/);

      const final = await as(owner).post(`/journals/${id}/approve`, { post: true }).expect(201);
      expect(final.body.status).toBe('POSTED');
      const history = await as(owner).get(`/approvals/history?documentType=JOURNAL&documentId=${id}`).expect(200);
      expect(history.body[0].status).toBe('APPROVED');
      expect(history.body[0].steps.map((s: { approvals: { userName: string }[] }) => s.approvals[0].userName)).toEqual(['Reviewer', 'Owner']);
    });

    it('keeps the default single approval below the threshold', async () => {
      const id = await submitJournal(journal('5000'));
      const res = await as(reviewer).post(`/journals/${id}/approve`).expect(201);
      expect(res.body.status).toBe('APPROVED');
    });

    it('lets a delegate act for the assigned approver', async () => {
      await as(owner).post('/delegations', { toUserId: managerId, startDate: '2026-01-01', endDate: '2030-12-31', reason: 'Leave' }).expect(201);
      const id = await submitJournal(journal('1500000'));
      await as(reviewer).post(`/journals/${id}/approve`).expect(201);
      const inbox = await as(manager).get('/approvals/inbox').expect(200);
      expect(inbox.body.find((r: { documentId: string }) => r.documentId === id)).toMatchObject({ onBehalfOf: 'Owner' });
      const res = await as(manager).post(`/journals/${id}/approve`).expect(201);
      expect(res.body.status).toBe('APPROVED');
      const history = await as(owner).get(`/approvals/history?documentType=JOURNAL&documentId=${id}`).expect(200);
      expect(history.body[0].steps[1].approvals[0]).toMatchObject({ userName: 'Manager', onBehalfOfName: 'Owner' });
      const delegations = await as(owner).get('/delegations').expect(200);
      await as(owner).post(`/delegations/${delegations.body[0].id}/end`).expect(200);
    });

    it('needs several different approvers on a parallel step', async () => {
      await as(owner)
        .post('/approval-rules', {
          name: 'Two signatures',
          documentType: 'JOURNAL',
          priority: 10,
          minAmount: '5000000',
          steps: [{ name: 'Two approvers', approverType: 'PERMISSION', requiredApprovals: 2 }],
        })
        .expect(201);
      const id = await submitJournal(journal('6000000'));
      const one = await as(reviewer).post(`/journals/${id}/approve`).expect(201);
      expect(one.body.approval).toMatchObject({ approvalsOnStep: 1, requiredOnStep: 2 });
      const two = await as(manager).post(`/journals/${id}/approve`).expect(201);
      expect(two.body.status).toBe('APPROVED');
    });

    it('escalates overdue approvals to the escalation contact', async () => {
      await as(owner).patch(`/approval-rules/${ruleId}`, {
        name: 'Large journals',
        documentType: 'JOURNAL',
        minAmount: '1000000',
        maxAmount: '5000000',
        steps: [{ name: 'Director sign-off', approverType: 'USER', userId: ownerId }],
        slaHours: 4,
        escalateToUserId: managerId,
      }).expect(200);
      const id = await submitJournal(journal('1200000'));
      // The manager cannot approve before escalation.
      await as(manager).post(`/journals/${id}/approve`).expect(403);
      const { db } = await getServices();
      await db.approvalRequests.updateOne({ documentId: id, status: 'PENDING' }, { dueAt: new Date(Date.now() - 60_000) });
      const run = await cron().expect(200);
      expect(run.body.workflow.escalated).toBe(1);
      const notes = await as(manager).get('/notifications?unread=true').expect(200);
      expect(notes.body.items.some((n: { title: string }) => n.title.startsWith('Overdue'))).toBe(true);
      await as(manager).post('/notifications/read', { ids: 'all' }).expect(200);
      expect((await as(manager).get('/notifications?unread=true').expect(200)).body.unread).toBe(0);
      const res = await as(manager).post(`/journals/${id}/approve`).expect(201);
      expect(res.body.status).toBe('APPROVED');
    });

    it('closes the request on rejection and opens a new one on resubmission', async () => {
      const id = await submitJournal(journal('2500000'));
      await as(owner).post(`/journals/${id}/reject`, { reason: 'Wrong period' }).expect(201);
      await as(preparer).post(`/journals/${id}/submit`).expect(201);
      const history = await as(owner).get(`/approvals/history?documentType=JOURNAL&documentId=${id}`).expect(200);
      expect(history.body.map((h: { status: string }) => h.status)).toEqual(['PENDING', 'REJECTED']);
      const stats = await as(owner).get('/approvals/stats').expect(200);
      expect(stats.body.find((s: { documentType: string }) => s.documentType === 'JOURNAL').approved).toBeGreaterThanOrEqual(4);
      await as(preparer).get('/approval-rules').expect(403);
    });
  });

  describe('analytics', () => {
    it('loads the warehouse and builds the executive dashboard', async () => {
      await postJournal(journal('900000', { journalDate: '2026-03-10', description: 'Cash sales' }, '1120', '4100'));
      await postJournal(journal('300000', { journalDate: '2026-03-12', description: 'Stock purchase' }, '5100', '1120'));
      const refresh = await as(owner).post('/analytics/warehouse/refresh', { full: true }).expect(200);
      expect(refresh.body.facts).toBeGreaterThan(0);
      const dash = await as(owner).get(`/analytics/executive?entityId=${ke}&asOf=2026-03-31`).expect(200);
      expect(dash.body.kpis.revenue.ytd).toBe('900000');
      expect(dash.body.kpis.grossMargin.percent).toBe('66.7');
      expect(dash.body.trend).toHaveLength(12);
      expect(dash.body.trend[11].month).toBe('2026-03');
      expect(dash.body.branches[0].revenue).toBe('900000');
      await as(preparer).get(`/analytics/executive?entityId=${ke}`).expect(200);
    });

    it('produces a cash flow statement that reconciles to cash', async () => {
      const cf = await as(owner).get(`/reports/cash-flow?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200);
      expect(cf.body.reconciles).toBe(true);
      expect(cf.body.netChange).toBe(cf.body.cashChange);
      expect(cf.body.operating.items[0]).toMatchObject({ key: 'profit' });
    });

    it('forecasts cash for 13 weeks from open items and run rate', async () => {
      const fc = await as(owner).get(`/analytics/cash-forecast?entityId=${ke}`).expect(200);
      expect(fc.body.weeks).toHaveLength(13);
      expect(fc.body.weeks[0].opening).toBe(fc.body.openingCash);
      for (const w of fc.body.weeks) expect(Number(w.closing)).toBeCloseTo(Number(w.opening) + Number(w.inflow) - Number(w.outflow), 2);
      expect(fc.body.weeks[1].opening).toBe(fc.body.weeks[0].closing);
    });

    it('flags duplicate bills and payments after bank-detail changes', async () => {
      const supplier = (await as(preparer).post('/suppliers', { code: 'DUPE', name: 'Dupe Supplies', currency: 'KES' }).expect(201)).body.id;
      const bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Main bank', glAccountId: acc['1120'] }).expect(201)).body.id;
      for (const ref of ['D-1', 'D-2']) {
        const bill = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-20', supplierInvoiceNumber: ref, lines: [{ description: 'Supplies', accountId: acc['6600'], quantity: '1', unitPrice: '45000' }] }).expect(201);
        await as(preparer).post(`/invoices/${bill.body.id}/submit`).expect(201);
        await as(reviewer).post(`/invoices/${bill.body.id}/approve`).expect(201);
      }
      await as(preparer).patch(`/suppliers/${supplier}`, { bankName: 'New Bank', bankAccountNumber: '999000111' }).expect(200);
      const pay = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-03-25', bankAccountId: bank, amount: '45000' }).expect(201);
      await as(preparer).post(`/payments/${pay.body.id}/submit`).expect(201);
      await as(reviewer).post(`/payments/${pay.body.id}/approve`).expect(201);

      const ex = await as(owner).get(`/analytics/exceptions?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200);
      const kinds = ex.body.map((e: { kind: string }) => e.kind);
      expect(kinds).toContain('duplicate_bill');
      expect(kinds).toContain('bank_change_payment');
      expect(ex.body[0].severity).toBe('high');
    });
  });

  describe('consolidation with non-controlling interest', () => {
    it('attributes profit and equity to outside shareholders', async () => {
      await as(owner).patch(`/entities/${ke}`, { ownershipPercent: '80' }).expect(200);
      const res = await as(owner).get('/consolidation?from=2026-01-01&asOf=2026-12-31').expect(200);
      const t = res.body.totals;
      const profit = Number(t.netProfit);
      expect(Number(t.profitToNonControlling)).toBeCloseTo(profit * 0.2, 1);
      expect(Number(t.profitToOwners) + Number(t.profitToNonControlling)).toBeCloseTo(profit, 2);
      expect(Number(t.equityToOwners) + Number(t.nonControllingInterest)).toBeCloseTo(Number(t.equity), 2);
      expect(t.balanced).toBe(true);
      expect(res.body.entities[0].ownershipPercent).toBe('80');
      await as(owner).patch(`/entities/${ke}`, { ownershipPercent: '120' }).expect(400);
    });
  });
});
