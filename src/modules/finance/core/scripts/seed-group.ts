/**
 * Demo data for Phase 3: monthly AVERAGE and CLOSING rates, intercompany trade between the Kenyan
 * and Ugandan entities, a September FX revaluation, and group consolidation adjustments.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Decimal, toD128 } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  ug: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  kla: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

export async function seedGroup(c: Context) {
  const { s, organisationId, ke, ug, hq, kla, accountant, approver, director } = c;
  const { db } = s;

  // ----- Monthly AVERAGE and CLOSING rates derived from the spot series ------------------------
  const spots = await db.exchangeRates.find({ organisationId, rateType: 'SPOT', status: 'APPROVED' }).sort({ effectiveDate: 1 }).lean();
  const pairs = [...new Set(spots.map((r) => `${r.fromCurrency}/${r.toCurrency}`))];
  const derived = [];
  for (const pair of pairs) {
    const series = spots.filter((r) => `${r.fromCurrency}/${r.toCurrency}` === pair);
    for (let i = 0; i < series.length - 1; i++) {
      const open = new Decimal(series[i].rate.toString());
      const close = new Decimal(series[i + 1].rate.toString());
      const start = series[i].effectiveDate;
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const base = { organisationId, fromCurrency: series[i].fromCurrency, toCurrency: series[i].toCurrency, status: 'APPROVED', createdBy: accountant.id, approvedBy: director.id, approvedAt: end };
      derived.push(
        { ...base, rateType: 'AVERAGE', rate: toD128(open.plus(close).div(2).toDecimalPlaces(6)), effectiveDate: start, source: 'Derived monthly average (demo)' },
        { ...base, rateType: 'CLOSING', rate: toD128(close), effectiveDate: end, source: 'Month-end closing (demo)' },
      );
    }
  }
  await db.exchangeRates.insertMany(derived);

  // ----- Intercompany: Kenya charges Uganda a management fee each quarter-end -------------------
  const acc = new Map((await db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const [icCustomer] = await db.customers.create([
    { organisationId, code: 'IC-UG01', name: 'Faraja Uganda Ltd (intercompany)', currency: 'KES', paymentTermsDays: 60, defaultAccountId: acc.get('4200'), intercompanyEntityId: ug._id },
  ]);
  const [icSupplier] = await db.suppliers.create([
    { organisationId, code: 'IC-KE01', name: 'Faraja Kenya Ltd (intercompany)', currency: 'KES', paymentTermsDays: 60, defaultAccountId: acc.get('6700'), intercompanyEntityId: ke._id },
  ]);
  for (const [date, amount] of [
    ['2026-06-30', 450000],
    ['2026-09-30', 480000],
  ] as const) {
    const inv = await s.documents.create(accountant, {
      entityId: ke._id,
      branchId: hq._id,
      kind: 'SALES_INVOICE',
      partyId: icCustomer._id,
      date: d(date),
      reference: `MGMT-${date.slice(0, 7)}`,
      lines: [{ description: `Group management fee – quarter to ${date}`, quantity: new Decimal(1), unitPrice: new Decimal(amount) }],
    });
    await s.documents.submit(accountant, inv._id);
    await s.documents.approve(approver, inv._id);
    const bill = await s.documents.create(accountant, {
      entityId: ug._id,
      branchId: kla._id,
      kind: 'PURCHASE_BILL',
      partyId: icSupplier._id,
      date: d(date),
      supplierInvoiceNumber: inv.number,
      lines: [{ description: `Group management fee – quarter to ${date}`, quantity: new Decimal(1), unitPrice: new Decimal(amount) }],
    });
    await s.documents.submit(accountant, bill._id);
    await s.documents.approve(approver, bill._id);
  }

  // ----- September FX revaluation (reverses on 1 October) --------------------------------------
  await s.revaluation.post(director, ke._id, d('2026-09-30'), 'CLOSING');
  // Uganda owes Kenya in KES: revaluing it keeps the intercompany balances aligned for consolidation.
  await s.revaluation.post(director, ug._id, d('2026-09-30'), 'CLOSING');

  // ----- Group adjustments: one approved, one waiting for approval --------------------------------
  const approved = await s.consolidation.create(accountant, {
    date: d('2026-09-30'),
    description: 'Group audit fee accrual (not recorded in entity books)',
    lines: [
      { accountId: acc.get('6700')!, debit: new Decimal(600000) },
      { accountId: acc.get('2120')!, credit: new Decimal(600000) },
    ],
  });
  await s.consolidation.act(accountant, approved._id, 'submit');
  await s.consolidation.act(approver, approved._id, 'approve');
  const pending = await s.consolidation.create(accountant, {
    date: d('2026-09-30'),
    entityId: ug._id,
    description: 'Reclassify Uganda deposits to current liabilities',
    lines: [
      { accountId: acc.get('2160')!, debit: new Decimal(150000) },
      { accountId: acc.get('2120')!, credit: new Decimal(150000) },
    ],
  });
  await s.consolidation.act(accountant, pending._id, 'submit');
}
