import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { transition } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { BankingService } from '../banking/banking.service';
import { JournalsService } from '../journals/journals.service';
import { WorkflowService } from '../workflow/workflow.service';

type Id = Types.ObjectId;
/** Requests that count against a category's monthly limit. */
const LIVE = ['SUBMITTED', 'APPROVED', 'PAID'];
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export interface PettyCashRequestInput { bankAccountId: Id; categoryId: Id; amount: Decimal; purpose: string; payee?: string; departmentId?: Id | null }
export interface PettyCashLimitsInput { float: Decimal | null; categories: { categoryId: Id; perVoucher: Decimal | null; perMonth: Decimal | null }[] }

/**
 * Petty cash on the imprest system: each petty cash box (a PETTY_CASH account) has a float and, per
 * expense category, the most a single voucher and a month may spend. Staff raise requests online; an
 * approver (not the requester) approves; the custodian pays out of the box, which posts the expense and
 * credits the box; the petty cash book shows the balance, what each category has used this month and how
 * much will restore the float.
 */
export class PettyCashService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly banking: BankingService,
    private readonly journals: JournalsService,
    private readonly workflow: WorkflowService,
  ) {}

  private async box(user: AuthUser, id: Id, session?: ClientSession) {
    const bank = await this.db.bankAccounts.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!bank?.isActive || bank.type !== 'PETTY_CASH') throw new BadRequestException('Petty cash account not found');
    return bank;
  }

  async boxes(user: AuthUser) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, type: 'PETTY_CASH', isActive: true };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return this.db.bankAccounts.find(filter, { name: 1, currency: 1, entityId: 1, branchId: 1 }).sort({ name: 1 }).lean();
  }

  // ----- Limits ------------------------------------------------------------------------------

  async limits(user: AuthUser, bankAccountId: Id) {
    await this.box(user, bankAccountId);
    const rows = await this.db.pettyCashLimits.find({ organisationId: user.organisationId, bankAccountId }).lean();
    return { float: rows.find((r) => !r.categoryId)?.float ?? null, categories: rows.filter((r) => r.categoryId).map((r) => ({ categoryId: r.categoryId, perVoucher: r.perVoucher, perMonth: r.perMonth })) };
  }

  async saveLimits(user: AuthUser, bankAccountId: Id, input: PettyCashLimitsInput) {
    await this.box(user, bankAccountId);
    const ids = input.categories.map((c) => c.categoryId);
    if (new Set(ids.map(String)).size !== ids.length) throw new BadRequestException('A category is listed twice');
    const found = await this.db.expenseCategories.countDocuments({ organisationId: user.organisationId, _id: { $in: ids } });
    if (found !== ids.length) throw new BadRequestException('Expense category not found');
    for (const c of input.categories) if (c.perVoucher && c.perMonth && c.perVoucher.gt(c.perMonth)) throw new BadRequestException('A single voucher cannot be allowed more than the month');
    const d = (v: Decimal | null) => (v ? toD128(v) : null);
    await this.db.pettyCashLimits.deleteMany({ organisationId: user.organisationId, bankAccountId });
    await this.db.pettyCashLimits.insertMany([
      { organisationId: user.organisationId, bankAccountId, categoryId: null, float: d(input.float) },
      ...input.categories.map((c) => ({ organisationId: user.organisationId, bankAccountId, categoryId: c.categoryId, perVoucher: d(c.perVoucher), perMonth: d(c.perMonth) })),
    ]);
    await this.audit.log(user, { action: 'pettycash.limits', recordType: 'BankAccount', recordId: bankAccountId, summary: `Set petty cash float and ${input.categories.length} category limit(s)` });
    return this.limits(user, bankAccountId);
  }

  /** Throws when the amount breaks the category's per-voucher or monthly limit. Categories without a limit row are not allowed. */
  private async checkLimits(user: AuthUser, v: { bankAccountId: Id; categoryId: Id; amount: Decimal; excludeId?: Id; categoryName: string }, session?: ClientSession) {
    const limit = await this.db.pettyCashLimits.findOne({ organisationId: user.organisationId, bankAccountId: v.bankAccountId, categoryId: v.categoryId }).session(session ?? null).lean();
    if (!limit) throw new BadRequestException(`${v.categoryName} is not paid from this petty cash box`);
    if (limit.perVoucher && v.amount.gt(dec(limit.perVoucher))) throw new BadRequestException(`${v.categoryName}: one petty cash voucher may not exceed ${dec(limit.perVoucher).toFixed(2)}`);
    if (limit.perMonth) {
      const used = await this.db.pettyCashVouchers
        .find({ organisationId: user.organisationId, bankAccountId: v.bankAccountId, categoryId: v.categoryId, status: { $in: LIVE }, createdAt: { $gte: monthStart(new Date()) }, ...(v.excludeId && { _id: { $ne: v.excludeId } }) }, { amount: 1 })
        .session(session ?? null)
        .lean();
      const total = sum(used.map((u) => dec(u.amount))).plus(v.amount);
      if (total.gt(dec(limit.perMonth))) throw new BadRequestException(`${v.categoryName}: this month's petty cash limit of ${dec(limit.perMonth).toFixed(2)} would be exceeded (${total.minus(v.amount).toFixed(2)} already used)`);
    }
  }

  // ----- Requests ----------------------------------------------------------------------------

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (!hasPermission(user, PERMISSIONS.EXPENSES_APPROVE) && !hasPermission(user, PERMISSIONS.EXPENSES_PAY)) filter.requesterId = user.id;
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  private async load(user: AuthUser, id: Id, session?: ClientSession) {
    const v = await this.db.pettyCashVouchers.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!v) throw new NotFoundException('Petty cash request not found');
    return v;
  }

  async list(user: AuthUser, q: { status?: string; mine?: boolean; bankAccountId?: Id }) {
    const filter = this.scope(user);
    if (q.status) filter.status = q.status;
    if (q.mine) filter.requesterId = user.id;
    if (q.bankAccountId) filter.bankAccountId = q.bankAccountId;
    return this.db.pettyCashVouchers.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  }

  async request(user: AuthUser, input: PettyCashRequestInput) {
    return this.db.transaction(async (session) => {
      const bank = await this.box(user, input.bankAccountId, session);
      assertBranchAccess(user, [bank.branchId]);
      const category = await this.db.expenseCategories.findOne({ _id: input.categoryId, organisationId: user.organisationId }).session(session).lean();
      if (!category?.isActive) throw new BadRequestException('Expense category not found or inactive');
      if (input.amount.lte(0)) throw new BadRequestException('Enter a positive amount');
      await this.checkLimits(user, { bankAccountId: bank._id, categoryId: category._id, amount: input.amount, categoryName: category.name }, session);
      const entity = await this.db.entities.findById(bank.entityId).session(session).lean();
      if (!entity) throw new BadRequestException('Entity not found');
      const number = await this.db.nextNumber(user.organisationId, entity, 'PCV', session);
      const [doc] = await this.db.pettyCashVouchers.create(
        [{ organisationId: user.organisationId, entityId: bank.entityId, branchId: bank.branchId, number, bankAccountId: bank._id, categoryId: category._id, categoryName: category.name, accountId: category.accountId, currency: bank.currency, amount: toD128(input.amount), purpose: input.purpose, payee: input.payee ?? '', departmentId: input.departmentId ?? null, requesterId: user.id, requesterName: user.name, createdBy: user.id, submittedBy: user.id }],
        { session },
      );
      await this.audit.log(user, { action: 'pettycash.request', recordType: 'PettyCashVoucher', recordId: doc._id, summary: `Requested ${number}: ${input.amount.toFixed(2)} for ${input.purpose}` }, session);
      return doc.toObject();
    });
  }

  async approve(user: AuthUser, id: Id) {
    return this.db.transaction(async (session) => {
      const v = await this.load(user, id, session);
      if (v.requesterId.equals(user.id)) throw new ForbiddenException('Segregation of duties: you cannot approve your own petty cash request');
      if (v.status !== 'SUBMITTED') throw new BadRequestException(`${v.number} is ${v.status.toLowerCase()}`);
      await this.checkLimits(user, { bankAccountId: v.bankAccountId, categoryId: v.categoryId, amount: dec(v.amount), excludeId: v._id, categoryName: v.categoryName }, session);
      const after = await transition(this.db.pettyCashVouchers, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() }, session);
      await this.audit.log(user, { action: 'pettycash.approve', recordType: 'PettyCashVoucher', recordId: id, summary: `Approved ${v.number}` }, session);
      await this.workflow.notify(user.organisationId, [v.requesterId], { kind: 'pettycash', title: `Petty cash ${v.number} approved`, body: 'Collect the cash from the petty cash custodian.', link: '/finance/petty-cash' }, session);
      return after;
    });
  }

  async reject(user: AuthUser, id: Id, reason: string) {
    return this.db.transaction(async (session) => {
      const v = await this.load(user, id, session);
      if (!['SUBMITTED', 'APPROVED'].includes(v.status)) throw new BadRequestException(`${v.number} is ${v.status.toLowerCase()}`);
      const after = await transition(this.db.pettyCashVouchers, id, ['SUBMITTED', 'APPROVED'], { status: 'REJECTED', rejectionReason: reason }, session);
      await this.audit.log(user, { action: 'pettycash.reject', recordType: 'PettyCashVoucher', recordId: id, summary: `Rejected ${v.number}: ${reason}` }, session);
      await this.workflow.notify(user.organisationId, [v.requesterId], { kind: 'pettycash', title: `Petty cash ${v.number} rejected`, body: reason, link: '/finance/petty-cash' }, session);
      return after;
    });
  }

  async cancel(user: AuthUser, id: Id) {
    const v = await this.load(user, id);
    if (!v.requesterId.equals(user.id)) throw new ForbiddenException('Only the requester can cancel');
    if (v.status !== 'SUBMITTED') throw new BadRequestException(`${v.number} is ${v.status.toLowerCase()}`);
    return transition(this.db.pettyCashVouchers, id, ['SUBMITTED'], { status: 'CANCELLED' });
  }

  /** The custodian pays out: debit the category's expense account, credit the petty cash box. */
  async pay(user: AuthUser, id: Id, input: { date: Date; receiptReference?: string }) {
    return this.db.transaction(async (session) => {
      const v = await this.load(user, id, session);
      if (v.status !== 'APPROVED') throw new BadRequestException('Only approved requests are paid');
      const bank = await this.box(user, v.bankAccountId, session);
      const amount = dec(v.amount);
      const balance = await this.banking.bookBalance(bank, input.date, session);
      if (balance.lt(amount)) throw new BadRequestException(`The petty cash box holds ${balance.toFixed(2)}; replenish it first`);
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: v.entityId,
          branchId: v.branchId,
          journalDate: input.date,
          description: `Petty cash ${v.number}: ${v.purpose}`,
          reference: input.receiptReference || v.number,
          lines: [
            { accountId: v.accountId, currency: v.currency, debit: amount, departmentId: v.departmentId, description: `${v.number} · ${v.requesterName}${v.payee ? ` · ${v.payee}` : ''}` },
            { accountId: bank.glAccountId, branchId: bank.branchId, currency: v.currency, credit: amount, description: `Petty cash ${v.number}` },
          ],
        },
        { sourceType: 'PettyCashVoucher', sourceId: v._id, sourceNumber: v.number },
        session,
      );
      const after = await transition(this.db.pettyCashVouchers, id, ['APPROVED'], { status: 'PAID', paidBy: user.id, paidAt: input.date, receiptReference: input.receiptReference ?? '', journalId: journal._id }, session);
      await this.audit.log(user, { action: 'pettycash.pay', recordType: 'PettyCashVoucher', recordId: id, summary: `Paid ${v.number} from ${bank.name} (${journal.number})` }, session);
      return after;
    });
  }

  /** The petty cash book: balance, the float and what restores it, and each category's use this month against its limits. */
  async book(user: AuthUser, bankAccountId: Id) {
    const bank = await this.box(user, bankAccountId);
    const limits = await this.limits(user, bankAccountId);
    const balance = await this.banking.bookBalance(bank);
    const since = monthStart(new Date());
    const vouchers = await this.db.pettyCashVouchers.find({ organisationId: user.organisationId, bankAccountId, status: { $in: LIVE }, createdAt: { $gte: since } }).lean();
    const categories = await this.db.expenseCategories.find({ organisationId: user.organisationId, _id: { $in: limits.categories.map((c) => c.categoryId) } }, { name: 1 }).lean();
    const float = limits.float ? dec(limits.float) : null;
    return {
      account: { id: bank._id, name: bank.name, currency: bank.currency },
      balance: balance.toFixed(2),
      float: float?.toFixed(2) ?? null,
      replenish: float && float.gt(balance) ? float.minus(balance).toFixed(2) : '0.00',
      pending: sum(vouchers.filter((v) => v.status !== 'PAID').map((v) => dec(v.amount))).toFixed(2),
      categories: limits.categories.map((c) => {
        const mine = vouchers.filter((v) => v.categoryId.equals(c.categoryId!));
        const used = sum(mine.map((v) => dec(v.amount)));
        return { categoryId: c.categoryId, name: categories.find((x) => x._id.equals(c.categoryId!))?.name ?? '', perVoucher: c.perVoucher, perMonth: c.perMonth, usedThisMonth: used.toFixed(2), left: c.perMonth ? Decimal.max(dec(c.perMonth).minus(used), 0).toFixed(2) : null };
      }),
    };
  }
}
