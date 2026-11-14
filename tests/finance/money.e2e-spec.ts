import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 18: customer refunds (by bank and M-Pesa), salary runs paid by M-Pesa,
 * M-Pesa charges booked from the tariff, card payments from the portal (Stripe checkout and signed
 * webhook), and bank feeds (pushed and pulled from Mono), against stand-in gateways.
 */

const PASSWORD = 'Password1234';

describe('Money in and out (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let opBank: string;
  let mpesaBank: string;
  let equityBank: string;
  let customer: string;
  let receipt: string;
  let creditNote: string;
  let secret: string;
  const acc: Record<string, string> = {};
  const calls: { path: string; body: Record<string, unknown>; raw: string; headers: Record<string, unknown> }[] = [];
  let gateway: Server;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  async function postDocument(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`).expect(201)).body;
  }
  async function balance(code: string, partyId?: string) {
    const { db } = await getServices();
    const [row] = await db.ledger.aggregate<{ d: { toString(): string }; c: { toString(): string } }>([
      { $match: { accountId: new Types.ObjectId(acc[code]), ...(partyId && { partyId: new Types.ObjectId(partyId) }) } },
      { $group: { _id: null, d: { $sum: '$debit' }, c: { $sum: '$credit' } } },
    ]);
    return row ? Number(row.d.toString()) - Number(row.c.toString()) : 0;
  }
  const deliver = async () => (await getServices()).payouts.deliverDue();
  const payoutResult = (originatorConversationId: string, transactionId: string) =>
    api()
      .post(`/api/v1/mpesa/callbacks/${secret}/payout-result`)
      .send({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: originatorConversationId, ConversationID: 'AG_1', TransactionID: transactionId } })
      .expect(200);

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0];
        const send = (status: number, body: object) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/oauth/v1/generate') return send(200, { access_token: 'tok', expires_in: '3599' });
        const body = (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw || '{}') as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
        calls.push({ path, body, raw, headers: req.headers });
        if (path === '/v1/checkout/sessions') return send(200, { id: `cs_test_${calls.length}`, url: `https://checkout.stripe.test/pay/cs_test_${calls.length}` });
        if (path.startsWith('/v2/accounts/acc_123/transactions')) {
          const page2 = (req.url ?? '').includes('page=2');
          return send(200, {
            status: 'successful',
            data: page2
              ? [{ id: 'mono-3', date: '2026-03-12T09:00:00Z', amount: 450000, type: 'credit', narration: 'TRANSFER FROM ACME' }]
              : [
                  { id: 'mono-1', date: '2026-03-10T09:00:00Z', amount: 120050, type: 'debit', narration: 'POS PURCHASE' },
                  { id: 'mono-2', date: '2026-03-11T09:00:00Z', amount: 5000, type: 'debit', narration: 'SMS ALERT CHARGES' },
                ],
            meta: { next: page2 ? null : `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v2/accounts/acc_123/transactions?page=2` },
          });
        }
        send(200, { ConversationID: `AG_${calls.length}`, OriginatorConversationID: body.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    process.env.MPESA_BASE_URL = base;
    process.env.STRIPE_API_BASE = base;
    process.env.MONO_API_BASE = base;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Money E2E', adminName: 'Owner', email: 'owner@money.test', password: PASSWORD, entityCode: 'KE', entityName: 'Money Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@money.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@money.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@money.test');
    reviewer = await login('rev@money.test');

    const banks = (await as(owner).get('/bank-accounts').expect(200)).body as { id: string; glAccountId: string }[];
    opBank = banks.find((b) => b.glAccountId === acc['1120'])?.id ?? (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Operating', type: 'BANK', glAccountId: acc['1120'], reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    const gl = await as(owner).post('/accounts', { code: '1140', name: 'M-Pesa', accountClass: 'ASSET', accountType: 'BANK', parentId: acc['1100'] }).expect(201);
    acc['1140'] = gl.body.id;
    mpesaBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'M-Pesa', type: 'MOBILE_MONEY', glAccountId: gl.body.id, reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    const settings = await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'ck', consumerSecret: 'cs', passkey: 'pk' }).expect(200);
    secret = /callbacks\/([^/]+)\/stk$/.exec(settings.body.callbackUrls.stk)![1];
    const eq = await as(owner).post('/accounts', { code: '1150', name: 'Equity Bank', accountClass: 'ASSET', accountType: 'BANK', parentId: acc['1100'] }).expect(201);
    equityBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Equity', type: 'BANK', glAccountId: eq.body.id, reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Wanjiru Stores', currency: 'KES', phone: '0712 345 678', email: 'pay@wanjiru.test' }).expect(201)).body.id;
  });

  afterAll(async () => {
    delete process.env.MPESA_BASE_URL;
    delete process.env.STRIPE_API_BASE;
    delete process.env.MONO_API_BASE;
    await new Promise((resolve) => gateway.close(resolve));
    await closeTestApp();
  });

  describe('customer refunds', () => {
    it('lists what a customer can be refunded', async () => {
      const r = await as(preparer).post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date: '2026-03-01', bankAccountId: opBank, amount: '1000', reference: 'OVERPAID' }).expect(201);
      await as(preparer).post(`/payments/${r.body.id}/submit`).expect(201);
      await as(preparer).post(`/payments/${r.body.id}/approve`).expect(201);
      receipt = r.body.id;
      creditNote = (await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_CREDIT', partyId: customer, date: '2026-03-02', lines: [{ description: 'Returned goods', accountId: acc['4100'], quantity: '1', unitPrice: '300' }] })).id;
      const credits = (await as(preparer).get(`/refunds/credits?customerId=${customer}&entityId=${ke}`).expect(200)).body;
      expect(credits.map((c: { type: string; available: string }) => [c.type, c.available])).toEqual([
        ['PAYMENT', '1000'],
        ['CREDIT_NOTE', '300'],
      ]);
    });

    it('pays back receipts and credit notes from the bank, clearing receivables', async () => {
      const base = { entityId: ke, partyId: customer, date: '2026-03-05', bankAccountId: opBank, reference: 'EFT-77' };
      const over = await as(preparer).post('/refunds', { ...base, sources: [{ type: 'CREDIT_NOTE', id: creditNote, amount: '400' }] }).expect(400);
      expect(over.body.message).toMatch(/exceeds the 300 available/);
      const draft = await as(preparer).post('/refunds', { ...base, sources: [{ type: 'PAYMENT', id: receipt, amount: '500' }, { type: 'CREDIT_NOTE', id: creditNote, amount: '300' }] }).expect(201);
      expect(draft.body).toMatchObject({ status: 'DRAFT', amount: '800', number: expect.stringMatching(/^RF-KE-/) });
      await as(preparer).post(`/refunds/${draft.body.id}/approve`).expect(403);
      const posted = (await as(reviewer).post(`/refunds/${draft.body.id}/approve`).expect(201)).body;
      expect(posted.status).toBe('POSTED');
      expect(await balance('1200', customer)).toBe(-500);
      expect(await balance('1120')).toBe(200);
      const credits = (await as(preparer).get(`/refunds/credits?customerId=${customer}&entityId=${ke}`).expect(200)).body;
      expect(credits.map((c: { available: string }) => c.available)).toEqual(['500']);
      // A refunded receipt or credit note cannot be voided while the refund stands.
      expect((await as(preparer).post(`/payments/${receipt}/void`, { date: '2026-03-06', reason: 'Wrong' }).expect(400)).body.message).toMatch(/refunded on RF-/);
      expect((await as(reviewer).post(`/invoices/${creditNote}/void`, { date: '2026-03-06', reason: 'Wrong' }).expect(400)).body.message).toMatch(/refunded on RF-/);

      await as(reviewer).post(`/refunds/${draft.body.id}/void`, { date: '2026-03-06', reason: 'Customer kept the credit' }).expect(201);
      expect(await balance('1200', customer)).toBe(-1300);
      expect((await as(preparer).get(`/refunds/credits?customerId=${customer}&entityId=${ke}`).expect(200)).body.map((c: { available: string }) => c.available)).toEqual(['1000', '300']);
    });

    it('refunds to the customer phone by M-Pesa, booking the M-Pesa charge from the tariff', async () => {
      await as(owner)
        .patch(`/bank-accounts/${mpesaBank}/mpesa/payouts`, {
          enabled: true,
          shortCode: '600111',
          initiatorName: 'apiop',
          securityCredential: 'ENC==',
          tariff: [{ upTo: '100', charge: '0' }, { upTo: '1500', charge: '5' }, { upTo: '250000', charge: '23' }],
          chargesAccountId: acc['6800'],
        })
        .expect(200);
      // The refund comes out of the M-Pesa account, so it needs money in it first.
      const topUp = await as(preparer).post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date: '2026-03-07', bankAccountId: mpesaBank, amount: '50000', reference: 'FLOAT' }).expect(201);
      await as(preparer).post(`/payments/${topUp.body.id}/submit`).expect(201);
      await as(preparer).post(`/payments/${topUp.body.id}/approve`).expect(201);

      const draft = await as(preparer).post('/refunds', { entityId: ke, partyId: customer, date: '2026-03-08', bankAccountId: mpesaBank, method: 'MOBILE_MONEY', sources: [{ type: 'PAYMENT', id: topUp.body.id, amount: '1200' }] }).expect(201);
      expect(draft.body.payeePhone).toBe('254712345678');
      await as(reviewer).post(`/refunds/${draft.body.id}/approve`).expect(201);
      const queued = (await as(reviewer).get(`/refunds/${draft.body.id}`).expect(200)).body.payout;
      expect(queued.status).toBe('QUEUED');
      expect(await deliver()).toEqual({ sent: 1, failed: 0 });
      expect(calls.at(-1)).toMatchObject({ path: '/mpesa/b2c/v3/paymentrequest', body: { Amount: 1200, PartyB: '254712345678' } });
      const { db } = await getServices();
      const payout = (await db.payouts.findOne({ sourceId: new Types.ObjectId(draft.body.id) }).lean())!;
      await payoutResult(payout.originatorConversationId, 'QKREF0001');
      const done = (await db.payouts.findById(payout._id).lean())!;
      expect(done.status).toBe('COMPLETED');
      expect(done.charge?.toString()).toBe('5');
      expect(await balance('6800')).toBe(5);
      const lines = await db.bankStatementLines.find({ reference: 'QKREF0001' }).sort({ amount: 1 }).lean();
      expect(lines.map((l) => [l.amount.toString(), l.status])).toEqual([
        ['-1200', 'MATCHED'],
        ['-5', 'MATCHED'],
      ]);
      const blocked = await as(reviewer).post(`/refunds/${draft.body.id}/void`, { date: '2026-03-09', reason: 'Oops' }).expect(400);
      expect(blocked.body.message).toMatch(/paid out through M-Pesa/);
    });
  });

  describe('salary runs', () => {
    const employees = [
      { employeeNumber: 'E001', employeeName: 'Achieng Otieno', phone: '0722000001', amount: '42000' },
      { employeeNumber: 'E002', employeeName: 'Kamau Njoroge', phone: '0722000002', amount: '38500' },
    ];

    it('needs a phone and whole shillings for every employee paid by M-Pesa', async () => {
      const base = { entityId: ke, period: '2026-03', date: '2026-03-28', bankAccountId: mpesaBank };
      expect((await as(owner).post('/salary-runs', { ...base, lines: [{ ...employees[0], phone: '' }] }).expect(400)).body.message).toMatch(/Safaricom number/);
      expect((await as(owner).post('/salary-runs', { ...base, lines: [{ ...employees[0], amount: '42000.50' }] }).expect(400)).body.message).toMatch(/whole shillings/);
    });

    it('pays each employee by M-Pesa with one payout and one matched statement line each', async () => {
      const run = await as(owner).post('/salary-runs', { entityId: ke, period: '2026-03', date: '2026-03-28', bankAccountId: mpesaBank, description: 'March net pay', lines: employees }).expect(201);
      expect(run.body).toMatchObject({ total: '80500', status: 'DRAFT', number: expect.stringMatching(/^SAL-KE-/) });
      await as(owner).post(`/salary-runs/${run.body.id}/approve`).expect(403);
      await as(reviewer).post(`/salary-runs/${run.body.id}/approve`).expect(201);
      expect(await balance('2145')).toBe(80500);
      expect(await deliver()).toEqual({ sent: 2, failed: 0 });
      const { db } = await getServices();
      const payouts = await db.payouts.find({ sourceId: new Types.ObjectId(run.body.id) }).sort({ sourceLine: 1 }).lean();
      expect(payouts.map((p) => [p.sourceLine, p.payeeNumber, p.amount.toString()])).toEqual([
        [1, '254722000001', '42000'],
        [2, '254722000002', '38500'],
      ]);
      // Results arrive out of order; each matches its own ledger line.
      await payoutResult(payouts[1].originatorConversationId, 'QKSAL0002');
      await payoutResult(payouts[0].originatorConversationId, 'QKSAL0001');
      const lines = await db.bankStatementLines.find({ reference: { $in: ['QKSAL0001', 'QKSAL0002'] } }).lean();
      expect(lines.filter((l) => !l.amount.toString().startsWith('-2')).every((l) => l.status === 'MATCHED')).toBe(true);
      const view = (await as(owner).get(`/salary-runs/${run.body.id}`).expect(200)).body;
      expect(view.payouts.map((p: { status: string; charge: string }) => [p.status, p.charge])).toEqual([
        ['COMPLETED', '23'],
        ['COMPLETED', '23'],
      ]);
      await as(reviewer).post(`/salary-runs/${run.body.id}/void`, { date: '2026-03-29', reason: 'Oops' }).expect(400);
    });

    it('cancels queued payouts when a run is voided before they go', async () => {
      const run = await as(owner).post('/salary-runs', { entityId: ke, period: '2026-04', date: '2026-04-28', bankAccountId: mpesaBank, lines: [employees[0]] }).expect(201);
      await as(reviewer).post(`/salary-runs/${run.body.id}/approve`).expect(201);
      await as(reviewer).post(`/salary-runs/${run.body.id}/void`, { date: '2026-04-28', reason: 'Paid by bank instead' }).expect(201);
      const view = (await as(owner).get(`/salary-runs/${run.body.id}`).expect(200)).body;
      expect(view.status).toBe('VOID');
      expect(view.payouts[0].status).toBe('CANCELLED');
    });
  });

  describe('card payments on the portal', () => {
    let token: string;
    let invoice: string;
    const sign = (payload: string, secretKey = 'whsec_testsecret0001') => {
      const t = Math.floor(Date.now() / 1000);
      return `t=${t},v1=${createHmac('sha256', secretKey).update(`${t}.${payload}`).digest('hex')}`;
    };

    it('lets the customer pay an invoice by card through the hosted checkout', async () => {
      await as(preparer).patch(`/bank-accounts/${opBank}/cards`, { enabled: true, secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'whsec_testsecret0001' }).expect(403);
      await as(owner).patch(`/bank-accounts/${opBank}/cards`, { enabled: true, secretKey: 'not-a-key', webhookSecret: 'whsec_testsecret0001' }).expect(400);
      const settings = (await as(owner).patch(`/bank-accounts/${opBank}/cards`, { enabled: true, secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'whsec_testsecret0001' }).expect(200)).body;
      expect(settings).toMatchObject({ enabled: true, hasSecretKey: true, hasWebhookSecret: true });
      expect(JSON.stringify(settings)).not.toContain('sk_test_abcdefghijkl');
      const hook = /\/cards\/webhooks\/([^/]+)$/.exec(settings.webhookUrl)![1];

      invoice = (await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-10', lines: [{ description: 'Goods', accountId: acc['4100'], quantity: '1', unitPrice: '2000' }] })).id;
      const link = await as(preparer).post(`/customers/${customer}/portal-links`, { entityId: ke }).expect(201);
      token = /portal\/([^/?]+)/.exec(link.body.url)![1];
      const view = (await api().get(`/api/v1/portal/${token}`).expect(200)).body;
      expect(view.card).toEqual({ available: true, currencies: ['KES'] });
      expect(view.open.find((o: { id: string }) => o.id === invoice).cardPayable).toBe(true);

      const start = await api().post(`/api/v1/portal/${token}/invoices/${invoice}/card`).send({}).expect(200);
      expect(start.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/pay\/cs_test_/);
      const call = calls.at(-1)!;
      expect(call.path).toBe('/v1/checkout/sessions');
      expect(call.headers.authorization).toBe('Bearer sk_test_abcdefghijkl');
      expect(call.body).toMatchObject({ mode: 'payment', 'line_items[0][price_data][currency]': 'kes', 'line_items[0][price_data][unit_amount]': '200000', customer_email: 'pay@wanjiru.test' });
      const sessionId = start.body.url.split('/').at(-1);

      const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'paid', amount_total: 200000, currency: 'kes', payment_intent: 'pi_123' } } });
      await api().post(`/api/v1/cards/webhooks/${hook}`).set('stripe-signature', sign(event, 'whsec_wrong00000001')).raw(event, 'application/json').expect(403);
      await api().post(`/api/v1/cards/webhooks/${hook}`).set('stripe-signature', sign(event)).raw(event, 'application/json').expect(200);
      await api().post(`/api/v1/cards/webhooks/${hook}`).set('stripe-signature', sign(event)).raw(event, 'application/json').expect(200);
      const doc = (await as(reviewer).get(`/invoices/${invoice}`).expect(200)).body;
      expect(doc.paymentStatus).toBe('PAID');
      const payments = (await as(reviewer).get(`/card-payments?status=PAID`).expect(200)).body;
      expect(payments).toHaveLength(1);
      const { db } = await getServices();
      expect(await db.payments.countDocuments({ method: 'CARD', reference: 'pi_123', status: 'POSTED' })).toBe(1);
    });
  });

  describe('bank feeds', () => {
    it('accepts transactions pushed with the feed token, once each', async () => {
      const settings = (await as(owner).patch(`/bank-accounts/${opBank}/feed`, { enabled: true, provider: 'PUSH' }).expect(200)).body;
      expect(settings.pushToken).toMatch(/^bf_/);
      expect((await as(owner).get(`/bank-accounts/${opBank}/feed`).expect(200)).body.pushToken).toBeUndefined();
      const url = `/api/v1/bank-feeds/${opBank}/transactions`;
      const transactions = [
        { id: 'eq-1001', date: '2026-03-01', amount: '1000', description: 'RTGS WANJIRU STORES' },
        { id: 'eq-1002', date: '2026-03-15', amount: '-350.00', description: 'LEDGER FEE' },
      ];
      await api().post(url).set('authorization', 'Bearer bf_wrong').send({ transactions }).expect(403);
      const first = (await api().post(url).set('authorization', `Bearer ${settings.pushToken}`).send({ transactions }).expect(200)).body;
      expect(first).toMatchObject({ received: 2, skipped: 0 });
      // The receipt of 1000 on 1 March is matched automatically.
      expect(first.matched).toBeGreaterThanOrEqual(1);
      const again = (await api().post(url).set('authorization', `Bearer ${settings.pushToken}`).send({ transactions }).expect(200)).body;
      expect(again).toMatchObject({ received: 0, skipped: 2 });
      const { db } = await getServices();
      const line = await db.bankStatementLines.findOne({ externalId: 'eq-1001' }).lean();
      expect(line?.status).toBe('MATCHED');
    });

    it('pulls new transactions from Mono, page by page, once each', async () => {
      await as(owner).patch(`/bank-accounts/${equityBank}/feed`, { enabled: true, provider: 'MONO' }).expect(400);
      await as(owner).patch(`/bank-accounts/${equityBank}/feed`, { enabled: true, provider: 'MONO', externalAccountId: 'acc_123', secretKey: 'live_sk_mono0001', syncFrom: '2026-03-01' }).expect(200);
      const first = (await as(owner).post(`/bank-accounts/${equityBank}/feed/sync`).expect(200)).body;
      expect(first).toMatchObject({ received: 3 });
      const monoCall = calls.find((c) => c.path.startsWith('/v2/accounts/acc_123'))!;
      expect(monoCall.headers['mono-sec-key']).toBe('live_sk_mono0001');
      const { db } = await getServices();
      const lines = await db.bankStatementLines.find({ bankAccountId: new Types.ObjectId(equityBank) }).sort({ date: 1 }).lean();
      expect(lines.map((l) => [l.externalId, l.amount.toString()])).toEqual([
        ['mono-1', '-1200.5'],
        ['mono-2', '-50'],
        ['mono-3', '4500'],
      ]);
      expect((await as(owner).post(`/bank-accounts/${equityBank}/feed/sync`).expect(200)).body).toMatchObject({ received: 0 });
      const feed = (await as(owner).get(`/bank-accounts/${equityBank}/feed`).expect(200)).body;
      expect(feed.lastSyncAt).toBeTruthy();
      expect(JSON.stringify(feed)).not.toContain('live_sk_mono0001');
    });
  });
});
