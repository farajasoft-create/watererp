import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertSegregation, transition } from '../../common/workflow';
import { Investment, INVESTMENT_TYPES } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService } from '../journals/journals.service';
import { addDays, ledgerSums } from '../reports/ledger-sums';
import { WorkflowService } from '../workflow/workflow.service';

type Id = Types.ObjectId;
const DAY = 86_400_000;
const days = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY));

export interface InvestmentInput {
  entityId: Id;
  type: (typeof INVESTMENT_TYPES)[number];
  institution: string;
  reference?: string;
  description?: string;
  principal: Decimal;
  ratePercent: Decimal;
  dayCount: 'ACT_365' | 'ACT_360';
  startDate: Date;
  maturityDate: Date;
  withholdingPercent: Decimal;
  bankAccountId: Id;
  investmentAccountId: Id;
  interestIncomeAccountId: Id;
  interestReceivableAccountId: Id;
  withholdingAccountId?: Id | null;
}

export interface SettleInput {
  date: Date;
  bankAccountId?: Id;
  /** Interest actually paid by the institution; defaults to the interest calculated to the date. */
  interest?: Decimal;
  rollover?: { maturityDate: Date; ratePercent?: Decimal; reinvestInterest: boolean } | null;
}

/**
 * Treasury: short-term investments (fixed and call deposits, treasury bills and bonds, money market
 * funds) placed from a bank account, with simple interest accrued to the ledger, settlement with
 * withholding tax on interest, rollover into a new placement, maturity reminders and a treasury report
 * of cash and investments for a day, week or month.
 */
