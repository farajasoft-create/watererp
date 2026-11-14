import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertApprovalLimit, assertSegregation, transition } from '../../common/workflow';
import { Imprest } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl, EmailService, layout } from '../communication/email.service';
import { SmsService } from '../communication/sms.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

const DAY = 86_400_000;
/** Days between reminders about the same overdue imprest. */
const REMIND_EVERY_DAYS = 3;
/** Statuses in which an applicant still holds the advance (no new imprest until it is accounted for). */
const OPEN = ['ISSUED', 'SURRENDER_SUBMITTED'];

export const DEFAULT_IMPREST_TYPES = [
  { code: 'SAFARI', name: 'Safari imprest', description: 'Travel and subsistence for official duty away from the station', surrenderDays: 7 },
  { code: 'SPECIAL', name: 'Special imprest', description: 'A one-off activity: a meeting, an event, an urgent purchase', surrenderDays: 7 },
  { code: 'STANDING', name: 'Standing imprest', description: 'A float held for recurring small payments, accounted for monthly', surrenderDays: 30 },
];

export interface ImprestInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  typeId: Types.ObjectId;
  purpose: string;
  destination?: string;
  startDate: Date;
  endDate: Date;
  departmentId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  lines: { description: string; amount: Decimal }[];
}

export interface SurrenderInput {
  date: Date;
  lines: { date: Date; categoryId: Types.ObjectId; description: string; receiptReference?: string; amount: Decimal; departmentId?: Types.ObjectId | null; projectId?: Types.ObjectId | null }[];
  cashReturned?: Decimal | null;
  refundBankAccountId?: Types.ObjectId | null;
  refundReference?: string;
  notes?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const nextPeriod = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);

/**
 * Staff imprest: a cash advance for official work that the holder must account for. Request → approval
 * (the workflow engine) → issue from a bank or cash account (debit the staff imprest asset) → surrender with
 * receipts and any unspent cash (expenses and the cash back clear the advance; spending beyond it is owed
 * to the holder) → approval of the surrender. Imprest not surrendered on time is chased by in-app
 * notice, email and SMS, and can be recovered through payroll as a deduction on the holder's pay.
 */
