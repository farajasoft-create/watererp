import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 14: KRA eTIMS stock reporting — movements collected per source document and
 * direction, reported in order (insertStockIO) with the quantity left after them (saveStockMaster).
 */

const PASSWORD = 'Password1234';

describe('KRA eTIMS stock reporting (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let br2: string;
  let mainWh: string;
  let wh2: string;
  let widget: string;
  let customer: string;
  let supplier: string;
  let deviceId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const kra: { path: string; body: Record<string, unknown> }[] = [];
  let failStockIO = 0;
  let server: Server;

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
  async function stockDocument(body: object) {
    const created = await as(preparer).post('/stock/documents', { entityId: ke, ...body }).expect(201);
    await as(preparer).post(`/stock/documents/${created.body.id}/submit`).expect(201);
    await as(reviewer).post(`/stock/documents/${created.body.id}/approve`).expect(201);
  }
  /** Movements are collected once they are a minute old (they may still be in an open transaction). */
  const age = async () => {
    const { db } = await getServices();
    // Reporting started an hour ago; the movements happened since but are now settled.
    await db.etimsDevices.updateOne({ _id: deviceId }, { stockReportFrom: new Date(Date.now() - 60 * 60_000) });
    await db.connection.collection('finance_stockmovements').updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
  };
  const stockIO = () => kra.filter((c) => c.path === '/insertStockIO');
  const masters = () => kra.filter((c) => c.path === '/saveStockMaster');

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
        if (req.url === '/selectInitOsdcInfo') return reply('000', { info: { cmcKey: 'CMC-S', sdcId: 'KRACU02', mrcNo: 'WIS02' } });
        if (req.headers.cmckey !== 'CMC-S') return reply('894', null, 'Unauthorised');
        if (req.url === '/insertStockIO' && failStockIO > 0) {
          failStockIO--;
          return reply('910', null, 'Request parameter error');
        }
        if (req.url === '/saveTrnsSalesOsdc') return reply('000', { curRcptNo: body.invcNo, totRcptNo: body.invcNo, intrlData: 'X', rcptSign: 'S', sdcDateTime: '20260301120000' });
        reply('000', null);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ETIMS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Stock E2E', adminName: 'Owner', email: 'owner@stk.test', password: PASSWORD, entityCode: 'KE', entityName: 'Stock Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    br2 = (await as(owner).post('/branches', { entityId: ke, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@stk.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@stk.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@stk.test');
    reviewer = await login('rev@stk.test');
    mainWh = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    wh2 = (await as(owner).post('/warehouses', { entityId: ke, branchId: br2, code: 'BR2-STORE', name: 'Branch Two store' }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Customer', currency: 'KES' }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'SUPP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
    widget = (
      await as(preparer)
        .post('/items', { code: 'WIDGET', name: 'Widget', type: 'STOCK', unit: 'each', etimsClassCode: '5020230500', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'], salesTaxCodeId: tax.VAT16 })
        .expect(201)
    ).body.id;
    deviceId = (await as(owner).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'P051234567A', bhfId: '00', dvcSrlNo: 'KRACU02', defaultItemClassCode: '8111150000' }).expect(200)).body.id;
    await as(owner).post(`/etims/devices/${deviceId}/initialise`).expect(200);
  });

  afterAll(async () => {
    delete process.env.ETIMS_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
    await closeTestApp();
  });

  it('reports each document’s movements at the branch in order, with the quantity left after them', async () => {
    await postDocument({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-01', supplierInvoiceNumber: 'S-1', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '10', unitPrice: '100' }] });
    await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-02', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '4', unitPrice: '200', taxCodeId: tax.VAT16 }] });
    await stockDocument({ kind: 'TRANSFER', date: '2026-03-03', reason: 'Restock Branch Two', warehouseId: mainWh, toWarehouseId: wh2, lines: [{ itemId: widget, quantity: '2' }] });
    await stockDocument({ kind: 'ADJUSTMENT', date: '2026-03-04', reason: 'Damaged', warehouseId: mainWh, adjustmentAccountId: acc['5100'], lines: [{ itemId: widget, quantity: '-1' }] });

    const { etimsStock } = await getServices();
    // Too fresh to collect.
    expect(await etimsStock.collect()).toEqual({ reports: 0 });
    await age();
    // Head office only: the transfer into Branch Two has no device.
    expect(await etimsStock.collect()).toEqual({ reports: 4 });
    expect(await etimsStock.collect()).toEqual({ reports: 0 });
    expect(await etimsStock.deliver()).toEqual({ sent: 4, failed: 0 });

    expect(stockIO().map((c) => [c.body.sarNo, c.body.sarTyCd])).toEqual([
      [1, '02'],
      [2, '11'],
      [3, '13'],
      [4, '16'],
    ]);
    const purchase = stockIO()[0].body as { itemList: Record<string, unknown>[]; ocrnDt: string; remark: string; totAmt: number };
    expect(purchase).toMatchObject({ ocrnDt: '20260301', totAmt: 1000, remark: expect.stringMatching(/^BILL-/) });
    expect(purchase.itemList[0]).toMatchObject({ itemClsCd: '5020230500', itemNm: 'Widget', qty: 10, prc: 100, splyAmt: 1000, taxTyCd: 'B' });
    expect(masters().map((c) => c.body.rsdQty)).toEqual([10, 6, 4, 3]);
    // The widget was registered with KRA once, before the first report that needed it.
    const saveItems = kra.filter((c) => c.path === '/saveItem' && c.body.itemNm === 'Widget');
    expect(saveItems).toHaveLength(1);
    expect(kra.indexOf(saveItems[0])).toBeLessThan(kra.indexOf(stockIO()[0]));

    const list = (await as(reviewer).get('/etims/stock-reports').expect(200)).body as { sarTyCd: string; status: string; lines: { item: { code: string } }[] }[];
    expect(list.every((r) => r.status === 'SENT')).toBe(true);
    expect(list[0].lines[0].item.code).toBe('WIDGET');
  });

  it('holds later reports behind a rejected one and resends on request', async () => {
    failStockIO = 1;
    await stockDocument({ kind: 'ADJUSTMENT', date: '2026-03-05', reason: 'Count gain', warehouseId: mainWh, adjustmentAccountId: acc['5100'], lines: [{ itemId: widget, quantity: '5' }] });
    await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-06', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '2', unitPrice: '200', taxCodeId: tax.VAT16 }] });
    await age();
    const { etimsStock, db } = await getServices();
    await etimsStock.collect();
    expect(await etimsStock.deliver()).toEqual({ sent: 0, failed: 1 });
    expect(await db.etimsStockReports.countDocuments({ status: 'PENDING' })).toBe(1);
    expect((await db.etimsDevices.findById(deviceId).lean())!.lastError).toMatch(/Stock .*910/);
    await as(preparer).post(`/etims/devices/${deviceId}/stock/retry`).expect(403);
    expect((await as(owner).post(`/etims/devices/${deviceId}/stock/retry`).expect(200)).body).toEqual({ sent: 2, failed: 0 });
    expect(stockIO().slice(-3).map((c) => [c.body.sarNo, c.body.sarTyCd])).toEqual([
      [5, '06'],
      [5, '06'],
      [6, '11'],
    ]);
    expect(masters().slice(-2).map((c) => c.body.rsdQty)).toEqual([8, 6]);
  });
});
