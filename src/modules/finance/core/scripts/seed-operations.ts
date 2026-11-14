/**
 * Demo data for Phase 4: stock items bought on bills and sold on invoices (weighted average cost),
 * a transfer and a write-off, fixed assets with monthly depreciation, expense claims through
 * approval and reimbursement, project details, and an approved budget with spending control.
 * Sourcing: requests for quotes, stock received on a goods received note, and a landed cost.
 * Batch (with expiry) and serial-number tracked items, and prices in other currencies.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Decimal, toD128 } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';
import { DocumentInput } from '../modules/documents/documents.service';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  msa: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const D = (v: string | number) => new Decimal(v);
const monthEnd = (year: number, month: number) => new Date(Date.UTC(year, month, 0));

export async function seedOperations(c: Context) {
  const { s, organisationId, ke, hq, msa, accountant, approver, director } = c;
  const { db } = s;
  const acc = new Map((await db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const A = (code: string) => acc.get(code)!;
  const tax = new Map((await db.taxCodes.find({ organisationId }).lean()).map((t) => [t.code, t._id]));
  const T = (code: string) => tax.get(code)!;
  const expansion = (await db.dimensions.findOne({ organisationId, type: 'PROJECT', code: 'EXPANSION' }).lean())!;

  async function post(input: DocumentInput) {
    const doc = await s.documents.create(accountant, input);
    await s.documents.submit(accountant, doc._id);
    return (await s.documents.approve(approver, doc._id))!;
  }

  // ----- Items and warehouses ------------------------------------------------------------------
  const stock = { type: 'STOCK', unit: 'each', inventoryAccountId: A('1300'), cogsAccountId: A('5100'), salesAccountId: A('4100'), salesTaxCodeId: T('VAT16'), purchaseTaxCodeId: T('VAT16') };
  const [lantern, filter, merch, install] = await db.items.create([
    { organisationId, code: 'SOL-LNT', name: 'Solar lantern', category: 'Solar', ...stock, salesPrice: toD128('4500'), reorderLevel: toD128('40') },
    { organisationId, code: 'WTR-F20', name: 'Water filter 20L', category: 'Water', ...stock, salesPrice: toD128('6800'), reorderLevel: toD128('20') },
    { organisationId, code: 'GEN-MERCH', name: 'General merchandise', category: 'General', ...stock, unit: 'lot' },
    { organisationId, code: 'SVC-INST', name: 'Installation service', category: 'Services', type: 'SERVICE', unit: 'job', salesAccountId: A('4200'), salesTaxCodeId: T('VAT16'), salesPrice: toD128('15000') },
  ]);
  const main = (await db.warehouses.findOne({ organisationId, entityId: ke._id }).lean())!;
  const [coastStore] = await db.warehouses.create([{ organisationId, entityId: ke._id, branchId: msa._id, code: 'MSA-STORE', name: 'Mombasa store' }]);

  const [sunpower] = await db.suppliers.create([
    { organisationId, code: 'SUNPOWER', name: 'SunPower Distributors Ltd', email: 'orders@sunpower.example', taxId: 'P051777888F', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('5100'), defaultTaxCodeId: T('VAT16') },
  ]);
  const coastal = (await db.customers.findOne({ organisationId, code: 'COASTAL' }).lean())!;
  const savanna = (await db.customers.findOne({ organisationId, code: 'SAVANNA' }).lean())!;

  // Two receipts at different prices, so the average cost moves.
  const base = { entityId: ke._id, branchId: hq._id };
  const stockLine = (itemId: Types.ObjectId, description: string, quantity: number, unitPrice: number, warehouseId = main._id) => ({
    description,
    itemId,
    warehouseId,
    quantity: D(quantity),
    unitPrice: D(unitPrice),
    taxCodeId: T('VAT16'),
  });
  await post({ ...base, kind: 'PURCHASE_BILL', partyId: sunpower._id, date: d('2026-09-04'), supplierInvoiceNumber: 'SP-40211', lines: [stockLine(lantern._id, 'Solar lanterns', 120, 2400), stockLine(filter._id, 'Water filters 20L', 60, 3800)] });
  await post({ ...base, kind: 'PURCHASE_BILL', partyId: sunpower._id, date: d('2026-09-19'), supplierInvoiceNumber: 'SP-40388', lines: [stockLine(lantern._id, 'Solar lanterns', 80, 2650)] });

  // Sales issue stock at average cost and post cost of sales in the same journal.
  await post({
    ...base,
    kind: 'SALES_INVOICE',
    partyId: coastal._id,
    date: d('2026-09-24'),
    reference: 'CH-LPO-118',
    lines: [stockLine(lantern._id, 'Solar lanterns', 45, 4500), stockLine(filter._id, 'Water filters 20L', 18, 6800)],
  });
  await post({
    ...base,
    kind: 'SALES_INVOICE',
    partyId: savanna._id,
    date: d('2026-09-29'),
    reference: 'PO-SV-2340',
    lines: [
      stockLine(lantern._id, 'Solar lanterns for regional outlets', 60, 4400),
      { description: 'Installation at new outlets', itemId: install._id, quantity: D(4), unitPrice: D(15000), taxCodeId: T('VAT16'), projectId: expansion._id },
    ],
  });

  // A transfer to Mombasa and a write-off of damaged stock, each approved by a second person.
  const transfer = await s.inventory.createDocument(accountant, {
    entityId: ke._id,
    kind: 'TRANSFER',
    date: d('2026-09-26'),
    reason: 'Stock for the coastal region',
    warehouseId: main._id,
    toWarehouseId: coastStore._id,
    lines: [
      { itemId: lantern._id, quantity: D(30) },
      { itemId: filter._id, quantity: D(12) },
    ],
  });
  await s.inventory.actDocument(accountant, transfer._id, 'submit');
  await s.inventory.actDocument(approver, transfer._id, 'approve');
  const writeOff = await s.inventory.createDocument(accountant, {
    entityId: ke._id,
    kind: 'ADJUSTMENT',
    date: d('2026-09-30'),
    reason: 'Stock count: damaged filters',
    warehouseId: main._id,
    adjustmentAccountId: A('5100'),
    lines: [{ itemId: filter._id, quantity: D(-2) }],
  });
  await s.inventory.actDocument(accountant, writeOff._id, 'submit');
  await s.inventory.actDocument(approver, writeOff._id, 'approve');
  // A count correction awaiting approval.
  const pendingCount = await s.inventory.createDocument(accountant, {
    entityId: ke._id,
    kind: 'ADJUSTMENT',
    date: d('2026-10-02'),
    reason: 'Mombasa count: lanterns found',
    warehouseId: coastStore._id,
    adjustmentAccountId: A('5100'),
    lines: [{ itemId: lantern._id, quantity: D(3) }],
  });
  await s.inventory.actDocument(accountant, pendingCount._id, 'submit');

  // Stock bought before the stock ledger existed was journalled straight to 1300. Take it on at the
  // value already in the ledger: the adjustment account is the inventory account itself, so the
  // journal nets to nothing and the stock ledger now agrees with the general ledger.
  const takeOnValue = new Decimal((await s.inventory.onHand(director, ke._id)).difference);
  if (takeOnValue.gt(0)) {
    const takeOn = await s.inventory.createDocument(accountant, {
      entityId: ke._id,
      kind: 'ADJUSTMENT',
      date: d('2026-09-30'),
      reason: 'Stock take-on: general merchandise already in the ledger',
      warehouseId: main._id,
      adjustmentAccountId: A('1300'),
      lines: [{ itemId: merch._id, quantity: D(1000), unitCost: takeOnValue.div(1000) }],
    });
    await s.inventory.actDocument(accountant, takeOn._id, 'submit');
    await s.inventory.actDocument(approver, takeOn._id, 'approve');
  }

  // ----- Sourcing: a request for quotes, stock received on the goods received note, landed costs --
  const [aquapure, bahari] = await db.suppliers.create([
    { organisationId, code: 'AQUAPURE', name: 'AquaPure East Africa', email: 'quotes@aquapure.example', currency: 'KES', paymentTermsDays: 30, defaultAccountId: A('5100'), defaultTaxCodeId: T('VAT16') },
    { organisationId, code: 'BAHARI', name: 'Bahari Clearing & Forwarding', email: 'accounts@bahari.example', currency: 'KES', paymentTermsDays: 14, defaultAccountId: A('1320'), defaultTaxCodeId: T('VAT16') },
  ]);
  const rfq = await s.rfqs.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    title: 'Water filters for Q4',
    date: d('2026-09-20'),
    dueDate: d('2026-09-23'),
    deliveryAddress: 'Main warehouse, Industrial Area',
    supplierIds: [sunpower._id, aquapure._id],
    lines: [{ description: 'Water filters 20L', quantity: D(40), itemId: filter._id, warehouseId: main._id, taxCodeId: T('VAT16') }],
  });
  await s.rfqs.send(accountant, rfq._id);
  await s.rfqs.recordQuote(accountant, rfq._id, { supplierId: sunpower._id, reference: 'SPQ-118', lines: [{ lineNo: 1, unitPrice: D(3700), leadTimeDays: 5 }] });
  await s.rfqs.recordQuote(accountant, rfq._id, { supplierId: aquapure._id, reference: 'AQ-2209', lines: [{ lineNo: 1, unitPrice: D(3900), leadTimeDays: 2 }] });
  const awarded = (await s.rfqs.award(approver, rfq._id, { date: d('2026-09-23'), lines: [{ lineNo: 1, supplierId: sunpower._id }] }))!;
  const filterOrder = awarded.awards[0].purchaseOrderId!;
  // The approver who awarded raised the order, so another person approves it.
  await s.procurement.orderAction(approver, filterOrder, 'submit');
  await s.procurement.orderAction(director, filterOrder, 'approve');
  // Received and not yet billed: the stock is in, owed to SunPower through goods received not invoiced.
  const grn = await s.procurement.receive(accountant, filterOrder, { date: d('2026-09-27'), reference: 'DN-78110', lines: [{ poLineNo: 1, quantity: D(40) }] });
  // The forwarder's freight is billed to Landed Costs Clearing, then spread over the filters received.
  await post({ ...base, kind: 'PURCHASE_BILL', partyId: bahari._id, date: d('2026-09-28'), supplierInvoiceNumber: 'BCF-5521', lines: [{ description: 'Transport and handling, DN-78110', accountId: A('1320'), quantity: D(1), unitPrice: D(6000), taxCodeId: T('VAT16') }] });
  const landed = await s.landedCosts.create(accountant, { entityId: ke._id, branchId: hq._id, date: d('2026-09-28'), description: 'Transport and handling on DN-78110', amount: D(6000), method: 'VALUE', receipts: [{ type: 'GoodsReceipt', id: grn._id }] });
  await s.landedCosts.post(approver, landed._id);
  // A second request still out for quotes.
  const open = await s.rfqs.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    title: 'Solar lanterns restock',
    date: d('2026-09-29'),
    dueDate: d('2026-10-06'),
    supplierIds: [sunpower._id, aquapure._id],
    lines: [{ description: 'Solar lanterns', quantity: D(150), itemId: lantern._id, warehouseId: main._id, taxCodeId: T('VAT16') }],
  });
  await s.rfqs.send(accountant, open._id);
  await s.rfqs.recordQuote(accountant, open._id, { supplierId: sunpower._id, reference: 'SPQ-131', lines: [{ lineNo: 1, unitPrice: D(2600), leadTimeDays: 7 }] });

  // ----- Batches, serial numbers and prices in other currencies ---------------------------------
  const [ors, handset] = await db.items.create([
    { organisationId, code: 'ORS-SACH', name: 'Oral rehydration salts (box of 50)', category: 'Health', ...stock, unit: 'box', salesPrice: toD128('1200'), tracking: 'BATCH', trackExpiry: true },
    { organisationId, code: 'PHN-A15', name: 'Smartphone A15', category: 'Electronics', ...stock, salesPrice: toD128('18500'), tracking: 'SERIAL', prices: [{ currency: 'UGX', price: toD128('520000') }] },
  ]);
  await db.items.updateOne({ _id: lantern._id }, { prices: [{ currency: 'USD', price: toD128('35') }, { currency: 'UGX', price: toD128('125000') }] });
  await post({
    ...base,
    kind: 'PURCHASE_BILL',
    partyId: sunpower._id,
    date: d('2026-09-10'),
    supplierInvoiceNumber: 'SP-40290',
    lines: [
      { ...stockLine(ors._id, 'ORS sachets', 60, 650), lots: [{ number: 'ORS-2611A', expiryDate: d('2026-11-30'), quantity: D(20) }, { number: 'ORS-2705B', expiryDate: d('2027-05-31'), quantity: D(40) }] },
      { ...stockLine(handset._id, 'Smartphones A15', 4, 14200), lots: ['356938035643809', '356938035643810', '356938035643811', '356938035643812'].map((number) => ({ number, quantity: D(1) })) },
    ],
  });
  // The sale takes the batch that expires first; the phone is sold by serial number.
  await post({
    ...base,
    kind: 'SALES_INVOICE',
    partyId: coastal._id,
    date: d('2026-09-25'),
    reference: 'CH-LPO-121',
    lines: [stockLine(ors._id, 'ORS sachets', 15, 1200), { ...stockLine(handset._id, 'Smartphone A15', 1, 18500), lots: [{ number: '356938035643810', quantity: D(1) }] }],
  });

  // ----- Fixed assets ----------------------------------------------------------------------------
  const categories = new Map((await db.assetCategories.find({ organisationId }).lean()).map((x) => [x.code, x._id]));
  for (const a of [
    { name: 'Delivery van – Toyota Probox', category: 'VEHICLES', branchId: hq._id, date: '2026-01-15', cost: 3200000, serialNumber: 'KDA 214X', location: 'Nairobi yard' },
    { name: 'Office furniture – head office', category: 'FURNITURE', branchId: hq._id, date: '2026-02-03', cost: 650000, location: 'Nairobi, 4th floor' },
    { name: 'Laptops (6)', category: 'EQUIPMENT', branchId: msa._id, date: '2026-03-10', cost: 540000, location: 'Mombasa office' },
    { name: 'Point-of-sale terminals', category: 'EQUIPMENT', branchId: hq._id, date: '2026-05-20', cost: 280000, serialNumber: 'POS-2026-01..04' },
  ]) {
    await s.assets.create(director, {
      entityId: ke._id,
      branchId: a.branchId,
      categoryId: categories.get(a.category)!,
      name: a.name,
      serialNumber: a.serialNumber,
      location: a.location,
      acquisitionDate: d(a.date),
      cost: D(a.cost),
      capitalisation: { mode: 'POST', contraAccountId: A('1120') },
    });
  }
  // Assets in the opening balances were depreciated by manual journal until September; they join
  // the register with that depreciation and are depreciated by the runs from October.
  for (const a of [
    { name: 'Warehouse building – Industrial Area', category: 'BUILDINGS', date: '2021-07-01', cost: 12000000, accumulated: 2250000 },
    { name: 'Delivery trucks (2)', category: 'VEHICLES', date: '2023-03-01', cost: 4500000, accumulated: 2000000 },
    { name: 'Shop fittings – branches', category: 'FURNITURE', date: '2022-01-01', cost: 1500000, accumulated: 700000 },
  ]) {
    await s.assets.create(director, {
      entityId: ke._id,
      branchId: hq._id,
      categoryId: categories.get(a.category)!,
      name: a.name,
      acquisitionDate: d(a.date),
      depreciationStart: d('2026-10-01'),
      cost: D(a.cost),
      openingAccumulated: D(a.accumulated),
      capitalisation: { mode: 'EXISTING' },
    });
  }
  for (let month = 1; month <= 9; month++) {
    const periodEnd = monthEnd(2026, month);
    const preview = await s.assets.preview(director, ke._id, periodEnd);
    if (preview.lines.length) await s.assets.run(director, ke._id, periodEnd);
  }

  // ----- Expense claims --------------------------------------------------------------------------
  const expenseCats = new Map((await db.expenseCategories.find({ organisationId }).lean()).map((x) => [x.code, x._id]));
  const E = (code: string) => expenseCats.get(code)!;
  const keBank = (await db.bankAccounts.findOne({ organisationId, entityId: ke._id, currency: 'KES', type: { $ne: 'PETTY_CASH' } }).lean())!;
  const trip = await s.expenses.create(accountant, {
    entityId: ke._id,
    branchId: msa._id,
    title: 'Mombasa store set-up visit',
    lines: [
      { date: d('2026-09-14'), categoryId: E('TRAVEL'), description: 'SGR Nairobi–Mombasa return', merchant: 'Kenya Railways', receiptReference: 'SGR-88412', amount: D(6000), projectId: expansion._id },
      { date: d('2026-09-14'), categoryId: E('ACCOM'), description: 'Hotel, 2 nights', merchant: 'Bahari Beach Hotel', receiptReference: 'BBH-2231', amount: D(31000), projectId: expansion._id },
      { date: d('2026-09-15'), categoryId: E('MEALS'), description: 'Dinner with landlord', merchant: 'Tamarind', receiptReference: 'TM-5520', amount: D(4600), projectId: expansion._id },
    ],
  });
  await s.expenses.submit(accountant, trip._id);
  await s.expenses.approve(approver, trip._id, 'Hotel rate agreed in advance for the store opening');
  await s.expenses.pay(director, trip._id, { date: d('2026-09-22'), bankAccountId: keBank._id, reference: 'EFT-EXP-0922' });

  const supplies = await s.expenses.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    title: 'Stationery for the month-end close',
    lines: [{ date: d('2026-09-28'), categoryId: E('OFFICE'), description: 'Files, toner and paper', merchant: 'Text Book Centre', receiptReference: 'TBC-77120', amount: D(8400) }],
  });
  await s.expenses.submit(accountant, supplies._id);
  await s.expenses.approve(approver, supplies._id);

  const pendingClaim = await s.expenses.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    title: 'Client lunch – Savanna Retailers',
    lines: [{ date: d('2026-10-01'), categoryId: E('MEALS'), description: 'Lunch with the Savanna buying team', merchant: 'Talisman', amount: D(7200) }],
  });
  await s.expenses.submit(accountant, pendingClaim._id);

  // ----- Projects --------------------------------------------------------------------------------
  const officePro = (await db.suppliers.findOne({ organisationId, code: 'OFFICEPRO' }).lean())!;
  await post({
    ...base,
    branchId: msa._id,
    kind: 'PURCHASE_BILL',
    partyId: officePro._id,
    date: d('2026-09-10'),
    supplierInvoiceNumber: 'OP-99812',
    lines: [{ description: 'Shop fit-out materials – new outlets', accountId: A('6600'), quantity: D(1), unitPrice: D(385000), taxCodeId: T('VAT16'), projectId: expansion._id }],
  });
  await db.dimensions.updateOne(
    { _id: expansion._id },
    { project: { customerId: savanna._id, managerUserId: director.id, contractValue: toD128('12000000'), budgetCost: toD128('1500000'), startDate: d('2026-07-01'), endDate: d('2027-03-31'), status: 'ACTIVE' } },
  );

  // ----- Budget: this year's monthly run rate with a stretch on revenue -------------------------
  const fy = (await db.fiscalYears.findOne({ organisationId, entityId: ke._id }).sort({ startDate: 1 }).lean())!;
  const periodCount = await db.periods.countDocuments({ organisationId, fiscalYearId: fy._id });
  const codes = ['4100', '4200', '5100', '6100', '6200', '6300', '6400', '6500', '6600', '6700', '6850'];
  const actuals = await db.ledger.aggregate<{ _id: Types.ObjectId; debit: Types.Decimal128; credit: Types.Decimal128 }>([
    { $match: { organisationId, entityId: ke._id, accountId: { $in: codes.map(A) }, date: { $gte: d('2026-01-01'), $lte: d('2026-09-30') } } },
    { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  const lines = codes
    .map((code, i) => {
      const row = actuals.find((r) => r._id.equals(A(code)));
      if (!row) return null;
      const revenue = code.startsWith('4');
      const net = revenue ? D(row.credit.toString()).minus(row.debit.toString()) : D(row.debit.toString()).minus(row.credit.toString());
      if (net.lte(0)) return null;
      // Revenue targets 10% above the run rate; costs vary between 92% and 104% so some lines overspend.
      const factor = revenue ? D('1.10') : D('0.92').plus(D(i % 4).times('0.04'));
      const monthly = net.div(9).times(factor).div(1000).toDecimalPlaces(0).times(1000);
      return { accountId: A(code), amounts: Array.from({ length: periodCount }, () => monthly) };
    })
    .filter((l) => l !== null);
  const budget = await s.budgets.create(accountant, { entityId: ke._id, fiscalYearId: fy._id, name: 'FY2026 operating budget', kind: 'BUDGET', notes: 'Approved by the board in January', lines });
  await s.budgets.act(accountant, budget._id, 'submit');
  await s.budgets.act(director, budget._id, 'approve');

  // Warn (and audit) when purchases would take an account over budget.
  await db.organisations.updateOne({ _id: organisationId }, { 'settings.budgetControl': 'WARN' });
}
