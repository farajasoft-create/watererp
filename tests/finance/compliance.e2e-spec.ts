import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 10 (Kenya compliance): tax withheld by customers with certificates, text
 * messages through Africa's Talking, and KRA eTIMS reporting against stand-in servers.
 */

const PASSWORD = 'Password1234';

describe('Kenya compliance (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let customer: string;
  let deviceId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};

  const kra: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  const texts: Record<string, string>[] = [];
  let kraFailNext = 0;
  let servers: Server[] = [];

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  async function postDocument(body: object) {
    const created = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, partyId: customer, date: '2026-03-10', ...body }).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201)).body as { id: string; number: string };
  }
  const invoice = (unitPrice: string) => postDocument({ kind: 'SALES_INVOICE', lines: [{ description: 'Consulting', accountId: acc['4200'], quantity: '1', unitPrice, taxCodeId: tax.VAT16 }] });
  const sales = () => kra.filter((c) => c.path === '/saveTrnsSalesOsdc');
  const deliver = async () => (await getServices()).etims.deliverDue();

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });

  beforeAll(async () => {
    process.env.ETIMS_BASE_URL = await listen((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        kra.push({ path: req.url ?? '', body, headers: req.headers });
        const reply = (resultCd: string, data: object | null, resultMsg = 'It is succeeded') => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ resultCd, resultMsg, resultDt: '20260310120000', data }));
        };
        if (req.url === '/selectInitOsdcInfo') return reply('000', { info: { cmcKey: 'CMC-KEY-123', sdcId: 'KRACU0100000001', mrcNo: 'WIS00000001', taxprNm: 'COMPLIANCE KENYA' } });
        if (req.headers.cmckey !== 'CMC-KEY-123') return reply('894', null, 'Unauthorised request');
        if (req.url === '/saveItem') return reply('000', null);
        if (req.url === '/saveTrnsSalesOsdc') {
          if (kraFailNext > 0) {
            kraFailNext--;
            return reply('910', null, 'Request parameter error');
          }
          return reply('000', { curRcptNo: body.invcNo, totRcptNo: Number(body.invcNo) + 100, intrlData: `INTRL${body.invcNo}`, rcptSign: `SIGN${body.invcNo}XYZ`, sdcDateTime: '20260310120501' });
        }
        reply('001', null, 'Unknown');
      });
    });
    process.env.AT_BASE_URL = await listen((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        texts.push({ ...form, apiKey: String(req.headers.apikey) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ SMSMessageData: { Message: 'Sent to 1/1 Total Cost: KES 0.8000', Recipients: [{ statusCode: 101, number: form.to, status: 'Success', cost: 'KES 0.8000', messageId: `ATXid_${texts.length}` }] } }));
      });
    });
    process.env.AT_USERNAME = 'farajatest';
    process.env.AT_API_KEY = 'at-test-key';

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Compliance E2E', adminName: 'Owner', email: 'owner@kra.test', password: PASSWORD, entityCode: 'KE', entityName: 'Compliance Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@kra.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@kra.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@kra.test');
    reviewer = await login('rev@kra.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Operating KES', glAccountId: acc['1120'], reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    customer = (
      await as(preparer)
        .post('/customers', { code: 'GOVT', name: 'County Government', taxId: 'P051111111A', phone: '0711 222 333', currency: 'KES', paymentTermsDays: 30, withholdingTaxCodeIds: [tax.WHT5, tax.WHVAT2] })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    for (const k of ['ETIMS_BASE_URL', 'AT_BASE_URL', 'AT_USERNAME', 'AT_API_KEY']) delete process.env[k];
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers = [];
    await closeTestApp();
  });

  describe('tax withheld by customers', () => {
    let inv: { id: string; number: string };
    let receiptId: string;

    beforeAll(async () => {
      inv = await invoice('100000');
    });

    it('provisions recoverable accounts and eTIMS tax types', async () => {
      const codes = (await as(owner).get('/tax-codes').expect(200)).body as { code: string; inputAccountId: string | null; etimsTaxType: string | null }[];
      expect(codes.find((c) => c.code === 'WHT5')!.inputAccountId).toBe(acc['1460']);
      expect(codes.find((c) => c.code === 'WHVAT2')!.inputAccountId).toBe(acc['1465']);
      expect(codes.find((c) => c.code === 'VAT16')!.etimsTaxType).toBe('B');
    });

    it('settles the invoice with cash plus the income tax and VAT the customer withheld', async () => {
      await as(preparer).post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date: '2026-03-20', bankAccountId: bank, amount: '109000', withholdingTaxCodeIds: [tax.WHT5] }).expect(400);
      const created = await as(preparer)
        .post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date: '2026-03-20', bankAccountId: bank, amount: '109000', withholdingTaxCodeIds: [tax.WHT5, tax.WHVAT2], allocations: [{ documentId: inv.id, amount: '116000' }] })
        .expect(201);
      receiptId = created.body.id;
      expect(created.body.withholdingAmount).toBe('7000');
      const posted = await as(preparer).post(`/payments/${receiptId}/approve`).expect(201);
      expect(posted.body.status).toBe('POSTED');
      expect((await as(owner).get(`/invoices/${inv.id}`).expect(200)).body.paymentStatus).toBe('PAID');
      const { db } = await getServices();
      const entries = await db.ledger.find({ journalId: posted.body.journalId }).lean();
      const net = (code: string) => entries.filter((e) => e.accountId.toString() === acc[code]).reduce((s, e) => s + Number(e.debit.toString()) - Number(e.credit.toString()), 0);
      expect([net('1120'), net('1460'), net('1465'), net('1200')]).toEqual([109000, 5000, 2000, -116000]);

      const report = (await as(owner).get(`/reports/tax?entityId=${ke}&from=2026-03-01&to=2026-03-31`).expect(200)).body;
      expect(report.totals).toMatchObject({ withheldByCustomers: '7000', vatWithheldByCustomers: '2000', withholdingTax: '0' });
    });

    it('tracks the withholding certificates still to come', async () => {
      const missing = (await as(preparer).get('/payments/withholding-certificates').expect(200)).body;
      expect(missing.items.map((i: { taxCode: string }) => i.taxCode).sort()).toEqual(['WHT5', 'WHVAT2']);
      expect(missing.outstandingFunctional).toBe('7000');
      await as(preparer).post(`/payments/${receiptId}/withholding-certificates`, { taxCodeId: tax.WHVAT2, certificateNumber: 'KRAWHT00012345', certificateDate: '2026-03-01' }).expect(400);
      await as(preparer).post(`/payments/${receiptId}/withholding-certificates`, { taxCodeId: tax.WHVAT2, certificateNumber: 'KRAWHT00012345', certificateDate: '2026-04-05' }).expect(200);
      const still = (await as(preparer).get('/payments/withholding-certificates').expect(200)).body;
      expect(still.items).toHaveLength(1);
      expect(still.outstandingFunctional).toBe('5000');
      expect((await as(preparer).get('/payments/withholding-certificates?status=RECEIVED').expect(200)).body.items[0].certificateNumber).toBe('KRAWHT00012345');
    });
  });

  describe('text messages', () => {
    it('stays off until an administrator turns it on', async () => {
      const inv = await invoice('2000');
      await as(preparer).post(`/invoices/${inv.id}/sms`).expect(400);
      await as(preparer).patch('/organisation/sms', { enabled: true, paymentConfirmations: true }).expect(403);
      expect((await as(owner).patch('/organisation/sms', { enabled: true, paymentConfirmations: true }).expect(200)).body).toMatchObject({ enabled: true, driver: 'africastalking' });
    });

    it('texts an invoice link to the customer through Africa’s Talking', async () => {
      const inv = await invoice('3000');
      await as(preparer).post(`/invoices/${inv.id}/sms`, { to: '12345' }).expect(400);
      const res = await as(preparer).post(`/invoices/${inv.id}/sms`).expect(201);
      expect(res.body.to).toBe('0711 222 333');
      const sent = texts.at(-1)!;
      expect(sent).toMatchObject({ username: 'farajatest', to: '+254711222333', apiKey: 'at-test-key' });
      expect(sent.message).toContain(`invoice ${inv.number} for KES 3,480.00`);
      expect(sent.message).toMatch(/\/portal\/[A-Za-z0-9_-]+\/invoices\//);
      const log = (await as(owner).get('/sms').expect(200)).body;
      expect(log.driver).toBe('africastalking');
      expect(log.items[0]).toMatchObject({ status: 'SENT', category: 'invoice', cost: 'KES 0.8000', to: '+254711•••333' });
    });

    it('sends a short overdue reminder and logs the contact', async () => {
      const res = await as(preparer).post(`/collections/${customer}/sms-reminder`, { entityId: ke, asOf: '2026-06-30' }).expect(200);
      expect(res.body.stage).toBe('final');
      const { db } = await getServices();
      await (await getServices()).sms.deliverDue();
      expect(texts.at(-1)!.message).toContain('FINAL NOTICE');
      expect(await db.collectionActivities.countDocuments({ customerId: customer, type: 'SMS' })).toBe(1);
    });
  });

  describe('KRA eTIMS', () => {
    let first: { id: string; number: string };

    it('connects the branch and initialises the device', async () => {
      await as(preparer).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'P051234567A', bhfId: '00', dvcSrlNo: 'KRACU0100000001', defaultItemClassCode: '8111150000' }).expect(403);
      await as(owner).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'bad', bhfId: '00', dvcSrlNo: 'KRACU0100000001' }).expect(400);
      const configured = await as(owner).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'p051234567a', bhfId: '00', dvcSrlNo: 'KRACU0100000001', defaultItemClassCode: '8111150000' }).expect(200);
      // Not reporting until initialised.
      expect(configured.body).toMatchObject({ tin: 'P051234567A', enabled: false, initialised: false });
      expect(configured.body.cmcKey).toBeUndefined();
      deviceId = configured.body.id;
      const init = await as(owner).post(`/etims/devices/${deviceId}/initialise`).expect(200);
      expect(init.body).toMatchObject({ enabled: true, initialised: true, sdcId: 'KRACU0100000001' });
      expect(JSON.stringify(init.body)).not.toContain('CMC-KEY-123');
      const { db } = await getServices();
      expect((await db.etimsDevices.findById(deviceId).lean())!.cmcKey).not.toBe('CMC-KEY-123');
    });

    it('reports posted invoices in order and prints KRA’s signature and QR code', async () => {
      first = await invoice('50000');
      await invoice('20000');
      expect((await as(owner).get(`/invoices/${first.id}`).expect(200)).body.etims.status).toBe('PENDING');
      expect(await deliver()).toEqual({ sent: 2, failed: 0 });
      const items = kra.filter((c) => c.path === '/saveItem');
      expect(items).toHaveLength(1);
      expect(items[0].body).toMatchObject({ itemCd: 'KE3NTU0000001', itemClsCd: '8111150000', taxTyCd: 'B', itemTyCd: '3' });
      const [s1, s2] = sales();
      expect(s1.body).toMatchObject({ tin: 'P051234567A', bhfId: '00', invcNo: 1, orgInvcNo: 0, rcptTyCd: 'S', custTin: 'P051111111A', taxblAmtB: 58000, taxAmtB: 8000, totAmt: 58000 });
      expect(s1.headers.cmckey).toBe('CMC-KEY-123');
      expect(s2.body.invcNo).toBe(2);
      const doc = await as(owner).get(`/invoices/${first.id}`).expect(200);
      expect(doc.body.etims).toMatchObject({ status: 'SENT', invcNo: 1, rcptSign: 'SIGN1XYZ', sdcId: 'KRACU0100000001' });
      expect(doc.body.etims.qrUrl).toContain('indexEtimsReceiptData?Data=P051234567A00SIGN1XYZ');
      const html = (await as(owner).get(`/invoices/${first.id}/document`).expect(200)).body as string;
      expect(html).toContain('KRA eTIMS');
      expect(html).toContain('CU invoice no. KRACU0100000001/1');
      expect(html).toContain('<svg');
    });

    it('refuses to void a signed invoice and requires credit notes to name the invoice', async () => {
      const voided = await as(reviewer).post(`/invoices/${first.id}/void`, { date: '2026-03-15', reason: 'Wrong price' }).expect(400);
      expect(voided.body.message).toMatch(/credit note/);
      const created = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, partyId: customer, date: '2026-03-12', kind: 'SALES_CREDIT', lines: [{ description: 'Discount', accountId: acc['4200'], quantity: '1', unitPrice: '1000', taxCodeId: tax.VAT16 }] }).expect(201);
      await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
      const refused = await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(400);
      expect(refused.body.message).toMatch(/against the invoice/);
      const credit = await postDocument({ kind: 'SALES_CREDIT', date: '2026-03-12', appliesToId: first.id, lines: [{ description: 'Price correction', accountId: acc['4200'], quantity: '1', unitPrice: '1000', taxCodeId: tax.VAT16 }] });
      await deliver();
      expect(sales().at(-1)!.body).toMatchObject({ invcNo: 3, orgInvcNo: 1, rcptTyCd: 'R', totAmt: 1160 });
      expect((await as(owner).get(`/invoices/${credit.id}`).expect(200)).body.etims.status).toBe('SENT');
    });

    it('holds later documents behind a rejected one and resends with the same number', async () => {
      kraFailNext = 1;
      const a = await invoice('700');
      const b = await invoice('800');
      expect(await deliver()).toEqual({ sent: 0, failed: 1 });
      const { db } = await getServices();
      expect((await db.etimsSubmissions.findOne({ invoiceId: a.id }).lean())).toMatchObject({ status: 'FAILED', invcNo: 4, resultCd: '910' });
      expect((await db.etimsSubmissions.findOne({ invoiceId: b.id }).lean())).toMatchObject({ status: 'PENDING', invcNo: null });
      const devices = (await as(preparer).get('/etims/devices').expect(200)).body;
      expect(devices[0]).toMatchObject({ failed: 1, pending: 1 });
      expect(devices[0].lastError).toMatch(/910/);
      const retried = await as(owner).post(`/etims/devices/${deviceId}/retry`).expect(200);
      expect(retried.body).toMatchObject({ sent: 2, failed: 0 });
      expect(sales().slice(-3).map((c) => c.body.invcNo)).toEqual([4, 4, 5]);
    });

    it('cancels a document voided before it reached KRA', async () => {
      const c = await invoice('900');
      await as(reviewer).post(`/invoices/${c.id}/void`, { date: '2026-03-15', reason: 'Raised in error' }).expect(201);
      const { db } = await getServices();
      expect((await db.etimsSubmissions.findOne({ invoiceId: c.id }).lean())!.status).toBe('CANCELLED');
      const before = sales().length;
      await deliver();
      expect(sales().length).toBe(before);
    });
  });
});
