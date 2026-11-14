import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { WaterDb as Db, waterSettings } from '@/modules/water/server/db';
import { DISCONNECTION_STATUSES } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { CustomersService } from '../customers/customers.service';
import { StatementService } from '../customers/statement.service';
import { SmsService } from '@/platform/services/sms.service';
import { dueForDisconnection } from '../billing/arrears';

const OPEN = ['LISTED', 'NOTICE_SENT', 'DISCONNECTED'];

/** Debt-driven disconnection and reconnection of supply. */
export class DisconnectionsService {
  /** Wired in the container: sends the reconnection fee to the ledger. */
  afterReconnected: (organisationId: Types.ObjectId, id: Types.ObjectId) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly statement: StatementService,
    private readonly sms: SmsService,
  ) {}

  async list(user: AuthUser, status?: (typeof DISCONNECTION_STATUSES)[number]) {
    const items = await this.db.disconnections
      .find({ organisationId: user.organisationId, ...(status ? { status } : { status: { $in: OPEN } }) })
      .sort({ listedAt: -1 })
      .limit(500)
      .lean();
    const customers = await this.db.customers.find({ _id: { $in: items.map((d) => d.customerId) } }, { accountNo: 1, name: 1, phone: 1, balance: 1, zoneId: 1, plotNo: 1, status: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return items.map((d) => ({ ...d, customer: byId.get(d.customerId.toHexString()) ?? null }));
  }

  /** Lists every active connection whose arrears are past the grace period and not already listed. */
  async generate(user: AuthUser, zoneId?: Types.ObjectId) {
    const org = await waterSettings(this.db, user.organisationId);
    const policy = { minArrears: org?.billing?.disconnectionMinArrears?.toString() ?? '0', graceDays: org?.billing?.disconnectionGraceDays ?? 30 };
    const today = new Date();
    const candidates = await this.db.customers
      .find({ organisationId: user.organisationId, status: 'ACTIVE', balance: { $gt: toD128(0) }, oldestUnpaidDueDate: { $ne: null }, ...(zoneId && { zoneId }) }, { balance: 1, oldestUnpaidDueDate: 1, accountNo: 1 })
      .lean();
    const listed = new Set((await this.db.disconnections.distinct('customerId', { organisationId: user.organisationId, status: { $in: OPEN } })).map(String));
    // Accounts honouring a payment plan stay connected.
    for (const id of await this.db.paymentPlans.distinct('customerId', { organisationId: user.organisationId, status: 'ACTIVE' })) listed.add(String(id));
    const due = candidates.filter((c) => !listed.has(c._id.toHexString()) && dueForDisconnection(c.balance?.toString() ?? 0, c.oldestUnpaidDueDate ?? null, policy, today));
    if (due.length) {
      await this.db.disconnections.insertMany(due.map((c) => ({ organisationId: user.organisationId, customerId: c._id, accountNo: c.accountNo, arrears: c.balance, status: 'LISTED' })));
    }
    await this.audit.record(user, 'disconnection.generate', 'disconnection', null, { listed: due.length });
    return { listed: due.length };
  }

  async sendNotices(user: AuthUser, ids: Types.ObjectId[]) {
    const [orgDoc, org] = await Promise.all([this.db.organisations.findById(user.organisationId, { name: 1 }).lean(), waterSettings(this.db, user.organisationId)]);
    const items = await this.db.disconnections.find({ _id: { $in: ids }, organisationId: user.organisationId, status: 'LISTED' }).lean();
    for (const d of items) {
      const c = await this.db.customers.findById(d.customerId, { phone: 1, name: 1, accountNo: 1, balance: 1 }).lean();
      if (!c) continue;
      const paybill = org?.billing?.paybill ? ` Pay via M-Pesa Paybill ${org.billing.paybill}, account ${c.accountNo}.` : '';
      await this.sms.queue(user.organisationId, c.phone, `${orgDoc?.name ?? 'Water'}: Dear ${c.name}, your account ${c.accountNo} has arrears of KES ${dec(c.balance).toFixed(2)}. Supply will be disconnected unless paid within 7 days.${paybill}`, 'water:disconnection-notice', d._id);
      await this.db.disconnections.updateOne({ _id: d._id }, { status: 'NOTICE_SENT', noticeSentAt: new Date() });
    }
    await this.audit.record(user, 'disconnection.notice', 'disconnection', null, { count: items.length });
    await this.sms.deliverDue(user.organisationId);
    return { sent: items.length };
  }

  async disconnect(user: AuthUser, id: Types.ObjectId, input: { meterReading?: Decimal | null; note?: string }) {
    const d = await this.db.disconnections.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d) throw new NotFoundException('Not on the disconnection list');
    if (!['LISTED', 'NOTICE_SENT'].includes(d.status)) throw new BadRequestException(`Already ${d.status.toLowerCase()}`);
    await this.customers.changeStatus(user, d.customerId, 'DISCONNECTED', 'Disconnected for arrears');
    await this.db.disconnections.updateOne(
      { _id: id },
      { status: 'DISCONNECTED', disconnectedAt: new Date(), disconnectedBy: user.id, ...(input.meterReading && { meterReading: toD128(input.meterReading) }), note: input.note },
    );
    await this.audit.record(user, 'disconnection.disconnect', 'disconnection', id, input);
    return this.db.disconnections.findById(id).lean();
  }

  /** Drops a listed account that paid before the crew got there. */
  async cancel(user: AuthUser, id: Types.ObjectId, note?: string) {
    const d = await this.db.disconnections.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: { $in: ['LISTED', 'NOTICE_SENT'] } }, { status: 'CANCELLED', note }, { new: true }).lean();
    if (!d) throw new BadRequestException('Only an account still awaiting disconnection can be taken off the list');
    await this.audit.record(user, 'disconnection.cancel', 'disconnection', id, { note });
    return d;
  }

  /** Restores supply, charging the reconnection fee to the account. */
  async reconnect(user: AuthUser, id: Types.ObjectId, input: { waiveFee?: boolean; note?: string }) {
    const d = await this.db.disconnections.findOne({ _id: id, organisationId: user.organisationId, status: 'DISCONNECTED' }).lean();
    if (!d) throw new BadRequestException('Only a disconnected account can be reconnected');
    const org = await waterSettings(this.db, user.organisationId);
    const fee = input.waiveFee ? new Decimal(0) : dec(org?.billing?.reconnectionFee);
    if (fee.gt(0)) {
      await this.db.transaction((session) =>
        this.statement.post({ organisationId: user.organisationId, customerId: d.customerId, date: new Date(), type: 'RECONNECTION_FEE', reference: 'RECON', description: 'Reconnection fee', debit: fee, sourceId: d._id }, session),
      );
    }
    await this.customers.changeStatus(user, d.customerId, 'ACTIVE', 'Reconnected');
    await this.db.disconnections.updateOne({ _id: id }, { status: 'RECONNECTED', reconnectedAt: new Date(), reconnectedBy: user.id, reconnectionFee: toD128(fee), note: input.note });
    await this.audit.record(user, 'disconnection.reconnect', 'disconnection', id, { fee: fee.toFixed(2) });
    if (fee.gt(0)) await this.afterReconnected(user.organisationId, id);
    return this.db.disconnections.findById(id).lean();
  }
}
