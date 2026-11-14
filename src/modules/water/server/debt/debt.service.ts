import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { SmsService } from '@/platform/services/sms.service';
import { AdjustmentsService } from '../customers/adjustments.service';
import { WaterDb as Db, waterSettings } from '../db';
import { CASE_STAGES, CLOSED_STAGES, PLAN_STATUSES } from '../service-schemas';
import { planState, schedule } from './plan';

type Stage = (typeof CASE_STAGES)[number];
const DAY = 86_400_000;

/** Messages sent when a case reaches a stage; the rest are recorded without a text. */
const STAGE_SMS: Partial<Record<Stage, (org: string, acc: string, amount: string, paybill: string) => string>> = {
  REMINDER: (org, acc, amount, paybill) => `${org}: Reminder: account ${acc} has an overdue balance of KES ${amount}.${paybill} Talk to us about a payment plan if you need one.`,
  DEMAND_LETTER: (org, acc, amount) => `${org}: Demand notice: account ${acc} owes KES ${amount}. A demand letter has been issued; pay within 14 days to avoid further action.`,
  FINAL_NOTICE: (org, acc, amount) => `${org}: FINAL NOTICE: account ${acc} owes KES ${amount}. Pay within 7 days or the debt goes to a collector and legal action.`,
};

/**
 * Debt management beyond the disconnection list: payment plans (arrears cleared in instalments, the
 * account kept off the disconnection list while the plan is honoured) and collection cases that move
 * from reminder to demand letter, collector and court, until settled or written off.
 */
