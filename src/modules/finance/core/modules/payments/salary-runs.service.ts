import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertApprovalLimit, assertSegregation } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { PeriodsService } from '../periods/periods.service';
import { normalisePhone } from './daraja';

export interface SalaryRunInput {
  entityId: Types.ObjectId;
  branchId?: Types.ObjectId | null;
  period: string;
  date: Date;
  description?: string;
  bankAccountId: Types.ObjectId;
  payableAccountId?: Types.ObjectId | null;
  lines: { employeeNumber?: string; employeeName: string; phone?: string; amount: Decimal; departmentId?: Types.ObjectId | null }[];
}

/**
 * Paying net salaries. Payroll is calculated elsewhere and its journal leaves net pay in Net Salaries
 * Payable; a salary run pays it: each employee line debits the payable and credits the bank, so each
 * payment matches its own statement line. From an account with M-Pesa payouts, every employee is paid
 * to their phone (one payout each).
 */
export class SalaryRunsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const r = await this.db.salaryRuns.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!r) throw new NotFoundException('Salary run not found');
    assertBranchAccess(user, [r.branchId]);
    return r;
  }

  async list(user: AuthUser, entityId?: Types.ObjectId) {
    return this.db.salaryRuns.find({ ...this.scope(user), ...(entityId && { entityId }) }, { lines: 0 }).sort({ date: -1, number: -1 }).limit(200).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const r = await this.load(user, id);
    const payouts = await this.db.payouts.find({ sourceId: r._id }, { sourceLine: 1, status: 1, transactionId: 1, resultDescription: 1, note: 1, charge: 1 }).lean();
    return { ...(await withTrail(this.db, r)), payouts };
  }

  private async build(user: AuthUser, input: SalaryRunInput, session: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const bank = await this.db.bankAccounts.findOne({ _id: input.bankAccountId, organisationId: org }).session(session).lean();
    if (!bank || !bank.entityId.equals(entity._id) || !bank.isActive) throw new BadRequestException('Bank account not found or inactive in this entity');
    if (bank.currency !== entity.functionalCurrency) throw new BadRequestException(`Salaries are paid in ${entity.functionalCurrency}; ${bank.name} is in ${bank.currency}`);
    const branchId = input.branchId ?? bank.branchId;
    assertBranchAccess(user, [branchId]);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new BadRequestException('The period is a month, YYYY-MM');
    const orgDoc = await this.db.organisations.findById(org).session(session).lean();
    const payableAccountId = input.payableAccountId ?? orgDoc?.settings?.salariesPayableAccountId;
    if (!payableAccountId) throw new BadRequestException('Choose the net salaries payable account');
    const payable = await this.db.accounts.findOne({ _id: payableAccountId, organisationId: org }).session(session).lean();
    if (!payable?.isActive || !payable.isPostable || payable.accountClass !== 'LIABILITY') throw new BadRequestException('The salaries payable account must be an active liability account');
    if (!input.lines.length) throw new BadRequestException('Add the employees to pay');
    const mpesa = !!(bank.mpesa?.enabled && bank.mpesa.payouts?.enabled);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const lines = input.lines.map((l, i) => {
      const tag = `Line ${i + 1} (${l.employeeName})`;
      if (!l.employeeName.trim()) throw new BadRequestException(`Line ${i + 1}: enter the employee`);
      if (!l.amount.gt(0)) throw new BadRequestException(`${tag}: the amount must be positive`);
      if (l.amount.decimalPlaces() > fp) throw new BadRequestException(`${tag}: at most ${fp} decimal places`);
      const phone = l.phone ? normalisePhone(l.phone) : '';
      if (l.phone && !phone) throw new BadRequestException(`${tag}: ${l.phone} is not a Safaricom number`);
      if (mpesa) {
        if (!phone) throw new BadRequestException(`${tag}: ${bank.name} pays by M-Pesa; enter the employee's Safaricom number`);
        if (l.amount.decimalPlaces() > 0) throw new BadRequestException(`${tag}: M-Pesa pays whole shillings`);
      }
      return { lineNo: i + 1, employeeNumber: l.employeeNumber ?? '', employeeName: l.employeeName.trim(), phone: phone ?? '', amount: toD128(l.amount), departmentId: l.departmentId ?? null };
    });
    const numbers = lines.map((l) => l.employeeNumber).filter(Boolean);
    if (new Set(numbers).size !== numbers.length) throw new BadRequestException('An employee number appears twice');
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId,
        period: input.period,
        date: input.date,
        description: input.description ?? '',
        bankAccountId: bank._id,
        payableAccountId: payable._id,
        lines,
        total: toD128(sum(input.lines.map((l) => l.amount))),
      },
    };
  }

  async create(user: AuthUser, input: SalaryRunInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'SAL', session);
      const [r] = await this.db.salaryRuns.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'salary_run.create', recordType: 'SalaryRun', recordId: r._id, summary: `Created ${number}: ${fields.lines.length} employee(s), ${fields.total.toString()} ${entity.functionalCurrency} for ${input.period}` }, session);
      return r.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: SalaryRunInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT') throw new BadRequestException('Only draft salary runs can be edited');
      const { fields } = await this.build(user, input, session);
      await this.db.salaryRuns.updateOne({ _id: id }, fields, { session });
      await this.audit.log(user, { action: 'salary_run.update', recordType: 'SalaryRun', recordId: id, summary: `Edited ${before.number}` }, session);
      return this.db.salaryRuns.findById(id).session(session).lean();
    });
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'DRAFT') throw new BadRequestException('Only draft salary runs can be deleted');
      await this.db.salaryRuns.deleteOne({ _id: id }, { session });
      await this.audit.log(user, { action: 'salary_run.delete', recordType: 'SalaryRun', recordId: id, summary: `Deleted draft ${r.number}` }, session);
      return { deleted: true };
    });
  }

  /** Approves and pays: one journal line pair per employee; M-Pesa payouts are queued by the payout listener. */
  async approve(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'DRAFT') throw new BadRequestException(`${r.number} is ${r.status.toLowerCase()}`);
      assertSegregation(user, r, 'a salary run');
      await this.build(user, { ...r, lines: r.lines.map((l) => ({ ...l, amount: dec(l.amount) })) }, session);
      const entity = (await this.db.entities.findById(r.entityId).session(session).lean())!;
      assertApprovalLimit(user, dec(r.total), entity.functionalCurrency, 'The salary run');
      await this.periods.assertPostable(user, r.entityId, r.date, session);
      const bank = (await this.db.bankAccounts.findById(r.bankAccountId).session(session).lean())!;
      const lines: LineInput[] = [];
      for (const l of r.lines) {
        const amount = dec(l.amount);
        const who = `${l.employeeName}${l.employeeNumber ? ` (${l.employeeNumber})` : ''}`;
        lines.push({ accountId: r.payableAccountId, branchId: r.branchId, departmentId: l.departmentId, currency: entity.functionalCurrency, description: `Net pay ${r.period}: ${who}`, debit: amount, credit: null });
        lines.push({ accountId: bank.glAccountId, branchId: r.branchId, currency: entity.functionalCurrency, description: `Salary ${r.period}: ${who}`, debit: null, credit: amount });
      }
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: r.entityId, branchId: r.branchId, journalDate: r.date, description: `Salaries ${r.period} ${r.number}${r.description ? ` · ${r.description}` : ''}`, reference: r.number, lines },
        { sourceType: 'SalaryRun', sourceId: r._id, sourceNumber: r.number },
        session,
      );
      await this.db.salaryRuns.updateOne({ _id: id, status: 'DRAFT' }, { status: 'POSTED', approvedBy: user.id, approvedAt: new Date(), journalId: journal._id }, { session });
      await this.audit.log(user, { action: 'salary_run.post', recordType: 'SalaryRun', recordId: id, summary: `Approved and paid ${r.number}: ${r.lines.length} employee(s), ${dec(r.total).toFixed()} ${entity.functionalCurrency} (${journal.number})` }, session);
      return this.db.salaryRuns.findById(id).session(session).lean();
    });
  }

  /** Voids a posted run whose payouts have not gone (queued ones are cancelled by the payout listener). */
  async void(user: AuthUser, id: Types.ObjectId, date: Date, reason: string) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'POSTED') throw new BadRequestException('Only posted salary runs can be voided');
      if (date < r.date) throw new BadRequestException('The void date cannot be before the run');
      // An M-Pesa payout that may have gone blocks the void (the payout listener refuses it).
      await this.audit.log(user, { action: 'salary_run.void', recordType: 'SalaryRun', recordId: id, summary: `Voided ${r.number}: ${reason}` }, session);
      const entries = await this.db.ledger.find({ journalId: r.journalId }, { _id: 1 }).session(session).lean();
      if (await this.db.bankMatches.exists({ ledgerEntryIds: { $in: entries.map((e) => e._id) } }).session(session)) throw new BadRequestException(`${r.number} is matched to bank statement lines; unmatch them first`);
      const reversal = await this.journals.reverseSystemJournal(user, r.journalId!, date, `Void of ${r.number}: ${reason}`, session);
      await this.db.salaryRuns.updateOne({ _id: id }, { status: 'VOID', voidedBy: user.id, voidedAt: new Date(), voidReason: reason, voidJournalId: reversal._id }, { session });
      return this.db.salaryRuns.findById(id).session(session).lean();
    });
  }

}
