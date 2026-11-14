/**
 * Demo data for Phase 5: approval rules with multi-step requests in progress, a delegation, a service
 * account, a partly owned subsidiary (non-controlling interest), two exceptions for the analytics to
 * find, and a loaded reporting warehouse.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Decimal } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  ug: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  msa: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const D = (v: string | number) => new Decimal(v);

export async function seedPlatform(c: Context) {
  const { s, organisationId, ke, ug, hq, msa, accountant, approver, director } = c;
  const { db } = s;
  const acc = new Map((await db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const A = (code: string) => acc.get(code)!;
  const roles = new Map((await db.roles.find({ organisationId }).lean()).map((r) => [r.name, r._id]));
  const manager = (await db.users.findOne({ organisationId, email: 'manager.msa@farajasoft.demo' }).lean())!;

  // Notifications raised while generating the earlier history count as seen.
  await db.notifications.updateMany({ organisationId }, { readAt: new Date() });

  // ----- Approval rules --------------------------------------------------------------------------
  await s.workflow.createRule(director, {
    name: 'Large journals: review and director sign-off',
    documentType: 'JOURNAL',
    priority: 10,
    entityId: null,
    branchIds: [],
    minAmount: D(1_000_000),
    maxAmount: null,
    steps: [
      { name: 'Finance review', approverType: 'ROLE', roleId: roles.get('Finance Reviewer'), requiredApprovals: 1 },
      { name: 'Director sign-off', approverType: 'USER', userId: director.id, requiredApprovals: 1 },
    ],
    slaHours: 48,
    escalateToUserId: director.id,
    escalateToRoleId: null,
    isActive: true,
  });
  await s.workflow.createRule(director, {
    name: 'Supplier payments over KES 2m need two approvers',
    documentType: 'SUPPLIER_PAYMENT',
    priority: 10,
    entityId: ke._id,
    branchIds: [],
    minAmount: D(2_000_000),
    maxAmount: null,
    steps: [{ name: 'Dual approval', approverType: 'PERMISSION', requiredApprovals: 2 }],
    slaHours: 24,
    escalateToUserId: null,
    escalateToRoleId: roles.get('Finance Director') ?? null,
    isActive: true,
  });
  await s.workflow.createRule(director, {
    name: 'Mombasa purchase orders: branch manager first',
    documentType: 'PURCHASE_ORDER',
    priority: 20,
    entityId: ke._id,
    branchIds: [msa._id],
    minAmount: null,
    maxAmount: null,
    steps: [
      { name: 'Branch manager', approverType: 'USER', userId: manager._id, requiredApprovals: 1 },
      { name: 'Finance', approverType: 'ROLE', roleId: roles.get('Finance Reviewer'), requiredApprovals: 1 },
    ],
    slaHours: 72,
    escalateToUserId: null,
    escalateToRoleId: null,
    isActive: true,
  });

  // A large journal halfway through its approval: reviewed, waiting for the director.
  const line = (code: string, side: 'debit' | 'credit', amount: string) => ({ accountId: A(code), currency: 'KES', [side]: D(amount) });
  const big = await s.journals.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    journalDate: d('2026-10-01'),
    description: 'Annual insurance premium – group policy',
    reference: 'INS-2027',
    lines: [line('1250', 'debit', '1850000'), line('1120', 'credit', '1850000')],
  });
  await s.journals.submit(accountant, big._id);
  await s.journals.approve(approver, big._id, { comment: 'Agreed to the broker schedule' });

  // The approver is away next week and hands approvals to the director.
  await s.workflow.createDelegation(approver, { toUserId: director.id, startDate: d('2026-10-05'), endDate: d('2026-10-16'), documentTypes: [], reason: 'Annual leave' }, false);

  // ----- Integrations ----------------------------------------------------------------------------
  await s.apiKeys.createAccount(director, { name: 'E-commerce connector', roleIds: [roles.get('Accountant')!], allBranches: false, branchIds: [hq._id] });

  // ----- Group structure: Uganda is 75% owned ----------------------------------------------------
  // Kenya bought 75% of Uganda when it was capitalised: the cost sits in Investments in Subsidiaries and
  // consolidation eliminates it against Uganda's equity, recognising goodwill and non-controlling interest.
  const accountId = async (code: string) => (await db.accounts.findOne({ organisationId, code }).lean())!._id;
  const acquisition = await s.journals.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    journalDate: new Date('2026-03-01T00:00:00Z'),
    description: 'Acquisition of 75% of Faraja Uganda Ltd',
    reference: 'SPA-2026-01',
    lines: [
      { accountId: await accountId('1640'), debit: new Decimal(21000000) },
      { accountId: await accountId('1120'), credit: new Decimal(21000000) },
    ],
  });
  await s.journals.submit(accountant, acquisition._id);
  // Large journals need a second approval under the rules set up above.
  const first = (await s.journals.approve(approver, acquisition._id, { post: true })) as { status?: string } | null;
  if (first?.status !== 'POSTED') await s.journals.approve(director, acquisition._id, { post: true });
  await s.consolidation.createInvestment(director, {
    parentEntityId: ke._id,
    subsidiaryEntityId: ug._id,
    acquisitionDate: new Date('2026-03-01T00:00:00Z'),
    investmentAccountId: await accountId('1640'),
    cost: new Decimal(21000000),
    ownershipPercent: new Decimal(75),
    goodwillAccountId: await accountId('1630'),
    notes: 'Share purchase agreement SPA-2026-01',
  });

  // ----- Exceptions for the analytics to surface -------------------------------------------------
  const office = (await db.suppliers.findOne({ organisationId, code: 'OFFICEPRO' }).lean())!;
  const bank = (await db.bankAccounts.findOne({ organisationId, entityId: ke._id, currency: 'KES', type: { $ne: 'PETTY_CASH' } }).lean())!;
  // The same bill entered twice with different references.
  for (const ref of ['OP-10455', 'OP-10455A']) {
    const bill = await s.documents.create(accountant, {
      entityId: ke._id,
      branchId: hq._id,
      kind: 'PURCHASE_BILL',
      partyId: office._id,
      date: d(ref.endsWith('A') ? '2026-09-23' : '2026-09-16'),
      supplierInvoiceNumber: ref,
      lines: [{ description: 'Printer toner and paper – September', accountId: A('6600'), quantity: D(1), unitPrice: D(68500), taxCodeId: (await db.taxCodes.findOne({ organisationId, code: 'VAT16' }).lean())!._id }],
    });
    await s.documents.submit(accountant, bill._id);
    await s.documents.approve(approver, bill._id);
  }
  // Bank details changed shortly before a payment (the change is recorded the way the API records it).
  const before = { bankName: office.bankName, bankAccountNumber: office.bankAccountNumber };
  await db.suppliers.updateOne({ _id: office._id }, { bankName: 'Gulf African Bank', bankAccountNumber: '0800455521' });
  await s.audit.log(accountant, { action: 'supplier.update', recordType: 'Supplier', recordId: office._id, summary: `Updated supplier ${office.code}`, before, after: { bankName: 'Gulf African Bank', bankAccountNumber: '0800455521' } });
  const payment = (await s.payments.create(accountant, { entityId: ke._id, kind: 'PAYMENT', partyId: office._id, date: d('2026-09-29'), bankAccountId: bank._id, amount: D(79460), reference: 'EFT-OP-0929', allocations: [] }))!;
  await s.payments.submit(accountant, payment._id);
  await s.payments.approve(approver, payment._id);

  // ----- History ---------------------------------------------------------------------------------
  // The demo is generated in one go; record each historic journal as posted the day after its date,
  // as it would have been in day-to-day use, so back-dating analytics see a realistic history.
  const cutoff = d('2026-10-01');
  const posted = { $add: ['$journalDate', 33 * 3_600_000] };
  await db.journals.updateMany({ organisationId, postedAt: { $ne: null }, journalDate: { $lt: cutoff } }, [{ $set: { postedAt: posted } }]);
  await db.ledger.updateMany({ organisationId, date: { $lt: cutoff } }, [{ $set: { postedAt: { $add: ['$date', 33 * 3_600_000] } } }]);

  // ----- Reporting warehouse ---------------------------------------------------------------------
  await s.warehouse.refresh(organisationId, { full: true });
}
