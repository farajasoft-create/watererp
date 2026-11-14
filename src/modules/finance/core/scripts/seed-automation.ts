/**
 * Demo data for Phase 7: recurring journals (Mombasa rent and an insurance prepayment release) and
 * collections history, including a promise to pay that was not kept. AI assistance stays off.
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
  hq: Branch & { _id: Types.ObjectId };
  msa: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const D = (v: string | number) => new Decimal(v);

export async function seedAutomation(c: Context) {
  const { s, organisationId, ke, hq, msa, accountant } = c;
  const acc = new Map((await s.db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const A = (code: string) => acc.get(code)!;

  await s.recurring.create(accountant, {
    entityId: ke._id,
    branchId: msa._id,
    name: 'Mombasa shop rent',
    description: 'Mombasa shop rent for {period}',
    reference: 'RENT-MSA-{year}{month}',
    type: 'STANDARD',
    autoReverse: false,
    lines: [
      { accountId: A('6200'), debit: D(180000), description: 'Rent {monthName} {year}' },
      { accountId: A('1120'), credit: D(180000) },
    ],
    frequency: 'MONTHLY',
    interval: 1,
    dayOfMonth: 31,
    startDate: d('2026-10-01'),
    action: 'SUBMIT',
  });
  await s.recurring.create(accountant, {
    entityId: ke._id,
    branchId: hq._id,
    name: 'Group insurance – monthly release',
    description: 'Insurance expense for {period} (1/12 of the annual premium)',
    type: 'STANDARD',
    autoReverse: false,
    lines: [
      { accountId: A('6600'), debit: D(154166.67), description: 'Insurance {monthName}' },
      { accountId: A('1250'), credit: D(154166.67), description: 'Prepaid insurance released' },
    ],
    frequency: 'MONTHLY',
    interval: 1,
    dayOfMonth: 31,
    startDate: d('2026-10-01'),
    maxOccurrences: 12,
    action: 'DRAFT',
  });

  // The monthly management pack goes to the finance director and the reviewer on the 5th.
  const recipients = await s.db.users.find({ organisationId, email: { $in: ['admin@farajasoft.demo', 'approver@farajasoft.demo'] } }, { _id: 1 }).lean();
  await s.db.reportSubscriptions.create([{ organisationId, entityId: ke._id, userIds: recipients.map((u) => u._id), dayOfMonth: 5, lastSentFor: '2026-09', createdBy: accountant.id }]);

  // Collections history with the customers who owe the most.
  const work = await s.collections.worklist(accountant, ke._id, d('2026-10-04'));
  const [first, second] = work.rows;
  if (first) {
    await s.collections.log(accountant, { entityId: ke._id, customerId: new Types.ObjectId(first.customerId), type: 'CALL', note: 'Spoke to accounts payable; invoices are with their finance director for sign-off.' });
    await s.collections.log(accountant, { entityId: ke._id, customerId: new Types.ObjectId(first.customerId), type: 'PROMISE', note: 'Promised to clear the oldest invoice by the end of September.', promiseDate: d('2026-09-30'), promiseAmount: first.overdue.div(2).toDecimalPlaces(0), followUpDate: d('2026-10-06') });
  }
  if (second) {
    await s.collections.log(accountant, { entityId: ke._id, customerId: new Types.ObjectId(second.customerId), type: 'EMAIL', note: 'Sent statement and a friendly reminder.', followUpDate: d('2026-10-09') });
  }
}
