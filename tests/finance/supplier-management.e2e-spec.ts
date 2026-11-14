import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Supplier management: categories that set the default ledger account, onboarding approval with a
 * compliance check and maker-checker, suspension and blacklisting (with what each still allows), and
 * performance ratings with on-time delivery from goods received.
 */

const PASSWORD = 'Password1234';

describe('Supplier management (e2e)', () => {
  let owner: string;
  let preparer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let works: string;
  let supplier: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const order = (supplierId: string, extra: object = {}) =>
    as(preparer).post('/purchase-orders', { entityId: ke, branchId: hq, supplierId, date: '2026-05-01', lines: [{ description: 'Pipe fittings', accountId: acc['6600'], quantity: '10', unitPrice: '500' }], ...extra });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Supplier E2E', adminName: 'Owner', email: 'owner@sm.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@sm.test', password: PASSWORD, roleIds: [roles.find((r) => r.name === 'Accountant')!.id] }).expect(201);
    preparer = await login('prep@sm.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('keeps supplier categories with a default ledger account', async () => {
    works = (await as(preparer).post('/supplier-categories', { code: 'works', name: 'Civil works', expenseAccountId: acc['6600'] }).expect(201)).body.id;
    await as(preparer).post('/supplier-categories', { code: 'WORKS', name: 'Again' }).expect(400);
    const control = await as(preparer).post('/supplier-categories', { code: 'BAD', name: 'Bad', expenseAccountId: acc['2110'] }).expect(400);
    expect(control.body.message).toMatch(/control account/);
    const goods = (await as(preparer).post('/supplier-categories', { code: 'GOODS', name: 'Goods' }).expect(201)).body.id;
    await as(preparer).patch(`/supplier-categories/${goods}`, { isActive: false }).expect(200);

    const s = (await as(preparer).post('/suppliers', { code: 'BUILD', name: 'Kitale Builders', currency: 'KES', categoryIds: [works] }).expect(201)).body;
    expect(s.categoryIds).toEqual([works]);
    expect(s.defaultAccountId).toBe(acc['6600']);
    expect(s.status).toBe('ACTIVE'); // onboarding approval is off by default
    const inactive = await as(preparer).post('/suppliers', { code: 'X1', name: 'X', currency: 'KES', categoryIds: [goods] }).expect(400);
    expect(inactive.body.message).toMatch(/GOODS is inactive/);
    await as(preparer).post('/customers', { code: 'C1', name: 'C', currency: 'KES', categoryIds: [works] }).expect(400);
    expect((await as(preparer).get('/supplier-categories').expect(200)).body).toHaveLength(2);
  });

  it('holds new suppliers for onboarding approval when the organisation asks for it', async () => {
    await as(owner).patch('/organisation', { settings: { supplierOnboardingApproval: true } }).expect(200);
    const created = (await as(preparer).post('/suppliers', { code: 'PIPES', name: 'Pipes Ltd', currency: 'KES', categoryIds: [works] }).expect(201)).body;
    supplier = created.id;
    expect(created.status).toBe('PENDING');

    // Nothing can be ordered, billed or paid until it is approved.
    expect((await order(supplier).expect(400)).body.message).toMatch(/awaiting onboarding approval/);
    await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-05-02', supplierInvoiceNumber: 'P-1', lines: [{ description: 'x', accountId: acc['6600'], quantity: '1', unitPrice: '1' }] }).expect(400);
    await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-05-02', bankAccountId: bank, amount: '1' }).expect(400);

    // The preparer cannot approve (no permission); the approver needs the compliance basics first.
    await as(preparer).post(`/suppliers/${supplier}/approve`).expect(403);
    const gaps = await as(owner).post(`/suppliers/${supplier}/approve`).expect(400);
    expect(gaps.body.message).toBe("Before approval, record the supplier's KRA PIN, bank or M-Pesa payment details, tax compliance certificate");
    await as(owner).post(`/suppliers/${supplier}/reject`, { reason: 'Send the tax compliance certificate' }).expect(201);
    await as(preparer).post(`/suppliers/${supplier}/resubmit`).expect(201);
    await as(preparer).patch(`/suppliers/${supplier}`, { taxId: 'P051234567X', bankName: 'KCB', bankAccountNumber: '1234567' }).expect(200);
    await as(preparer).post(`/suppliers/${supplier}/compliance`, { documents: [{ type: 'TAX_COMPLIANCE', number: 'KRAWHT2026', issuedOn: '2026-01-10', expiresOn: '2025-12-31' }] }).expect(400);
    await as(preparer).post(`/suppliers/${supplier}/compliance`, { documents: [{ type: 'TAX_COMPLIANCE', number: 'KRA-TCC-1', issuedOn: '2025-06-10', expiresOn: '2026-01-31' }] }).expect(201);
    expect((await as(owner).post(`/suppliers/${supplier}/approve`).expect(400)).body.message).toMatch(/current tax compliance certificate/);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await as(preparer).post(`/suppliers/${supplier}/compliance`, { documents: [{ type: 'TAX_COMPLIANCE', number: 'KRA-TCC-2', issuedOn: '2026-01-10', expiresOn: soon }, { type: 'AGPO', number: 'AGPO/Y/77' }] }).expect(201);
    const approved = (await as(owner).post(`/suppliers/${supplier}/approve`, { comment: 'Documents verified' }).expect(201)).body;
    expect(approved.status).toBe('ACTIVE');
    await as(owner).post(`/suppliers/${supplier}/approve`).expect(400);

    // The owner registers one and cannot approve their own.
    const own = (await as(owner).post('/suppliers', { code: 'OWN', name: 'Own pick', currency: 'KES' }).expect(201)).body.id;
    expect((await as(owner).post(`/suppliers/${own}/approve`).expect(403)).body.message).toMatch(/someone else/);

    const expiring = (await as(owner).get('/supplier-compliance?days=30').expect(200)).body;
    expect(expiring).toMatchObject([{ code: 'PIPES', type: 'TAX_COMPLIANCE', number: 'KRA-TCC-2' }]);
    await as(owner).patch('/organisation', { settings: { supplierOnboardingApproval: false } }).expect(200);
  });

  it('suspends and blacklists: no new orders, but existing work is still billed and paid', async () => {
    const po = (await order(supplier, { expectedDate: '2026-05-10' }).expect(201)).body;
    await as(preparer).post(`/purchase-orders/${po.id}/submit`).expect(201);
    await as(owner).post(`/purchase-orders/${po.id}/approve`).expect(201);

    await as(owner).post(`/suppliers/${supplier}/status`, { status: 'SUSPENDED' }).expect(400); // reason required
    await as(preparer).post(`/suppliers/${supplier}/status`, { status: 'SUSPENDED', reason: 'Late deliveries' }).expect(403);
    await as(owner).post(`/suppliers/${supplier}/status`, { status: 'SUSPENDED', reason: 'Late deliveries under review', until: '2026-01-01' }).expect(201);
    expect((await order(supplier).expect(400)).body.message).toBe('Pipes Ltd is suspended: Late deliveries under review');
    await as(preparer).post('/rfqs', { entityId: ke, branchId: hq, title: 'Fittings', date: '2026-05-03', dueDate: '2026-05-09', supplierIds: [supplier], lines: [{ description: 'Fittings', quantity: '1', accountId: acc['6600'] }] }).expect(400);
    // Goods on the approved order are still received, billed and paid.
    await as(preparer).post(`/purchase-orders/${po.id}/receipts`, { date: '2026-05-08', lines: [{ poLineNo: 1, quantity: '10' }] }).expect(201);
    const bill = (await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-05-09', supplierInvoiceNumber: 'PL-9', purchaseOrderId: po.id, lines: [{ description: 'Pipe fittings', accountId: acc['6600'], quantity: '10', unitPrice: '500', poLineNo: 1 }] }).expect(201)).body;
    await as(preparer).post(`/invoices/${bill.id}/submit`).expect(201);
    await as(owner).post(`/invoices/${bill.id}/approve`, {}).expect(201);
    await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-05-12', bankAccountId: bank, amount: '5000', allocations: [{ documentId: bill.id, amount: '5000' }] }).expect(201);

    // The suspension's end date has passed: the scheduled job reinstates it.
    const { supplierManagement } = await getServices();
    expect(await supplierManagement.liftExpiredSuspensions()).toEqual({ reinstated: 1 });
    expect((await as(owner).get(`/suppliers/${supplier}`).expect(200)).body.status).toBe('ACTIVE');

    await as(owner).post(`/suppliers/${supplier}/status`, { status: 'BLACKLISTED', reason: 'Forged delivery notes', until: '2027-01-01' }).expect(400);
    await as(owner).post(`/suppliers/${supplier}/status`, { status: 'BLACKLISTED', reason: 'Forged delivery notes' }).expect(201);
    expect((await order(supplier).expect(400)).body.message).toMatch(/blacklisted: Forged delivery notes/);
    await as(owner).post(`/suppliers/${supplier}/status`, { status: 'ACTIVE' }).expect(201);
    await order(supplier).expect(201);
  });

  it('rates suppliers after delivery and works out on-time delivery', async () => {
    const pos = (await as(owner).get(`/purchase-orders?supplierId=${supplier}&pageSize=50`).expect(200)).body.items as { id: string; number: string; expectedDate: string | null }[];
    const delivered = pos.find((p) => p.expectedDate)!;
    const undelivered = pos.find((p) => !p.expectedDate)!;
    await as(preparer).post(`/suppliers/${supplier}/ratings`, { purchaseOrderId: undelivered.id, date: '2026-05-20', quality: 4, delivery: 4, price: 4, service: 4 }).expect(400);
    await as(preparer).post(`/suppliers/${supplier}/ratings`, { purchaseOrderId: delivered.id, date: '2026-05-20', quality: 6, delivery: 4, price: 4, service: 4 }).expect(400);
    await as(preparer).post(`/suppliers/${supplier}/ratings`, { purchaseOrderId: delivered.id, date: '2026-05-20', quality: 5, delivery: 3, price: 4, service: 4, comment: 'Good fittings, one day late on paperwork' }).expect(201);
    await as(preparer).post(`/suppliers/${supplier}/ratings`, { purchaseOrderId: delivered.id, date: '2026-05-21', quality: 1, delivery: 1, price: 1, service: 1 }).expect(400);
    await as(owner).post(`/suppliers/${supplier}/ratings`, { date: '2026-06-01', quality: 3, delivery: 5, price: 4, service: 2 }).expect(201);

    const perf = (await as(owner).get(`/suppliers/${supplier}/performance`).expect(200)).body;
    expect(perf).toMatchObject({ ratingCount: 2, averages: { quality: 4, delivery: 4, price: 4, service: 3 }, overall: 3.8, ordersDelivered: 1, onTime: 1, onTimePercent: 100 });
    expect(perf.ratings[0].ratedByName).toBe('Owner');
    const cards = (await as(owner).get('/supplier-scorecards').expect(200)).body as { code: string; overall: number | null; categories: string[]; status: string }[];
    expect(cards.find((c) => c.code === 'PIPES')).toMatchObject({ overall: 3.8, categories: ['WORKS'], status: 'ACTIVE' });
    expect(cards.find((c) => c.code === 'OWN')).toMatchObject({ status: 'PENDING', overall: null });
  });
});
