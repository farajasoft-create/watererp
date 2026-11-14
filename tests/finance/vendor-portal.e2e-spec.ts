import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/modules/finance/core/database/db.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * The vendor portal: a private link per supplier to follow orders, bills and what is owed, and payments
 * with what each settled; invoices sent in by the supplier for accounts payable to enter or turn back;
 * links that expire and can be withdrawn.
 */

const PASSWORD = 'Password1234';

describe('Vendor portal (e2e)', () => {
  let db: Db;
  let payment: string;
  let owner: string;
  let preparer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let supplier: string;
  let po: string;
  let token = '';
  let linkId = '';
  const acc: Record<string, string> = {};

  const as = (t: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${t}`).send(body ?? {}),
  });
  const anon = { get: (url: string) => api().get(`/api/v1${url}`), post: (url: string, body: object) => api().post(`/api/v1${url}`).send(body) };

  beforeAll(async () => {
    ({ db } = await createTestApp());
    const reg = await api().post('/api/v1/auth/register').send({ organisationName: 'Vendor E2E', adminName: 'Owner', email: 'owner@vp.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' }).expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@vp.test', password: PASSWORD, roleIds: [roles.find((r) => r.name === 'Accountant')!.id] }).expect(201);
    preparer = (await api().post('/api/v1/auth/login').send({ email: 'prep@vp.test', password: PASSWORD }).expect(200)).body.token;
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'PIPES', name: 'Eldoret Pipes Ltd', currency: 'KES', email: 'accounts@pipes.test' }).expect(201)).body.id;
    po = (await as(preparer).post('/purchase-orders', { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-05-01', lines: [{ description: 'HDPE pipe 110mm', accountId: acc['6600'], quantity: '10', unitPrice: '5000' }] }).expect(201)).body.id;
    await as(preparer).post(`/purchase-orders/${po}/submit`).expect(201);
    await as(owner).post(`/purchase-orders/${po}/approve`).expect(201);
    const bill = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-05-10', dueDate: '2026-05-20', supplierInvoiceNumber: 'EP-77', lines: [{ description: 'HDPE pipe', accountId: acc['6600'], quantity: '1', unitPrice: '30000' }] }).expect(201);
    await as(preparer).post(`/invoices/${bill.body.id}/submit`).expect(201);
    await as(owner).post(`/invoices/${bill.body.id}/approve`).expect(201);
    const pay = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-05-25', bankAccountId: bank, amount: '10000', reference: 'EFT-55', allocations: [{ documentId: bill.body.id, amount: '10000' }] }).expect(201);
    await as(preparer).post(`/payments/${pay.body.id}/submit`).expect(201);
    await as(owner).post(`/payments/${pay.body.id}/approve`).expect(201);
    payment = pay.body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('emails the supplier a remittance advice when the payment posts, and again on request', async () => {
    const sent = await db.emails.find({ relatedType: 'Payment' }).lean();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['accounts@pipes.test']);
    expect(sent[0].text).toContain('EP-77');
    expect(sent[0].text).toContain('10,000.00');
    await as(preparer).post(`/payments/${payment}/remittance`, { to: 'md@pipes.test' }).expect(200);
    expect(await db.emails.countDocuments({ relatedType: 'Payment', to: 'md@pipes.test' })).toBe(1);
    expect((await as(preparer).get(`/payments/${payment}`).expect(200)).body.remittanceSentTo).toBe('md@pipes.test');
  });

  it('gives a supplier a private link', async () => {
    const link = await as(preparer).post(`/suppliers/${supplier}/portal-links`, { days: 30 }).expect(201);
    token = String(link.body.url).split('/vendors/')[1];
    linkId = link.body.id;
    expect(token.length).toBeGreaterThan(20);
    const links = await as(preparer).get(`/suppliers/${supplier}/portal-links`).expect(200);
    expect(links.body).toEqual([expect.objectContaining({ active: true })]);
    expect(links.body[0].tokenHash).toBeUndefined();
  });

  it('shows the supplier their orders, invoices, what is owed and payments', async () => {
    const v = (await anon.get(`/vendor-portal/${token}`).expect(200)).body;
    expect(v.supplier.name).toBe('Eldoret Pipes Ltd');
    expect(v.orders.map((o: { status: string }) => o.status)).toHaveLength(1);
    expect(v.invoices).toEqual([expect.objectContaining({ supplierInvoiceNumber: 'EP-77', overdue: true })]);
    expect(Number(v.summary.owed)).toBe(20000);
    expect(v.payments).toEqual([expect.objectContaining({ reference: 'EFT-55', settled: [expect.objectContaining({ amount: '10000' })] })]);
    await anon.get('/vendor-portal/not-a-real-link-at-all-xx').expect(404);
  });

  it('takes invoices from the supplier for accounts payable to enter', async () => {
    await anon.post(`/vendor-portal/${token}/invoices`, { invoiceNumber: 'EP-80', invoiceDate: '2026-06-01', amount: '60000', purchaseOrderId: po }).expect(400); // more than the order
    const sent = await anon.post(`/vendor-portal/${token}/invoices`, { invoiceNumber: 'EP-80', invoiceDate: '2026-06-01', amount: '50000', purchaseOrderId: po, etimsNumber: 'KRA0001' }).expect(201);
    await anon.post(`/vendor-portal/${token}/invoices`, { invoiceNumber: 'EP-80', invoiceDate: '2026-06-01', amount: '50000' }).expect(409);
    const queue = (await as(preparer).get('/supplier-invoices?status=SUBMITTED').expect(200)).body;
    expect(queue).toEqual([expect.objectContaining({ invoiceNumber: 'EP-80', supplier: 'Eldoret Pipes Ltd' })]);
    await as(preparer).post(`/supplier-invoices/${sent.body.id}/decide`, { status: 'REJECTED' }).expect(400);
    await as(preparer).post(`/supplier-invoices/${sent.body.id}/decide`, { status: 'REJECTED', reason: 'Goods not yet received' }).expect(200);
    const v = (await anon.get(`/vendor-portal/${token}`).expect(200)).body;
    expect(v.submissions).toEqual([expect.objectContaining({ invoiceNumber: 'EP-80', status: 'REJECTED', reason: 'Goods not yet received' })]);
  });

  it('stops working once withdrawn', async () => {
    await as(preparer).post(`/supplier-portal-links/${linkId}/revoke`).expect(200);
    await anon.get(`/vendor-portal/${token}`).expect(404);
  });
  it('prints a cheque only for posted cheque payments', async () => {
    await as(preparer).get(`/payments/${payment}/cheque`).expect(400); // paid by transfer
    const chq = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-05-26', bankAccountId: bank, amount: '1250.50', method: 'CHEQUE', reference: '000123' }).expect(201);
    await as(preparer).get(`/payments/${chq.body.id}/cheque`).expect(400); // not yet approved
    await as(preparer).post(`/payments/${chq.body.id}/submit`).expect(201);
    await as(owner).post(`/payments/${chq.body.id}/approve`).expect(201);
    const pdfRes = await as(preparer).get(`/payments/${chq.body.id}/cheque`).expect(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect((await db.payments.findById(chq.body.id).lean())?.chequePrints).toBe(1);
  });
  it("uses the organisation's own wording for procurement emails", async () => {
    const list = (await as(preparer).get('/email-templates').expect(200)).body as { key: string; customised: boolean }[];
    expect(list.map((t) => t.key)).toEqual(['rfq', 'lpo', 'remittance']);
    const tpl = { subject: 'Payment {{number}} to {{supplier}}', intro: 'Habari {{supplier}},', body: 'We sent {{currency}} {{amount}} on {{date}}.\n\nAsante.', footer: 'Accounts office' };
    await api().patch('/api/v1/email-templates/remittance').set('Authorization', `Bearer ${preparer}`).send({ ...tpl, body: 'Paid {{cash}}' }).expect(400);
    await api().patch('/api/v1/email-templates/remittance').set('Authorization', `Bearer ${preparer}`).send(tpl).expect(200);
    await as(preparer).post(`/payments/${payment}/remittance`, {}).expect(200);
    const last = await db.emails.findOne({ relatedType: 'Payment' }).sort({ createdAt: -1 }).lean();
    expect(last?.subject).toBe('Payment ' + (await as(preparer).get(`/payments/${payment}`).expect(200)).body.number + ' to Eldoret Pipes Ltd');
    expect(last?.text).toContain('Asante.');
    await api().delete('/api/v1/email-templates/remittance').set('Authorization', `Bearer ${preparer}`).expect(200);
  });

  it('holds a cheque until enough signatories have signed it electronically', async () => {
    const ownerId = (await db.users.findOne({ email: 'owner@vp.test' }).lean())!._id.toHexString();
    const prepId = (await db.users.findOne({ email: 'prep@vp.test' }).lean())!._id.toHexString();
    const put = (url: string, body: object, t = owner) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${t}`).send(body);
    await put(`/bank-accounts/${bank}/cheque-signatories`, { userIds: [ownerId], required: 2 }).expect(400); // more than the signatories
    await put(`/bank-accounts/${bank}/cheque-signatories`, { userIds: [ownerId, prepId], required: 1 }).expect(200);
    const chq = await as(preparer).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: supplier, date: '2026-05-27', bankAccountId: bank, amount: '777', method: 'CHEQUE', reference: '000124' }).expect(201);
    await as(preparer).post(`/payments/${chq.body.id}/submit`).expect(201);
    await as(owner).post(`/payments/${chq.body.id}/approve`).expect(201);
    expect((await as(preparer).get(`/payments/${chq.body.id}/cheque`).expect(400)).body.message).toMatch(/needs 1 signature/);
    await as(preparer).post(`/payments/${chq.body.id}/cheque-sign`).expect(403); // prepared it
    const st = (await as(owner).post(`/payments/${chq.body.id}/cheque-sign`).expect(200)).body;
    expect(st).toMatchObject({ complete: true, valid: true, signatures: [expect.objectContaining({ name: 'Owner' })] });
    await as(owner).post(`/payments/${chq.body.id}/cheque-sign`).expect(400); // already signed
    await as(preparer).get(`/payments/${chq.body.id}/cheque`).expect(200);
    // Altering the cheque afterwards breaks the signature.
    await db.payments.updateOne({ _id: chq.body.id }, { partyName: 'Someone Else' });
    expect((await as(owner).get(`/payments/${chq.body.id}/cheque-signatures`).expect(200)).body.valid).toBe(false);
  });
});