export class ImprestService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly workflow: WorkflowService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
  ) {}

  // ----- Types ---------------------------------------------------------------------------------

  async types(organisationId: Types.ObjectId) {
    if (!(await this.db.imprestTypes.exists({ organisationId }))) {
      await this.db.imprestTypes.insertMany(DEFAULT_IMPREST_TYPES.map((t) => ({ ...t, organisationId }))).catch(() => undefined);
    }
    return this.db.imprestTypes.find({ organisationId }).sort({ code: 1 }).lean();
  }

  async saveType(user: AuthUser, id: Types.ObjectId | null, input: { code?: string; name?: string; description?: string; maxAmount?: Decimal | null; surrenderDays?: number; isActive?: boolean }) {
    const doc = { ...input, ...(input.code && { code: input.code.toUpperCase() }), ...(input.maxAmount !== undefined && { maxAmount: input.maxAmount ? toD128(input.maxAmount) : null }) };
    if (!id) {
      if (!input.code || !input.name) throw new BadRequestException('Code and name are required');
      if (await this.db.imprestTypes.exists({ organisationId: user.organisationId, code: doc.code })) throw new BadRequestException(`Imprest type ${doc.code} already exists`);
      const [t] = await this.db.imprestTypes.create([{ ...doc, organisationId: user.organisationId }]);
      await this.audit.log(user, { action: 'imprest.type.create', recordType: 'ImprestType', recordId: t._id, summary: `Created imprest type ${t.code}` });
      return t.toObject();
    }
    const after = await this.db.imprestTypes.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, doc, { new: true }).lean();
    if (!after) throw new NotFoundException('Imprest type not found');
    await this.audit.log(user, { action: 'imprest.type.update', recordType: 'ImprestType', recordId: id, summary: `Edited imprest type ${after.code}` });
    return after;
  }

  // ----- Requests ------------------------------------------------------------------------------

  private canSeeAll(user: AuthUser) {
    return hasPermission(user, PERMISSIONS.EXPENSES_APPROVE) || hasPermission(user, PERMISSIONS.EXPENSES_PAY);
  }

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (!this.canSeeAll(user)) filter.applicantId = user.id;
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<Imprest> {
    const doc = await this.db.imprests.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!doc) throw new NotFoundException('Imprest not found');
    return doc;
  }

  async list(user: AuthUser, q: { entityId?: Types.ObjectId; status?: string; mine?: boolean; overdue?: boolean }) {
    const filter = this.scope(user);
    if (q.entityId) filter.entityId = q.entityId;
    if (q.status) filter.status = q.status;
    if (q.mine) filter.applicantId = user.id;
    if (q.overdue) Object.assign(filter, this.overdueFilter(new Date()));
    return this.db.imprests.find(filter, { lines: 0, 'surrender.lines': 0 }).sort({ createdAt: -1 }).limit(300).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    return withTrail(this.db, await this.load(user, id));
  }

  private async build(user: AuthUser, input: ImprestInput, session: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: org, entityId: entity._id }).session(session).lean();
    if (!branch) throw new BadRequestException('Branch not found in this entity');
    assertBranchAccess(user, [branch._id]);
    const type = await this.db.imprestTypes.findOne({ _id: input.typeId, organisationId: org }).session(session).lean();
    if (!type?.isActive) throw new BadRequestException('Imprest type not found or inactive');
    if (input.endDate < input.startDate) throw new BadRequestException('The activity cannot end before it starts');
    if (!input.lines.length) throw new BadRequestException('Add at least one line to the estimate');
    const fp = await this.currencies.precision(entity.functionalCurrency);
    for (const [i, l] of input.lines.entries()) {
      if (l.amount.lte(0) || l.amount.decimalPlaces() > fp) throw new BadRequestException(`Line ${i + 1}: enter a positive amount`);
    }
    const amount = sum(input.lines.map((l) => l.amount));
    if (type.maxAmount && amount.gt(dec(type.maxAmount))) throw new BadRequestException(`${type.name} is limited to ${dec(type.maxAmount).toFixed()} ${entity.functionalCurrency}`);
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId: branch._id,
        typeId: type._id,
        typeName: type.name,
        purpose: input.purpose,
        destination: input.destination ?? '',
        startDate: input.startDate,
        endDate: input.endDate,
        departmentId: input.departmentId ?? null,
        projectId: input.projectId ?? null,
        currency: entity.functionalCurrency,
        lines: input.lines.map((l) => ({ description: l.description, amount: toD128(l.amount) })),
        amount: toD128(amount),
      },
    };
  }

  async create(user: AuthUser, input: ImprestInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'IMP', session);
      const [doc] = await this.db.imprests.create([{ ...fields, organisationId: user.organisationId, number, applicantId: user.id, applicantName: user.name, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'imprest.create', recordType: 'Imprest', recordId: doc._id, summary: `Created ${number}: ${input.purpose}`, after: doc }, session);
      return doc.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: ImprestInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (!before.applicantId.equals(user.id)) throw new ForbiddenException('Only the applicant can edit an imprest request');
      const { fields } = await this.build(user, input, session);
      const after = await transition(this.db.imprests, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT', rejectionReason: '' }, session);
      await this.audit.log(user, { action: 'imprest.update', recordType: 'Imprest', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  /** Submits for approval. Someone still holding an earlier advance cannot apply for another. */
  async submit(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      if (!doc.applicantId.equals(user.id)) throw new ForbiddenException('Only the applicant can submit an imprest request');
      const held = await this.db.imprests
        .findOne({ organisationId: user.organisationId, applicantId: doc.applicantId, _id: { $ne: doc._id }, $or: [{ status: { $in: OPEN } }, { status: 'SURRENDERED', outstanding: { $gt: toD128(new Decimal(0)) } }] }, { number: 1 })
        .session(session)
        .lean();
      if (held) throw new BadRequestException(`Surrender ${held.number} before applying for another imprest`);
      const after = await transition(this.db.imprests, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() }, session);
      await this.audit.log(user, { action: 'imprest.submit', recordType: 'Imprest', recordId: id, summary: `Submitted ${doc.number} (${dec(doc.amount).toFixed()} ${doc.currency})` }, session);
      await this.workflow.open(user, subjectOf('IMPREST', after), session);
      return after;
    });
  }

  async approve(user: AuthUser, id: Types.ObjectId, comment?: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      if (doc.status !== 'SUBMITTED') throw new BadRequestException('Only submitted imprest requests can be approved');
      assertSegregation(user, { createdBy: doc.applicantId, submittedBy: doc.submittedBy }, 'an imprest request');
      const gate = await this.workflow.gate(user, subjectOf('IMPREST', doc), comment, session);
      if (!gate.final) return { ...doc, approval: this.workflow.view(gate.request) };
      assertApprovalLimit(user, dec(doc.amount), doc.currency, 'The imprest');
      const after = await transition(this.db.imprests, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() }, session);
      await this.audit.log(user, { action: 'imprest.approve', recordType: 'Imprest', recordId: id, summary: `Approved ${doc.number}${comment ? ` — ${comment}` : ''}` }, session);
      await this.workflow.notify(user.organisationId, [doc.applicantId], { kind: 'approved', title: `Imprest ${doc.number} approved`, body: 'Finance will issue the advance.', link: `/finance/imprest?open=${doc._id}` }, session);
      return after;
    });
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const after = await transition(this.db.imprests, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: new Date(), rejectionReason: reason }, session);
      await this.audit.log(user, { action: 'imprest.reject', recordType: 'Imprest', recordId: id, summary: `Rejected ${doc.number}: ${reason}` }, session);
      await this.workflow.close(user, 'IMPREST', id, 'REJECTED', reason, session);
      return after;
    });
  }

  async cancel(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const own = doc.applicantId.equals(user.id);
      if (!own && !hasPermission(user, PERMISSIONS.EXPENSES_APPROVE)) throw new ForbiddenException('Only the applicant or an approver can cancel an imprest request');
      const after = await transition(this.db.imprests, id, ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED'], { status: 'CANCELLED', rejectionReason: reason }, session);
      if (doc.status === 'SUBMITTED') await this.workflow.close(user, 'IMPREST', id, 'CANCELLED', reason, session);
      await this.audit.log(user, { action: 'imprest.cancel', recordType: 'Imprest', recordId: id, summary: `Cancelled ${doc.number}: ${reason}` }, session);
      return after;
    });
  }

  // ----- Issue ---------------------------------------------------------------------------------

  /** The staff imprest account, created (1260, a control account under current assets) on first use. */
  private async imprestAccount(organisationId: Types.ObjectId, session: ClientSession) {
    const org = await this.db.organisations.findById(organisationId).session(session).lean();
    if (org?.settings?.imprestAccountId) return org.settings.imprestAccountId;
    let account = await this.db.accounts.findOne({ organisationId, code: '1260' }).session(session).lean();
    if (!account) {
      const parent = await this.db.accounts.findOne({ organisationId, code: '1100' }).session(session).lean();
      [account] = await this.db.accounts.create([{ organisationId, code: '1260', name: 'Staff Imprest', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parentId: parent?._id ?? null, isControl: true, allowManualPosting: false }], { session });
    }
    await this.db.organisations.updateOne({ _id: organisationId }, { 'settings.imprestAccountId': account._id }, { session });
    return account._id;
  }

  private async claimsAccount(organisationId: Types.ObjectId, session: ClientSession) {
    const org = await this.db.organisations.findById(organisationId).session(session).lean();
    const id = org?.settings?.employeeClaimsAccountId;
    if (!id) throw new BadRequestException('Set the employee claims payable account in organisation settings first');
    return id;
  }

  private async bank(user: AuthUser, entityId: Types.ObjectId, id: Types.ObjectId, currency: string, session: ClientSession) {
    const bank = await this.db.bankAccounts.findOne({ _id: id, organisationId: user.organisationId, entityId }).session(session).lean();
    if (!bank?.isActive) throw new BadRequestException('Bank or cash account not found in this entity');
    if (bank.currency !== currency) throw new BadRequestException(`Use a ${currency} bank or cash account`);
    return bank;
  }

  /** Pays the advance out: debit staff imprest, credit the bank or cash account. Sets the surrender date. */
  async issue(user: AuthUser, id: Types.ObjectId, input: { date: Date; bankAccountId: Types.ObjectId; reference?: string }) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      if (doc.status !== 'APPROVED') throw new BadRequestException('Only approved imprest can be issued');
      const bank = await this.bank(user, doc.entityId, input.bankAccountId, doc.currency, session);
      const account = await this.imprestAccount(user.organisationId, session);
      const type = await this.db.imprestTypes.findById(doc.typeId).session(session).lean();
      const from = input.date > doc.endDate ? input.date : doc.endDate;
      const surrenderDue = new Date(from.getTime() + (type?.surrenderDays ?? 7) * DAY);
      const amount = dec(doc.amount);
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: doc.entityId,
          branchId: doc.branchId,
          journalDate: input.date,
          description: `Imprest ${doc.number} issued to ${doc.applicantName}: ${doc.purpose}`,
          reference: input.reference || doc.number,
          lines: [
            { accountId: account, currency: doc.currency, debit: amount, departmentId: doc.departmentId, projectId: doc.projectId, description: `${doc.number} · ${doc.applicantName}` },
            { accountId: bank.glAccountId, branchId: bank.branchId, currency: doc.currency, credit: amount, description: `Imprest ${doc.number} · ${doc.applicantName}` },
          ],
        },
        { sourceType: 'Imprest', sourceId: doc._id, sourceNumber: doc.number },
        session,
      );
      const after = await transition(
        this.db.imprests,
        id,
        ['APPROVED'],
        { status: 'ISSUED', surrenderDue, outstanding: toD128(amount), issue: { date: input.date, bankAccountId: bank._id, reference: input.reference ?? '', journalId: journal._id, issuedBy: user.id } },
        session,
      );
      await this.audit.log(user, { action: 'imprest.issue', recordType: 'Imprest', recordId: id, summary: `Issued ${doc.number} from ${bank.name} (${journal.number}); surrender by ${iso(surrenderDue)}` }, session);
      await this.workflow.notify(user.organisationId, [doc.applicantId], { kind: 'imprest', title: `Imprest ${doc.number} issued`, body: `Surrender it with receipts by ${iso(surrenderDue)}.`, link: `/finance/imprest?open=${doc._id}` }, session);
      return after;
    });
  }

  // ----- Surrender -----------------------------------------------------------------------------

  async submitSurrender(user: AuthUser, id: Types.ObjectId, input: SurrenderInput) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      if (!doc.applicantId.equals(user.id)) throw new ForbiddenException('Only the imprest holder can surrender it');
      if (doc.status !== 'ISSUED') throw new BadRequestException('Only issued imprest can be surrendered');
      const fp = await this.currencies.precision(doc.currency);
      const categories = await this.db.expenseCategories.find({ organisationId: user.organisationId, _id: { $in: input.lines.map((l) => l.categoryId) } }).session(session).lean();
      const lines = input.lines.map((l, i) => {
        const tag = `Line ${i + 1}`;
        const category = categories.find((c) => c._id.equals(l.categoryId));
        if (!category?.isActive) throw new BadRequestException(`${tag}: expense category not found or inactive`);
        if (l.amount.lte(0) || l.amount.decimalPlaces() > fp) throw new BadRequestException(`${tag}: enter a positive amount`);
        if (category.requiresReceipt && !l.receiptReference?.trim()) throw new BadRequestException(`${tag}: ${category.name} needs a receipt reference`);
        return { lineNo: i + 1, date: l.date, categoryId: category._id, accountId: category.accountId, description: l.description, receiptReference: l.receiptReference ?? '', amount: toD128(l.amount), departmentId: l.departmentId ?? doc.departmentId ?? null, projectId: l.projectId ?? doc.projectId ?? null };
      });
      const spent = sum(lines.map((l) => dec(l.amount)));
      const cash = input.cashReturned ?? new Decimal(0);
      if (cash.lt(0) || cash.decimalPlaces() > fp) throw new BadRequestException('Cash returned must be zero or more');
      if (cash.gt(0)) {
        if (!input.refundBankAccountId) throw new BadRequestException('Say which bank or cash account the unspent cash was paid into');
        await this.bank(user, doc.entityId, input.refundBankAccountId, doc.currency, session);
      }
      if (spent.plus(cash).isZero()) throw new BadRequestException('Account for the imprest: add what was spent or the cash returned');
      const surrender = {
        date: input.date,
        lines,
        spent: toD128(spent),
        cashReturned: toD128(cash),
        refundBankAccountId: cash.gt(0) ? input.refundBankAccountId : null,
        refundReference: input.refundReference ?? '',
        notes: input.notes ?? '',
        submittedBy: user.id,
        submittedAt: new Date(),
        approvedBy: null,
        approvedAt: null,
        rejectionReason: '',
        journalId: null,
      };
      const after = await transition(this.db.imprests, id, ['ISSUED'], { status: 'SURRENDER_SUBMITTED', surrender }, session);
      await this.audit.log(user, { action: 'imprest.surrender', recordType: 'Imprest', recordId: id, summary: `Surrendered ${doc.number}: spent ${spent.toFixed()}, returned ${cash.toFixed()} ${doc.currency}` }, session);
      await this.workflow.open(user, subjectOf('IMPREST_SURRENDER', after), session);
      return after;
    });
  }

  async rejectSurrender(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const after = await transition(this.db.imprests, id, ['SURRENDER_SUBMITTED'], { status: 'ISSUED', 'surrender.rejectionReason': reason }, session);
      await this.audit.log(user, { action: 'imprest.surrender.reject', recordType: 'Imprest', recordId: id, summary: `Returned the surrender of ${doc.number}: ${reason}` }, session);
      await this.workflow.close(user, 'IMPREST_SURRENDER', id, 'REJECTED', reason, session);
      return after;
    });
  }

  /**
   * Posts the surrender: expenses and the cash paid back clear the advance. A shortfall stays outstanding
   * (to be recovered); spending beyond the advance is owed to the holder through employee claims payable.
   */
  async approveSurrender(user: AuthUser, id: Types.ObjectId, comment?: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const surrender = doc.surrender;
      if (doc.status !== 'SURRENDER_SUBMITTED' || !surrender) throw new BadRequestException('There is no surrender waiting for approval');
      assertSegregation(user, { createdBy: doc.applicantId, submittedBy: surrender.submittedBy }, 'an imprest surrender');
      const gate = await this.workflow.gate(user, subjectOf('IMPREST_SURRENDER', doc), comment, session);
      if (!gate.final) return { ...doc, approval: this.workflow.view(gate.request) };
      const account = await this.imprestAccount(user.organisationId, session);
      const spent = dec(surrender.spent);
      const cash = dec(surrender.cashReturned ?? 0);
      const outstanding = dec(doc.outstanding ?? doc.amount);
      const accounted = spent.plus(cash);
      const cleared = Decimal.min(accounted, outstanding);
      const excess = accounted.minus(cleared);
      const lines: LineInput[] = surrender.lines.map((l) => ({ accountId: l.accountId, currency: doc.currency, debit: dec(l.amount), departmentId: l.departmentId, projectId: l.projectId, description: `${doc.applicantName}: ${l.description}` }));
      if (cash.gt(0)) {
        const bank = await this.bank(user, doc.entityId, surrender.refundBankAccountId!, doc.currency, session);
        lines.push({ accountId: bank.glAccountId, branchId: bank.branchId, currency: doc.currency, debit: cash, description: `Unspent imprest returned · ${doc.number}` });
      }
      if (cleared.gt(0)) lines.push({ accountId: account, currency: doc.currency, credit: cleared, description: `${doc.number} accounted for` });
      if (excess.gt(0)) lines.push({ accountId: await this.claimsAccount(user.organisationId, session), currency: doc.currency, credit: excess, description: `${doc.number} spent beyond the advance, due to ${doc.applicantName}` });
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: doc.entityId, branchId: doc.branchId, journalDate: surrender.date!, description: `Surrender of imprest ${doc.number}: ${doc.purpose}`, reference: surrender.refundReference || doc.number, lines },
        { sourceType: 'Imprest', sourceId: doc._id, sourceNumber: doc.number },
        session,
      );
      const left = outstanding.minus(cleared);
      const after = await transition(
        this.db.imprests,
        id,
        ['SURRENDER_SUBMITTED'],
        { status: 'SURRENDERED', outstanding: toD128(left), owedToApplicant: excess.gt(0) ? toD128(excess) : null, 'surrender.approvedBy': user.id, 'surrender.approvedAt': new Date(), 'surrender.journalId': journal._id },
        session,
      );
      await this.audit.log(user, { action: 'imprest.surrender.approve', recordType: 'Imprest', recordId: id, summary: `Approved the surrender of ${doc.number} (${journal.number})${left.gt(0) ? `; ${left.toFixed()} ${doc.currency} still unaccounted for` : ''}${excess.gt(0) ? `; ${excess.toFixed()} ${doc.currency} due to the holder` : ''}` }, session);
      await this.workflow.notify(user.organisationId, [doc.applicantId], { kind: 'approved', title: `Surrender of imprest ${doc.number} approved`, body: left.gt(0) ? `${left.toFixed()} ${doc.currency} is still unaccounted for.` : undefined, link: `/finance/imprest?open=${doc._id}` }, session);
      return after;
    });
  }

  /** Pays the holder what they spent beyond the advance. */
  async payBalance(user: AuthUser, id: Types.ObjectId, input: { date: Date; bankAccountId: Types.ObjectId }) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const owed = dec(doc.owedToApplicant ?? 0);
      if (doc.status !== 'SURRENDERED' || owed.lte(0) || doc.balancePayment?.journalId) throw new BadRequestException('Nothing is owed to the holder on this imprest');
      const bank = await this.bank(user, doc.entityId, input.bankAccountId, doc.currency, session);
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: doc.entityId,
          branchId: doc.branchId,
          journalDate: input.date,
          description: `Imprest ${doc.number}: overspend paid to ${doc.applicantName}`,
          reference: doc.number,
          lines: [
            { accountId: await this.claimsAccount(user.organisationId, session), currency: doc.currency, debit: owed, description: `${doc.number} overspend paid` },
            { accountId: bank.glAccountId, branchId: bank.branchId, currency: doc.currency, credit: owed, description: `Imprest ${doc.number} overspend · ${doc.applicantName}` },
          ],
        },
        { sourceType: 'Imprest', sourceId: doc._id, sourceNumber: doc.number },
        session,
      );
      const after = await transition(this.db.imprests, id, ['SURRENDERED'], { balancePayment: { date: input.date, bankAccountId: bank._id, journalId: journal._id } }, session);
      await this.audit.log(user, { action: 'imprest.balance.pay', recordType: 'Imprest', recordId: id, summary: `Paid ${owed.toFixed()} ${doc.currency} overspend on ${doc.number} (${journal.number})` }, session);
      return after;
    });
  }

  // ----- Overdue: reminders and recovery -------------------------------------------------------

  private overdueFilter(now: Date) {
    return { $or: [{ status: 'ISSUED', surrenderDue: { $lt: now } }, { status: 'SURRENDERED', outstanding: { $gt: toD128(new Decimal(0)) } }] };
  }

  /**
   * Reminds holders of overdue imprest (in-app, email and, when SMS is on, a text), at most every few
   * days, and tells the people who issue imprest. Run by the daily job.
   */
  async remindOverdue(now = new Date(), opts: { organisationId?: Types.ObjectId } = {}) {
    const due = await this.db.imprests
      .find({ ...(opts.organisationId && { organisationId: opts.organisationId }), ...this.overdueFilter(now), $and: [{ $or: [{ 'reminders.lastAt': null }, { 'reminders.lastAt': { $lt: new Date(now.getTime() - REMIND_EVERY_DAYS * DAY) } }] }] })
      .limit(500)
      .lean();
    let reminded = 0;
    for (const doc of due) {
      const days = doc.surrenderDue ? Math.max(0, Math.floor((now.getTime() - doc.surrenderDue.getTime()) / DAY)) : 0;
      const left = dec(doc.outstanding ?? doc.amount);
      const title = `Imprest ${doc.number} is overdue`;
      const body = `${left.toFixed(2)} ${doc.currency} for "${doc.purpose}" was due for surrender on ${doc.surrenderDue ? iso(doc.surrenderDue) : '—'}${days ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ''}. Unaccounted imprest is recovered from salary.`;
      const link = `/finance/imprest?open=${doc._id}`;
      await this.db.transaction(async (session) => {
        const claimed = await this.db.imprests.updateOne({ _id: doc._id, 'reminders.lastAt': doc.reminders?.lastAt ?? null }, { $set: { 'reminders.lastAt': now }, $inc: { 'reminders.count': 1 } }, { session });
        if (!claimed.modifiedCount) return;
        await this.workflow.notify(doc.organisationId, [doc.applicantId], { kind: 'imprest', title, body, link }, session);
        const holder = await this.db.users.findOne({ _id: doc.applicantId, organisationId: doc.organisationId, isActive: true }, { email: 1, name: 1, phone: 1 }).session(session).lean();
        if (holder) {
          const mail = layout({ title, intro: `Hello ${holder.name},`, paragraphs: [body, 'Surrender it with your receipts, or pay back what was not spent, as soon as possible.'], action: { label: 'Surrender the imprest', url: `${appUrl()}${link}` } });
          await this.email.enqueue({ organisationId: doc.organisationId, to: [holder.email], subject: title, ...mail, category: 'reminder', related: { type: 'Imprest', id: doc._id } }, session);
          if (holder.phone) await this.sms.enqueue({ organisationId: doc.organisationId, to: holder.phone, message: `${title}: ${left.toFixed(2)} ${doc.currency} was due on ${doc.surrenderDue ? iso(doc.surrenderDue) : '—'}. Please surrender it.`, category: 'reminder', related: { type: 'Imprest', id: doc._id } }, { optional: true, session });
        }
        if (doc.issue?.issuedBy && (doc.reminders?.count ?? 0) === 0) {
          await this.workflow.notify(doc.organisationId, [doc.issue.issuedBy], { kind: 'imprest', title: `${doc.applicantName} has not surrendered ${doc.number}`, body, link }, session);
        }
        reminded++;
      });
    }
    return { overdue: due.length, reminded };
  }

  /**
   * Sends unaccounted imprest to payroll: a deduction on the holder's pay (in instalments if asked) that
   * stops when the balance is recovered. The advance moves from staff imprest to the payroll deductions
   * account, which the payroll's deduction then clears.
   */
  async recover(user: AuthUser, id: Types.ObjectId, input: { date: Date; fromPeriod?: string; installment?: Decimal | null }) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const left = dec(doc.outstanding ?? 0);
      const overdue = doc.status === 'ISSUED' && doc.surrenderDue && doc.surrenderDue < input.date;
      if (!(overdue || doc.status === 'SURRENDERED') || left.lte(0)) throw new BadRequestException('Only overdue or partly accounted-for imprest with a balance can be recovered from salary');
      const conn = this.db.connection;
      const employee = await conn.collection('hr_employees').findOne({ organisationId: user.organisationId, userId: doc.applicantId, status: { $ne: 'TERMINATED' } }, { session });
      if (!employee) throw new BadRequestException(`${doc.applicantName} has no active employee record linked to their sign-in, so the imprest cannot go to payroll`);
      const hr = await conn.collection('hr_settings').findOne({ organisationId: user.organisationId }, { session });
      const deductions = (hr?.accounts as Record<string, string> | undefined)?.otherDeductions;
      if (!deductions || !Types.ObjectId.isValid(deductions)) throw new BadRequestException('Set the "Other staff deductions payable" account under HR settings → Ledger accounts first');
      const installment = input.installment && input.installment.gt(0) ? Decimal.min(input.installment, left) : left;
      const fromPeriod = input.fromPeriod ?? nextPeriod(input.date);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromPeriod)) throw new BadRequestException('The first payroll month must look like 2026-12');
      const now = new Date();
      const item = await conn.collection('hr_pay_items').insertOne(
        {
          organisationId: user.organisationId,
          employeeId: employee._id,
          kind: 'DEDUCTION',
          code: 'IMPREST',
          name: `Imprest recovery ${doc.number}`,
          amount: toD128(installment),
          taxable: true,
          pension: false,
          balance: toD128(left),
          fromPeriod,
          toPeriod: null,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      const account = await this.imprestAccount(user.organisationId, session);
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: doc.entityId,
          branchId: doc.branchId,
          journalDate: input.date,
          description: `Imprest ${doc.number} to be recovered from ${doc.applicantName}'s salary`,
          reference: doc.number,
          lines: [
            { accountId: new Types.ObjectId(deductions), currency: doc.currency, debit: left, description: `${doc.number} recoverable through payroll from ${fromPeriod}` },
            { accountId: account, currency: doc.currency, credit: left, description: `${doc.number} sent to payroll` },
          ],
        },
        { sourceType: 'Imprest', sourceId: doc._id, sourceNumber: doc.number },
        session,
      );
      const after = await transition(
        this.db.imprests,
        id,
        [doc.status],
        { status: 'RECOVERING', outstanding: toD128(new Decimal(0)), recovery: { employeeId: employee._id, payItemId: item.insertedId, fromPeriod, installment: toD128(installment), amount: toD128(left), journalId: journal._id, by: user.id, at: now } },
        session,
      );
      if (doc.status === 'ISSUED') await this.db.approvalRequests.updateMany({ organisationId: user.organisationId, documentType: 'IMPREST_SURRENDER', documentId: doc._id, status: 'PENDING' }, { status: 'CANCELLED' }, { session });
      await this.audit.log(user, { action: 'imprest.recover', recordType: 'Imprest', recordId: id, summary: `Sent ${left.toFixed()} ${doc.currency} of ${doc.number} to payroll from ${fromPeriod} at ${installment.toFixed()} a month (${journal.number})` }, session);
      await this.workflow.notify(user.organisationId, [doc.applicantId], { kind: 'imprest', title: `Imprest ${doc.number} will be recovered from your salary`, body: `${left.toFixed(2)} ${doc.currency} from the ${fromPeriod} payroll, ${installment.toFixed(2)} a month.`, link: `/finance/imprest?open=${doc._id}` }, session);
      return after;
    });
  }

  /** Who holds what: outstanding imprest by holder, with how overdue it is. */
  async outstandingReport(user: AuthUser, entityId: Types.ObjectId, now = new Date()) {
    const rows = await this.db.imprests
      .find({ ...this.scope(user), entityId, $or: [{ status: { $in: OPEN } }, { status: 'SURRENDERED', outstanding: { $gt: toD128(new Decimal(0)) } }] }, { lines: 0, 'surrender.lines': 0 })
      .sort({ surrenderDue: 1 })
      .lean();
    return rows.map((r) => ({
      id: r._id,
      number: r.number,
      applicantName: r.applicantName,
      typeName: r.typeName,
      purpose: r.purpose,
      status: r.status,
      issuedOn: r.issue?.date ?? null,
      surrenderDue: r.surrenderDue,
      outstanding: r.outstanding ?? r.amount,
      daysOverdue: r.surrenderDue && r.surrenderDue < now ? Math.floor((now.getTime() - r.surrenderDue.getTime()) / DAY) : 0,
      reminders: r.reminders?.count ?? 0,
    }));
  }
}
