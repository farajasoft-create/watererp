import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../../src/modules/finance/core/common/auth';
import { getServices } from '../../src/modules/finance/core/container';
import { amountInWords, numberInWords } from '../../src/modules/finance/core/modules/payments/voucher.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Printable payment vouchers: supplier payments (bills settled, withholding tax, coding, approval names),
 * imprest advances and expense claim reimbursements, with draft and unpaid vouchers stamped.
 */

const PASSWORD = 'Password1234';
const oid = (id: string) => new Types.ObjectId(id);

describe('Payment vouchers (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let supplier: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const userOf = async (token: string) => authenticate((await getServices()).db, new Request('http://test/api/v1/me', { headers: { authorization: `Bearer ${token}` } }), { ip: null });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Voucher E2E', adminName: 'Owner', email: 'owner@pv.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@pv.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@pv.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@pv.test');
    reviewer = await login('rev@pv.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'KCB Main', accountNumber: '1100223344', glAccountId: acc['1120'] }).expect(201)).body.id;
    supplier = (
      await as(preparer)
        .post('/suppliers', { code: 'PIPES', name: 'Pipes Ltd', legalName: 'Pipes & Fittings Limited', currency: 'KES', taxId: 'P051234567X', bankName: 'Equity Bank', bankBranch: 'Eldoret', bankAccountNumber: '0450199', bankAccountName: 'Pipes & Fittings Ltd', withholdingTaxCodeId: tax.WHT5 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('writes amounts in words', () => {
    expect(numberInWords(BigInt(0))).toBe('zero');
    expect(numberInWords(BigInt(1005))).toBe('one thousand and five');
    expect(numberInWords(BigInt(111000))).toBe('one hundred and eleven thousand');
    expect(numberInWords(BigInt(2_340_019))).toBe('two million three hundred and forty thousand and nineteen');
    expect(amountInWords('12500.50', 'KES')).toBe('Kenya Shillings twelve thousand five hundred and cents fifty only');
    expect(amountInWords('1', 'USD')).toBe('US Dollars one only');
  });

  it('prints a supplier payment voucher with the bill, withholding tax, coding and approver', async () => {
    const created = await as(preparer)
      .post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-08', supplierInvoiceNumber: 'PF-778', lines: [{ description: 'HDPE pipes', accountId: acc['6700'], quantity: '10', unitPrice: '10000', taxCodeId: tax.VAT16 }] })
      .expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    const billDoc = (await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201)).body;
    const run = await as(preparer).post('/payments/runs', { entityId: ke, bankAccountId: bank, date: '2026-04-05', submit: true, items: [{ documentId: billDoc.id, amount: '116000' }] }).expect(201);
    const paymentId = run.body.payments[0].id as string;
    const { vouchers } = await getServices();

    // Awaiting approval: printable for the approver, stamped, no coding yet.
    const draft = await vouchers.paymentView(await userOf(reviewer), oid(paymentId));
    expect(draft.stamp).toBe('NOT APPROVED');
    expect(draft.coding).toHaveLength(0);
    expect(draft.particulars[0]).toMatchObject({ reference: billDoc.number, amount: '116,000.00' });

    await as(reviewer).post(`/payments/${paymentId}/approve`).expect(201);
    const v = await vouchers.paymentView(await userOf(preparer), oid(paymentId));
    expect(v.stamp).toBeNull();
    expect(v.title).toBe('Payment voucher');
    expect(v.payee).toMatchObject({ name: 'Pipes & Fittings Limited', code: 'PIPES', taxId: 'P051234567X' });
    expect(v.payee.lines.join(' ')).toMatch(/Equity Bank, Eldoret a\/c 0450199/);
    expect(v.amount).toBe('111,000.00');
    expect(v.amountInWords).toBe('Kenya Shillings one hundred and eleven thousand only');
    expect(v.particulars).toEqual([{ reference: billDoc.number, description: 'Supplier invoice PF-778, dated 2026-03-08', amount: '116,000.00' }]);
    expect(v.deductions).toEqual([{ label: 'Less withholding tax (WHT5)', amount: '-5,000.00' }]);
    expect(v.codingTotals).toEqual({ debit: '116,000.00', credit: '116,000.00' });
    expect(v.coding.map((c) => c.code).sort()).toEqual(['1120', '2110', '2150']);
    expect(v.signatures[0]).toMatchObject({ role: 'Prepared by', name: 'Paula Preparer' });
    expect(v.signatures.slice(1).map((s) => s.name)).toContain('Rita Reviewer');
    expect(v.facts).toContainEqual(['Paid from', 'KCB Main 1100223344']);

    const res = await as(preparer).get(`/payments/${paymentId}/voucher`).expect(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''Payment%20voucher%20PAY-KE-\d+\.pdf/);
    expect(String(res.body).startsWith('%PDF-')).toBe(true);

    // Receipts are not vouchers; voids are stamped.
    await as(reviewer).post(`/payments/${paymentId}/void`, { date: '2026-04-06', reason: 'Wrong bank' }).expect(201);
    expect((await vouchers.paymentView(await userOf(preparer), oid(paymentId))).stamp).toBe('VOID');
  });

  it('prints imprest and expense claim vouchers, stamped until paid', async () => {
    const types = (await as(preparer).get('/imprest-types').expect(200)).body as { id: string; code: string }[];
    const imp = await as(preparer)
      .post('/imprests', { entityId: ke, branchId: hq, typeId: types.find((t) => t.code === 'SAFARI')!.id, purpose: 'Meter audit, Kapsabet', destination: 'Kapsabet', startDate: '2026-04-01', endDate: '2026-04-03', lines: [{ description: 'Per diem', amount: '9000' }, { description: 'Fuel', amount: '3500.50' }] })
      .expect(201);
    await as(preparer).post(`/imprests/${imp.body.id}/submit`).expect(201);
    await as(reviewer).post(`/imprests/${imp.body.id}/approve`, {}).expect(201);
    const { vouchers } = await getServices();
    const before = await vouchers.imprestView(await userOf(preparer), oid(imp.body.id));
    expect(before.stamp).toBe('NOT PAID');
    await as(reviewer).post(`/imprests/${imp.body.id}/issue`, { date: '2026-04-01', bankAccountId: bank, reference: 'CHQ 0042' }).expect(201);
    const v = await vouchers.imprestView(await userOf(preparer), oid(imp.body.id));
    expect(v.stamp).toBeNull();
    expect(v.amountInWords).toBe('Kenya Shillings twelve thousand five hundred and cents fifty only');
    expect(v.particulars.map((p) => p.description)).toEqual(['Per diem', 'Fuel']);
    expect(v.coding.map((c) => c.code).sort()).toEqual(['1120', '1260']);
    expect(v.signatures.map((s) => s.role)).toEqual(expect.arrayContaining(['Prepared by', 'Issued by']));
    expect(v.signatures.find((s) => s.role === 'Issued by')!.name).toBe('Rita Reviewer');
    await as(preparer).get(`/imprests/${imp.body.id}/voucher`).expect(200);

    const categories = (await as(preparer).get('/expense-categories').expect(200)).body as { id: string; code: string }[];
    const claim = await as(preparer)
      .post('/expense-claims', { entityId: ke, branchId: hq, title: 'Site visit', lines: [{ date: '2026-03-02', categoryId: categories.find((c) => c.code === 'TRAVEL')!.id, description: 'Train ticket', amount: '2000', receiptReference: 'SGR-1123' }] })
      .expect(201);
    await as(preparer).post(`/expense-claims/${claim.body.id}/submit`).expect(201);
    await as(reviewer).post(`/expense-claims/${claim.body.id}/approve`, {}).expect(201);
    expect((await vouchers.claimView(await userOf(preparer), oid(claim.body.id))).stamp).toBe('NOT PAID');
    await as(reviewer).post(`/expense-claims/${claim.body.id}/pay`, { date: '2026-03-05', bankAccountId: bank }).expect(201);
    const c = await vouchers.claimView(await userOf(preparer), oid(claim.body.id));
    expect(c.stamp).toBeNull();
    expect(c.payee.name).toBe('Paula Preparer');
    expect(c.particulars[0]).toMatchObject({ reference: 'SGR-1123', amount: '2,000.00' });
    expect(c.signatures.find((s) => s.role === 'Paid by')!.name).toBe('Rita Reviewer');
    await as(preparer).get(`/expense-claims/${claim.body.id}/voucher`).expect(200);
  });
});
