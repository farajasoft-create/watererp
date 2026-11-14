import { ClientSession, Types } from 'mongoose';
import { Decimal, dec, DecimalInput, toD128 } from '@/platform/common/money';
import { WaterDb as Db } from '@/modules/water/server/db';
import { LEDGER_TYPES } from '@/modules/water/server/schemas';

export interface StatementEntry {
  organisationId: Types.ObjectId;
  customerId: Types.ObjectId;
  date: Date;
  type: (typeof LEDGER_TYPES)[number];
  reference: string;
  description: string;
  /** Increases what the customer owes. */
  debit?: DecimalInput;
  /** Reduces what the customer owes. */
  credit?: DecimalInput;
  sourceId?: Types.ObjectId | null;
}

/**
 * The customer statement. Every change to a balance goes through `post`, which moves the running balance
 * and writes the statement line with the balance after it, inside the caller's transaction.
 */
export class StatementService {
  constructor(private readonly db: Db) {}

  async post(entry: StatementEntry, session: ClientSession): Promise<Decimal> {
    const debit = dec(entry.debit);
    const credit = dec(entry.credit);
    const movement = debit.minus(credit);
    const customer = await this.db.customers.findOneAndUpdate(
      { _id: entry.customerId, organisationId: entry.organisationId },
      { $inc: { balance: toD128(movement) } },
      { new: true, session, projection: { balance: 1 } },
    );
    if (!customer) throw new Error('Customer not found');
    const balance = dec(customer.balance);
    await this.db.ledger.create(
      [{ ...entry, debit: toD128(debit), credit: toD128(credit), balance: toD128(balance), sourceId: entry.sourceId ?? null }],
      { session },
    );
    await this.refreshOldestUnpaid(entry.organisationId, entry.customerId, balance, session);
    return balance;
  }

  /**
   * Payments clear the oldest bills first. Walking back from the newest bill, the bill at which the bills
   * add up to the balance is the oldest one still (partly) unpaid.
   */
  async refreshOldestUnpaid(organisationId: Types.ObjectId, customerId: Types.ObjectId, balance: Decimal, session: ClientSession) {
    let oldest: Date | null = null;
    if (balance.gt(0)) {
      const bills = await this.db.bills
        .find({ organisationId, customerId, status: 'ISSUED' }, { currentCharges: 1, dueDate: 1 })
        .sort({ billDate: -1, _id: -1 })
        .session(session)
        .lean();
      let covered = new Decimal(0);
      for (const bill of bills) {
        oldest = bill.dueDate ?? null;
        covered = covered.plus(dec(bill.currentCharges));
        if (covered.gte(balance)) break;
      }
    }
    await this.db.customers.updateOne({ _id: customerId, organisationId }, { oldestUnpaidDueDate: oldest }, { session });
  }

  list(organisationId: Types.ObjectId, customerId: Types.ObjectId, opts: { from?: Date; to?: Date } = {}) {
    const q: Record<string, unknown> = { organisationId, customerId };
    if (opts.from || opts.to) q.date = { ...(opts.from && { $gte: opts.from }), ...(opts.to && { $lte: opts.to }) };
    // Posting order: each line's balance was fixed when it was posted, so back-dated lines stay in sequence.
    return this.db.ledger.find(q).sort({ createdAt: 1, _id: 1 }).lean();
  }
}
