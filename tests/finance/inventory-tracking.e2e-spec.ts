import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 17: batch and serial tracking (receipts name them, batch issues go first
 * expiry first out, serial issues name them, transfers and voids carry them, trace and expiry reports) and
 * multi-currency stock (prices per currency, purchase cost in the supplier's currency, valuation in
 * another currency).
 */

const PASSWORD = 'Password1234';

describe('Inventory tracking and currencies (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let br2: string;
  let mainWh: string;
  let wh2: string;
  let med: string;
  let phone: string;
  let widget: string;
  let customer: string;
  let supplier: string;
  let usdSupplier: string;
  let phoneSale: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  async function create(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return created.body.id as string;
  }
  async function postDocument(body: object) {
    const id = await create(body);
    return (await as(reviewer).post(`/invoices/${id}/approve`).expect(201)).body;
  }
  const lots = async (q = '') => (await as(reviewer).get(`/stock/lots?entityId=${ke}${q}`).expect(200)).body as { itemCode: string; warehouseCode: string; number: string; quantity: string; expiryDate: string | null; daysToExpiry: number | null }[];
  const bill = (lines: object[], extra: object = {}) => ({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-01', supplierInvoiceNumber: `S-${Math.random()}`, lines, ...extra });
  const sale = (lines: object[], date = '2026-03-05') => ({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date, lines });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Lots E2E', adminName: 'Owner', email: 'owner@lots.test', password: PASSWORD, entityCode: 'KE', entityName: 'Lots Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    br2 = (await as(owner).post('/branches', { entityId: ke, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@lots.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@lots.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@lots.test');
    reviewer = await login('rev@lots.test');
    mainWh = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    wh2 = (await as(owner).post('/warehouses', { entityId: ke, branchId: br2, code: 'BR2-STORE', name: 'Branch Two store' }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Customer', currency: 'KES' }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'SUPP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
    usdSupplier = (await as(preparer).post('/suppliers', { code: 'USD', name: 'Shenzhen Parts', currency: 'USD' }).expect(201)).body.id;
    const stock = { type: 'STOCK', unit: 'each', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'] };
    med = (await as(preparer).post('/items', { code: 'MED', name: 'Medicine', ...stock, tracking: 'BATCH', trackExpiry: true }).expect(201)).body.id;
    phone = (await as(preparer).post('/items', { code: 'PHONE', name: 'Phone', ...stock, tracking: 'SERIAL' }).expect(201)).body.id;
    widget = (await as(preparer).post('/items', { code: 'WIDGET', name: 'Widget', ...stock, salesPrice: '500', prices: [{ currency: 'usd', price: '4.5' }] }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('batches', () => {
    it('requires the batches received, with expiry dates', async () => {
      const missing = await as(preparer).post('/invoices', bill([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '15', unitPrice: '100' }])).expect(400);
      expect(missing.body.message).toMatch(/tracked by batch; enter the batch received/);
      const noExpiry = await as(preparer).post('/invoices', bill([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '15', unitPrice: '100', lots: [{ number: 'b1', quantity: '15' }] }])).expect(400);
      expect(noExpiry.body.message).toMatch(/expiry date/);
      const short = await as(preparer).post('/invoices', bill([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '15', unitPrice: '100', lots: [{ number: 'B1', quantity: '10', expiryDate: '2027-01-31' }] }])).expect(400);
      expect(short.body.message).toMatch(/add up to 10, not 15/);

      await postDocument(
        bill([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '15', unitPrice: '100', lots: [{ number: 'b1', quantity: '10', expiryDate: '2027-01-31' }, { number: 'B2', quantity: '5', expiryDate: '2026-12-31' }] }]),
      );
      const on = await lots(`&itemId=${med}`);
      expect(on.map((l) => [l.number, l.quantity, l.expiryDate?.slice(0, 10)])).toEqual([
        ['B2', '5', '2026-12-31'],
        ['B1', '10', '2027-01-31'],
      ]);
    });

    it('issues the first batch to expire unless one is named', async () => {
      const inv = await postDocument(sale([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '7', unitPrice: '200' }]));
      expect(inv.lines[0].lots.map((l: { number: string; quantity: string }) => [l.number, l.quantity])).toEqual([
        ['B2', '5'],
        ['B1', '2'],
      ]);
      await postDocument(sale([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '3', unitPrice: '200', lots: [{ number: 'B1', quantity: '3' }] }]));
      expect((await lots(`&itemId=${med}`)).map((l) => [l.number, l.quantity])).toEqual([['B1', '5']]);

      const id = await create(sale([{ description: 'Medicine', itemId: med, warehouseId: mainWh, quantity: '1', unitPrice: '200', lots: [{ number: 'B9', quantity: '1' }] }]));
      const res = await as(reviewer).post(`/invoices/${id}/approve`).expect(400);
      expect(res.body.message).toMatch(/Batch B9 of MED in .*: none on hand/);
    });

    it('carries batches across a transfer, keeping the expiry date', async () => {
      const doc = await as(preparer).post('/stock/documents', { entityId: ke, kind: 'TRANSFER', date: '2026-03-06', reason: 'Restock', warehouseId: mainWh, toWarehouseId: wh2, lines: [{ itemId: med, quantity: '3' }] }).expect(201);
      await as(preparer).post(`/stock/documents/${doc.body.id}/submit`).expect(201);
      const posted = (await as(reviewer).post(`/stock/documents/${doc.body.id}/approve`).expect(201)).body;
      expect(posted.lines[0].lots).toMatchObject([{ number: 'B1', quantity: '3' }]);
      const byWh = await lots(`&itemId=${med}`);
      expect(byWh.map((l) => [l.warehouseCode, l.number, l.quantity, l.expiryDate?.slice(0, 10)]).sort()).toEqual([
        ['BR2-STORE', 'B1', '3', '2027-01-31'],
        ['KE-MAIN', 'B1', '2', '2027-01-31'],
      ].sort());
    });

    it('lists batches expiring soon', async () => {
      // Only batches with an expiry date are listed, each with the days left.
      const soon = await lots(`&expiringWithinDays=3650`);
      expect(soon.map((l) => l.itemCode)).toEqual(['MED', 'MED']);
      expect(soon.every((l) => typeof l.daysToExpiry === 'number')).toBe(true);
      expect((await lots(`&expiringWithinDays=0`)).every((l) => l.daysToExpiry! <= 0)).toBe(true);
      const empties = await lots(`&itemId=${med}&includeEmpty=true`);
      expect(empties.some((l) => l.number === 'B2' && l.quantity === '0')).toBe(true);
    });
  });

  describe('serial numbers', () => {
    it('requires one serial number per unit received, unique while in stock', async () => {
      const wrong = await as(preparer).post('/invoices', bill([{ description: 'Phones', itemId: phone, warehouseId: mainWh, quantity: '2', unitPrice: '10000', lots: [{ number: 'SN1', quantity: '2' }] }])).expect(400);
      expect(wrong.body.message).toMatch(/each serial number is one unit/);
      await postDocument(bill([{ description: 'Phones', itemId: phone, warehouseId: mainWh, quantity: '2', unitPrice: '10000', lots: [{ number: 'sn1', quantity: '1' }, { number: 'SN2', quantity: '1' }] }]));
      const dup = await create(bill([{ description: 'Phone', itemId: phone, warehouseId: wh2, quantity: '1', unitPrice: '10000', lots: [{ number: 'SN1', quantity: '1' }] }]));
      const res = await as(reviewer).post(`/invoices/${dup}/approve`).expect(400);
      expect(res.body.message).toMatch(/Serial number SN1 of PHONE is already in stock/);
    });

    it('sells by serial number and traces it', async () => {
      const unnamed = await as(preparer).post('/invoices', sale([{ description: 'Phone', itemId: phone, warehouseId: mainWh, quantity: '1', unitPrice: '15000' }])).expect(400);
      expect(unnamed.body.message).toMatch(/enter the serial numbers issued/);
      const inv = await postDocument(sale([{ description: 'Phone', itemId: phone, warehouseId: mainWh, quantity: '1', unitPrice: '15000', lots: [{ number: 'SN2', quantity: '1' }] }], '2026-03-07'));
      phoneSale = inv.id;
      const trace = (await as(reviewer).get(`/stock/trace?entityId=${ke}&number=sn2`).expect(200)).body;
      expect(trace.onHand).toEqual([]);
      expect(trace.movements.map((m: { type: string; quantity: string }) => [m.type, m.quantity])).toEqual([
        ['PURCHASE', '1'],
        ['SALE', '-1'],
      ]);
    });

    it('puts the serial number back in stock when the sale is voided', async () => {
      await as(owner).post(`/invoices/${phoneSale}/void`, { date: '2026-03-08', reason: 'Returned unopened' }).expect(201);
      const trace = (await as(reviewer).get(`/stock/trace?entityId=${ke}&number=SN2`).expect(200)).body;
      expect(trace.onHand).toMatchObject([{ itemCode: 'PHONE', quantity: '1' }]);
      expect(trace.movements.map((m: { type: string }) => m.type)).toEqual(['PURCHASE', 'SALE', 'REVERSAL']);
    });

    it('records serial numbers on the goods received note', async () => {
      const po = await as(preparer)
        .post('/purchase-orders', { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-03-09', lines: [{ description: 'Phone', accountId: acc['1300'], quantity: '1', unitPrice: '9000', itemId: phone, warehouseId: mainWh }] })
        .expect(201);
      await as(preparer).post(`/purchase-orders/${po.body.id}/submit`).expect(201);
      await as(owner).post(`/purchase-orders/${po.body.id}/approve`).expect(201);
      const missing = await as(preparer).post(`/purchase-orders/${po.body.id}/receipts`, { date: '2026-03-10', lines: [{ poLineNo: 1, quantity: '1' }] }).expect(400);
      expect(missing.body.message).toMatch(/serial/);
      const grn = await as(preparer).post(`/purchase-orders/${po.body.id}/receipts`, { date: '2026-03-10', lines: [{ poLineNo: 1, quantity: '1', lots: [{ number: 'SN3', quantity: '1' }] }] }).expect(201);
      expect(grn.body.lines[0].lots).toMatchObject([{ number: 'SN3', quantity: '1' }]);
      expect((await lots(`&itemId=${phone}`)).map((l) => l.number).sort()).toEqual(['SN1', 'SN2', 'SN3']);
    });

    it('will not change tracking while stock is on hand', async () => {
      const res = await as(owner).patch(`/items/${phone}`, { tracking: 'NONE' }).expect(400);
      expect(res.body.message).toMatch(/before changing how the item is tracked/);
      const plain = await as(preparer).post('/invoices', bill([{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '1', unitPrice: '1', lots: [{ number: 'X', quantity: '1' }] }])).expect(400);
      expect(plain.body.message).toMatch(/not tracked/);
    });
  });

  describe('currencies', () => {
    it('keeps selling prices per currency', async () => {
      const item = (await as(reviewer).get('/items').expect(200)).body.find((i: { id: string }) => i.id === widget);
      expect(item.prices).toEqual([{ currency: 'USD', price: '4.5' }]);
      await as(preparer).patch(`/items/${widget}`, { prices: [{ currency: 'USD', price: '4' }, { currency: 'USD', price: '5' }] }).expect(400);
    });

    it('records the purchase cost in the supplier currency and values stock in another currency', async () => {
      await as(owner).post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '130', effectiveDate: '2026-03-01' }).expect(201);
      await postDocument(bill([{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '10', unitPrice: '2' }], { partyId: usdSupplier, date: '2026-03-11' }));
      const item = (await as(reviewer).get('/items').expect(200)).body.find((i: { id: string }) => i.id === widget);
      expect(item.lastPurchase).toMatchObject({ currency: 'USD', unitPrice: '2' });
      const movement = (await as(reviewer).get(`/stock/movements?entityId=${ke}&itemId=${widget}`).expect(200)).body[0];
      expect(movement).toMatchObject({ foreignCurrency: 'USD', foreignValue: '20', value: '2600' });

      const stock = (await as(reviewer).get(`/stock?entityId=${ke}&currency=USD&date=2026-03-31`).expect(200)).body;
      expect(stock.presentation.currency).toBe('USD');
      const kes = Number(stock.total);
      expect(Number(stock.presentation.total)).toBeCloseTo(kes / 130, 1);
      const w = stock.presentation.rows.find((r: { itemId: string }) => r.itemId === widget);
      expect(w.value).toBe('20');
      await as(reviewer).get(`/stock?entityId=${ke}&currency=EUR`).expect(400);
    });
  });
});
