import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 11: paying suppliers and reimbursing expense claims through M-Pesa
 * (B2C and B2B) against a stand-in Daraja server.
 */

const PASSWORD = 'Password1234';

describe('M-Pesa payouts (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let mpesaBank: string;
  let secret: string;
  const acc: Record<string, string> = {};
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let mode: 'ok' | 'refuse' | 'drop' = 'ok';
  let daraja: Server;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const supplier = async (code: string, mpesaPayee: object | null) => (await as(preparer).post('/suppliers', { code, name: `${code} Ltd`, currency: 'KES', mpesaPayee }).expect(201)).body.id as string;
  /** A supplier payment by M-Pesa, prepared, submitted and (attempted to be) approved. */
  const pay = async (partyId: string, amount: string, approveStatus = 201) => {
    const created = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId, date: '2026-03-20', bankAccountId: mpesaBank, method: 'MOBILE_MONEY', amount, reference: `PAY-${amount}` }).expect(201);
    await as(preparer).post(`/payments/${created.body.id}/submit`).expect(201);
    const approved = await as(reviewer).post(`/payments/${created.body.id}/approve`).expect(approveStatus);
    return { id: created.body.id as string, approved: approved.body };
  };
  const payout = async (sourceId: string) => (await as(reviewer).get(`/mpesa/payouts/by-source/${sourceId}`).expect(200)).body;
  const deliver = async () => (await getServices()).payouts.deliverDue();
  const result = (originatorConversationId: string, ok: boolean, transactionId = 'QK00000000') =>
    api()
      .post(`/api/v1/mpesa/callbacks/${secret}/payout-result`)
      .send({ Result: { ResultType: 0, ResultCode: ok ? 0 : 2001, ResultDesc: ok ? 'The service request is processed successfully.' : 'The initiator information is invalid.', OriginatorConversationID: originatorConversationId, ConversationID: 'AG_1', TransactionID: transactionId } });

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
        if (path === '/oauth/v1/generate') return send(200, { access_token: 'tok-p', expires_in: '3599' });
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        calls.push({ path, body });
        if (mode === 'drop') {
          mode = 'ok';
          return req.socket.destroy();
        }
        if (mode === 'refuse') {
          mode = 'ok';
          return send(400, { requestId: 'x', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' });
        }
        send(200, { ConversationID: `AG_${calls.length}`, OriginatorConversationID: body.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
      });
    });
    await new Promise<void>((resolve) => daraja.listen(0, '127.0.0.1', resolve));
    process.env.MPESA_BASE_URL = `http://127.0.0.1:${(daraja.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Payouts E2E', adminName: 'Owner', email: 'owner@payouts.test', password: PASSWORD, entityCode: 'KE', entityName: 'Payouts Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@payouts.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@payouts.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@payouts.test');
    reviewer = await login('rev@payouts.test');

    const gl = await as(owner).post('/accounts', { code: '1140', name: 'M-Pesa', accountClass: 'ASSET', accountType: 'BANK', parentId: acc['1100'] }).expect(201);
    mpesaBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'M-Pesa', type: 'MOBILE_MONEY', glAccountId: gl.body.id, reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    const settings = await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'ck', consumerSecret: 'cs', passkey: 'pk' }).expect(200);
    secret = /callbacks\/([^/]+)\/stk$/.exec(settings.body.callbackUrls.stk)![1];
  });

  afterAll(async () => {
    delete process.env.MPESA_BASE_URL;
    await new Promise((resolve) => daraja.close(resolve));
    await closeTestApp();
  });

  it('enables payouts with an initiator and keeps the credential secret', async () => {
    await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa/payouts`, { enabled: true, shortCode: '600111', initiatorName: 'apiop' }).expect(400);
    await as(preparer).patch(`/bank-accounts/${mpesaBank}/mpesa/payouts`, { enabled: true, shortCode: '600111', initiatorName: 'apiop', securityCredential: 'ENCRYPTED==' }).expect(403);
    const res = await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa/payouts`, { enabled: true, shortCode: '600111', initiatorName: 'apiop', securityCredential: 'ENCRYPTED==', dailyLimit: '100000' }).expect(200);
    expect(res.body.payouts).toMatchObject({ enabled: true, shortCode: '600111', initiatorName: 'apiop', hasSecurityCredential: true, dailyLimit: '100000' });
    expect(JSON.stringify(res.body)).not.toContain('ENCRYPTED==');
  });

  it('validates supplier M-Pesa details', async () => {
    await as(preparer).post('/suppliers', { code: 'BAD1', name: 'Bad', currency: 'KES', mpesaPayee: { type: 'PHONE', number: '12345' } }).expect(400);
    await as(preparer).post('/suppliers', { code: 'BAD2', name: 'Bad', currency: 'KES', mpesaPayee: { type: 'PAYBILL', number: '888880' } }).expect(400);
    await as(preparer).post('/customers', { code: 'CUST1', name: 'Customer', currency: 'KES', mpesaPayee: { type: 'TILL', number: '123456' } }).expect(400);
    const id = await supplier('JUAKALI', { type: 'PHONE', number: '0722 111 222' });
    expect((await as(preparer).get(`/suppliers/${id}`).expect(200)).body.mpesaPayee).toEqual({ type: 'PHONE', number: '254722111222', accountReference: '' });
  });

  it('pays a supplier phone by B2C when the payment is released and reconciles it on success', async () => {
    const juakali = (await as(preparer).get('/suppliers').expect(200)).body.find((s: { code: string }) => s.code === 'JUAKALI').id;
    const { id, approved } = await pay(juakali, '15000');
    expect(approved.status).toBe('POSTED');
    expect((await payout(id)).status).toBe('QUEUED');
    expect(await deliver()).toEqual({ sent: 1, failed: 0 });
    const call = calls.at(-1)!;
    expect(call.path).toBe('/mpesa/b2c/v3/paymentrequest');
    expect(call.body).toMatchObject({ InitiatorName: 'apiop', SecurityCredential: 'ENCRYPTED==', CommandID: 'BusinessPayment', Amount: 15000, PartyA: '600111', PartyB: '254722111222' });
    expect(String(call.body.ResultURL)).toContain(`/mpesa/callbacks/${secret}/payout-result`);
    const sent = await payout(id);
    expect(sent.status).toBe('SENT');
    // Money in flight: the payment cannot be voided.
    await as(reviewer).post(`/payments/${id}/void`, { date: '2026-03-21', reason: 'Oops' }).expect(400);
    await result(sent.originatorConversationId, true, 'QKB2C00001').expect(200);
    await result(sent.originatorConversationId, true, 'QKB2C00001').expect(200);
    const done = await payout(id);
    expect(done).toMatchObject({ status: 'COMPLETED', transactionId: 'QKB2C00001' });
    const { db } = await getServices();
    const line = (await db.bankStatementLines.findById(done.statementLineId).lean())!;
    expect(line).toMatchObject({ status: 'MATCHED', reference: 'QKB2C00001' });
    expect(line.amount.toString()).toBe('-15000');
    expect(await db.bankStatementLines.countDocuments({ reference: 'QKB2C00001' })).toBe(1);
  });

  it('pays a paybill by B2B with the account number', async () => {
    const kplc = await supplier('KPLC', { type: 'PAYBILL', number: '888880', accountReference: '54321' });
    const { id } = await pay(kplc, '3200');
    await deliver();
    expect(calls.at(-1)!).toMatchObject({ path: '/mpesa/b2b/v1/paymentrequest', body: { CommandID: 'BusinessPayBill', PartyB: '888880', AccountReference: '54321', Amount: 3200, RecieverIdentifierType: '4' } });
    expect((await payout(id)).status).toBe('SENT');
  });

  it('refuses payments M-Pesa cannot make and enforces the daily limit', async () => {
    const nodetails = await supplier('NODETAIL', null);
    const missing = await pay(nodetails, '1000', 400);
    expect(missing.approved.message).toMatch(/M-Pesa details/);
    const juakali = (await as(preparer).get('/suppliers').expect(200)).body.find((s: { code: string }) => s.code === 'JUAKALI').id;
    expect((await pay(juakali, '1000.50', 400)).approved.message).toMatch(/whole shillings/);
    // 15,000 + 3,200 already today; 90,000 more would pass 100,000.
    const over = await pay(juakali, '90000', 400);
    expect(over.approved.message).toMatch(/daily limit/);
    expect((await as(preparer).get(`/payments/${over.id}`).expect(200)).body.status).toBe('SUBMITTED');
  });

  it('marks refused payouts failed, and lets them be retried or cancelled', async () => {
    const juakali = (await as(preparer).get('/suppliers').expect(200)).body.find((s: { code: string }) => s.code === 'JUAKALI').id;
    mode = 'refuse';
    const a = await pay(juakali, '2000');
    expect(await deliver()).toEqual({ sent: 0, failed: 1 });
    const failed = await payout(a.id);
    expect(failed).toMatchObject({ status: 'FAILED', resultDescription: 'Bad Request - Invalid PartyB' });
    await as(preparer).post(`/mpesa/payouts/${failed.id}/retry`).expect(403);
    const retried = await as(reviewer).post(`/mpesa/payouts/${failed.id}/retry`).expect(200);
    expect(retried.body.status).toBe('SENT');
    expect(retried.body.originatorConversationId).not.toBe(failed.originatorConversationId);

    // A failure reported later by the result callback.
    const b = await pay(juakali, '2500');
    await deliver();
    const sent = await payout(b.id);
    await result(sent.originatorConversationId, false).expect(200);
    expect((await payout(b.id)).status).toBe('FAILED');
    await as(reviewer).post(`/mpesa/payouts/${sent.id}/cancel`, { reason: 'Paid in cash instead' }).expect(200);
    await as(reviewer).post(`/payments/${b.id}/void`, { date: '2026-03-21', reason: 'Paid in cash' }).expect(201);
  });

  it('never resends a payout M-Pesa did not answer without confirmation', async () => {
    const juakali = (await as(preparer).get('/suppliers').expect(200)).body.find((s: { code: string }) => s.code === 'JUAKALI').id;
    mode = 'drop';
    const { id } = await pay(juakali, '1500');
    await deliver();
    const check = await payout(id);
    expect(check.status).toBe('CHECK');
    await deliver();
    expect((await payout(id)).status).toBe('CHECK');
    await as(reviewer).post(`/payments/${id}/void`, { date: '2026-03-21', reason: 'Unsure' }).expect(400);
    await as(reviewer).post(`/mpesa/payouts/${check.id}/retry`).expect(400);
    expect((await as(reviewer).post(`/mpesa/payouts/${check.id}/retry`, { confirmNotPaid: true }).expect(200)).body.status).toBe('SENT');
  });

  it('reimburses an expense claim to the claimant phone', async () => {
    const categories = (await as(preparer).get('/expense-categories').expect(200)).body as { id: string; code: string }[];
    const claim = await as(preparer)
      .post('/expense-claims', { entityId: ke, branchId: hq, title: 'Site visit', lines: [{ date: '2026-03-02', categoryId: categories.find((c) => c.code === 'TRAVEL')!.id, description: 'Matatu fares', amount: '1200', receiptReference: 'R-1' }] })
      .expect(201);
    await as(preparer).post(`/expense-claims/${claim.body.id}/submit`).expect(201);
    await as(reviewer).post(`/expense-claims/${claim.body.id}/approve`, {}).expect(201);
    const noPhone = await as(reviewer).post(`/expense-claims/${claim.body.id}/pay`, { date: '2026-03-21', bankAccountId: mpesaBank }).expect(400);
    expect(noPhone.body.message).toMatch(/Safaricom number for Preparer/);
    await as(preparer).patch('/auth/preferences', { phone: '12' }).expect(400);
    expect((await as(preparer).patch('/auth/preferences', { phone: '0733 444 555' }).expect(200)).body.phone).toBe('254733444555');
    await as(reviewer).post(`/expense-claims/${claim.body.id}/pay`, { date: '2026-03-21', bankAccountId: mpesaBank }).expect(201);
    await deliver();
    expect(calls.at(-1)!.body).toMatchObject({ CommandID: 'BusinessPayment', PartyB: '254733444555', Amount: 1200 });
    const list = (await as(reviewer).get('/mpesa/payouts').expect(200)).body as { sourceType: string; payeeNumber: string }[];
    expect(list[0]).toMatchObject({ sourceType: 'ExpenseClaim', payeeNumber: '254733••••55' });
  });
});
