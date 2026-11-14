import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 12: M-Pesa resolving its own loose ends — payment prompts whose callback
 * never came (STK query), unconfirmed payouts (transaction status) and the disbursement float
 * (account balance, low-balance alerts, releases the float cannot cover).
 */

const PASSWORD = 'Password1234';

describe('M-Pesa status and balance queries (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let mpesaBank: string;
  let secret: string;
  let supplier: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let stkAnswer: 'paid' | 'cancelled' | 'processing' = 'paid';
  let dropPayouts = false;
  let daraja: Server;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const callback = (path: string, body: object) => api().post(`/api/v1/mpesa/callbacks/${secret}/${path}`).send(body);
  const backdate = async (collection: 'mobilemoneytransactions' | 'mobilemoneypayouts', id: string, seconds: number, field = 'createdAt') => {
    const { db } = await getServices();
    await db.connection.collection(`finance_${collection}`).updateOne({ _id: new (await import('mongoose')).Types.ObjectId(id) }, { $set: { [field]: new Date(Date.now() - seconds * 1000) } });
  };

  async function postInvoice(unitPrice: string) {
    const created = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: (await customer()), date: '2026-03-10', lines: [{ description: 'Service', accountId: acc['4200'], quantity: '1', unitPrice, taxCodeId: tax.VAT16 }] }).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201)).body as { id: string; number: string };
  }
  let customerId: string | null = null;
  const customer = async () => (customerId ??= (await as(preparer).post('/customers', { code: 'ACME', name: 'Acme Ltd', currency: 'KES' }).expect(201)).body.id as string);
  const pay = async (amount: string, status = 201) => {
    const created = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-03-20', bankAccountId: mpesaBank, method: 'MOBILE_MONEY', amount }).expect(201);
    await as(preparer).post(`/payments/${created.body.id}/submit`).expect(201);
    const res = await as(reviewer).post(`/payments/${created.body.id}/approve`).expect(status);
    return { id: created.body.id as string, body: res.body };
  };

  beforeAll(async () => {
    daraja = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0];
        const send = (status: number, body: object) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/oauth/v1/generate') return send(200, { access_token: 'tok-q', expires_in: '3599' });
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        calls.push({ path, body });
        if (path === '/mpesa/stkpush/v1/processrequest') return send(200, { MerchantRequestID: 'mr', CheckoutRequestID: `ws_CO_${calls.length}`, ResponseCode: '0', CustomerMessage: 'Success' });
        if (path === '/mpesa/stkpushquery/v1/query') {
          if (stkAnswer === 'processing') return send(500, { requestId: 'x', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
          return send(200, { ResponseCode: '0', ResponseDescription: 'The service request has been accepted successsfully', ResultCode: stkAnswer === 'paid' ? '0' : '1032', ResultDesc: stkAnswer === 'paid' ? 'The service request is processed successfully.' : 'Request cancelled by user' });
        }
        if (path === '/mpesa/b2c/v3/paymentrequest' && dropPayouts) {
          dropPayouts = false;
          return req.socket.destroy();
        }
        send(200, { ConversationID: `AG_${calls.length}`, OriginatorConversationID: body.OriginatorConversationID ?? 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
      });
    });
    await new Promise<void>((resolve) => daraja.listen(0, '127.0.0.1', resolve));
    process.env.MPESA_BASE_URL = `http://127.0.0.1:${(daraja.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Queries E2E', adminName: 'Owner', email: 'owner@queries.test', password: PASSWORD, entityCode: 'KE', entityName: 'Queries Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@queries.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@queries.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@queries.test');
    reviewer = await login('rev@queries.test');
    const gl = await as(owner).post('/accounts', { code: '1140', name: 'M-Pesa', accountClass: 'ASSET', accountType: 'BANK', parentId: acc['1100'] }).expect(201);
    mpesaBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'M-Pesa', type: 'MOBILE_MONEY', glAccountId: gl.body.id, reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    const settings = await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'ck', consumerSecret: 'cs', passkey: 'pk' }).expect(200);
    secret = /callbacks\/([^/]+)\/stk$/.exec(settings.body.callbackUrls.stk)![1];
    await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa/payouts`, { enabled: true, shortCode: '600111', initiatorName: 'apiop', securityCredential: 'CRED==', lowBalanceAlert: '10000' }).expect(200);
    supplier = (await as(preparer).post('/suppliers', { code: 'FUNDI', name: 'Fundi Works', currency: 'KES', mpesaPayee: { type: 'PHONE', number: '0722000111' } }).expect(201)).body.id;
  });

  afterAll(async () => {
    delete process.env.MPESA_BASE_URL;
    await new Promise((resolve) => daraja.close(resolve));
    await closeTestApp();
  });

  describe('payment prompts whose callback never came', () => {
    it('asks M-Pesa and receipts a completed prompt, then takes the real receipt number from the late callback', async () => {
      const inv = await postInvoice('1000');
      const prompt = await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0712345678' }).expect(201);
      // Too early to ask.
      expect((await as(preparer).get(`/mpesa/transactions/${prompt.body.id}/status`).expect(200)).body.status).toBe('PENDING');
      expect(calls.some((c) => c.path === '/mpesa/stkpushquery/v1/query')).toBe(false);
      await backdate('mobilemoneytransactions', prompt.body.id, 60);
      stkAnswer = 'paid';
      expect((await as(preparer).get(`/mpesa/transactions/${prompt.body.id}/status`).expect(200)).body.status).toBe('RECEIPTED');
      expect(calls.filter((c) => c.path === '/mpesa/stkpushquery/v1/query')).toHaveLength(1);
      expect((await as(owner).get(`/invoices/${inv.id}`).expect(200)).body.paymentStatus).toBe('PAID');
      const { db } = await getServices();
      const tx = (await db.mobileMoney.findById(prompt.body.id).lean())!;
      expect(tx.transactionId).toMatch(/^STK-/);
      await callback('stk', { Body: { stkCallback: { CheckoutRequestID: tx.checkoutRequestId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1160 }, { Name: 'MpesaReceiptNumber', Value: 'QLATE00001' }] } } } }).expect(200);
      const after = (await db.mobileMoney.findById(prompt.body.id).lean())!;
      expect(after.transactionId).toBe('QLATE00001');
      expect((await db.payments.findById(after.paymentId).lean())!.reference).toBe('QLATE00001');
      expect(await db.payments.countDocuments({ partyId: after.customerId })).toBe(1);
    });

    it('marks cancelled prompts failed and waits while M-Pesa is still processing', async () => {
      const inv = await postInvoice('500');
      const a = await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0712345678', amount: '100' }).expect(201);
      await backdate('mobilemoneytransactions', a.body.id, 60);
      stkAnswer = 'processing';
      expect((await as(preparer).get(`/mpesa/transactions/${a.body.id}/status`).expect(200)).body.status).toBe('PENDING');
      // Asked at most every 30 seconds.
      await as(preparer).get(`/mpesa/transactions/${a.body.id}/status`).expect(200);
      expect(calls.filter((c) => c.path === '/mpesa/stkpushquery/v1/query')).toHaveLength(2);
      await backdate('mobilemoneytransactions', a.body.id, 40, 'queriedAt');
      stkAnswer = 'cancelled';
      const failed = (await as(preparer).get(`/mpesa/transactions/${a.body.id}/status`).expect(200)).body;
      expect(failed).toMatchObject({ status: 'FAILED', resultDescription: 'Request cancelled by user' });
    });
  });

  describe('unconfirmed payouts', () => {
    it('resolves an unconfirmed payout from M-Pesa’s transaction status', async () => {
      dropPayouts = true;
      const { id } = await pay('2000');
      const { payouts, db } = await getServices();
      await payouts.deliverDue();
      const check = (await db.payouts.findOne({ sourceId: id }).lean())!;
      expect(check.status).toBe('CHECK');
      await payouts.reconcile();
      const query = calls.filter((c) => c.path === '/mpesa/transactionstatus/v1/query').at(-1)!;
      expect(query.body).toMatchObject({ CommandID: 'TransactionStatusQuery', OriginalConversationID: check.originatorConversationId, PartyA: '600111', Initiator: 'apiop' });
      expect(String(query.body.ResultURL)).toContain(`/status-result/${check._id.toHexString()}`);
      // Asked again only after 30 minutes.
      await payouts.reconcile();
      expect(calls.filter((c) => c.path === '/mpesa/transactionstatus/v1/query')).toHaveLength(1);
      await as(reviewer).post(`/mpesa/payouts/${check._id}/check`).expect(400);

      await callback(`status-result/${check._id}`, {
        Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: 'QSTATUS001' }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'Amount', Value: 2000 }] } },
      }).expect(200);
      const done = (await db.payouts.findById(check._id).lean())!;
      expect(done).toMatchObject({ status: 'COMPLETED', transactionId: 'QSTATUS001' });
      expect((await db.bankStatementLines.findById(done.statementLineId).lean())!.status).toBe('MATCHED');
    });

    it('leaves a payout unconfirmed when M-Pesa cannot say', async () => {
      dropPayouts = true;
      const { id } = await pay('1500');
      const { payouts, db } = await getServices();
      await payouts.deliverDue();
      const check = (await db.payouts.findOne({ sourceId: id }).lean())!;
      await as(reviewer).post(`/mpesa/payouts/${check._id}/check`).expect(200);
      await callback(`status-result/${check._id}`, { Result: { ResultType: 0, ResultCode: 2032, ResultDesc: 'Transaction not found' } }).expect(200);
      expect((await db.payouts.findById(check._id).lean())!).toMatchObject({ status: 'CHECK', note: 'Status check: Transaction not found' });
    });
  });

  describe('the float', () => {
    it('records the balance, alerts approvers when it is low and refuses releases it cannot cover', async () => {
      const { payouts, db } = await getServices();
      await payouts.reconcile();
      expect(calls.some((c) => c.path === '/mpesa/accountbalance/v1/query' && c.body.PartyA === '600111')).toBe(true);
      await callback('balance-result', {
        Result: { ResultType: 0, ResultCode: 0, ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|900.00|900.00|0.00|0.00&Utility Account|KES|6000.00|6000.00|0.00|0.00&Charges Paid Account|KES|-120.00|-120.00|0.00|0.00' }] } },
      }).expect(200);
      const settings = (await as(owner).get(`/bank-accounts/${mpesaBank}/mpesa`).expect(200)).body;
      expect(settings.payouts.balance).toMatchObject({ available: '6000' });
      expect(settings.payouts.balance.accounts).toHaveLength(3);
      const notes = await db.notifications.find({ kind: 'mpesa_low_balance' }).lean();
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].body).toContain('KES 6000.00 available');
      // A second report the same day does not alert again.
      await callback('balance-result', { Result: { ResultCode: 0, ResultParameters: { ResultParameter: { Key: 'AccountBalance', Value: 'Utility Account|KES|5500.00|5500.00|0.00|0.00' } } } }).expect(200);
      expect(await db.notifications.countDocuments({ kind: 'mpesa_low_balance' })).toBe(notes.length);

      const refused = await pay('6000', 400);
      expect(refused.body.message).toMatch(/float \(KES 5500\.00/);
      await pay('5000');
      // 5,000 now on its way: only 500 left.
      expect((await pay('600', 400)).body.message).toMatch(/already on its way/);
      await as(reviewer).post(`/bank-accounts/${mpesaBank}/mpesa/balance`).expect(400);
    });
  });
});
