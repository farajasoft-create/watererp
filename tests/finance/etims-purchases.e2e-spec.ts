import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 13: KRA eTIMS purchases — supplier invoices fetched from KRA, matched to
 * bills or turned into bills, accepted or rejected back to KRA, and bills whose input VAT is at risk.
 */

const PASSWORD = 'Password1234';

const sale = (over: Record<string, unknown>) => ({
  spplrTin: 'P051333444D',
  spplrNm: 'OFFICEPRO SUPPLIES LTD',
  spplrBhfId: '00',
  rcptTyCd: 'S',
  pmtTyCd: '02',
  cfmDt: '20260312101500',
  salesDt: '20260312',
  totTaxblAmt: 11600,
  totTaxAmt: 1600,
  totAmt: 11600,
  itemList: [{ itemSeq: 1, itemCd: 'KE2NTU0000003', itemClsCd: '4410310000', itemNm: 'Printer paper A4', qty: 10, prc: 1160, splyAmt: 11600, dcRt: 0, dcAmt: 0, taxTyCd: 'B', taxblAmt: 11600, taxAmt: 1600, totAmt: 11600 }],
  ...over,
});

describe('KRA eTIMS purchases (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let officepro: string;
  let draftBill: string;
  let deviceId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const kra: { path: string; body: Record<string, unknown> }[] = [];
  let saleList: Record<string, unknown>[] = [];
  let server: Server;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const inbox = async () => (await as(preparer).get('/etims/purchases').expect(200)).body as { id: string; supplierInvcNo: string; supplierTin: string; status: string; billId: string | null; report: { status: string } }[];
  const purchase = async (invcNo: string, tin = 'P051333444D') => (await inbox()).find((p) => p.supplierInvcNo === invcNo && p.supplierTin === tin)!;
  const reports = () => kra.filter((c) => c.path === '/insertTrnsPurchase');

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        kra.push({ path: req.url ?? '', body });
        const reply = (resultCd: string, data: object | null, resultMsg = 'It is succeeded') => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ resultCd, resultMsg, data }));
        };
        if (req.url === '/selectInitOsdcInfo') return reply('000', { info: { cmcKey: 'CMC-P', sdcId: 'KRACU01', mrcNo: 'WIS01' } });
        if (req.headers.cmckey !== 'CMC-P') return reply('894', null, 'Unauthorised');
        if (req.url === '/selectTrnsPurchaseSalesList') return saleList.length ? reply('000', { saleList }) : reply('001', null, 'There is no search result');
        if (req.url === '/insertTrnsPurchase') return reply('000', null);
        reply('000', null);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ETIMS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Purchases E2E', adminName: 'Owner', email: 'owner@pch.test', password: PASSWORD, entityCode: 'KE', entityName: 'Purchases Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@pch.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@pch.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@pch.test');
    reviewer = await login('rev@pch.test');

    officepro = (await as(preparer).post('/suppliers', { code: 'OFFICEPRO', name: 'OfficePro Supplies', taxId: 'P051333444D', currency: 'KES', defaultAccountId: acc['6600'] }).expect(201)).body.id;
    // The bill was keyed in before the supplier's eTIMS invoice arrived.
    draftBill = (
      await as(preparer)
        .post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: officepro, date: '2026-03-12', supplierInvoiceNumber: 'INV-00042', lines: [{ description: 'Paper', accountId: acc['6600'], quantity: '10', unitPrice: '1000', taxCodeId: tax.VAT16 }] })
        .expect(201)
    ).body.id;

    const device = await as(owner).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'P051234567A', bhfId: '00', dvcSrlNo: 'KRACU01', defaultItemClassCode: '8111150000' }).expect(200);
    deviceId = device.body.id;
    await as(owner).post(`/etims/devices/${deviceId}/initialise`).expect(200);
  });

  afterAll(async () => {
    delete process.env.ETIMS_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
    await closeTestApp();
  });

  it('fetches supplier invoices once and matches the bill already entered', async () => {
    saleList = [
      sale({ spplrInvcNo: 42 }),
      sale({ spplrTin: 'P051999888X', spplrNm: 'KAHAWA SUPPLIES', spplrInvcNo: 7, totTaxblAmt: 6800, totTaxAmt: 800, totAmt: 6800, itemList: [
        { itemSeq: 1, itemNm: 'Coffee beans 1kg', qty: 5, prc: 1160, splyAmt: 5800, taxTyCd: 'B', taxblAmt: 5800, taxAmt: 800, totAmt: 5800 },
        { itemSeq: 2, itemNm: 'Maize flour', qty: 10, prc: 100, splyAmt: 1000, taxTyCd: 'A', taxblAmt: 1000, taxAmt: 0, totAmt: 1000 },
      ] }),
      sale({ spplrInvcNo: 43 }),
    ];
    // Reviewers can see the inbox but not fetch into it.
    await as(reviewer).post('/etims/purchases/fetch').expect(403);
    expect((await as(preparer).post('/etims/purchases/fetch').expect(200)).body).toMatchObject({ received: 3, matched: 1 });
    const { etimsPurchases } = await getServices();
    const list = await inbox();
    expect(list).toHaveLength(3);
    const matched = await purchase('42');
    expect(matched).toMatchObject({ status: 'MATCHED', billId: draftBill });
    expect((await purchase('7', 'P051999888X')).status).toBe('RECEIVED');
    expect(kra.find((c) => c.path === '/selectTrnsPurchaseSalesList')!.body).toMatchObject({ tin: 'P051234567A', bhfId: '00', lastReqDt: '20200101000000' });
    // Fetching again does not duplicate, and asks only for what is new.
    await etimsPurchases.fetch();
    expect(await inbox()).toHaveLength(3);
    expect(kra.filter((c) => c.path === '/selectTrnsPurchaseSalesList').at(-1)!.body.lastReqDt).not.toBe('20200101000000');
  });

  it('reports acceptance to KRA when the bill is posted', async () => {
    await as(preparer).post(`/invoices/${draftBill}/submit`).expect(201);
    await as(reviewer).post(`/invoices/${draftBill}/approve`, {}).expect(201);
    expect((await purchase('42')).status).toBe('ACCEPTED');
    const { etimsPurchases } = await getServices();
    expect(await etimsPurchases.deliverReports()).toEqual({ sent: 1, failed: 0 });
    expect(reports()[0].body).toMatchObject({ tin: 'P051234567A', invcNo: 1, spplrTin: 'P051333444D', spplrInvcNo: 42, pchsSttsCd: '02', rcptTyCd: 'P', totAmt: 11600, taxblAmtB: 11600, taxAmtB: 1600, remark: expect.stringMatching(/^BILL-/) });
    expect((await purchase('42')).report.status).toBe('SENT');
    const forBill = (await as(preparer).get(`/etims/purchases/by-bill/${draftBill}`).expect(200)).body;
    expect(forBill.registered).toBe(true);
  });

  it('turns an invoice from a new supplier into a draft bill', async () => {
    const kahawa = await purchase('7', 'P051999888X');
    const created = await as(preparer).post(`/etims/purchases/${kahawa.id}/bill`, { accountId: acc['6600'] }).expect(201);
    expect(created.body.difference).toBeNull();
    const bill = (await as(preparer).get(`/invoices/${created.body.billId}`).expect(200)).body;
    expect(bill).toMatchObject({ status: 'DRAFT', supplierInvoiceNumber: '7', priceIncludesTax: true, total: '6800', taxTotal: '800' });
    expect(bill.lines.map((l: { taxCodeId: string }) => l.taxCodeId)).toEqual([tax.VAT16, tax.EXEMPT]);
    const supplier = (await as(preparer).get(`/suppliers/${bill.partyId}`).expect(200)).body;
    expect(supplier).toMatchObject({ taxId: 'P051999888X', name: 'KAHAWA SUPPLIES' });
    expect((await purchase('7', 'P051999888X'))).toMatchObject({ status: 'MATCHED', billId: created.body.billId });
    await as(preparer).post(`/etims/purchases/${kahawa.id}/bill`, { accountId: acc['6600'] }).expect(400);
  });

  it('rejects an invoice back to KRA, refusing links to the wrong supplier', async () => {
    const other = (await as(preparer).post('/suppliers', { code: 'OTHER', name: 'Other Ltd', taxId: 'P051000000Q', currency: 'KES' }).expect(201)).body.id;
    const wrong = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: other, date: '2026-03-12', supplierInvoiceNumber: 'X1', lines: [{ description: 'x', accountId: acc['6600'], quantity: '1', unitPrice: '100' }] }).expect(201);
    const dup = await purchase('43');
    expect((await as(preparer).post(`/etims/purchases/${dup.id}/link`, { billId: wrong.body.id }).expect(400)).body.message).toMatch(/not PIN P051333444D/);
    await as(preparer).post(`/etims/purchases/${dup.id}/reject`, { reason: 'Duplicate of invoice 42' }).expect(200);
    const { etimsPurchases } = await getServices();
    await etimsPurchases.deliverReports();
    expect(reports().at(-1)!.body).toMatchObject({ invcNo: 2, spplrInvcNo: 43, pchsSttsCd: '04', remark: 'Duplicate of invoice 42' });
    await as(preparer).post(`/etims/purchases/${dup.id}/reject`, { reason: 'Again' }).expect(400);
  });

  it('flags posted bills whose input VAT has no eTIMS invoice', async () => {
    const created = await as(preparer)
      .post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: officepro, date: '2026-03-20', supplierInvoiceNumber: 'INV-00099', lines: [{ description: 'Toner', accountId: acc['6600'], quantity: '1', unitPrice: '5000', taxCodeId: tax.VAT16 }] })
      .expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201);
    expect((await as(preparer).get(`/etims/purchases/by-bill/${created.body.id}`).expect(200)).body).toMatchObject({ registered: false, inputVatAtRisk: true });
    const report = (await as(preparer).get(`/etims/unregistered-bills?entityId=${ke}&from=2026-03-01&to=2026-03-31`).expect(200)).body;
    expect(report.items.map((b: { supplierInvoiceNumber: string }) => b.supplierInvoiceNumber)).toEqual(['INV-00099']);
    expect(report.inputVatAtRisk).toBe('800');

    // The supplier registers it late: the next fetch links it and accepts it at once.
    saleList = [sale({ spplrInvcNo: 99, cfmDt: '20260321090000', salesDt: '20260320', totTaxblAmt: 5800, totTaxAmt: 800, totAmt: 5800 })];
    const { etimsPurchases } = await getServices();
    expect(await etimsPurchases.fetch()).toMatchObject({ received: 1, matched: 1 });
    expect((await purchase('99')).status).toBe('ACCEPTED');
    expect((await as(preparer).get(`/etims/unregistered-bills?entityId=${ke}&from=2026-03-01&to=2026-03-31`).expect(200)).body.items).toHaveLength(0);
  });
});
