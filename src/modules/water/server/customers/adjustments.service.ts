import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { WaterDb as Db } from '@/modules/water/server/db';
import { AuditService } from '@/platform/services/audit.service';
import { StatementService } from './statement.service';

type Category = 'BILLING_ERROR' | 'LEAK_ALLOWANCE' | 'METER_FAULT' | 'WAIVER' | 'DEBIT_NOTE' | 'OTHER';

/** Credits and debit notes on customer accounts: requested by one person, approved by another. */
export class AdjustmentsService {
  afterApproved: (organisationId: Types.ObjectId, id: Types.ObjectId) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly statement: StatementService,
  ) {}

  async list(user: AuthUser, q: { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; customerId?: Types.ObjectId }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.customerId) filter.customerId = q.customerId;
    const items = await this.db.adjustments.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const customers = await this.db.customers.find({ _id: { $in: items.map((a) => a.customerId) } }, { accountNo: 1, name: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return items.map((a) => ({ ...a, customer: byId.get(a.customerId.toHexString()) ?? null }));
  }

  async request(user: AuthUser, input: { customerId: Types.ObjectId; amount: Decimal; reason: string; category: Category }) {
    if (input.amount.isZero()) throw new BadRequestException('The amount cannot be zero');
    if (!(await this.db.customers.exists({ _id: input.customerId, organisationId: user.organisationId }))) throw new NotFoundException('Customer not found');
    const [adj] = await this.db.adjustments.create([{ ...input, amount: toD128(input.amount), organisationId: user.organisationId, requestedBy: user.id }]);
    await this.audit.record(user, 'adjustment.request', 'adjustment', adj._id, { amount: input.amount.toFixed(2) });
    return adj;
  }

  async review(user: AuthUser, id: Types.ObjectId, input: { approve: boolean; note?: string }) {
    await this.db.transaction(async (session) => {
      const adj = await this.db.adjustments.findOne({ _id: id, organisationId: user.organisationId }).session(session);
      if (!adj) throw new NotFoundException('Adjustment not found');
      if (adj.status !== 'PENDING') throw new BadRequestException(`The adjustment is already ${adj.status.toLowerCase()}`);
      if (adj.requestedBy?.equals(user.id)) throw new ForbiddenException('Segregation of duties: someone else must approve an adjustment you requested');
      adj.set({ status: input.approve ? 'APPROVED' : 'REJECTED', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: input.note });
      await adj.save({ session });
      if (input.approve) {
        const amount = dec(adj.amount);
        await this.statement.post(
          {
            organisationId: user.organisationId,
            customerId: adj.customerId,
            date: new Date(),
            type: 'ADJUSTMENT',
            reference: `ADJ-${adj._id.toHexString().slice(-6).toUpperCase()}`,
            description: adj.reason,
            ...(amount.isNegative() ? { credit: amount.abs() } : { debit: amount }),
            sourceId: adj._id,
          },
          session,
        );
      }
      await this.audit.record(user, input.approve ? 'adjustment.approve' : 'adjustment.reject', 'adjustment', id, { note: input.note }, session);
    });
    if (input.approve) await this.afterApproved(user.organisationId, id);
    return this.db.adjustments.findById(id).lean();
  }
}
