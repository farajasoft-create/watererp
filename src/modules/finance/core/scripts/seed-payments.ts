/**
 * Demo data for Phase 9: invoice letterhead details, an M-Pesa paybill (sandbox, placeholder keys) with
 * a few paybill payments already received — two matched to invoices, one on account, one waiting to be
 * assigned — and a customer portal link. Phase 18: M-Pesa charge bands on payouts, a customer refund paid
 * from the bank, salaries for September paid by bank and October's run waiting for approval.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { dec, Decimal, toD128 } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

export async function seedPayments(c: Context): Promise<{ portalUrl: string | null }> {
  const { s, organisationId, ke, hq, accountant, approver, director } = c;
  await s.db.entities.updateOne(
    { _id: ke._id },
    {
      address: 'Riverside Square, 4th Floor\nRiverside Drive, Nairobi',
      phone: '+254 709 000 100',
      email: 'accounts@farajasoft.demo',
      website: 'farajasoft.demo',
      paymentInstructions: 'Bank transfer: Equity Bank, Upper Hill branch, account 0240 2938 4471 (KES)\nSWIFT: EQBLKENA',
    },
  );

  const parent = await s.db.accounts.findOne({ organisationId, code: '1100' }).lean();
  const [gl] = await s.db.accounts.create([
    { organisationId, code: '1140', name: 'M-Pesa Paybill', accountClass: 'ASSET', accountType: 'BANK', parentId: parent?._id ?? null, isPostable: true, entityIds: [ke._id] },
  ]);
  const bank = await s.banking.create(director, { entityId: ke._id, branchId: hq._id, name: 'M-Pesa Paybill 600999', type: 'MOBILE_MONEY', glAccountId: gl._id, reconcileFrom: new Date('2026-10-01T00:00:00Z') });
  const settings = await s.mpesa.configure(director, bank._id, {
    enabled: true,
    environment: 'sandbox',
    shortCode: '600999',
    shortCodeType: 'PAYBILL',
    // Placeholders: enter your own Daraja sandbox keys in Banking → M-Pesa Paybill → M-Pesa to send real prompts.
    consumerKey: 'demo-consumer-key',
    consumerSecret: 'demo-consumer-secret',
    passkey: 'demo-passkey',
    postAsUserId: accountant.id,
  });
  const secret = /callbacks\/([^/]+)\/stk$/.exec(settings.callbackUrls!.stk)![1];
  // Paying out from the same account (placeholder credential): OfficePro is paid to its till.
  await s.mpesa.configurePayouts(director, bank._id, { enabled: true, shortCode: '600111', initiatorName: 'faraja_api', securityCredential: 'demo-security-credential', dailyLimit: new Decimal(500000),
    lowBalanceAlert: new Decimal(50000),
    // Business-pays B2C charges by band (illustrative; use your contract's tariff).
    tariff: [
      { upTo: new Decimal(100), charge: new Decimal(0) },
      { upTo: new Decimal(1500), charge: new Decimal(5) },
      { upTo: new Decimal(5000), charge: new Decimal(9) },
      { upTo: new Decimal(20000), charge: new Decimal(11) },
      { upTo: new Decimal(250000), charge: new Decimal(13) },
    ],
  });
  await s.db.suppliers.updateOne({ organisationId, code: 'OFFICEPRO' }, { mpesaPayee: { type: 'TILL', number: '5123456', accountReference: '' } });

  // Paybill payments as Safaricom would confirm them.
  const open = await s.db.invoices
    .find({ organisationId, entityId: ke._id, kind: 'SALES_INVOICE', status: 'POSTED', currency: 'KES', paymentStatus: { $ne: 'PAID' }, partyName: { $not: /Uganda/i } })
    .sort({ dueDate: 1 })
    .limit(2)
    .lean();
  const payers = [
    { FirstName: 'GRACE', LastName: 'WANJIKU', MSISDN: '254722481936' },
    { FirstName: 'PETER', LastName: 'OTIENO', MSISDN: '254711602583' },
  ];
  let n = 0;
  for (const [i, inv] of open.entries()) {
    const amount = dec(inv.amountDue).mul(i === 0 ? 1 : 0.5).toDecimalPlaces(0, 1);
    await s.mpesa.c2bConfirmation(secret, { TransID: `SJD${4100 + ++n}XK${n}`, TransTime: `2026100${n + 1}0930${10 + n}`, TransAmount: amount.toFixed(), BillRefNumber: inv.number.toLowerCase(), ...payers[i] });
  }
  const customer = open[0] ? await s.db.customers.findById(open[0].partyId, { code: 1 }).lean() : null;
  if (customer) await s.mpesa.c2bConfirmation(secret, { TransID: `SJD${4100 + ++n}XK${n}`, TransTime: '20261003141502', TransAmount: '15000', BillRefNumber: customer.code, FirstName: 'GRACE', LastName: 'WANJIKU', MSISDN: '254722481936' });
  await s.mpesa.c2bConfirmation(secret, { TransID: `SJD${4100 + ++n}XK${n}`, TransTime: '20261004111845', TransAmount: '8250', BillRefNumber: 'SEPT RENT', FirstName: 'JOHN', MiddleName: 'K', LastName: 'MUTUA', MSISDN: '254733905117' });

  // A customer refund: part of the payment held on account, paid back by bank transfer.
  const operating = await s.db.bankAccounts.findOne({ organisationId, entityId: ke._id, currency: 'KES', type: { $ne: 'MOBILE_MONEY' } }).lean();
  const onAccount = customer ? await s.db.payments.findOne({ organisationId, partyId: customer._id, status: 'POSTED', unallocated: { $gt: toD128(0) } }).lean() : null;
  if (operating && onAccount) {
    const refund = await s.refunds.create(accountant, {
      entityId: ke._id,
      partyId: onAccount.partyId,
      date: new Date('2026-10-05T00:00:00Z'),
      bankAccountId: operating._id,
      method: 'BANK_TRANSFER',
      reference: 'EFT-REF-1005',
      description: 'Overpayment returned',
      sources: [{ type: 'PAYMENT', id: onAccount._id, amount: Decimal.min(new Decimal(5000), dec(onAccount.unallocated)) }],
    });
    await s.refunds.approve(approver, refund._id);
  }
  // Salaries: September paid by bank; October to be paid by M-Pesa once approved.
  const staff = [
    { employeeNumber: 'FS-001', employeeName: 'Achieng Otieno', phone: '0722 410 225', amount: new Decimal(86500) },
    { employeeNumber: 'FS-002', employeeName: 'Kamau Njoroge', phone: '0711 908 314', amount: new Decimal(64200) },
    { employeeNumber: 'FS-003', employeeName: 'Fatuma Hassan', phone: '0733 551 760', amount: new Decimal(58750) },
    { employeeNumber: 'FS-004', employeeName: 'Brian Kiprotich', phone: '0790 214 683', amount: new Decimal(47300) },
  ];
  if (operating) {
    const september = await s.salaryRuns.create(accountant, { entityId: ke._id, period: '2026-09', date: new Date('2026-09-28T00:00:00Z'), description: 'September net pay', bankAccountId: operating._id, lines: staff });
    await s.salaryRuns.approve(approver, september._id);
  }
  await s.salaryRuns.create(accountant, { entityId: ke._id, period: '2026-10', date: new Date('2026-10-28T00:00:00Z'), description: 'October net pay', bankAccountId: bank._id, lines: staff });

  const portal = open[0] ? await s.portal.createLink(accountant, open[0].partyId, ke._id) : null;
  return { portalUrl: portal?.url ?? null };
}
