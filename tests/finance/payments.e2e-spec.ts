import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 9 (getting paid): printable invoices, emailing them, the customer portal
 * and M-Pesa (STK push prompts and paybill confirmations) against a stand-in Daraja server.
 */

const PASSWORD = 'Password1234';

interface DarajaCall {
  path: string;
  body: Record<string, unknown>;
}

describe('Getting paid (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let mpesaBank: string;
  let customer: string;
  let other: string;
  let secret: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const calls: DarajaCall[] = [];
  let daraja: Server;
  let checkout = 0;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  async function postInvoice(partyId: string, unitPrice: string, date = '2026-03-10') {
    const created = await as(preparer)
      .post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId, date, lines: [{ description: 'Consulting', accountId: acc['4200'], quantity: '1', unitPrice, taxCodeId: tax.VAT16 }] })
      .expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201)).body as { id: string; number: string; total: string };
  }
  const invoice = async (id: string) => (await as(owner).get(`/invoices/${id}`).expect(200)).body;
  const stkCallback = (checkoutRequestId: string, ok: boolean, amount?: string, receipt?: string) =>
    api()
      .post(`/api/v1/mpesa/callbacks/${secret}/stk`)
      .send({
        Body: {
          stkCallback: {
            MerchantRequestID: 'm',
            CheckoutRequestID: checkoutRequestId,
            ResultCode: ok ? 0 : 1032,
            ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
            ...(ok && { CallbackMetadata: { Item: [{ Name: 'Amount', Value: Number(amount) }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20260315101500 }, { Name: 'PhoneNumber', Value: 254712345678 }] } }),
          },
        },
      });
  const c2b = (transId: string, amount: string, billRef: string) =>
    api().post(`/api/v1/mpesa/callbacks/${secret}/confirmation`).send({ TransactionType: 'Pay Bill', TransID: transId, TransTime: '20260316093000', TransAmount: amount, BusinessShortCode: '600999', BillRefNumber: billRef, MSISDN: '254722000111', FirstName: 'JANE', LastName: 'DOE' });

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
        if (path === '/oauth/v1/generate') {
          if (req.headers.authorization !== `Basic ${Buffer.from('ck-test:cs-test').toString('base64')}`) return send(400, { errorMessage: 'Invalid credentials' });
          return send(200, { access_token: 'tok-1', expires_in: '3599' });
        }
        if (req.headers.authorization !== 'Bearer tok-1') return send(401, { errorMessage: 'Invalid Access Token' });
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        calls.push({ path, body });
        if (path === '/mpesa/stkpush/v1/processrequest') {
          checkout++;
          return send(200, { MerchantRequestID: `mr-${checkout}`, CheckoutRequestID: `ws_CO_${checkout}`, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success. Request accepted for processing' });
        }
        if (path === '/mpesa/c2b/v2/registerurl') return send(200, { ResponseCode: '0', ResponseDescription: 'Success' });
        send(404, { errorMessage: 'Not found' });
      });
    });
    await new Promise<void>((resolve) => daraja.listen(0, '127.0.0.1', resolve));
    process.env.MPESA_BASE_URL = `http://127.0.0.1:${(daraja.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Payments E2E', adminName: 'Owner', email: 'owner@pay.test', password: PASSWORD, entityCode: 'KE', entityName: 'Pay Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@pay.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@pay.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@pay.test');
    reviewer = await login('rev@pay.test');

    await as(owner)
      .patch(`/entities/${ke}`, { address: '1 Riverside Drive\nNairobi', phone: '+254 700 000 000', email: 'billing@pay.test', paymentInstructions: 'Bank: KCB, account 1234567890' })
      .expect(200);
    const gl = await as(owner).post('/accounts', { code: '1140', name: 'M-Pesa Paybill', accountClass: 'ASSET', accountType: 'BANK', parentId: acc['1100'] }).expect(201);
    mpesaBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'M-Pesa Paybill', type: 'MOBILE_MONEY', glAccountId: gl.body.id, reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'ACME', name: 'Acme Ltd', email: 'accounts@acme.test', currency: 'KES', paymentTermsDays: 30 }).expect(201)).body.id;
    other = (await as(preparer).post('/customers', { code: 'GLOBEX', name: 'Globex Kenya', currency: 'KES' }).expect(201)).body.id;
  });

  afterAll(async () => {
    delete process.env.MPESA_BASE_URL;
    await new Promise((resolve) => daraja.close(resolve));
    await closeTestApp();
  });

  describe('M-Pesa settings', () => {
    it('connects a paybill without ever returning its credentials', async () => {
      await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL' }).expect(400);
      await as(preparer).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'ck-test', consumerSecret: 'cs-test', passkey: 'pk-test' }).expect(403);
      const res = await as(owner)
        .patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL', consumerKey: 'ck-test', consumerSecret: 'cs-test', passkey: 'pk-test' })
        .expect(200);
      expect(res.body).toMatchObject({ enabled: true, shortCode: '600999', hasConsumerKey: true, hasConsumerSecret: true, hasPasskey: true });
      expect(JSON.stringify(res.body)).not.toMatch(/ck-test|cs-test|pk-test/);
      secret = /callbacks\/([^/]+)\/stk$/.exec(res.body.callbackUrls.stk)![1];

      const list = await as(owner).get('/bank-accounts').expect(200);
      const text = JSON.stringify(list.body);
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/consumerKey|consumerSecret|passkey/);
      expect(list.body.find((b: { id: string }) => b.id === mpesaBank).mpesa).toEqual({ enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL' });
      const { db } = await getServices();
      const stored = (await db.bankAccounts.findById(mpesaBank).lean())!;
      expect(stored.mpesa!.consumerSecret).not.toBe('cs-test');

      // Saving again without re-entering secrets keeps them.
      await as(owner).patch(`/bank-accounts/${mpesaBank}/mpesa`, { enabled: true, environment: 'sandbox', shortCode: '600999', shortCodeType: 'PAYBILL' }).expect(200);
    });

    it('registers the payment notification URLs with Safaricom', async () => {
      const res = await as(owner).post(`/bank-accounts/${mpesaBank}/mpesa/register`).expect(200);
      expect(res.body.registeredAt).toBeTruthy();
      const call = calls.find((c) => c.path === '/mpesa/c2b/v2/registerurl')!;
      expect(call.body).toMatchObject({ ShortCode: '600999', ResponseType: 'Completed' });
      expect(String(call.body.ConfirmationURL)).toContain(`/api/v1/mpesa/callbacks/${secret}/confirmation`);
    });

    it('rejects callbacks without the account secret', async () => {
      await api().post('/api/v1/mpesa/callbacks/not-the-secret-at-all-xxxxxxxx/confirmation').send({ TransID: 'X1', TransAmount: '10' }).expect(403);
    });
  });

  describe('invoice documents', () => {
    let inv: { id: string; number: string };

    beforeAll(async () => {
      inv = await postInvoice(customer, '100000');
    });

    it('renders a printable tax invoice with how to pay', async () => {
      const res = await as(owner).get(`/invoices/${inv.id}/document`).expect(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
      expect(res.body).toContain('Tax invoice');
      expect(res.body).toContain(inv.number);
      expect(res.body).toContain('116,000.00');
      expect(res.body).toContain('Paybill <b>600999</b>');
      expect(res.body).toContain('Bank: KCB, account 1234567890');
      expect(res.body).toContain('1 Riverside Drive<br>Nairobi');
    });

    it('escapes what users type', async () => {
      const created = await as(preparer)
        .post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-10', lines: [{ description: '<script>alert(1)</script>', accountId: acc['4200'], quantity: '1', unitPrice: '10' }] })
        .expect(201);
      const res = await as(owner).get(`/invoices/${created.body.id}/document`).expect(200);
      expect(res.body).not.toContain('<script>alert(1)</script>');
      expect(res.body).toContain('&lt;script&gt;');
      expect(res.body).toContain('DRAFT');
    });

    it('emails the invoice with a private portal link', async () => {
      const res = await as(preparer).post(`/invoices/${inv.id}/email`, { message: 'Thank you for your business.' }).expect(201);
      expect(res.body.to).toEqual(['accounts@acme.test']);
      const { db } = await getServices();
      const mail = (await db.emails.findOne({ to: 'accounts@acme.test' }).sort({ _id: -1 }).lean())!;
      expect(mail).toMatchObject({ category: 'invoice', replyTo: 'billing@pay.test' });
      expect(mail.subject).toBe(`Tax invoice ${inv.number} from Pay Kenya`);
      expect(mail.text).toContain('Thank you for your business.');
      expect(mail.text).toContain('paybill 600999');
      expect((await invoice(inv.id)).emailedAt).toBeTruthy();
      // Customers without an address need one entered.
      const globex = await postInvoice(other, '500');
      await as(preparer).post(`/invoices/${globex.id}/email`).expect(400);
    });
  });

  describe('payment prompts (STK push)', () => {
    let inv: { id: string; number: string };
    let txId: string;

    beforeAll(async () => {
      inv = await postInvoice(customer, '50000');
    });

    it('sends a prompt to the customer phone', async () => {
      await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0812' }).expect(400);
      await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0712345678', amount: '60000' }).expect(400);
      const res = await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0712 345 678', amount: '20000' }).expect(201);
      expect(res.body.status).toBe('PENDING');
      txId = res.body.id;
      const call = calls.filter((c) => c.path === '/mpesa/stkpush/v1/processrequest').at(-1)!;
      expect(call.body).toMatchObject({ BusinessShortCode: '600999', PartyA: '254712345678', Amount: 20000, TransactionType: 'CustomerPayBillOnline' });
      expect(Buffer.from(String(call.body.Password), 'base64').toString()).toBe(`600999pk-test${call.body.Timestamp}`);
      expect(String(call.body.CallBackURL)).toContain(`/mpesa/callbacks/${secret}/stk`);
      // No second prompt while the first is open.
      await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0712345678', amount: '20000' }).expect(400);
    });

    it('records a cancelled prompt as failed', async () => {
      const res = await as(preparer).post(`/invoices/${inv.id}/mpesa-request`, { phone: '0733000111', amount: '1000' }).expect(201);
      const { db } = await getServices();
      const tx = (await db.mobileMoney.findById(res.body.id).lean())!;
      await stkCallback(tx.checkoutRequestId!, false).expect(200);
      expect((await as(preparer).get(`/mpesa/transactions/${res.body.id}/status`).expect(200)).body.status).toBe('FAILED');
    });

    it('turns a paid prompt into a receipt matched on the M-Pesa statement', async () => {
      const { db } = await getServices();
      const tx = (await db.mobileMoney.findById(txId).lean())!;
      await stkCallback(tx.checkoutRequestId!, true, '20000', 'QJK1STK001').expect(200);
      await stkCallback(tx.checkoutRequestId!, true, '20000', 'QJK1STK001').expect(200);
      const after = (await db.mobileMoney.findById(txId).lean())!;
      expect(after.status).toBe('RECEIPTED');
      const payments = await db.payments.find({ reference: 'QJK1STK001' }).lean();
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ status: 'POSTED', method: 'MOBILE_MONEY' });
      expect((await invoice(inv.id)).amountDue).toBe('38000');
      const line = (await db.bankStatementLines.findById(after.statementLineId).lean())!;
      expect(line.status).toBe('MATCHED');
      expect(line.amount.toString()).toBe('20000');
    });
  });

  describe('paybill payments (C2B)', () => {
    let inv: { id: string; number: string };

    beforeAll(async () => {
      inv = await postInvoice(customer, '10000');
    });

    it('receipts a payment against the invoice number the payer typed, once', async () => {
      const typed = inv.number.toLowerCase().replace(/-/g, ' ');
      const res = await c2b('QJK2C2B001', '11600', typed).expect(200);
      expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      await c2b('QJK2C2B001', '11600', typed).expect(200);
      const { db } = await getServices();
      expect(await db.payments.countDocuments({ reference: 'QJK2C2B001' })).toBe(1);
      expect((await invoice(inv.id)).paymentStatus).toBe('PAID');
      const tx = (await db.mobileMoney.findOne({ transactionId: 'QJK2C2B001' }).lean())!;
      expect(tx).toMatchObject({ status: 'RECEIPTED', payerName: 'JANE DOE' });
    });

    it('takes a payment on account when the payer typed the customer code', async () => {
      await c2b('QJK2C2B002', '2500', 'acme').expect(200);
      const { db } = await getServices();
      const tx = (await db.mobileMoney.findOne({ transactionId: 'QJK2C2B002' }).lean())!;
      expect(tx.status).toBe('RECEIPTED');
      const payment = (await db.payments.findById(tx.paymentId).lean())!;
      expect(payment.partyId.toString()).toBe(customer);
    });

    it('queues payments it cannot place, to assign or set aside', async () => {
      await c2b('QJK2C2B003', '500', 'GLOBEX-MAY').expect(200);
      await c2b('QJK2C2B004', '75', 'wrong number').expect(200);
      const queue = (await as(preparer).get('/mpesa/transactions?status=UNMATCHED').expect(200)).body as { id: string; transactionId: string; phone: string }[];
      expect(queue.map((q) => q.transactionId).sort()).toEqual(['QJK2C2B003', 'QJK2C2B004']);
      expect(queue[0].phone).toMatch(/••••/);
      const globexInvoice = await postInvoice(other, '400');
      const assigned = await as(preparer).post(`/mpesa/transactions/${queue.find((q) => q.transactionId === 'QJK2C2B003')!.id}/assign`, { customerId: other, invoiceId: globexInvoice.id }).expect(200);
      expect(assigned.body.status).toBe('RECEIPTED');
      expect((await invoice(globexInvoice.id)).paymentStatus).toBe('PAID');
      await as(preparer).post(`/mpesa/transactions/${queue.find((q) => q.transactionId === 'QJK2C2B004')!.id}/ignore`, { note: 'Refunded to sender' }).expect(200);
      expect((await as(preparer).get('/mpesa/transactions?status=UNMATCHED').expect(200)).body).toHaveLength(0);
      // Only the set-aside payment is left to explain on the M-Pesa account.
      const bank = (await as(owner).get('/bank-accounts').expect(200)).body.find((b: { id: string }) => b.id === mpesaBank);
      expect(bank.unmatchedStatementLines).toBe(1);
    });
  });

  describe('customer portal', () => {
    let token: string;
    let inv: { id: string; number: string };

    beforeAll(async () => {
      inv = await postInvoice(customer, '3000');
      await as(preparer).post(`/invoices/${inv.id}/email`).expect(201);
      const { db } = await getServices();
      const mail = (await db.emails.findOne({ to: 'accounts@acme.test' }).sort({ _id: -1 }).lean())!;
      token = /\/portal\/([A-Za-z0-9_-]+)\/invoices\//.exec(mail.text)![1];
      expect(await db.portalLinks.findOne({ tokenHash: token })).toBeNull();
    });

    it("shows the customer their open invoices and nothing of anyone else's", async () => {
      const res = await api().get(`/api/v1/portal/${token}`).expect(200);
      expect(res.body.customer).toEqual({ name: 'Acme Ltd', code: 'ACME' });
      expect(res.body.mpesa).toMatchObject({ available: true, shortCode: '600999' });
      const numbers = res.body.open.map((i: { number: string }) => i.number);
      expect(numbers).toContain(inv.number);
      expect(res.body.open.every((i: { payable: boolean }) => i.payable)).toBe(true);
      const doc = await api().get(`/api/v1/portal/${token}/invoices/${inv.id}/document`).expect(200);
      expect(doc.body).toContain(inv.number);
      expect(doc.body).toContain('Pay online');
      const globex = await postInvoice(other, '100');
      await api().get(`/api/v1/portal/${token}/invoices/${globex.id}/document`).expect(404);
      await api().post(`/api/v1/portal/${token}/invoices/${globex.id}/pay`).send({ phone: '0712345678' }).expect(404);
      await api().get('/api/v1/portal/not-a-real-token-at-all-000000').expect(404);
    });

    it('lets the customer pay by M-Pesa and follow the payment', async () => {
      const res = await api().post(`/api/v1/portal/${token}/invoices/${inv.id}/pay`).send({ phone: '+254 712 345 678' }).expect(201);
      expect(res.body.amount).toBe('3480');
      expect((await api().get(`/api/v1/portal/${token}/payments/${res.body.id}`).expect(200)).body.status).toBe('PENDING');
      const { db } = await getServices();
      const tx = (await db.mobileMoney.findById(res.body.id).lean())!;
      expect(tx.requestedVia).toBe('portal');
      await stkCallback(tx.checkoutRequestId!, true, '3480', 'QJK3PORT01').expect(200);
      const status = (await api().get(`/api/v1/portal/${token}/payments/${res.body.id}`).expect(200)).body;
      expect(status).toMatchObject({ status: 'PAID' });
      expect(status.message).toContain('QJK3PORT01');
      expect((await invoice(inv.id)).paymentStatus).toBe('PAID');
    });

    it('lets staff see and revoke links', async () => {
      const links = (await as(preparer).get(`/customers/${customer}/portal-links`).expect(200)).body as { id: string; active: boolean; views: number; tokenHash?: string }[];
      expect(links.length).toBeGreaterThanOrEqual(2);
      expect(links[0].tokenHash).toBeUndefined();
      expect(links[0].views).toBeGreaterThan(0);
      for (const l of links) await as(preparer).post(`/portal-links/${l.id}/revoke`).expect(200);
      await api().get(`/api/v1/portal/${token}`).expect(404);
    });
  });
});
