import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../../src/modules/finance/core/database/db.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for commercial finance: receivables, payables, procurement, banking and tax,
 * including the ledger effects and controls behind them.
 */

const PASSWORD = 'Password1234';

describe('Commercial finance (e2e)', () => {
  let db: Db;
  let owner: string; // Administrator + Finance Director
  let preparer: string; // Accountant
  let reviewer: string; // Finance Reviewer
  let entityId: string;
  let hqId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  let kesBank: string;
  let usdBank: string;
  let customer: string;
  let usdCustomer: string;
  let supplier: string;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function login(email: string) {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    return res.body.token as string;
  }

  const invoice = (overrides: Record<string, unknown> = {}) => ({
    entityId,
    branchId: hqId,
    kind: 'SALES_INVOICE',
    partyId: customer,
    date: '2026-03-10',
    lines: [{ description: 'Consulting', accountId: acc['4200'], quantity: '10', unitPrice: '10000', taxCodeId: tax.VAT16 }],
    ...overrides,
  });

  /** Creates, submits and approves (posts) a document; returns the posted document. */
  async function postDocument(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    const approved = await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201);
    return approved.body;
  }

  /** Net ledger movement (debit - credit, functional) on an account from a set of journals. */
  async function ledgerNet(accountCode: string, journalIds: string[]) {
    const rows = await db.ledger.find({ journalId: { $in: journalIds }, accountId: acc[accountCode] }).lean();
    return rows.reduce((s, r) => s + Number(r.debit.toString()) - Number(r.credit.toString()), 0);
  }

  beforeAll(async () => {
    ({ db } = await createTestApp());

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        organisationName: 'Commercial E2E',
        adminName: 'Owner',
        email: 'owner@commercial.test',
        password: PASSWORD,
        entityCode: 'KE',
        entityName: 'Commercial Kenya',
        country: 'Kenya',
        functionalCurrency: 'KES',
        fiscalYearStart: '2026-01-01',
      })
      .expect(201);
    owner = reg.body.token;
    entityId = (await as(owner).get('/entities').expect(200)).body[0].id;
    hqId = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;

    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@commercial.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@commercial.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@commercial.test');
    reviewer = await login('rev@commercial.test');

    await as(owner).post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '130', effectiveDate: '2026-03-01' }).expect(201);
    await as(owner).post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '132', effectiveDate: '2026-04-01' }).expect(201);

    kesBank = (await as(owner).post('/bank-accounts', { entityId, branchId: hqId, name: 'Operating KES', glAccountId: acc['1120'], reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    usdBank = (await as(owner).post('/bank-accounts', { entityId, branchId: hqId, name: 'USD Account', glAccountId: acc['1130'] }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'ACME', name: 'Acme Ltd', currency: 'KES', paymentTermsDays: 30, defaultAccountId: acc['4100'] }).expect(201)).body.id;
    usdCustomer = (await as(preparer).post('/customers', { code: 'GLOBEX', name: 'Globex Inc', currency: 'USD' }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'LAWCO', name: 'Law & Co', currency: 'KES', withholdingTaxCodeId: tax.WHT5 }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('provisions jurisdiction tax codes and subledger settings', () => {
    expect(Object.keys(tax)).toEqual(expect.arrayContaining(['VAT16', 'ZERO', 'EXEMPT', 'WHT5']));
  });

  describe('receivables', () => {
    let invoiceId: string;

    it('keeps invoices off the ledger until a second person approves them', async () => {
      const created = await as(preparer).post('/invoices', invoice()).expect(201);
      expect(created.body.number).toMatch(/^INV-KE-/);
      expect(created.body.total).toBe('116000');
      await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
      await as(preparer).post(`/invoices/${created.body.id}/approve`, {}).expect(403);
      expect(await db.ledger.countDocuments({ organisationId: created.body.organisationId })).toBe(0);
      const posted = await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201);
      invoiceId = posted.body.id;
      expect(posted.body.status).toBe('POSTED');
      expect(posted.body.amountDue).toBe('116000');
      const j = posted.body.journalId;
      expect(await ledgerNet('1200', [j])).toBe(116000);
      expect(await ledgerNet('4200', [j])).toBe(-100000);
      expect(await ledgerNet('2130', [j])).toBe(-16000);
      const ledgerLine = await db.ledger.findOne({ journalId: j, accountId: acc['1200'] }).lean();
      expect(ledgerLine!.partyId!.toHexString()).toBe(customer);
    });

    it('blocks manual journals to the receivables control account', async () => {
      await as(preparer)
        .post('/journals', { entityId, branchId: hqId, journalDate: '2026-03-15', description: 'x', lines: [{ accountId: acc['1200'], debit: '1' }, { accountId: acc['4100'], credit: '1' }] })
        .expect(400);
    });

    it('applies a partial receipt and tracks the open balance', async () => {
      const receipt = await as(preparer)
        .post('/payments', { entityId, kind: 'RECEIPT', partyId: customer, date: '2026-03-20', bankAccountId: kesBank, amount: '50000', reference: 'EFT-1', allocations: [{ documentId: invoiceId, amount: '50000' }], post: true })
        .expect(201);
      expect(receipt.body.status).toBe('POSTED');
      const inv = await as(preparer).get(`/invoices/${invoiceId}`).expect(200);
      expect(inv.body.amountDue).toBe('66000');
      expect(inv.body.paymentStatus).toBe('PARTIAL');
      expect(inv.body.allocations).toHaveLength(1);
    });

    it('settles with a credit note raised against the invoice', async () => {
      const cn = await postDocument(
        invoice({ kind: 'SALES_CREDIT', appliesToId: invoiceId, date: '2026-03-25', lines: [{ description: 'Discount', accountId: acc['4200'], quantity: '1', unitPrice: '10000', taxCodeId: tax.VAT16 }] }),
      );
      expect(cn.number).toMatch(/^CN-/);
      expect(cn.amountDue).toBe('0');
      const inv = await as(preparer).get(`/invoices/${invoiceId}`).expect(200);
      expect(inv.body.amountDue).toBe('54400');
    });

    it('refuses to void a document that has allocations', async () => {
      const res = await as(reviewer).post(`/invoices/${invoiceId}/void`, { date: '2026-03-31', reason: 'test' }).expect(400);
      expect(res.body.message).toMatch(/reverse them before voiding/);
    });

    it('enforces customer credit limits', async () => {
      await as(owner).patch(`/customers/${customer}`, { creditLimit: '100000' }).expect(200);
      const created = await as(preparer).post('/invoices', invoice({ date: '2026-03-26' })).expect(201);
      await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
      const res = await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(403);
      expect(res.body.message).toMatch(/Credit control/);
      await as(owner).patch(`/customers/${customer}`, { creditLimit: null }).expect(200);
      await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(201);
    });

    it('books realised FX when a foreign-currency invoice is paid at a different rate', async () => {
      const inv = await postDocument(invoice({ partyId: usdCustomer, date: '2026-03-15', lines: [{ description: 'Export', accountId: acc['4100'], quantity: '1', unitPrice: '1000' }] }));
      expect(inv.currency).toBe('USD');
      expect(inv.totalFunctional).toBe('130000');
      const receipt = await as(preparer)
        .post('/payments', { entityId, kind: 'RECEIPT', partyId: usdCustomer, date: '2026-04-10', bankAccountId: usdBank, amount: '1000', allocations: [{ documentId: inv.id, amount: '1000' }], post: true })
        .expect(201);
      expect(receipt.body.amountFunctional).toBe('132000');
      const allocation = await db.allocations.findOne({ sourceId: receipt.body.id }).lean();
      expect(allocation!.fxAmount.toString()).toBe('2000');
      expect(await ledgerNet('4900', [allocation!.journalId!.toHexString()])).toBe(-2000);
      const paid = await as(preparer).get(`/invoices/${inv.id}`).expect(200);
      expect(paid.body.paymentStatus).toBe('PAID');
      expect(paid.body.amountDueFunctional).toBe('0');
    });

    it('requires receipts to use a bank account in the customer currency', async () => {
      const res = await as(preparer)
        .post('/payments', { entityId, kind: 'RECEIPT', partyId: usdCustomer, date: '2026-04-10', bankAccountId: kesBank, amount: '10', post: true })
        .expect(400);
      expect(res.body.message).toMatch(/trades in USD/);
    });
  });

  describe('payables and procurement', () => {
    let poId: string;

    it('runs a purchase order through approval and goods receipt', async () => {
      const po = await as(preparer)
        .post('/purchase-orders', { entityId, branchId: hqId, supplierId: supplier, date: '2026-03-01', lines: [{ description: 'Legal retainer (hours)', accountId: acc['6700'], quantity: '10', unitPrice: '10000', taxCodeId: tax.VAT16 }] })
        .expect(201);
      poId = po.body.id;
      await as(preparer).post(`/purchase-orders/${poId}/submit`).expect(201);
      await as(preparer).post(`/purchase-orders/${poId}/approve`).expect(403);
      await as(reviewer).post(`/purchase-orders/${poId}/approve`).expect(201);
      await as(preparer).post(`/purchase-orders/${poId}/receipts`, { date: '2026-03-05', lines: [{ poLineNo: 1, quantity: '20' }] }).expect(400);
      const grn = await as(preparer).post(`/purchase-orders/${poId}/receipts`, { date: '2026-03-05', lines: [{ poLineNo: 1, quantity: '10' }] }).expect(201);
      expect(grn.body.number).toMatch(/^GRN-/);
      expect((await as(preparer).get(`/purchase-orders/${poId}`).expect(200)).body.status).toBe('RECEIVED');
    });

    const bill = (overrides: Record<string, unknown> = {}) => ({
      entityId,
      branchId: hqId,
      kind: 'PURCHASE_BILL',
      partyId: supplier,
      date: '2026-03-08',
      supplierInvoiceNumber: 'LC-1001',
      purchaseOrderId: poId,
      lines: [{ description: 'Legal retainer', accountId: acc['6700'], quantity: '10', unitPrice: '10000', taxCodeId: tax.VAT16, poLineNo: 1 }],
      ...overrides,
    });

    let billId: string;

    it('blocks bills that fail the three-way match', async () => {
      const created = await as(preparer).post('/invoices', bill({ supplierInvoiceNumber: 'LC-0999', lines: [{ description: 'Legal retainer', accountId: acc['6700'], quantity: '10', unitPrice: '12000', taxCodeId: tax.VAT16, poLineNo: 1 }] })).expect(201);
      await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
      const res = await as(reviewer).post(`/invoices/${created.body.id}/approve`, {}).expect(400);
      expect(res.body.message).toMatch(/Three-way match failed.*above the order price/);
      await as(reviewer).post(`/invoices/${created.body.id}/reject`, { reason: 'Price differs from the order' }).expect(201);
      await api().delete(`/api/v1/invoices/${created.body.id}`).set('Authorization', `Bearer ${preparer}`).expect(200);
    });

    it('posts a matched bill and rejects a duplicate supplier invoice number', async () => {
      const posted = await postDocument(bill());
      billId = posted.id;
      expect(posted.matchStatus).toBe('MATCHED');
      expect(await ledgerNet('2110', [posted.journalId])).toBe(-116000);
      expect(await ledgerNet('1450', [posted.journalId])).toBe(16000);
      const dup = await as(preparer).post('/invoices', bill({ purchaseOrderId: null, lines: [{ description: 'Again', accountId: acc['6700'], quantity: '1', unitPrice: '1' }] })).expect(400);
      expect(dup.body.message).toMatch(/Possible duplicate/);
      const po = await as(preparer).get(`/purchase-orders/${poId}`).expect(200);
      expect(po.body.lines[0].quantityBilled).toBe('10');
    });

    let paymentId: string;

    it('pays a bill net of withholding tax after approval', async () => {
      const proposal = await as(preparer).get(`/payments/proposal?entityId=${entityId}&bankAccountId=${kesBank}&dueBy=2026-12-31`).expect(200);
      expect(proposal.body.bills.map((b: { id: string }) => b.id)).toContain(billId);
      const run = await as(preparer).post('/payments/runs', { entityId, bankAccountId: kesBank, date: '2026-04-05', submit: true, items: [{ documentId: billId, amount: '116000' }] }).expect(201);
      const payment = run.body.payments[0];
      paymentId = payment.id;
      expect(payment.withholdingAmount).toBe('5000');
      expect(payment.amount).toBe('111000');
      await as(preparer).post(`/payments/${paymentId}/approve`).expect(403);
      const approved = await as(reviewer).post(`/payments/${paymentId}/approve`).expect(201);
      expect(approved.body.status).toBe('POSTED');
      expect(await ledgerNet('1120', [approved.body.journalId])).toBe(-111000);
      expect(await ledgerNet('2150', [approved.body.journalId])).toBe(-5000);
      expect(await ledgerNet('2110', [approved.body.journalId])).toBe(116000);
      expect((await as(preparer).get(`/invoices/${billId}`).expect(200)).body.paymentStatus).toBe('PAID');
    });

    it('voids a payment and reopens the bill', async () => {
      const voided = await as(reviewer).post(`/payments/${paymentId}/void`, { date: '2026-04-06', reason: 'Wrong bank' }).expect(201);
      expect(voided.body.status).toBe('VOID');
      const reopened = await as(preparer).get(`/invoices/${billId}`).expect(200);
      expect(reopened.body.amountDue).toBe('116000');
      expect(reopened.body.allocations[0].status).toBe('REVERSED');
    });
  });

  describe('banking', () => {
    it('imports a statement, matches, adjusts and locks a reconciliation', async () => {
      const imported = await as(preparer)
        .post(`/bank-accounts/${kesBank}/statements`, {
          lines: [
            { date: '2026-03-21', description: 'EFT ACME', reference: 'EFT-1', amount: '50000' },
            { date: '2026-03-31', description: 'Monthly service fee', amount: '-450' },
          ],
        })
        .expect(201);
      expect(imported.body.imported).toBe(2);
      const again = await as(preparer).post(`/bank-accounts/${kesBank}/statements`, { lines: [{ date: '2026-03-21', description: 'EFT ACME', reference: 'EFT-1', amount: '50000' }] }).expect(201);
      expect(again.body.duplicates).toBe(1);

      expect((await as(reviewer).post(`/bank-accounts/${kesBank}/auto-match`).expect(201)).body.matched).toBe(1);
      const ws = await as(reviewer).get(`/bank-accounts/${kesBank}/reconciliation?asOf=2026-03-31`).expect(200);
      const fee = ws.body.statementLines.find((l: { amount: string }) => l.amount === '-450');
      await as(reviewer).post(`/bank-accounts/${kesBank}/adjustments`, { statementLineId: fee.id, accountId: acc['6800'], description: 'Bank charges' }).expect(201);

      const wrong = await as(reviewer).post(`/bank-accounts/${kesBank}/reconciliations`, { statementDate: '2026-03-31', statementBalance: '1' }).expect(400);
      expect(wrong.body.message).toMatch(/Not reconciled/);
      const rec = await as(reviewer).post(`/bank-accounts/${kesBank}/reconciliations`, { statementDate: '2026-03-31', statementBalance: '49550' }).expect(201);
      expect(rec.body.matchedCount).toBe(2);
      const late = await as(preparer).post(`/bank-accounts/${kesBank}/statements`, { lines: [{ date: '2026-03-30', amount: '5' }] }).expect(400);
      expect(late.body.message).toMatch(/reconciled to 2026-03-31/);
    });

    it('converts between currencies through a transfer with FX', async () => {
      const t = await as(preparer).post('/bank-transfers', { entityId, fromBankAccountId: usdBank, toBankAccountId: kesBank, date: '2026-04-15', amount: '500', toAmount: '65000' }).expect(201);
      expect(t.body.number).toMatch(/^TRF-/);
      // 500 USD at 132 = 66,000 KES carried; 65,000 received: a 1,000 loss.
      expect(await ledgerNet('6900', [t.body.journalId])).toBe(1000);
    });
  });

  describe('reporting and controls', () => {
    it('keeps the subledgers in agreement with the control accounts', async () => {
      const res = await as(owner).get(`/reports/subledger-control?entityId=${entityId}`).expect(200);
      for (const check of res.body.checks) expect({ party: check.partyType, reconciled: check.reconciled, differences: check.differences }).toEqual({ party: check.partyType, reconciled: true, differences: [] });
    });

    it('produces a tax report with output, input and withholding tax', async () => {
      const res = await as(owner).get(`/reports/tax?entityId=${entityId}&from=2026-01-01&to=2026-12-31`).expect(200);
      // Output: 16,000 + 16,000 (second invoice) - 1,600 (credit note). Input: 16,000. WHT: 5,000 then reversed.
      expect(res.body.totals.outputTax).toBe('30400');
      expect(res.body.totals.inputTax).toBe('16000');
      expect(res.body.totals.netVatPayable).toBe('14400');
      expect(res.body.totals.withholdingTax).toBe('0');
    });

    it('ages receivables by due date', async () => {
      const res = await as(owner).get(`/reports/aging?entityId=${entityId}&partyType=CUSTOMER&asOf=2026-05-15`).expect(200);
      const acme = res.body.rows.find((r: { partyId: string }) => r.partyId === customer);
      // INV 1 was due 9 April (36 days overdue); INV 2 was due 25 April (20 days).
      expect(acme.buckets.days31to60).toBe('54400');
      expect(acme.buckets.days1to30).toBe('116000');
      const statement = await as(owner).get(`/reports/statement?entityId=${entityId}&partyType=CUSTOMER&partyId=${customer}&from=2026-01-01&to=2026-05-15`).expect(200);
      expect(statement.body.closingBalance).toBe('170400');
    });

    it('still produces a balanced trial balance', async () => {
      const tb = await as(owner).get(`/reports/trial-balance?entityId=${entityId}&from=2026-01-01&to=2026-12-31`).expect(200);
      expect(tb.body.balanced).toBe(true);
    });

    it('hides receivables from users without access', async () => {
      const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
      const auditor = roles.find((r) => r.name === 'Auditor')!.id;
      await as(owner).post('/users', { name: 'Viewer', email: 'viewer@commercial.test', password: PASSWORD, roleIds: [auditor] }).expect(201);
      const viewer = await login('viewer@commercial.test');
      await as(viewer).get('/invoices?kind=SALES_INVOICE').expect(200);
      await as(viewer).post('/invoices', invoice()).expect(403);
    });
  });
});