export class DebtService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  private async names(organisationId: Types.ObjectId) {
    const [org, settings] = await Promise.all([this.db.organisations.findById(organisationId, { name: 1 }).lean(), waterSettings(this.db, organisationId)]);
    return { org: org?.name ?? 'Water', paybill: settings.billing?.paybill ? ` Pay via M-Pesa Paybill ${settings.billing.paybill}.` : '', settings };
  }

  // -------------------------------------------------------------------------------------------
  // Payment plans
  // -------------------------------------------------------------------------------------------

  async listPlans(user: AuthUser, q: { status?: (typeof PLAN_STATUSES)[number]; customerId?: Types.ObjectId }) {
    const plans = await this.db.paymentPlans
      .find({ organisationId: user.organisationId, ...(q.status && { status: q.status }), ...(q.customerId && { customerId: q.customerId }) })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    const customers = await this.db.customers.find({ _id: { $in: plans.map((p) => p.customerId) } }, { name: 1, balance: 1, phone: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return plans.map((p) => ({ ...p, customer: byId.get(p.customerId.toHexString()) ?? null }));
  }

  /** Proposes a plan for the account's current balance; someone else approves it. */
  async createPlan(user: AuthUser, input: { customerId: Types.ObjectId; deposit: Decimal; instalments: number; startDate: Date; graceDays?: number; notes?: string }) {
    const customer = await this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    const arrears = dec(customer.balance);
    if (arrears.lte(0)) throw new BadRequestException('The account has no arrears');
    if (input.deposit.lt(0) || input.deposit.gte(arrears)) throw new BadRequestException('The deposit must be less than the arrears');
    if (await this.db.paymentPlans.exists({ organisationId: user.organisationId, customerId: customer._id, status: { $in: ['PENDING', 'ACTIVE'] } })) throw new BadRequestException('The account already has a plan');
    const instalments = schedule(arrears, input.deposit, input.instalments, input.startDate);
    const plan = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, 'water:plan', session);
      const [p] = await this.db.paymentPlans.create(
        [
          {
            organisationId: user.organisationId,
            number: `PP-${String(seq).padStart(5, '0')}`,
            customerId: customer._id,
            accountNo: customer.accountNo,
            arrears: toD128(arrears),
            deposit: toD128(input.deposit),
            instalments: instalments.map((i) => ({ dueDate: i.dueDate, amount: toD128(i.amount), paid: toD128(0) })),
            startDate: input.startDate,
            graceDays: input.graceDays ?? 7,
            notes: input.notes,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.record(user, 'water.plan.create', 'paymentPlan', p._id, { accountNo: customer.accountNo, arrears: arrears.toFixed(2), instalments: input.instalments }, session);
      return p.toObject();
    });
    return plan;
  }

  async reviewPlan(user: AuthUser, id: Types.ObjectId, approve: boolean) {
    const plan = await this.db.paymentPlans.findOne({ _id: id, organisationId: user.organisationId, status: 'PENDING' });
    if (!plan) throw new BadRequestException('Only a proposed plan can be approved or rejected');
    if (plan.createdBy?.equals(user.id) && !user.isAdmin) throw new ForbiddenException('Segregation of duties: someone else must approve a plan you proposed');
    plan.set({ status: approve ? 'ACTIVE' : 'REJECTED', approvedBy: user.id, approvedAt: new Date(), ...(!approve && { closedAt: new Date() }) });
    await plan.save();
    if (approve) {
      // The account comes off the disconnection list while the plan is honoured.
      await this.db.disconnections.updateMany({ organisationId: user.organisationId, customerId: plan.customerId, status: { $in: ['LISTED', 'NOTICE_SENT'] } }, { status: 'CANCELLED', note: `Payment plan ${plan.number}` });
      const c = await this.db.customers.findById(plan.customerId, { phone: 1 }).lean();
      const { org } = await this.names(user.organisationId);
      const first = plan.instalments[0];
      await this.sms.queue(user.organisationId, c?.phone, `${org}: Payment plan ${plan.number} for ${plan.accountNo} is approved: deposit KES ${dec(plan.deposit).toFixed(2)}, then ${plan.instalments.length} instalments of KES ${dec(first?.amount).toFixed(2)} from ${first?.dueDate?.toISOString().slice(0, 10)}.`, 'water:plan', plan._id);
      await this.sms.deliverDue(user.organisationId);
    }
    await this.audit.record(user, approve ? 'water.plan.approve' : 'water.plan.reject', 'paymentPlan', id, {});
    return plan.toObject();
  }

  async cancelPlan(user: AuthUser, id: Types.ObjectId, note: string) {
    const plan = await this.db.paymentPlans.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: { $in: ['PENDING', 'ACTIVE', 'DEFAULTED'] } }, { status: 'CANCELLED', closedAt: new Date(), notes: note }, { new: true }).lean();
    if (!plan) throw new BadRequestException('The plan is already closed');
    await this.audit.record(user, 'water.plan.cancel', 'paymentPlan', id, { note });
    return plan;
  }

  private async refreshPlan(planId: Types.ObjectId, today = new Date()) {
    const plan = await this.db.paymentPlans.findById(planId);
    if (!plan || plan.status !== 'ACTIVE') return null;
    const state = planState({ deposit: plan.deposit?.toString(), startDate: plan.startDate, instalments: plan.instalments.map((i) => ({ dueDate: i.dueDate!, amount: i.amount?.toString() ?? '0' })), paidToDate: plan.paidToDate?.toString(), graceDays: plan.graceDays }, today);
    plan.set({ status: state.status, instalments: state.instalments.map((i) => ({ dueDate: i.dueDate, amount: toD128(i.amount), paid: toD128(i.paid) })), ...(state.status !== 'ACTIVE' && { closedAt: today }) });
    await plan.save();
    return plan;
  }

  /** A payment reached the account: counts towards its plan, and settles open cases once the balance is cleared. */
  async onPayment(organisationId: Types.ObjectId, paymentId: Types.ObjectId) {
    const payment = await this.db.payments.findById(paymentId, { customerId: 1, amount: 1, status: 1 }).lean();
    if (!payment?.customerId || payment.status !== 'POSTED') return;
    const plan = await this.db.paymentPlans.findOne({ organisationId, customerId: payment.customerId, status: 'ACTIVE' }, { _id: 1 }).lean();
    if (plan) {
      await this.db.paymentPlans.updateOne({ _id: plan._id }, { $inc: { paidToDate: payment.amount } });
      await this.refreshPlan(plan._id);
    }
    const customer = await this.db.customers.findById(payment.customerId, { balance: 1 }).lean();
    if (dec(customer?.balance).lte(0)) {
      await this.db.debtCases.updateMany(
        { organisationId, customerId: payment.customerId, open: true },
        { stage: 'SETTLED', open: false, $push: { history: { at: new Date(), by: null, stage: 'SETTLED', note: 'Balance cleared' } } },
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Collection and legal cases
  // -------------------------------------------------------------------------------------------

  async listCases(user: AuthUser, q: { stage?: Stage; open?: boolean; customerId?: Types.ObjectId }) {
    const cases = await this.db.debtCases
      .find({ organisationId: user.organisationId, ...(q.stage && { stage: q.stage }), ...(q.open !== undefined && { open: q.open }), ...(q.customerId && { customerId: q.customerId }) })
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    const customers = await this.db.customers.find({ _id: { $in: cases.map((c) => c.customerId) } }, { name: 1, balance: 1, phone: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return cases.map((c) => ({ ...c, customer: byId.get(c.customerId.toHexString()) ?? null }));
  }

  private async notify(organisationId: Types.ObjectId, stage: Stage, customerId: Types.ObjectId, caseId: Types.ObjectId) {
    const make = STAGE_SMS[stage];
    if (!make) return;
    const c = await this.db.customers.findById(customerId, { phone: 1, accountNo: 1, balance: 1 }).lean();
    if (!c) return;
    const { org, paybill } = await this.names(organisationId);
    await this.sms.queue(organisationId, c.phone, make(org, c.accountNo, dec(c.balance).toFixed(2), paybill), `water:debt-${stage.toLowerCase()}`, caseId);
  }

  async openCase(user: AuthUser, input: { customerId: Types.ObjectId; stage?: Stage; note?: string; assignedTo?: Types.ObjectId | null }) {
    const customer = await this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    if (dec(customer.balance).lte(0)) throw new BadRequestException('The account has no arrears');
    if (await this.db.debtCases.exists({ organisationId: user.organisationId, customerId: customer._id, open: true })) throw new BadRequestException('The account already has an open case');
    const stage = input.stage ?? 'REMINDER';
    const created = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, 'water:debt-case', session);
      const [c] = await this.db.debtCases.create(
        [
          {
            organisationId: user.organisationId,
            number: `DC-${String(seq).padStart(5, '0')}`,
            customerId: customer._id,
            accountNo: customer.accountNo,
            category: customer.category,
            amount: customer.balance,
            stage,
            assignedTo: input.assignedTo ?? null,
            nextActionAt: new Date(Date.now() + 14 * DAY),
            history: [{ at: new Date(), by: user.id, stage, note: input.note ?? 'Case opened' }],
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.record(user, 'water.debt-case.open', 'debtCase', c._id, { accountNo: customer.accountNo, stage }, session);
      return c.toObject();
    });
    await this.notify(user.organisationId, stage, customer._id, created._id);
    await this.sms.deliverDue(user.organisationId);
    return created;
  }

  /** Moves a case to another stage, with the collector or court details where they apply. */
  async advance(user: AuthUser, id: Types.ObjectId, input: { stage: Stage; note?: string; collector?: string; legal?: { advocate?: string; court?: string; caseNo?: string; filedAt?: Date | null; nextHearing?: Date | null; judgementAmount?: Decimal | null }; nextActionAt?: Date | null }) {
    const c = await this.db.debtCases.findOne({ _id: id, organisationId: user.organisationId });
    if (!c) throw new NotFoundException('Case not found');
    if (!c.open) throw new BadRequestException('The case is closed');
    if (input.stage === 'WRITTEN_OFF') throw new BadRequestException('Use write-off, which needs approval');
    c.stage = input.stage;
    if (CLOSED_STAGES.includes(input.stage)) c.open = false;
    if (input.collector !== undefined) c.collector = input.collector;
    if (input.legal) c.legal = { ...(c.legal ?? {}), ...input.legal, judgementAmount: input.legal.judgementAmount ? toD128(input.legal.judgementAmount) : c.legal?.judgementAmount };
    if (input.nextActionAt !== undefined) c.nextActionAt = input.nextActionAt ?? undefined;
    c.history.push({ at: new Date(), by: user.id, stage: input.stage, note: input.note });
    await c.save();
    await this.audit.record(user, 'water.debt-case.stage', 'debtCase', id, { stage: input.stage, note: input.note });
    await this.notify(user.organisationId, input.stage, c.customerId, c._id);
    await this.sms.deliverDue(user.organisationId);
    return c.toObject();
  }

  /** Requests a credit for the whole balance; the write-off takes effect when the adjustment is approved. */
  async writeOff(user: AuthUser, id: Types.ObjectId, reason: string) {
    const c = await this.db.debtCases.findOne({ _id: id, organisationId: user.organisationId });
    if (!c) throw new NotFoundException('Case not found');
    if (!c.open) throw new BadRequestException('The case is closed');
    const customer = await this.db.customers.findById(c.customerId, { balance: 1 }).lean();
    const balance = dec(customer?.balance);
    if (balance.lte(0)) throw new BadRequestException('Nothing is owed');
    const adj = await this.adjustments.request(user, { customerId: c.customerId, amount: balance.negated(), reason: `Write-off ${c.number}: ${reason}`, category: 'WAIVER' });
    c.set({ stage: 'WRITTEN_OFF', open: false, writeOffAdjustmentId: adj._id });
    c.history.push({ at: new Date(), by: user.id, stage: 'WRITTEN_OFF', note: `${reason} (credit of ${balance.toFixed(2)} awaiting approval)` });
    await c.save();
    await this.audit.record(user, 'water.debt-case.write-off', 'debtCase', id, { amount: balance.toFixed(2), reason });
    return c.toObject();
  }

  /**
   * The daily collection run: opens reminder cases for accounts overdue past the reminder days (unless
   * on a plan), and puts plans whose instalments are late into default.
   */
  async collectionRun(user: AuthUser) {
    const { settings } = await this.names(user.organisationId);
    const days = settings.service?.reminderAfterDays ?? 14;
    const before = new Date(Date.now() - days * DAY);
    const [onPlan, withCase] = await Promise.all([
      this.db.paymentPlans.distinct('customerId', { organisationId: user.organisationId, status: { $in: ['PENDING', 'ACTIVE'] } }),
      this.db.debtCases.distinct('customerId', { organisationId: user.organisationId, open: true }),
    ]);
    const skip = [...onPlan, ...withCase];
    const due = await this.db.customers.find({ organisationId: user.organisationId, status: { $in: ['ACTIVE', 'DISCONNECTED'] }, balance: { $gt: toD128(0) }, oldestUnpaidDueDate: { $ne: null, $lt: before }, _id: { $nin: skip } }, { _id: 1 }).limit(2000).lean();
    let opened = 0;
    for (const c of due) {
      await this.openCase(user, { customerId: c._id, note: `Overdue more than ${days} days` });
      opened++;
    }
    const active = await this.db.paymentPlans.find({ organisationId: user.organisationId, status: 'ACTIVE' }, { _id: 1 }).lean();
    let defaulted = 0;
    for (const p of active) if ((await this.refreshPlan(p._id))?.status === 'DEFAULTED') defaulted++;
    return { opened, defaulted };
  }

  /** Arrears by customer category and case stage, and plans by status. */
  async summary(user: AuthUser) {
    const [byStage, plans] = await Promise.all([
      this.db.debtCases.aggregate<{ _id: { stage: string; category: string }; n: number; amount: Types.Decimal128 }>([
        { $match: { organisationId: user.organisationId, open: true } },
        { $group: { _id: { stage: '$stage', category: '$category' }, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
      this.db.paymentPlans.aggregate<{ _id: string; n: number; arrears: Types.Decimal128; paid: Types.Decimal128 }>([
        { $match: { organisationId: user.organisationId } },
        { $group: { _id: '$status', n: { $sum: 1 }, arrears: { $sum: '$arrears' }, paid: { $sum: '$paidToDate' } } },
      ]),
    ]);
    return { cases: byStage.map((r) => ({ stage: r._id.stage, category: r._id.category, count: r.n, amount: r.amount })), plans };
  }
}
