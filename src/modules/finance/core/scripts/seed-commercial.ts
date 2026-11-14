/**
 * Demo data for commercial finance: customers and suppliers, invoices and bills through approval,
 * receipts and payments (including FX and withholding tax), procurement, banking and a statement.
 * Everything goes through the real services, so the ledger, tax and subledgers stay in agreement.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Decimal } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';
import { DocumentInput, DocumentLineInput } from '../modules/documents/documents.service';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  ug: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  msa: Branch & { _id: Types.ObjectId };
  kla: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const D = (v: string | number) => new Decimal(v);

export async function seedCommercial(c: Context) {
  const { s, organisationId, ke, ug, hq, msa, kla, accountant, approver } = c;
  const { db } = s;
  const acc = new Map((await db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const A = (code: string) => acc.get(code)!;
  await s.provisioning.createTaxCodes(organisationId, 'Uganda', acc);
  const tax = new Map((await db.taxCodes.find({ organisationId }).lean()).map((t) => [t.code, t._id]));
  const T = (code: string) => tax.get(code)!;

  // ----- Bank and cash accounts -------------------------------------------------------------
  const [keBank, usdBank] = await db.bankAccounts.create([
    { organisationId, entityId: ke._id, branchId: hq._id, name: 'Equity Bank – Operating', bankName: 'Equity Bank', accountNumber: '0170299123456', currency: 'KES', glAccountId: A('1120'), reconcileFrom: d('2026-09-01') },
    { organisationId, entityId: ke._id, branchId: hq._id, name: 'KCB – USD Account', bankName: 'KCB', accountNumber: '1104477889', currency: 'USD', glAccountId: A('1130'), reconcileFrom: d('2026-09-01') },
    { organisationId, entityId: ke._id, branchId: hq._id, name: 'Head office petty cash', type: 'PETTY_CASH', currency: 'KES', glAccountId: A('1110') },
    { organisationId, entityId: ug._id, branchId: kla._id, name: 'Stanbic Uganda – Operating', bankName: 'Stanbic', accountNumber: '9030012345678', currency: 'UGX', glAccountId: A('1120') },
  ]);

  // ----- Customers & suppliers ----------------------------------------------------------------
  const [savanna, coast, lakeside, atlas] = await db.customers.create([
    { organisationId, code: 'SAVANNA', name: 'Savanna Retailers Ltd', email: 'accounts@savanna.example', city: 'Nairobi', country: 'Kenya', taxId: 'P051234567A', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('4100'), defaultTaxCodeId: T('VAT16') },
    { organisationId, code: 'COASTAL', name: 'Coastal Hotels Group', email: 'payables@coastal.example', city: 'Mombasa', country: 'Kenya', taxId: 'P051987654B', currency: 'KES', paymentTermsDays: 14, defaultAccountId: A('4200'), defaultTaxCodeId: T('VAT16') },
    { organisationId, code: 'LAKESIDE', name: 'Lakeside Traders', email: 'info@lakeside.example', city: 'Kisumu', country: 'Kenya', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('4100'), defaultTaxCodeId: T('VAT16'), onHold: true },
    { organisationId, code: 'ATLAS', name: 'Atlas Imports Inc.', email: 'ap@atlas.example', city: 'Dubai', country: 'UAE', currency: 'USD', paymentTermsDays: 45, defaultAccountId: A('4100'), defaultTaxCodeId: T('ZERO') },
  ]);
  const [lawco, office, freight, cloud] = await db.suppliers.create([
    { organisationId, code: 'MWANGI', name: 'Mwangi & Partners Advocates', email: 'billing@mwangi.example', taxId: 'P051111222C', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('6700'), defaultTaxCodeId: T('VAT16'), withholdingTaxCodeId: T('WHT5'), bankName: 'NCBA', bankAccountNumber: '1003456789' },
    { organisationId, code: 'OFFICEPRO', name: 'OfficePro Supplies', email: 'sales@officepro.example', taxId: 'P051333444D', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('6600'), defaultTaxCodeId: T('VAT16'), bankName: 'Co-op Bank', bankAccountNumber: '01129876543' },
    { organisationId, code: 'SWIFTLOG', name: 'Swift Logistics Ltd', email: 'invoices@swift.example', taxId: 'P051555666E', currency: 'KES', paymentTermsDays: 14, defaultAccountId: A('5100'), defaultTaxCodeId: T('VAT16') },
    { organisationId, code: 'CLOUDCO', name: 'CloudCo Software LLC', email: 'billing@cloudco.example', country: 'USA', currency: 'USD', paymentTermsDays: 30, defaultAccountId: A('6600') },
  ]);
  await db.customers.updateOne({ _id: savanna._id }, { creditLimit: Types.Decimal128.fromString('5000000') });

  const line = (description: string, quantity: string | number, unitPrice: string | number, extra: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
    description,
    quantity: D(quantity),
    unitPrice: D(unitPrice),
    ...extra,
  });
  const base = { entityId: ke._id, branchId: hq._id };

  /** Prepared by the accountant, approved and posted by the reviewer. */
  async function post(input: DocumentInput) {
    const doc = await s.documents.create(accountant, input);
    await s.documents.submit(accountant, doc._id);
    return (await s.documents.approve(approver, doc._id))!;
  }
  async function receipt(partyId: Types.ObjectId, date: string, bankAccountId: Types.ObjectId, amount: string, allocations: { documentId: Types.ObjectId; amount: string }[], reference: string) {
    return s.payments.create(
      accountant,
      { entityId: ke._id, kind: 'RECEIPT', partyId, date: d(date), bankAccountId, amount: D(amount), reference, allocations: allocations.map((a) => ({ documentId: a.documentId, amount: D(a.amount) })) },
      { post: true },
    );
  }

  // ----- Sales --------------------------------------------------------------------------------
  const inv1 = await post({ ...base, kind: 'SALES_INVOICE', partyId: savanna._id, date: d('2026-07-08'), reference: 'PO-SV-2207', lines: [line('Wholesale stock – July order', 120, 9500, { taxCodeId: T('VAT16') })] });
  const inv2 = await post({ ...base, kind: 'SALES_INVOICE', partyId: savanna._id, date: d('2026-08-12'), reference: 'PO-SV-2291', lines: [line('Wholesale stock – August order', 80, 9500, { taxCodeId: T('VAT16') }), line('Delivery', 1, 12000, { accountId: A('4800'), taxCodeId: T('VAT16') })] });
  const inv3 = await post({ ...base, branchId: msa._id, kind: 'SALES_INVOICE', partyId: coast._id, date: d('2026-09-03'), lines: [line('Conference catering supplies', 1, 385000, { accountId: A('4200'), taxCodeId: T('VAT16') })] });
  const inv4 = await post({ ...base, branchId: msa._id, kind: 'SALES_INVOICE', partyId: coast._id, date: d('2026-09-24'), lines: [line('Housekeeping consumables', 40, 3250, { taxCodeId: T('VAT16'), discountPercent: D(5) })] });
  await post({ ...base, kind: 'SALES_INVOICE', partyId: savanna._id, date: d('2026-09-28'), reference: 'PO-SV-2350', priceIncludesTax: true, lines: [line('Wholesale stock – September order (VAT inclusive)', 60, 11020, { taxCodeId: T('VAT16') })] });
  const usdInv = await post({ ...base, branchId: msa._id, kind: 'SALES_INVOICE', partyId: atlas._id, date: d('2026-08-18'), lines: [line('Export consignment – tea and coffee', 1, 18500, { taxCodeId: T('ZERO') })] });
  await post({ ...base, branchId: msa._id, kind: 'SALES_INVOICE', partyId: atlas._id, date: d('2026-09-22'), lines: [line('Export consignment – macadamia', 1, 12400, { taxCodeId: T('ZERO') })] });

  await receipt(savanna._id, '2026-08-06', keBank._id, '1322400', [{ documentId: inv1._id, amount: '1322400' }], 'EFT SAVANNA JUL');
  await receipt(savanna._id, '2026-09-15', keBank._id, '500000', [{ documentId: inv2._id, amount: '500000' }], 'EFT SAVANNA PART');
  await receipt(coast._id, '2026-09-16', keBank._id, '446600', [{ documentId: inv3._id, amount: '446600' }], 'CHQ 004512');
  // The USD export invoice is settled in October at a different rate: realised FX is booked.
  await receipt(atlas._id, '2026-10-02', usdBank._id, '18500', [{ documentId: usdInv._id, amount: '18500' }], 'SWIFT ATL-8812');
  // A customer credit note for damaged goods, applied to the invoice it relates to.
  await post({ ...base, branchId: msa._id, kind: 'SALES_CREDIT', partyId: coast._id, date: d('2026-09-30'), appliesToId: inv4._id, lines: [line('Damaged cartons returned', 4, 3250, { taxCodeId: T('VAT16'), discountPercent: D(5) })] });

  // A draft and a submitted invoice for the approval queue
  const queued = await s.documents.create(accountant, { ...base, kind: 'SALES_INVOICE', partyId: coast._id, date: d('2026-10-02'), lines: [line('October linen supply', 1, 210000, { taxCodeId: T('VAT16') })] });
  await s.documents.submit(accountant, queued._id);
  await s.documents.create(accountant, { ...base, kind: 'SALES_INVOICE', partyId: lakeside._id, date: d('2026-10-03'), lines: [line('Trial order', 10, 9500, { taxCodeId: T('VAT16') })] });

  // ----- Procurement and payables ---------------------------------------------------------------
  const req = await s.procurement.createRequisition(accountant, {
    ...base,
    date: d('2026-08-20'),
    requiredBy: d('2026-09-10'),
    description: 'Office supplies and printer toner for head office',
    lines: [
      { description: 'Printer toner cartridges', accountId: A('6600'), quantity: D(12), estimatedUnitPrice: D(8500) },
      { description: 'A4 paper (boxes)', accountId: A('6600'), quantity: D(40), estimatedUnitPrice: D(2400) },
    ],
  });
  await s.procurement.requisitionAction(accountant, req._id, 'submit');
  await s.procurement.requisitionAction(approver, req._id, 'approve');
  const po = await s.procurement.createOrder(accountant, {
    ...base,
    supplierId: office._id,
    date: d('2026-08-25'),
    expectedDate: d('2026-09-05'),
    requisitionId: req._id,
    reference: 'QUOTE-OP-5531',
    lines: [
      { description: 'Printer toner cartridges', accountId: A('6600'), quantity: D(12), unitPrice: D(8200), taxCodeId: T('VAT16') },
      { description: 'A4 paper (boxes)', accountId: A('6600'), quantity: D(40), unitPrice: D(2350), taxCodeId: T('VAT16') },
    ],
  });
  await s.procurement.orderAction(accountant, po._id, 'submit');
  await s.procurement.orderAction(approver, po._id, 'approve');
  await s.procurement.receive(accountant, po._id, { date: d('2026-09-04'), reference: 'DN-77812', lines: [{ poLineNo: 1, quantity: D(12) }, { poLineNo: 2, quantity: D(30) }] });
  const draft = await s.procurement.billDraft(accountant, po._id);
  const officeBill = await post({
    ...base,
    kind: 'PURCHASE_BILL',
    partyId: office._id,
    date: d('2026-09-06'),
    supplierInvoiceNumber: 'OP-INV-10442',
    purchaseOrderId: po._id,
    lines: draft.lines.map((l) => ({ description: l.description, accountId: l.accountId, quantity: l.quantity, unitPrice: new Decimal(l.unitPrice.toString()), taxCodeId: l.taxCodeId, poLineNo: l.poLineNo })),
  });
  // A second order waiting for goods to arrive
  const po2 = await s.procurement.createOrder(accountant, {
    ...base,
    branchId: msa._id,
    supplierId: freight._id,
    date: d('2026-09-29'),
    expectedDate: d('2026-10-10'),
    lines: [{ description: 'Container haulage Mombasa–Nairobi', accountId: A('5100'), quantity: D(3), unitPrice: D(145000), taxCodeId: T('VAT16') }],
  });
  await s.procurement.orderAction(accountant, po2._id, 'submit');

  const legal = await post({ ...base, kind: 'PURCHASE_BILL', partyId: lawco._id, date: d('2026-08-31'), supplierInvoiceNumber: 'MP/2026/0831', lines: [line('Legal retainer – August', 1, 250000, { taxCodeId: T('VAT16') })] });
  const freightBill = await post({ ...base, branchId: msa._id, kind: 'PURCHASE_BILL', partyId: freight._id, date: d('2026-09-12'), supplierInvoiceNumber: 'SL-88213', lines: [line('Inbound freight – September', 1, 186000, { taxCodeId: T('VAT16') })] });
  const saas = await post({ ...base, kind: 'PURCHASE_BILL', partyId: cloud._id, date: d('2026-09-01'), supplierInvoiceNumber: 'CC-2026-09-4471', lines: [line('ERP and email licences – annual', 1, 4800)] });
  await post({ ...base, kind: 'PURCHASE_BILL', partyId: lawco._id, date: d('2026-09-30'), supplierInvoiceNumber: 'MP/2026/0930', lines: [line('Legal retainer – September', 1, 250000, { taxCodeId: T('VAT16') })] });

  // Supplier payments: one released with withholding tax, one USD payment, and a payment run awaiting approval.
  const pay = await s.payments.create(accountant, {
    entityId: ke._id,
    kind: 'PAYMENT',
    partyId: lawco._id,
    date: d('2026-09-18'),
    bankAccountId: keBank._id,
    amount: D('277500'),
    withholdingTaxCodeId: T('WHT5'),
    reference: 'RTGS 556120',
    allocations: [{ documentId: legal._id, amount: D('290000') }],
  });
  await s.payments.submit(accountant, pay!._id);
  await s.payments.approve(approver, pay!._id);
  const usdPay = await s.payments.create(accountant, { entityId: ke._id, kind: 'PAYMENT', partyId: cloud._id, date: d('2026-09-20'), bankAccountId: usdBank._id, amount: D('4800'), reference: 'SWIFT CC-4471', allocations: [{ documentId: saas._id, amount: D('4800') }] });
  await s.payments.submit(accountant, usdPay!._id);
  await s.payments.approve(approver, usdPay!._id);
  await s.payments.createRun(accountant, {
    entityId: ke._id,
    bankAccountId: keBank._id,
    date: d('2026-10-03'),
    submit: true,
    items: [
      { documentId: officeBill._id, amount: new Decimal(officeBill.amountDue.toString()) },
      { documentId: freightBill._id, amount: new Decimal(freightBill.amountDue.toString()) },
    ],
  });

  // ----- Banking ------------------------------------------------------------------------------
  await s.banking.transfer(accountant, { entityId: ke._id, fromBankAccountId: usdBank._id, toBankAccountId: keBank._id, date: d('2026-09-25'), amount: D('10000'), toAmount: D('1291500'), reference: 'FX-CONV-0925' });
  await s.banking.importStatement(accountant, keBank._id, {
    name: 'Equity Bank September 2026',
    closingBalance: null,
    lines: [
      { date: d('2026-09-15'), description: 'EFT SAVANNA RETAILERS', reference: 'EFT SAVANNA PART', amount: D('500000') },
      { date: d('2026-09-17'), description: 'CHQ DEP 004512 COASTAL HOTELS', reference: 'CHQ 004512', amount: D('446600') },
      { date: d('2026-09-19'), description: 'RTGS MWANGI & PARTNERS', reference: 'RTGS 556120', amount: D('-277500') },
      { date: d('2026-09-25'), description: 'FX CONVERSION USD 10,000', reference: 'FX-CONV-0925', amount: D('1291500') },
      { date: d('2026-09-30'), description: 'MONTHLY LEDGER FEE', amount: D('-1150') },
      { date: d('2026-09-30'), description: 'SMS ALERT CHARGES', amount: D('-230') },
    ],
  });
  await s.banking.autoMatch(approver, keBank._id);

}

