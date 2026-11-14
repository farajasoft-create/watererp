import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertApprovalLimit, assertSegregation, transition } from '../../common/workflow';
import { ExpenseClaim } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { TaxService } from '../tax/tax.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface ClaimInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  title: string;
  lines: {
    date: Date;
    categoryId: Types.ObjectId;
    description: string;
    merchant?: string;
    receiptReference?: string;
    /** Functional-currency amount; worked out from the original when spent in another currency. */
    amount?: Decimal | null;
    /** Spent in another currency: its code, the receipt amount, and optionally the rate actually paid. */
    currency?: string | null;
    originalAmount?: Decimal | null;
    exchangeRate?: Decimal | null;
    taxCodeId?: Types.ObjectId | null;
    departmentId?: Types.ObjectId | null;
    projectId?: Types.ObjectId | null;
  }[];
}

/**
 * Employee expense claims: the claimant prepares and submits, a manager approves (policy breaches
 * are flagged and need a reason), approval posts the expense against the employee claims liability,
 * and reimbursement pays it from a bank account.
 */
export class ExpensesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly tax: TaxService,
    private readonly workflow: WorkflowService,
  ) {}

  private canSeeAll(user: AuthUser) {
    return hasPermission(user, PERMISSIONS.EXPENSES_APPROVE) || hasPermission(user, PERMISSIONS.EXPENSES_PAY);
  }

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (!this.canSeeAll(user)) filter.claimantId = user.id;
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<ExpenseClaim> {
    const c = await this.db.expenseClaims.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!c) throw new NotFoundException('Expense claim not found');
    return c;
  }

  private async build(user: AuthUser, input: ClaimInput, session?: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: org, entityId: entity._id }).session(session ?? null).lean();
    if (!branch) throw new BadRequestException('Branch not found in this entity');
    assertBranchAccess(user, [branch._id]);
    if (!input.lines.length) throw new BadRequestException('Add at least one expense');
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const categories = await this.db.expenseCategories.find({ organisationId: org, _id: { $in: input.lines.map((l) => l.categoryId) } }).session(session ?? null).lean();
    const taxCodes = await this.tax.codes(org, input.lines.map((l) => l.taxCodeId), session);
    let breaches = 0;
    // Lines spent in another currency are converted at the rate entered (e.g. the card rate) or the day's rate.
    const converted: { amount: Decimal; currency: string | null; originalAmount: Decimal | null; rate: Decimal | null; note?: string }[] = [];
    for (const [i, l] of input.lines.entries()) {
      const tag = `Line ${i + 1}`;
      if (l.currency && l.currency !== entity.functionalCurrency) {
        if (!l.originalAmount?.gt(0)) throw new BadRequestException(`${tag}: enter the amount on the ${l.currency} receipt`);
        const op = await this.currencies.precision(l.currency);
        if (l.originalAmount.decimalPlaces() > op) throw new BadRequestException(`${tag}: ${l.currency} allows at most ${op} decimal places`);
        let rate = l.exchangeRate ?? null;
        if (rate && rate.lte(0)) throw new BadRequestException(`${tag}: the exchange rate must be positive`);
        const reference = await this.currencies.findRate(org, l.currency, entity.functionalCurrency, l.date, 'SPOT', session);
        let note: string | undefined;
        if (!rate) {
          if (!reference) throw new BadRequestException(`${tag}: no approved ${l.currency}/${entity.functionalCurrency} rate on or before ${l.date.toISOString().slice(0, 10)}; enter the rate you paid`);
          rate = reference.rate;
        } else if (!reference) {
          note = `Rate ${rate.toFixed()} entered with no approved ${l.currency} rate to check it against`;
        } else {
          // Card and bureau rates differ a little from the day's rate; more than 3% needs the approver's reason.
          const gap = rate.minus(reference.rate).div(reference.rate).times(100);
          if (gap.abs().gt(3)) note = `Rate ${rate.toFixed()} is ${gap.abs().toFixed(1)}% ${gap.isNeg() ? 'below' : 'above'} the day's rate of ${reference.rate.toFixed()}`;
        }
        converted.push({ amount: round(l.originalAmount.times(rate), fp), currency: l.currency, originalAmount: l.originalAmount, rate, note });
      } else {
        if (!l.amount) throw new BadRequestException(`${tag}: enter the amount`);
        converted.push({ amount: l.amount, currency: null, originalAmount: null, rate: null });
      }
    }
    const lines = input.lines.map((input, i) => {
      const tag = `Line ${i + 1}`;
      const l = { ...input, amount: converted[i].amount };
      const category = categories.find((c) => c._id.equals(l.categoryId));
      if (!category?.isActive) throw new BadRequestException(`${tag}: expense category not found or inactive`);
      if (l.amount.lte(0) || l.amount.decimalPlaces() > fp) throw new BadRequestException(`${tag}: enter a positive amount`);
      const taxCodeId = l.taxCodeId === undefined ? category.taxCodeId : l.taxCodeId;
      let taxAmount = new Decimal(0);
      if (taxCodeId) {
        const code = this.tax.assertUsable(taxCodes.get(taxCodeId.toHexString()) ?? undefined, entity.country, 'VAT', tag);
        const rate = this.tax.rateOn(code, l.date);
        // Claimed amounts include tax; recoverable input tax is backed out.
        taxAmount = code.inputAccountId ? l.amount.minus(round(l.amount.times(100).div(new Decimal(100).plus(rate)), fp)) : new Decimal(0);
      }
      const notes: string[] = [];
      if (category.limitPerLine && l.amount.gt(dec(category.limitPerLine))) notes.push(`Above the ${category.name} limit of ${dec(category.limitPerLine).toFixed()}`);
      if (category.requiresReceipt && !l.receiptReference?.trim()) notes.push('Receipt reference missing');
      if (l.date > new Date()) notes.push('Dated in the future');
      if (converted[i].note) notes.push(converted[i].note!);
      breaches += notes.length;
      return {
        lineNo: i + 1,
        date: l.date,
        categoryId: category._id,
        accountId: category.accountId,
        description: l.description,
        merchant: l.merchant ?? '',
        receiptReference: l.receiptReference ?? '',
        amount: toD128(l.amount),
        currency: converted[i].currency,
        originalAmount: converted[i].originalAmount ? toD128(converted[i].originalAmount!) : null,
        exchangeRate: converted[i].rate ? toD128(converted[i].rate!) : null,
        taxCodeId: taxCodeId ?? null,
        taxAmount: toD128(taxAmount),
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        policyNotes: notes,
      };
    });
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId: branch._id,
        title: input.title,
        currency: entity.functionalCurrency,
        lines,
        total: toD128(sum(lines.map((l) => l.amount))),
        policyBreaches: breaches,
      },
    };
  }

  async list(user: AuthUser, q: { entityId?: Types.ObjectId; status?: string; mine?: boolean }) {
    const filter = this.scope(user);
    if (q.entityId) filter.entityId = q.entityId;
    if (q.status) filter.status = q.status;
    if (q.mine) filter.claimantId = user.id;
    return this.db.expenseClaims.find(filter, { lines: 0 }).sort({ createdAt: -1 }).limit(300).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    return withTrail(this.db, await this.load(user, id));
  }

  async create(user: AuthUser, input: ClaimInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'EXP', session);
      const [claim] = await this.db.expenseClaims.create([{ ...fields, organisationId: user.organisationId, number, claimantId: user.id, claimantName: user.name, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'expense.create', recordType: 'ExpenseClaim', recordId: claim._id, summary: `Created ${number}: ${input.title}`, after: claim }, session);
      return claim.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: ClaimInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (!before.claimantId.equals(user.id)) throw new ForbiddenException('Only the claimant can edit a claim');
      if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or rejected claims can be edited');
      const { fields } = await this.build(user, input, session);
      const after = await transition(this.db.expenseClaims, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT', rejectionReason: '' }, session);
      await this.audit.log(user, { action: 'expense.update', recordType: 'ExpenseClaim', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async submit(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const c = await this.load(user, id, session);
      if (!c.claimantId.equals(user.id)) throw new ForbiddenException('Only the claimant can submit a claim');
      const after = await transition(this.db.expenseClaims, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() }, session);
      await this.audit.log(user, { action: 'expense.submit', recordType: 'ExpenseClaim', recordId: id, summary: `Submitted ${c.number} (${dec(c.total).toFixed()} ${c.currency})` }, session);
      await this.workflow.open(user, subjectOf('EXPENSE_CLAIM', after), session);
      return after;
    });
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const c = await this.load(user, id, session);
      const after = await transition(this.db.expenseClaims, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: new Date(), rejectionReason: reason }, session);
      await this.audit.log(user, { action: 'expense.reject', recordType: 'ExpenseClaim', recordId: id, summary: `Rejected ${c.number}: ${reason}` }, session);
      await this.workflow.close(user, 'EXPENSE_CLAIM', id, 'REJECTED', reason, session);
      return after;
    });
  }

  private async claimsAccount(organisationId: Types.ObjectId, session: ClientSession) {
    const org = await this.db.organisations.findById(organisationId).session(session).lean();
    const id = org?.settings?.employeeClaimsAccountId;
    if (!id) throw new BadRequestException('Set the employee claims payable account in organisation settings first');
    return id;
  }

  /** Approves a claim and posts it: expenses (and recoverable VAT) against the employee claims liability. */
  async approve(user: AuthUser, id: Types.ObjectId, comment?: string) {
    return this.db.transaction(async (session) => {
      const c = await this.load(user, id, session);
      if (c.status !== 'SUBMITTED') throw new BadRequestException('Only submitted claims can be approved');
      assertSegregation(user, { createdBy: c.claimantId, submittedBy: c.submittedBy }, 'an expense claim');
      if (c.policyBreaches > 0 && !comment?.trim()) throw new BadRequestException(`This claim has ${c.policyBreaches} policy exception(s); give a reason to approve it`);
      const gate = await this.workflow.gate(user, subjectOf('EXPENSE_CLAIM', c), comment, session);
      if (!gate.final) return { ...c, approval: this.workflow.view(gate.request) };
      assertApprovalLimit(user, dec(c.total), c.currency, 'The claim');
      const liability = await this.claimsAccount(user.organisationId, session);
      const taxCodes = await this.tax.codes(user.organisationId, c.lines.map((l) => l.taxCodeId), session);
      const lines: LineInput[] = [];
      for (const l of c.lines) {
        const tax = dec(l.taxAmount);
        lines.push({ accountId: l.accountId, currency: c.currency, debit: dec(l.amount).minus(tax), departmentId: l.departmentId, projectId: l.projectId, description: `${c.claimantName}: ${l.description}` });
        if (tax.gt(0)) lines.push({ accountId: taxCodes.get(l.taxCodeId!.toHexString())!.inputAccountId!, currency: c.currency, debit: tax, description: `Input tax on ${c.number}` });
      }
      lines.push({ accountId: liability, currency: c.currency, credit: dec(c.total), description: `${c.number} due to ${c.claimantName}` });
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: c.entityId, branchId: c.branchId, journalDate: c.lines.reduce((d, l) => (l.date > d ? l.date : d), c.lines[0].date), description: `Expense claim ${c.number}: ${c.title}`, reference: c.number, lines },
        { sourceType: 'ExpenseClaim', sourceId: c._id, sourceNumber: c.number },
        session,
      );
      const after = await transition(this.db.expenseClaims, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date(), journalId: journal._id }, session);
      await this.audit.log(user, { action: 'expense.approve', recordType: 'ExpenseClaim', recordId: id, summary: `Approved ${c.number} (${journal.number})${comment ? ` — ${comment}` : ''}` }, session);
      return after;
    });
  }

  /** Reimburses an approved claim from a bank or cash account. */
  async pay(user: AuthUser, id: Types.ObjectId, input: { date: Date; bankAccountId: Types.ObjectId; reference?: string }) {
    return this.db.transaction(async (session) => {
      const c = await this.load(user, id, session);
      if (c.status !== 'APPROVED') throw new BadRequestException('Only approved claims can be reimbursed');
      const bank = await this.db.bankAccounts.findOne({ _id: input.bankAccountId, organisationId: user.organisationId, entityId: c.entityId }).session(session).lean();
      if (!bank?.isActive) throw new BadRequestException('Bank account not found in this entity');
      const liability = await this.claimsAccount(user.organisationId, session);
      // From an account in another currency the claimant gets the equivalent at the payment date's rate;
      // the claim (in functional currency) is cleared in full.
      let paid: { currency: string; amount: Decimal; rate: Decimal } | null = null;
      if (bank.currency !== c.currency) {
        const found = await this.currencies.findRate(user.organisationId, bank.currency, c.currency, input.date, 'SPOT', session);
        if (!found) throw new BadRequestException(`No approved ${bank.currency}/${c.currency} rate on or before ${input.date.toISOString().slice(0, 10)}`);
        const bp = await this.currencies.precision(bank.currency);
        paid = { currency: bank.currency, amount: round(dec(c.total).div(found.rate), bp), rate: found.rate };
      }
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: c.entityId,
          branchId: c.branchId,
          journalDate: input.date,
          description: `Reimbursement of ${c.number} to ${c.claimantName}`,
          reference: input.reference,
          lines: [
            { accountId: liability, currency: c.currency, debit: dec(c.total), description: `${c.number} reimbursed` },
            paid
              ? { accountId: bank.glAccountId, branchId: bank.branchId, currency: paid.currency, exchangeRate: paid.rate, credit: paid.amount, functionalDebit: new Decimal(0), functionalCredit: dec(c.total), description: `Reimbursement ${c.number} · ${c.claimantName} (${paid.currency} ${paid.amount.toFixed()})` }
              : { accountId: bank.glAccountId, branchId: bank.branchId, currency: c.currency, credit: dec(c.total), description: `Reimbursement ${c.number} · ${c.claimantName}` },
          ],
        },
        { sourceType: 'ExpenseClaim', sourceId: c._id, sourceNumber: c.number },
        session,
      );
      const after = await transition(
        this.db.expenseClaims,
        id,
        ['APPROVED'],
        {
          status: 'PAID',
          payment: { date: input.date, bankAccountId: bank._id, reference: input.reference ?? '', journalId: journal._id, paidBy: user.id, currency: paid?.currency ?? null, amount: paid ? toD128(paid.amount) : null, exchangeRate: paid ? toD128(paid.rate) : null },
        },
        session,
      );
      await this.audit.log(user, { action: 'expense.pay', recordType: 'ExpenseClaim', recordId: id, summary: `Reimbursed ${c.number} from ${bank.name} (${journal.number})` }, session);
      return after;
    });
  }
}
