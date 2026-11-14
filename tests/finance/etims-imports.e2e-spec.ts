import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 15: KRA eTIMS imports — customs-declared items fetched from KRA, approved as
 * one of our items (or rejected) back to KRA, and stock received on the import bill reported as an import.
 */

const PASSWORD = 'Password1234';

const declared = [
  { taskCd: 'T2026031', dclDe: '20260305', itemSeq: 1, dclNo: 'C 2026 MSA 12345', hsCd: '8471300000', itemNm: 'LAPTOP COMPUTERS', orgnNatCd: 'CN', exptNatCd: 'CN', pkg: 2, pkgUnitCd: 'CT', qty: 20, qtyUnitCd: 'U', totWt: 60, netWt: 50, spplrNm: 'SHENZHEN TECH LTD', agntNm: 'BAHARI CLEARING', invcFcurAmt: 9000, invcFcurCd: 'USD', invcFcurExcrt: 130 },
  { taskCd: 'T2026031', dclDe: '20260305', itemSeq: 2, dclNo: 'C 2026 MSA 12345', hsCd: '8504400000', itemNm: 'POWER ADAPTERS', orgnNatCd: 'CN', exptNatCd: 'CN', qty: 20, qtyUnitCd: 'U', spplrNm: 'SHENZHEN TECH LTD', invcFcurAmt: 200, invcFcurCd: 'USD', invcFcurExcrt: 130 },
];

describe('KRA eTIMS imports (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let laptop: string;
  let supplier: string;
  let mainWh: string;
  let deviceId: string;
  const acc: Record<string, string> = {};
  const kra: { path: string; body: Record<string, unknown> }[] = [];
  let server: Server;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const inbox = async (status?: string) => (await as(preparer).get(`/etims/imports${status ? `?status=${status}` : ''}`).expect(200)).body as { id: string; itemSeq: number; status: string; itemName: string; item: { code: string } | null; report: { status: string } }[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        kra.push({ path: req.url ?? '', body });
        const reply = (resultCd: string, data: object | null) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ resultCd, resultMsg: resultCd === '000' ? 'It is succeeded' : 'There is no search result', data }));
        };
        if (req.url === '/selectInitOsdcInfo') return reply('000', { info: { cmcKey: 'CMC-I', sdcId: 'KRACU03', mrcNo: 'WIS03' } });
        if (req.url === '/selectImportItemList') return body.lastReqDt === '20200101000000' ? reply('000', { itemList: declared }) : reply('001', null);
        reply('000', null);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ETIMS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Imports E2E', adminName: 'Owner', email: 'owner@imp.test', password: PASSWORD, entityCode: 'KE', entityName: 'Imports Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@imp.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@imp.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@imp.test');
    reviewer = await login('rev@imp.test');
    mainWh = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    supplier = (await as(preparer).post('/suppliers', { code: 'SZTECH', name: 'Shenzhen Tech', currency: 'KES' }).expect(201)).body.id;
    laptop = (await as(preparer).post('/items', { code: 'LAPTOP', name: 'Laptop 14"', type: 'STOCK', unit: 'each', etimsClassCode: '4321150000', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'] }).expect(201)).body.id;
    deviceId = (await as(owner).patch('/etims/devices', { branchId: hq, enabled: true, environment: 'sandbox', tin: 'P051234567A', bhfId: '00', dvcSrlNo: 'KRACU03', defaultItemClassCode: '8111150000' }).expect(200)).body.id;
    await as(owner).post(`/etims/devices/${deviceId}/initialise`).expect(200);
  });

  afterAll(async () => {
    delete process.env.ETIMS_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
    await closeTestApp();
  });

  it('fetches customs-declared items once', async () => {
    await as(reviewer).post('/etims/imports/fetch').expect(403);
    expect((await as(preparer).post('/etims/imports/fetch').expect(200)).body).toMatchObject({ received: 2 });
    expect((await as(preparer).post('/etims/imports/fetch').expect(200)).body).toMatchObject({ received: 0 });
    const list = await inbox();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ status: 'RECEIVED', itemName: 'LAPTOP COMPUTERS', declarationNumber: 'C 2026 MSA 12345', quantity: 20, invoiceCurrency: 'USD', originCountry: 'CN' });
  });

  it('approves an item as ours, rejects another, and reports both to KRA', async () => {
    const bill = await as(preparer)
      .post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-06', supplierInvoiceNumber: 'SZ-778', lines: [{ description: 'Laptops (imported)', itemId: laptop, warehouseId: mainWh, quantity: '20', unitPrice: '58500' }] })
      .expect(201);
    const [laptops, adapters] = (await inbox()).sort((a, b) => a.itemSeq - b.itemSeq);
    await as(preparer).post(`/etims/imports/${laptops.id}/approve`, { itemId: acc['6200'] }).expect(400);
    await as(preparer).post(`/etims/imports/${laptops.id}/approve`, { itemId: laptop, billId: bill.body.id }).expect(200);
    await as(preparer).post(`/etims/imports/${adapters.id}/reject`, { reason: 'Not ordered; returned to agent' }).expect(200);
    await as(preparer).post(`/etims/imports/${adapters.id}/approve`, { itemId: laptop }).expect(400);

    const { etimsImports } = await getServices();
    expect(await etimsImports.deliverReports()).toEqual({ sent: 2, failed: 0 });
    const updates = kra.filter((c) => c.path === '/updateImportItem').map((c) => c.body).sort((a, b) => Number(a.itemSeq) - Number(b.itemSeq));
    expect(updates[0]).toMatchObject({ taskCd: 'T2026031', dclDe: '20260305', itemSeq: 1, hsCd: '8471300000', imptItemSttsCd: '3', itemClsCd: '4321150000', itemCd: expect.stringMatching(/^KE2NTU\d{7}$/) });
    expect(updates[1]).toMatchObject({ itemSeq: 2, imptItemSttsCd: '4', itemCd: null, remark: 'Not ordered; returned to agent' });
    // The item was registered with KRA before the approval named it.
    const save = kra.findIndex((c) => c.path === '/saveItem' && c.body.itemNm === 'Laptop 14"');
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(kra.findIndex((c) => c.path === '/updateImportItem'));
    const list = await inbox('APPROVED');
    expect(list[0]).toMatchObject({ item: { code: 'LAPTOP' }, report: { status: 'SENT' } });

    // Receiving the bill reports the stock to KRA as an import.
    await as(preparer).post(`/invoices/${bill.body.id}/submit`).expect(201);
    await as(reviewer).post(`/invoices/${bill.body.id}/approve`, {}).expect(201);
    const { db, etimsStock } = await getServices();
    await db.etimsDevices.updateOne({ _id: deviceId }, { stockReportFrom: new Date(Date.now() - 3_600_000) });
    await db.connection.collection('finance_stockmovements').updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    await etimsStock.collect();
    await etimsStock.deliver();
    const io = kra.filter((c) => c.path === '/insertStockIO').at(-1)!;
    expect(io.body).toMatchObject({ sarTyCd: '01', totAmt: 1170000 });
  });
});