export class InvestmentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Simple interest on the principal between two dates. */
  static interest(inv: { principal: unknown; ratePercent: unknown; dayCount: string }, from: Date, to: Date, places: number) {
    const basis = inv.dayCount === 'ACT_360' ? 360 : 365;
    return round(dec(inv.principal as never).times(dec(inv.ratePercent as never)).div(100).times(days(from, to)).div(basis), places);
  }

  list(user: AuthUser, q: { entityId: Id; status?: string }) {
    return this.db.investments.find({ organisationId: user.organisationId, entityId: q.entityId, ...(q.status && { status: q.status }) }).sort({ maturityDate: 1 }).limit(1000).lean();
  }

  async get(user: AuthUser, id: Id) {
    const inv = await this.db.investments.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!inv) throw new NotFoundException('Investment not found');
    const fp = await this.precisionOf(inv.entityId);
    const today = new Date();
    return {
      ...(await withTrail(this.db, inv)),
      termInterest: InvestmentsService.interest(inv, inv.startDate, inv.maturityDate, fp),
      interestToDate: inv.status === 'ACTIVE' ? InvestmentsService.interest(inv, inv.startDate, today < inv.maturityDate ? today : inv.maturityDate, fp) : null,
    };
  }

  private async precisionOf(entityId: Id) {
    const entity = (await this.db.entities.findById(entityId).lean())!;
    return this.currencies.precision(entity.functionalCurrency);
  }

  private async validate(user: AuthUser, input: InvestmentInput, session?: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    if (!input.principal.gt(0)) throw new BadRequestException('Enter the amount invested');
    if (input.ratePercent.lt(0) || input.ratePercent.gt(100)) throw new BadRequestException('Enter the annual interest rate as a percentage');
    if (input.withholdingPercent.lt(0) || input.withholdingPercent.gt(100)) throw new BadRequestException('Withholding tax is a percentage between 0 and 100');
    if (input.maturityDate <= input.startDate) throw new BadRequestException('The maturity date must be after the start date');
    const bank = await this.db.bankAccounts.findOne({ _id: input.bankAccountId, organisationId: user.organisationId, entityId: entity._id }).session(session ?? null).lean();
    if (!bank) throw new BadRequestException('Bank account not found for this entity');
    if (bank.currency !== entity.functionalCurrency) throw new BadRequestException(`Investments are placed from a ${entity.functionalCurrency} account`);
    const ids = [input.investmentAccountId, input.interestIncomeAccountId, input.interestReceivableAccountId, ...(input.withholdingAccountId ? [input.withholdingAccountId] : [])];
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: ids } }).session(session ?? null).lean();
    const need = (id: Id, label: string, classes: string[]) => {
      const a = accounts.find((x) => x._id.equals(id));
      if (!a?.isPostable || a.isControl || !classes.includes(a.accountClass)) throw new BadRequestException(`Choose a postable ${classes.map((c) => c.toLowerCase()).join(' or ')} account for ${label}`);
      return a;
    };
    need(input.investmentAccountId, 'the investment', ['ASSET']);
    need(input.interestReceivableAccountId, 'interest receivable', ['ASSET']);
    need(input.interestIncomeAccountId, 'interest income', ['REVENUE']);
    if (input.withholdingPercent.gt(0)) {
      if (!input.withholdingAccountId) throw new BadRequestException('Choose the account for withholding tax deducted from interest');
      need(input.withholdingAccountId, 'withholding tax', ['ASSET', 'EXPENSE']);
    }
    const fp = await this.currencies.precision(entity.functionalCurrency);
    return { entity, bank, fp };
  }

  private fields(input: InvestmentInput, fp: number, branchId: Id) {
    return {
      entityId: input.entityId,
      branchId,
      type: input.type,
      institution: input.institution,
      reference: input.reference ?? '',
      description: input.description ?? '',
      principal: toD128(round(input.principal, fp)),
      ratePercent: toD128(input.ratePercent),
      dayCount: input.dayCount,
      startDate: input.startDate,
      maturityDate: input.maturityDate,
      withholdingPercent: toD128(input.withholdingPercent),
      bankAccountId: input.bankAccountId,
      investmentAccountId: input.investmentAccountId,
      interestIncomeAccountId: input.interestIncomeAccountId,
      interestReceivableAccountId: input.interestReceivableAccountId,
      withholdingAccountId: input.withholdingAccountId ?? null,
    };
  }

  async save(user: AuthUser, id: Id | null, input: InvestmentInput) {
    const { entity, bank, fp } = await this.validate(user, input);
    const fields = this.fields(input, fp, bank.branchId);
    if (!id) {
      const number = await this.db.nextNumber(user.organisationId, entity, 'TRS');
      const [doc] = await this.db.investments.create([{ ...fields, organisationId: user.organisationId, number, accruedInterest: toD128(0), accruedTo: input.startDate, createdBy: user.id }]);
      await this.audit.log(user, { action: 'investment.create', recordType: 'Investment', recordId: doc._id, summary: `Prepared ${number}: ${input.principal.toFixed()} with ${input.institution} at ${input.ratePercent.toFixed()}%` });
      return doc.toObject();
    }
    const before = await this.get(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or returned investments can be edited');
    const after = await transition(this.db.investments, id, ['DRAFT', 'REJECTED'], { ...fields, accruedTo: input.startDate, status: 'DRAFT' });
    await this.audit.log(user, { action: 'investment.update', recordType: 'Investment', recordId: id, summary: `Edited ${before.number}` });
    return after;
  }

  /** Submit, approve (posts the placement: investment debited, bank credited), reject or cancel. */
  async act(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject' | 'cancel', reason?: string) {
    return this.db.transaction(async (session) => {
      const inv = (await this.db.investments.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as Investment | null;
      if (!inv) throw new NotFoundException('Investment not found');
      const now = new Date();
      let after;
      if (action === 'submit') {
        after = await transition(this.db.investments, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        const roles = await this.db.roles.find({ organisationId: user.organisationId, permissions: PERMISSIONS.PAYMENTS_APPROVE }, { _id: 1 }).session(session).lean();
        const approvers = await this.db.users.find({ organisationId: user.organisationId, isActive: true, roleIds: { $in: roles.map((r) => r._id) }, _id: { $ne: user.id } }, { _id: 1 }).session(session).lean();
        await this.workflow.notify(user.organisationId, approvers.map((u) => u._id), { kind: 'approval', title: `Investment ${inv.number} awaits approval`, body: `${dec(inv.principal).toFixed()} with ${inv.institution}`, link: `/finance/banking/investments?open=${id}` }, session);
      } else if (action === 'reject') {
        if (!reason?.trim()) throw new BadRequestException('Give the reason');
        after = await transition(this.db.investments, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason }, session);
      } else if (action === 'cancel') {
        after = await transition(this.db.investments, id, ['DRAFT', 'REJECTED', 'SUBMITTED'], { status: 'CANCELLED' }, session);
      } else {
        if (inv.status !== 'SUBMITTED') throw new BadRequestException('Only submitted investments can be approved');
        assertSegregation(user, inv, 'an investment');
        const journal = await this.journals.postSystemJournal(
          user,
          {
            entityId: inv.entityId,
            branchId: inv.branchId,
            journalDate: inv.startDate,
            description: `${inv.number}: placement with ${inv.institution}`,
            reference: inv.reference,
            lines: [
              { accountId: inv.investmentAccountId, debit: dec(inv.principal), description: `${inv.institution} ${inv.reference}`.trim() },
              { accountId: (await this.bankGl(inv.bankAccountId, session)), credit: dec(inv.principal), description: `Placement ${inv.number}` },
            ],
          },
          { sourceType: 'Investment', sourceId: inv._id, sourceNumber: inv.number },
          session,
        );
        after = await transition(this.db.investments, id, ['SUBMITTED'], { status: 'ACTIVE', approvedBy: user.id, approvedAt: now, placementJournalId: journal._id }, session);
      }
      await this.audit.log(user, { action: `investment.${action}`, recordType: 'Investment', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${inv.number}${reason ? `: ${reason}` : ''}` }, session);
      return after;
    });
  }

  private async bankGl(bankAccountId: Id, session?: ClientSession) {
    const bank = await this.db.bankAccounts.findById(bankAccountId).session(session ?? null).lean();
    if (!bank) throw new BadRequestException('Bank account not found');
    return bank.glAccountId;
  }

  /**
   * Accrues interest earned to `asOf` (or maturity, if sooner) on every active investment of the entity:
   * interest receivable debited, interest income credited. Accrual is cumulative, so rounding never drifts.
   */
  async accrue(user: AuthUser, q: { entityId: Id; asOf: Date }) {
    const active = await this.db.investments.find({ organisationId: user.organisationId, entityId: q.entityId, status: 'ACTIVE', accruedTo: { $lt: q.asOf } }).lean();
    const fp = await this.precisionOf(q.entityId);
    const posted: { number: string; amount: Decimal }[] = [];
    for (const inv of active) {
      const to = q.asOf < inv.maturityDate ? q.asOf : inv.maturityDate;
      if (to <= inv.accruedTo!) continue;
      const amount = InvestmentsService.interest(inv, inv.startDate, to, fp).minus(dec(inv.accruedInterest));
      if (!amount.gt(0)) continue;
      await this.db.transaction(async (session) => {
        const journal = await this.journals.postSystemJournal(
          user,
          {
            entityId: inv.entityId,
            branchId: inv.branchId,
            journalDate: to,
            description: `${inv.number}: interest accrued to ${to.toISOString().slice(0, 10)}`,
            lines: [
              { accountId: inv.interestReceivableAccountId, debit: amount, description: `Interest on ${inv.number}` },
              { accountId: inv.interestIncomeAccountId, credit: amount, description: `Interest on ${inv.number}` },
            ],
          },
          { sourceType: 'Investment', sourceId: inv._id, sourceNumber: inv.number },
          session,
        );
        const res = await this.db.investments.updateOne(
          { _id: inv._id, status: 'ACTIVE', accruedTo: inv.accruedTo },
          { $set: { accruedTo: to, accruedInterest: toD128(dec(inv.accruedInterest).plus(amount)) }, $push: { accruals: { date: to, amount: toD128(amount), journalId: journal._id } } },
          { session },
        );
        if (!res.modifiedCount) throw new BadRequestException(`${inv.number} was changed by someone else; run the accrual again`);
      });
      posted.push({ number: inv.number, amount });
    }
    if (posted.length) await this.audit.log(user, { action: 'investment.accrue', recordType: 'Investment', recordId: active[0]._id, summary: `Accrued interest to ${q.asOf.toISOString().slice(0, 10)} on ${posted.length} investments (${sum(posted.map((p) => p.amount)).toFixed()})` });
    return { accrued: posted.length, total: sum(posted.map((p) => p.amount)), investments: posted };
  }

  /**
   * Maturity or early termination: the principal and interest come back to the bank less withholding
   * tax; interest already accrued clears the receivable and the rest is income. Optionally rolls the
   * principal (and net interest) into a new placement with the same institution.
   */
  async settle(user: AuthUser, id: Id, input: SettleInput) {
    return this.db.transaction(async (session) => {
      const inv = (await this.db.investments.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as Investment | null;
      if (!inv) throw new NotFoundException('Investment not found');
      if (inv.status !== 'ACTIVE') throw new BadRequestException('Only active investments can be settled');
      if (input.date < inv.startDate) throw new BadRequestException('Settlement cannot be before the start date');
      const fp = await this.precisionOf(inv.entityId);
      const end = input.date < inv.maturityDate ? input.date : inv.maturityDate;
      const interest = input.interest ? round(input.interest, fp) : InvestmentsService.interest(inv, inv.startDate, end, fp);
      if (interest.lt(0)) throw new BadRequestException('Interest cannot be negative');
      const withholding = round(interest.times(dec(inv.withholdingPercent)).div(100), fp);
      const principal = dec(inv.principal);
      const net = principal.plus(interest).minus(withholding);
      const accrued = dec(inv.accruedInterest);
      const bankId = input.bankAccountId ?? inv.bankAccountId;
      const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId, entityId: inv.entityId }).session(session).lean();
      if (!bank) throw new BadRequestException('Bank account not found for this entity');
      const income = interest.minus(accrued);
      const lines = [
        { accountId: bank.glAccountId, debit: net, description: `Proceeds of ${inv.number}` },
        ...(withholding.gt(0) ? [{ accountId: inv.withholdingAccountId!, debit: withholding, description: `Withholding tax on interest, ${inv.number}` }] : []),
        { accountId: inv.investmentAccountId, credit: principal, description: `${inv.institution} ${inv.reference}`.trim() },
        ...(accrued.gt(0) ? [{ accountId: inv.interestReceivableAccountId, credit: accrued, description: `Accrued interest, ${inv.number}` }] : []),
        ...(income.isZero() ? [] : [{ accountId: inv.interestIncomeAccountId, ...(income.gt(0) ? { credit: income } : { debit: income.neg() }), description: `Interest on ${inv.number}` }]),
      ];
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: inv.entityId, branchId: bank.branchId, journalDate: input.date, description: `${inv.number}: ${input.date < inv.maturityDate ? 'early withdrawal' : 'maturity'} from ${inv.institution}`, reference: inv.reference, lines },
        { sourceType: 'Investment', sourceId: inv._id, sourceNumber: inv.number },
        session,
      );
      let rolledOverToId: Id | null = null;
      if (input.rollover) {
        const entity = (await this.db.entities.findById(inv.entityId).session(session).lean())!;
        const amount = input.rollover.reinvestInterest ? net : principal;
        const number = await this.db.nextNumber(user.organisationId, entity, 'TRS', session);
        if (input.rollover.maturityDate <= input.date) throw new BadRequestException('The new maturity date must be after the settlement date');
        const next = {
          ...this.fields(
            {
              entityId: inv.entityId,
              type: inv.type as InvestmentInput['type'],
              institution: inv.institution,
              reference: inv.reference,
              description: `Rollover of ${inv.number}`,
              principal: amount,
              ratePercent: input.rollover.ratePercent ?? dec(inv.ratePercent),
              dayCount: inv.dayCount as InvestmentInput['dayCount'],
              startDate: input.date,
              maturityDate: input.rollover.maturityDate,
              withholdingPercent: dec(inv.withholdingPercent),
              bankAccountId: bank._id,
              investmentAccountId: inv.investmentAccountId,
              interestIncomeAccountId: inv.interestIncomeAccountId,
              interestReceivableAccountId: inv.interestReceivableAccountId,
              withholdingAccountId: inv.withholdingAccountId,
            },
            fp,
            bank.branchId,
          ),
          organisationId: user.organisationId,
          number,
          accruedInterest: toD128(0),
          accruedTo: input.date,
          rolledOverFromId: inv._id,
          createdBy: user.id,
          approvedBy: user.id,
          approvedAt: new Date(),
          status: 'ACTIVE',
        };
        const nextId = new Types.ObjectId();
        const placement = await this.journals.postSystemJournal(
          user,
          {
            entityId: inv.entityId,
            branchId: bank.branchId,
            journalDate: input.date,
            description: `${number}: rollover of ${inv.number} with ${inv.institution}`,
            lines: [
              { accountId: inv.investmentAccountId, debit: amount, description: `${inv.institution} ${inv.reference}`.trim() },
              { accountId: bank.glAccountId, credit: amount, description: `Rollover ${number}` },
            ],
          },
          { sourceType: 'Investment', sourceId: nextId, sourceNumber: number },
          session,
        );
        await this.db.investments.create([{ ...next, _id: nextId, placementJournalId: placement._id }], { session });
        rolledOverToId = nextId;
      }
      const after = await transition(
        this.db.investments,
        id,
        ['ACTIVE'],
        {
          status: 'MATURED',
          accruedTo: end,
          settlement: { date: input.date, bankAccountId: bank._id, interest: toD128(interest), withholding: toD128(withholding), net: toD128(net), journalId: journal._id, rolledOverToId },
        },
        session,
      );
      await this.audit.log(
        user,
        { action: 'investment.settle', recordType: 'Investment', recordId: id, summary: `Settled ${inv.number}: interest ${interest.toFixed()}, withholding ${withholding.toFixed()}, net ${net.toFixed()}${rolledOverToId ? ', rolled over' : ''}` },
        session,
      );
      return after;
    });
  }

  /**
   * Treasury report for a day, week or month: each bank account's opening balance, money in and out and
   * closing balance, investments held at the end with interest earned, and what matures next.
   */
  async report(user: AuthUser, q: { entityId: Id; from: Date; to: Date; horizonDays?: number }) {
    const entity = await this.db.entities.findOne({ _id: q.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const banks = await this.db.bankAccounts.find({ organisationId: user.organisationId, entityId: entity._id }).sort({ name: 1 }).lean();
    const glIds = banks.map((b) => b.glAccountId);
    const match = { organisationId: user.organisationId, entityId: entity._id, accountId: { $in: glIds } };
    const [before, during] = await Promise.all([ledgerSums(this.db, match, null, q.from, ['account']), ledgerSums(this.db, match, q.from, addDays(q.to, 1), ['account'])]);
    const bankRows = banks.map((b) => {
      const o = before.find((r) => r.account?.equals(b.glAccountId));
      const d = during.find((r) => r.account?.equals(b.glAccountId));
      const opening = o ? o.debit.minus(o.credit) : new Decimal(0);
      const receipts = d?.debit ?? new Decimal(0);
      const payments = d?.credit ?? new Decimal(0);
      return { id: b._id, name: b.name, currency: b.currency, opening, receipts, payments, closing: opening.plus(receipts).minus(payments) };
    });
    // Several bank accounts can share one ledger account; count each ledger account once in the totals.
    const seen = new Set<string>();
    const unique = bankRows.filter((r, i) => {
      const k = banks[i].glAccountId.toHexString();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const invs = await this.db.investments.find({ organisationId: user.organisationId, entityId: entity._id, status: { $in: ['ACTIVE', 'MATURED'] }, startDate: { $lte: q.to } }).sort({ maturityDate: 1 }).lean();
    const heldAt = (i: Investment, d: Date) => i.startDate <= d && (i.status === 'ACTIVE' || (i.settlement?.date && i.settlement.date > d));
    const earnedIn = (i: Investment) => {
      const stop = i.settlement?.date && i.settlement.date < i.maturityDate ? i.settlement.date : i.maturityDate;
      const a = i.startDate > q.from ? i.startDate : q.from;
      const end = addDays(q.to, 1);
      const b = stop < end ? stop : end;
      return b > a ? InvestmentsService.interest(i, i.startDate, b, fp).minus(InvestmentsService.interest(i, i.startDate, a, fp)) : new Decimal(0);
    };
    const holdings = invs
      .filter((i) => heldAt(i as Investment, q.to))
      .map((i) => ({
        id: i._id,
        number: i.number,
        type: i.type,
        institution: i.institution,
        principal: dec(i.principal),
        ratePercent: dec(i.ratePercent),
        startDate: i.startDate,
        maturityDate: i.maturityDate,
        daysToMaturity: days(q.to, i.maturityDate),
        interestToDate: InvestmentsService.interest(i, i.startDate, q.to < i.maturityDate ? addDays(q.to, 1) : i.maturityDate, fp),
        termInterest: InvestmentsService.interest(i, i.startDate, i.maturityDate, fp),
      }));
    const horizon = addDays(q.to, q.horizonDays ?? 30);
    const settled = invs.filter((i) => i.settlement?.date && i.settlement.date >= q.from && i.settlement.date <= q.to);
    const placed = invs.filter((i) => i.startDate >= q.from && i.startDate <= q.to);
    const cash = sum(unique.map((r) => r.closing));
    const invested = sum(holdings.map((h) => h.principal));
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from: q.from,
      to: q.to,
      banks: bankRows,
      totals: { opening: sum(unique.map((r) => r.opening)), receipts: sum(unique.map((r) => r.receipts)), payments: sum(unique.map((r) => r.payments)), cash, invested, liquidity: cash.plus(invested) },
      holdings,
      maturing: holdings.filter((h) => h.maturityDate <= horizon),
      placed: placed.map((i) => ({ id: i._id, number: i.number, institution: i.institution, principal: dec(i.principal), startDate: i.startDate })),
      settled: settled.map((i) => ({ id: i._id, number: i.number, institution: i.institution, date: i.settlement!.date, interest: dec(i.settlement!.interest), withholding: dec(i.settlement!.withholding), net: dec(i.settlement!.net) })),
      interestEarned: sum(invs.map((i) => earnedIn(i as Investment))),
    };
  }

  /** Scheduled: reminds treasury approvers a week before an investment matures (once per investment). */
  async remindMaturities(now = new Date()) {
    const soon = await this.db.investments.find({ status: 'ACTIVE', maturityDate: { $gte: now, $lte: new Date(now.getTime() + 7 * DAY) }, maturityReminderAt: null }).lean();
    let sent = 0;
    for (const inv of soon) {
      const roles = await this.db.roles.find({ organisationId: inv.organisationId, permissions: { $in: [PERMISSIONS.BANKING_MANAGE, PERMISSIONS.PAYMENTS_APPROVE] } }, { _id: 1 }).lean();
      const users = await this.db.users.find({ organisationId: inv.organisationId, isActive: true, roleIds: { $in: roles.map((r) => r._id) } }, { _id: 1 }).lean();
      await this.workflow.notify(inv.organisationId, users.map((u) => u._id), {
        kind: 'investment-maturity',
        title: `${inv.number} with ${inv.institution} matures on ${inv.maturityDate.toISOString().slice(0, 10)}`,
        body: `Principal ${dec(inv.principal).toFixed()} at ${dec(inv.ratePercent).toFixed()}%. Settle or roll it over.`,
        link: `/finance/banking/investments?open=${inv._id}`,
      });
      await this.db.investments.updateOne({ _id: inv._id }, { $set: { maturityReminderAt: now } });
      sent++;
    }
    return { sent };
  }
}
