import { randomUUID } from 'node:crypto';
import { ClientSession, Types } from 'mongoose';
import { actorFor, AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { decryptSecret } from '../../common/totp';
import { BankAccount } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { MobileMoneyPayout } from '../../database/payments.schemas';
import { AuditService } from '../audit/audit.service';
import { BankingService } from '../banking/banking.service';
import { JournalsService } from '../journals/journals.service';
import { WorkflowService } from '../workflow/workflow.service';
import { DarajaError, normalisePhone, parseBalances } from './daraja';
import { MpesaService } from './mpesa.service';

/** M-Pesa days run on East Africa Time. */
const startOfEatDay = (d = new Date()) => {
  const eat = new Date(d.getTime() + 3 * 3_600_000);
  return new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()) - 3 * 3_600_000);
};

/**
 * Paying out through M-Pesa. Releasing a supplier payment by mobile money, or reimbursing an expense claim,
 * from an account with payouts enabled queues the payout in the same transaction; it is then sent to
 * Safaricom (B2C to a phone, B2B to a paybill or till) and completed by Safaricom's result callback,
 * which also records the statement line, matched to the payment. Money is never resent automatically
 * when M-Pesa's answer is unknown.
 */
export class PayoutsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mpesa: MpesaService,
    private readonly banking: BankingService,
    private readonly workflow: WorkflowService,
    private readonly journals: JournalsService,
  ) {}

  // ----- Queueing (inside the posting transaction) -----------------------------------------------

  async onAudit(organisationId: Types.ObjectId, event: { type: string; recordType: string; recordId?: Types.ObjectId | null }, session?: ClientSession) {
    if (!event.recordId) return;
    if (event.type === 'payment.post' && event.recordType === 'Payment') await this.queuePayment(event.recordId, session);
    if (event.type === 'expense.pay' && event.recordType === 'ExpenseClaim') await this.queueClaim(event.recordId, session);
    if (event.type === 'payment.void' && event.recordType === 'Payment') await this.guardVoid(event.recordId, session);
    if (event.type === 'refund.post' && event.recordType === 'Refund') await this.queueRefund(event.recordId, session);
    if (event.type === 'refund.void' && event.recordType === 'Refund') await this.guardVoid(event.recordId, session);
    if (event.type === 'salary_run.post' && event.recordType === 'SalaryRun') await this.queueSalaries(event.recordId, session);
    if (event.type === 'salary_run.void' && event.recordType === 'SalaryRun') await this.guardVoid(event.recordId, session);
  }

  private async payoutAccount(bankAccountId: Types.ObjectId, session?: ClientSession) {
    const bank = await this.db.bankAccounts.findById(bankAccountId).session(session ?? null).lean();
    return bank?.mpesa?.enabled && bank.mpesa.payouts?.enabled ? bank : null;
  }

  private checkTransaction(amount: Decimal, who = '') {
    const tag = who ? `${who}: ` : '';
    if (amount.decimalPlaces() > 0) throw new BadRequestException(`${tag}M-Pesa pays whole shillings; round the amount`);
    if (amount.lt(10)) throw new BadRequestException(`${tag}M-Pesa payouts start at KES 10`);
    if (amount.gt(250_000)) throw new BadRequestException(`${tag}M-Pesa pays at most KES 250,000 per transaction; split the payment or pay by bank transfer`);
  }

  private async checkAmount(bank: BankAccount, amount: Decimal, session?: ClientSession) {
    this.checkTransaction(amount);
    await this.checkCapacity(bank, amount, session);
  }

  /** Today's limit and the float (when recently checked) must cover the amount about to be paid out. */
  private async checkCapacity(bank: BankAccount, amount: Decimal, session?: ClientSession) {
    const limit = bank.mpesa?.payouts?.dailyLimit ? dec(bank.mpesa.payouts.dailyLimit) : null;
    if (limit) {
      const [row] = await this.db.payouts
        .aggregate<{ total: unknown }>([
          { $match: { bankAccountId: bank._id, createdAt: { $gte: startOfEatDay() }, status: { $nin: ['FAILED', 'CANCELLED'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .session(session ?? null);
      const today = row ? dec(row.total as never) : new Decimal(0);
      if (today.plus(amount).gt(limit)) throw new BadRequestException(`This would take today's M-Pesa payouts from ${bank.name} to KES ${today.plus(amount).toFixed()}, over the daily limit of KES ${limit.toFixed()}`);
    }
    // With a recent balance, refuse what the float cannot cover (after payouts already on their way).
    const balance = bank.mpesa?.payouts?.balance;
    if (balance?.available && balance.checkedAt && Date.now() - balance.checkedAt.getTime() < 6 * 3_600_000) {
      const [row] = await this.db.payouts
        .aggregate<{ total: unknown }>([{ $match: { bankAccountId: bank._id, status: { $in: ['QUEUED', 'SENT', 'CHECK'] }, createdAt: { $gte: balance.checkedAt } } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
        .session(session ?? null);
      const committed = row ? dec(row.total as never) : new Decimal(0);
      const free = dec(balance.available).minus(committed);
      if (amount.gt(free)) throw new BadRequestException(`The M-Pesa float (KES ${dec(balance.available).toFixed(2)} at the last check${committed.gt(0) ? `, KES ${committed.toFixed()} already on its way` : ''}) cannot cover KES ${amount.toFixed()}; top up the float first`);
    }
  }

  private async queuePayment(paymentId: Types.ObjectId, session?: ClientSession) {
    const p = await this.db.payments.findById(paymentId).session(session ?? null).lean();
    if (!p || p.kind !== 'PAYMENT' || p.method !== 'MOBILE_MONEY' || p.status !== 'POSTED') return;
    const bank = await this.payoutAccount(p.bankAccountId, session);
    if (!bank) return;
    const supplier = await this.db.suppliers.findById(p.partyId).session(session ?? null).lean();
    const payee = supplier?.mpesaPayee;
    if (!payee) throw new BadRequestException(`Add ${p.partyName}'s M-Pesa details (phone, paybill or till) before paying them by M-Pesa`);
    const amount = dec(p.amount);
    await this.checkAmount(bank, amount, session);
    await this.db.payouts.create(
      [
        {
          organisationId: p.organisationId,
          entityId: p.entityId,
          bankAccountId: bank._id,
          sourceType: 'Payment',
          sourceId: p._id,
          sourceNumber: p.number,
          journalId: p.journalId!,
          payeeName: p.partyName,
          payeeType: payee.type,
          payeeNumber: payee.number,
          accountReference: payee.accountReference || p.reference || p.number,
          amount: toD128(amount),
          originatorConversationId: randomUUID(),
          requestedBy: p.approvedBy ?? p.createdBy,
        },
      ],
      { session },
    );
  }

  private async queueClaim(claimId: Types.ObjectId, session?: ClientSession) {
    const c = await this.db.expenseClaims.findById(claimId).session(session ?? null).lean();
    if (!c || c.status !== 'PAID' || !c.payment?.bankAccountId) return;
    const bank = await this.payoutAccount(c.payment.bankAccountId, session);
    if (!bank) return;
    const claimant = await this.db.users.findById(c.claimantId, { phone: 1, name: 1 }).session(session ?? null).lean();
    const phone = normalisePhone(claimant?.phone ?? '');
    if (!phone) throw new BadRequestException(`Add a Safaricom number for ${c.claimantName} (their profile) before reimbursing by M-Pesa`);
    // Reimbursed from an account in another currency: the converted amount is what is paid out.
    const amount = c.payment.amount ? dec(c.payment.amount) : dec(c.total);
    await this.checkAmount(bank, amount, session);
    await this.db.payouts.create(
      [
        {
          organisationId: c.organisationId,
          entityId: c.entityId,
          bankAccountId: bank._id,
          sourceType: 'ExpenseClaim',
          sourceId: c._id,
          sourceNumber: c.number,
          journalId: c.payment.journalId!,
          payeeName: c.claimantName,
          payeeType: 'PHONE',
          payeeNumber: phone,
          accountReference: c.number,
          amount: toD128(amount),
          originatorConversationId: randomUUID(),
          requestedBy: c.payment.paidBy!,
        },
      ],
      { session },
    );
  }

  private async queueRefund(refundId: Types.ObjectId, session?: ClientSession) {
    const r = await this.db.refunds.findById(refundId).session(session ?? null).lean();
    if (!r || r.status !== 'POSTED' || r.method !== 'MOBILE_MONEY') return;
    const bank = await this.payoutAccount(r.bankAccountId, session);
    if (!bank) return;
    const phone = normalisePhone(r.payeePhone);
    if (!phone) throw new BadRequestException(`Enter the Safaricom number to refund ${r.partyName} to`);
    const amount = dec(r.amount);
    await this.checkAmount(bank, amount, session);
    await this.db.payouts.create(
      [
        {
          organisationId: r.organisationId,
          entityId: r.entityId,
          bankAccountId: bank._id,
          sourceType: 'Refund',
          sourceId: r._id,
          sourceNumber: r.number,
          journalId: r.journalId!,
          payeeName: r.partyName,
          payeeType: 'PHONE',
          payeeNumber: phone,
          accountReference: r.number,
          amount: toD128(amount),
          originatorConversationId: randomUUID(),
          requestedBy: r.approvedBy ?? r.createdBy,
        },
      ],
      { session },
    );
  }

  /** One payout per employee; the run is refused as a whole if the float or limits cannot cover it. */
  private async queueSalaries(runId: Types.ObjectId, session?: ClientSession) {
    const run = await this.db.salaryRuns.findById(runId).session(session ?? null).lean();
    if (!run || run.status !== 'POSTED') return;
    const bank = await this.payoutAccount(run.bankAccountId, session);
    if (!bank) return;
    for (const l of run.lines) this.checkTransaction(dec(l.amount), l.employeeName);
    await this.checkCapacity(bank, dec(run.total), session);
    await this.db.payouts.create(
      run.lines.map((l) => ({
        organisationId: run.organisationId,
        entityId: run.entityId,
        bankAccountId: bank._id,
        sourceType: 'SalaryRun',
        sourceId: run._id,
        sourceLine: l.lineNo,
        sourceNumber: run.number,
        journalId: run.journalId!,
        payeeName: l.employeeName,
        payeeType: 'PHONE',
        payeeNumber: l.phone,
        accountReference: `${run.number} ${run.period}`,
        amount: l.amount,
        originatorConversationId: randomUUID(),
        requestedBy: run.approvedBy ?? run.createdBy,
      })),
      { session, ordered: true },
    );
  }

  private async guardVoid(sourceId: Types.ObjectId, session?: ClientSession) {
    const payouts = await this.db.payouts.find({ sourceId }).session(session ?? null).lean();
    for (const payout of payouts) {
      const who = payout.sourceType === 'SalaryRun' ? `${payout.payeeName}'s pay on ${payout.sourceNumber}` : payout.sourceNumber;
      if (payout.status === 'SENT' || payout.status === 'COMPLETED') throw new BadRequestException(`${who} was paid out through M-Pesa (${payout.transactionId ?? 'awaiting the result'}); it cannot be voided`);
      if (payout.status === 'CHECK') throw new BadRequestException(`M-Pesa did not confirm whether ${who} was paid; check the M-Pesa statement and resolve the payout first`);
    }
    await this.db.payouts.updateMany({ sourceId, status: 'QUEUED' }, { status: 'CANCELLED', note: 'Voided before it was sent' }, { session });
  }

  // ----- Sending ----------------------------------------------------------------------------------

  async deliverDue(opts: { organisationId?: Types.ObjectId; limit?: number } = {}) {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < (opts.limit ?? 50); i++) {
      const now = new Date();
      const payout = await this.db.payouts
        .findOneAndUpdate(
          { status: 'QUEUED', $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }], ...(opts.organisationId && { organisationId: opts.organisationId }) },
          { lockedUntil: new Date(now.getTime() + 120_000), $inc: { attempts: 1 } },
          { new: true, sort: { createdAt: 1 } },
        )
        .lean();
      if (!payout) break;
      if (await this.send(payout)) sent++;
      else failed++;
    }
    return { sent, failed };
  }

  private async send(payout: MobileMoneyPayout): Promise<boolean> {
    const bank = (await this.db.bankAccounts.findById(payout.bankAccountId).lean())!;
    const p = bank.mpesa?.payouts;
    try {
      if (!bank.mpesa?.enabled || !p?.enabled || !p.securityCredential) throw new DarajaError(`M-Pesa payouts are not enabled on ${bank.name}`);
      const urls = this.mpesa.callbacks(bank);
      const common = {
        originatorConversationId: payout.originatorConversationId,
        initiatorName: p.initiatorName,
        securityCredential: decryptSecret(p.securityCredential),
        shortCode: p.shortCode,
        amount: dec(payout.amount).toNumber(),
        remarks: `${payout.sourceNumber} ${payout.payeeName}`,
        resultUrl: urls.payoutResult,
        timeoutUrl: urls.payoutTimeout,
      };
      const client = this.mpesa.client(bank);
      const res =
        payout.payeeType === 'PHONE'
          ? await client.b2c({ ...common, phone: payout.payeeNumber, occasion: payout.accountReference })
          : await client.b2b({ ...common, till: payout.payeeType === 'TILL', partyB: payout.payeeNumber, accountReference: payout.accountReference });
      await this.db.payouts.updateOne({ _id: payout._id, status: 'QUEUED' }, { status: 'SENT', conversationId: res.ConversationID, sentAt: new Date(), lockedUntil: null, note: '' });
      return true;
    } catch (err) {
      // A refusal from Safaricom means nothing was paid; no answer at all means it might have been.
      const refused = err instanceof DarajaError || (err instanceof Error && 'status' in err);
      await this.db.payouts.updateOne(
        { _id: payout._id, status: 'QUEUED' },
        refused
          ? { status: 'FAILED', resultDescription: (err as Error).message.slice(0, 300), lockedUntil: null }
          : { status: 'CHECK', note: 'No answer from M-Pesa; check the M-Pesa statement before trying again', lockedUntil: null },
      );
      return false;
    }
  }

  // ----- Callbacks from Safaricom ----------------------------------------------------------------

  async result(secret: string, body: unknown) {
    const bank = await this.mpesa.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    const r = (body as { Result?: { ResultCode?: number | string; ResultDesc?: string; OriginatorConversationID?: string; ConversationID?: string; TransactionID?: string } })?.Result;
    if (!r) throw new BadRequestException('Not a payout result');
    const payout = await this.db.payouts.findOne({ bankAccountId: bank._id, $or: [{ originatorConversationId: r.OriginatorConversationID }, { conversationId: r.ConversationID }] }).lean();
    if (!payout || payout.status === 'COMPLETED' || payout.status === 'CANCELLED') return { ResultCode: 0, ResultDesc: 'Accepted' };
    if (Number(r.ResultCode) !== 0) {
      await this.db.payouts.updateOne({ _id: payout._id, status: { $in: ['SENT', 'CHECK', 'QUEUED'] } }, { status: 'FAILED', resultCode: String(r.ResultCode), resultDescription: r.ResultDesc ?? 'Failed' });
      await this.audit.log({ organisationId: payout.organisationId, name: 'M-Pesa' }, { action: 'mpesa.payout_failed', recordType: payout.sourceType, recordId: payout.sourceId, summary: `M-Pesa payout for ${payout.sourceNumber} to ${payout.payeeName} failed: ${r.ResultDesc ?? r.ResultCode}` });
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
    const done = await this.db.payouts
      .findOneAndUpdate({ _id: payout._id, status: { $in: ['SENT', 'CHECK', 'QUEUED', 'FAILED'] } }, { status: 'COMPLETED', resultCode: '0', resultDescription: r.ResultDesc ?? '', transactionId: r.TransactionID ?? null, completedAt: new Date(), note: '' }, { new: true })
      .lean();
    if (done) await this.recordStatementLine(bank, done);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  async timeout(secret: string, body: unknown) {
    const bank = await this.mpesa.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    const id = (body as { OriginatorConversationID?: string; Result?: { OriginatorConversationID?: string } })?.OriginatorConversationID ?? (body as { Result?: { OriginatorConversationID?: string } })?.Result?.OriginatorConversationID;
    if (id) await this.db.payouts.updateOne({ bankAccountId: bank._id, originatorConversationId: id, status: 'SENT' }, { status: 'CHECK', note: 'M-Pesa timed out; check the M-Pesa statement before trying again' });
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /** The money left the account: a statement line on the day's M-Pesa statement, matched to the payment. */
  private async recordStatementLine(bank: BankAccount, payout: MobileMoneyPayout) {
    const date = payout.completedAt ?? new Date();
    const statement = await this.mpesa.statementFor(bank, date);
    const [line] = await this.db.bankStatementLines.create([
      {
        organisationId: bank.organisationId,
        bankAccountId: bank._id,
        statementId: statement!._id,
        date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
        description: `M-Pesa payout ${payout.payeeName} ${payout.sourceNumber}`,
        reference: payout.transactionId ?? '',
        amount: toD128(dec(payout.amount).neg()),
      },
    ]);
    await this.db.payouts.updateOne({ _id: payout._id }, { statementLineId: line._id });
    // Salary runs credit the bank once per employee, in line order.
    const entries = await this.db.ledger.find({ journalId: payout.journalId, accountId: bank.glAccountId }).sort({ lineNo: 1 }).lean();
    const entry = payout.sourceLine ? entries[payout.sourceLine - 1] : entries[0];
    const actor = await actorFor(this.db, payout.requestedBy);
    if (entry && actor) await this.banking.match(actor, bank._id, [line._id], [entry._id], 'AUTO').catch(() => undefined);
    if (actor) await this.bookCharge(actor, bank, payout, statement!._id, date).catch(async (err: Error) => {
      await this.db.payouts.updateOne({ _id: payout._id }, { note: `The M-Pesa charge was not booked: ${err.message}`.slice(0, 300) });
    });
  }

  /** The charge for an amount from the account's tariff (first band the amount fits), or null without one. */
  static chargeFor(tariff: { upTo: unknown; charge: unknown }[] | undefined, amount: Decimal): Decimal | null {
    const bands = (tariff ?? []).map((b) => ({ upTo: dec(b.upTo as never), charge: dec(b.charge as never) })).sort((a, b) => a.upTo.comparedTo(b.upTo));
    const band = bands.find((b) => amount.lte(b.upTo));
    return band ? band.charge : bands.length ? bands[bands.length - 1].charge : null;
  }

  /** Books the M-Pesa charge on a completed payout: Dr charges, Cr the M-Pesa account, with its statement line matched. */
  private async bookCharge(actor: AuthUser, bank: BankAccount, payout: MobileMoneyPayout, statementId: Types.ObjectId, date: Date) {
    const charge = PayoutsService.chargeFor(bank.mpesa?.payouts?.tariff, dec(payout.amount));
    if (!charge || charge.lte(0) || payout.chargeJournalId) return;
    const chargesAccountId = bank.mpesa?.payouts?.chargesAccountId ?? (await this.db.accounts.findOne({ organisationId: bank.organisationId, code: '6800' }).lean())?._id;
    if (!chargesAccountId) throw new BadRequestException('Choose the account for M-Pesa charges');
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const entity = (await this.db.entities.findById(bank.entityId).lean())!;
    const journalId = await this.db.transaction(async (session) => {
      const journal = await this.journals.postSystemJournal(
        actor,
        {
          entityId: bank.entityId,
          branchId: bank.branchId,
          journalDate: day,
          description: `M-Pesa charge on ${payout.sourceNumber} to ${payout.payeeName}`,
          reference: payout.transactionId ?? '',
          lines: [
            { accountId: chargesAccountId, branchId: bank.branchId, currency: entity.functionalCurrency, description: `M-Pesa charge ${payout.transactionId ?? ''}`.trim(), debit: charge, credit: null },
            { accountId: bank.glAccountId, branchId: bank.branchId, currency: entity.functionalCurrency, description: `M-Pesa charge ${payout.transactionId ?? ''}`.trim(), debit: null, credit: charge },
          ],
        },
        { sourceType: 'MobileMoneyPayout', sourceId: payout._id, sourceNumber: payout.sourceNumber },
        session,
      );
      await this.db.payouts.updateOne({ _id: payout._id }, { charge: toD128(charge), chargeJournalId: journal._id }, { session });
      return journal._id;
    });
    const [line] = await this.db.bankStatementLines.create([
      { organisationId: bank.organisationId, bankAccountId: bank._id, statementId, date: day, description: `M-Pesa charge ${payout.payeeName} ${payout.sourceNumber}`, reference: payout.transactionId ?? '', amount: toD128(charge.neg()) },
    ]);
    const entry = await this.db.ledger.findOne({ journalId, accountId: bank.glAccountId }).lean();
    if (entry) await this.banking.match(actor, bank._id, [line._id], [entry._id], 'AUTO').catch(() => undefined);
  }

  // ----- Resolving unconfirmed payouts and watching the float ---------------------------------

  /** Asks M-Pesa what became of a payout; the answer arrives at the status-result callback. */
  private async queryStatus(payout: MobileMoneyPayout) {
    const bank = (await this.db.bankAccounts.findById(payout.bankAccountId).lean())!;
    const p = bank.mpesa?.payouts;
    if (!bank.mpesa?.enabled || !p?.enabled || !p.securityCredential) return false;
    await this.db.payouts.updateOne({ _id: payout._id }, { statusQueriedAt: new Date(), $inc: { statusQueries: 1 } });
    const urls = this.mpesa.callbacks(bank);
    try {
      await this.mpesa.client(bank).transactionStatus({
        initiatorName: p.initiatorName,
        securityCredential: decryptSecret(p.securityCredential),
        shortCode: p.shortCode,
        transactionId: payout.transactionId,
        originalConversationId: payout.originatorConversationId,
        resultUrl: urls.statusResult(payout._id.toHexString()),
        timeoutUrl: urls.queryTimeout,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cron: asks about unconfirmed payouts and sent ones with no result after 15 minutes, at most every
   * 30 minutes and six times each; checks each account's float once a day.
   */
  async reconcile(opts: { organisationId?: Types.ObjectId } = {}) {
    const now = Date.now();
    const due = await this.db.payouts
      .find({
        ...(opts.organisationId && { organisationId: opts.organisationId }),
        statusQueries: { $lt: 6 },
        $and: [
          { $or: [{ status: 'CHECK' }, { status: 'SENT', sentAt: { $lte: new Date(now - 15 * 60_000) } }] },
          { $or: [{ statusQueriedAt: null }, { statusQueriedAt: { $lte: new Date(now - 30 * 60_000) } }] },
        ],
      })
      .limit(100)
      .lean();
    let queried = 0;
    for (const payout of due) if (await this.queryStatus(payout)) queried++;
    const banks = await this.db.bankAccounts
      .find({ ...(opts.organisationId && { organisationId: opts.organisationId }), 'mpesa.enabled': true, 'mpesa.payouts.enabled': true, $or: [{ 'mpesa.payouts.balance.requestedAt': null }, { 'mpesa.payouts.balance.requestedAt': { $lte: new Date(now - 20 * 3_600_000) } }] })
      .lean();
    let balances = 0;
    for (const bank of banks) if (await this.requestBalance(bank)) balances++;
    return { queried, balances };
  }

  async checkNow(user: AuthUser, id: Types.ObjectId) {
    const payout = await this.load(user, id);
    if (!['CHECK', 'SENT'].includes(payout.status)) throw new BadRequestException('Only payouts awaiting confirmation can be checked');
    if (payout.statusQueriedAt && Date.now() - payout.statusQueriedAt.getTime() < 60_000) throw new BadRequestException('Already asked M-Pesa in the last minute; the answer is on its way');
    if (!(await this.queryStatus(payout))) throw new BadRequestException('Could not reach M-Pesa; try again shortly');
    return this.db.payouts.findById(payout._id).lean();
  }

  async statusResult(secret: string, payoutId: string, body: unknown) {
    const bank = await this.mpesa.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    if (!Types.ObjectId.isValid(payoutId)) throw new BadRequestException('Unknown payout');
    const payout = await this.db.payouts.findOne({ _id: new Types.ObjectId(payoutId), bankAccountId: bank._id }).lean();
    const r = (body as { Result?: { ResultCode?: number | string; ResultDesc?: string; ResultParameters?: { ResultParameter?: { Key: string; Value?: string | number }[] | { Key: string; Value?: string | number } } } })?.Result;
    if (!payout || !r || !['CHECK', 'SENT'].includes(payout.status)) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const params = r.ResultParameters?.ResultParameter;
    const list = Array.isArray(params) ? params : params ? [params] : [];
    const value = (key: string) => list.find((p) => p.Key === key)?.Value;
    const state = String(value('TransactionStatus') ?? '').toLowerCase();
    const receipt = String(value('ReceiptNo') ?? '');
    if (Number(r.ResultCode) === 0 && state === 'completed') {
      const done = await this.db.payouts
        .findOneAndUpdate({ _id: payout._id, status: { $in: ['CHECK', 'SENT'] } }, { status: 'COMPLETED', resultCode: '0', resultDescription: 'Confirmed by status query', transactionId: receipt || payout.transactionId, completedAt: new Date(), note: '' }, { new: true })
        .lean();
      if (done) await this.recordStatementLine(bank, done);
    } else if (Number(r.ResultCode) === 0 && ['failed', 'cancelled', 'declined', 'expired'].includes(state)) {
      await this.db.payouts.updateOne({ _id: payout._id, status: { $in: ['CHECK', 'SENT'] } }, { status: 'FAILED', resultDescription: `M-Pesa reports the payout ${state}`, note: '' });
    } else {
      // Not found or not yet final: leave it for a person (or the next query) to resolve.
      await this.db.payouts.updateOne({ _id: payout._id }, { note: `Status check: ${r.ResultDesc ?? 'no answer'}` });
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  private async requestBalance(bank: BankAccount) {
    const p = bank.mpesa?.payouts;
    if (!bank.mpesa?.enabled || !p?.enabled || !p.securityCredential) return false;
    await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'mpesa.payouts.balance.requestedAt': new Date() });
    const urls = this.mpesa.callbacks(bank);
    try {
      await this.mpesa.client(bank).accountBalance({ initiatorName: p.initiatorName, securityCredential: decryptSecret(p.securityCredential), shortCode: p.shortCode, resultUrl: urls.balanceResult, timeoutUrl: urls.queryTimeout });
      return true;
    } catch {
      return false;
    }
  }

  async balanceNow(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId }).lean();
    if (!bank?.mpesa?.payouts?.enabled) throw new BadRequestException('M-Pesa payouts are not enabled on this account');
    const last = bank.mpesa.payouts.balance?.requestedAt;
    if (last && Date.now() - last.getTime() < 60_000) throw new BadRequestException('Already asked M-Pesa in the last minute; the balance is on its way');
    if (!(await this.requestBalance(bank))) throw new BadRequestException('Could not reach M-Pesa; try again shortly');
    return { requested: true };
  }

  async balanceResult(secret: string, body: unknown) {
    const bank = await this.mpesa.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    const r = (body as { Result?: { ResultCode?: number | string; ResultParameters?: { ResultParameter?: { Key: string; Value?: string | number }[] | { Key: string; Value?: string | number } } } })?.Result;
    if (!r || Number(r.ResultCode) !== 0) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const params = r.ResultParameters?.ResultParameter;
    const list = Array.isArray(params) ? params : params ? [params] : [];
    const accounts = parseBalances(list.find((p) => p.Key === 'AccountBalance')?.Value);
    // B2C pays from the utility account; fall back to the working account.
    const float = accounts.find((a) => /utility/i.test(a.name)) ?? accounts.find((a) => /working/i.test(a.name)) ?? accounts[0];
    if (!float) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const available = dec(float.available);
    await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'mpesa.payouts.balance.available': toD128(available), 'mpesa.payouts.balance.accounts': accounts, 'mpesa.payouts.balance.checkedAt': new Date() });
    const threshold = bank.mpesa?.payouts?.lowBalanceAlert ? dec(bank.mpesa.payouts.lowBalanceAlert) : null;
    const alerted = bank.mpesa?.payouts?.balance?.alertedAt;
    if (threshold && available.lt(threshold) && (!alerted || Date.now() - alerted.getTime() > 20 * 3_600_000)) {
      const roles = await this.db.roles.find({ organisationId: bank.organisationId, permissions: PERMISSIONS.PAYMENTS_APPROVE }, { _id: 1 }).lean();
      const users = await this.db.users.find({ organisationId: bank.organisationId, isActive: true, isServiceAccount: { $ne: true }, roleIds: { $in: roles.map((r) => r._id) } }, { _id: 1 }).lean();
      await this.workflow.notify(bank.organisationId, users.map((u) => u._id), {
        kind: 'mpesa_low_balance',
        title: `M-Pesa float low on ${bank.name}`,
        body: `KES ${available.toFixed(2)} available, below the alert level of KES ${threshold.toFixed()}. Top up before releasing more M-Pesa payments.`,
        link: `/finance/banking/${bank._id.toHexString()}`,
      });
      await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'mpesa.payouts.balance.alertedAt': new Date() });
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ----- Review -----------------------------------------------------------------------------------

  async list(user: AuthUser, q: { status?: string; limit: number }) {
    const rows = await this.db.payouts.find({ organisationId: user.organisationId, ...(q.status && { status: q.status }) }).sort({ createdAt: -1 }).limit(q.limit).lean();
    return rows.map((r) => ({ ...r, payeeNumber: r.payeeType === 'PHONE' ? `${r.payeeNumber.slice(0, 6)}••••${r.payeeNumber.slice(-2)}` : r.payeeNumber }));
  }

  /** The payout for a supplier payment or expense claim, for those who may see that document. */
  async forSource(user: AuthUser, sourceId: Types.ObjectId) {
    const any = [PERMISSIONS.AP_VIEW, PERMISSIONS.AR_VIEW, PERMISSIONS.BANKING_VIEW, PERMISSIONS.EXPENSES_PAY, PERMISSIONS.EXPENSES_APPROVE].some((p) => hasPermission(user, p));
    if (!any) throw new ForbiddenException('You cannot see payouts');
    const payout = await this.db.payouts.findOne({ organisationId: user.organisationId, sourceId }).lean();
    if (!payout) return null;
    const allowed =
      payout.sourceType === 'Payment'
        ? hasPermission(user, PERMISSIONS.AP_VIEW) || hasPermission(user, PERMISSIONS.BANKING_VIEW)
        : payout.sourceType === 'Refund'
          ? hasPermission(user, PERMISSIONS.AR_VIEW) || hasPermission(user, PERMISSIONS.BANKING_VIEW)
          : payout.sourceType === 'SalaryRun'
            ? hasPermission(user, PERMISSIONS.BANKING_MANAGE)
            : hasPermission(user, PERMISSIONS.EXPENSES_PAY) || hasPermission(user, PERMISSIONS.EXPENSES_APPROVE) || hasPermission(user, PERMISSIONS.BANKING_VIEW);
    if (!allowed) throw new ForbiddenException('You cannot see this payout');
    return payout;
  }

  private async load(user: AuthUser, id: Types.ObjectId) {
    const payout = await this.db.payouts.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!payout) throw new NotFoundException('Payout not found');
    const permission = payout.sourceType === 'ExpenseClaim' ? PERMISSIONS.EXPENSES_PAY : PERMISSIONS.PAYMENTS_APPROVE;
    if (!hasPermission(user, permission)) throw new ForbiddenException(`Missing permission: ${permission}`);
    return payout;
  }

  /**
   * Sends a failed payout again. When M-Pesa never answered (CHECK), the user must confirm they checked
   * the M-Pesa statement and the money did not go.
   */
  async retry(user: AuthUser, id: Types.ObjectId, confirmNotPaid: boolean) {
    const payout = await this.load(user, id);
    if (payout.status !== 'FAILED' && payout.status !== 'CHECK') throw new BadRequestException('Only failed or unconfirmed payouts can be sent again');
    if (payout.status === 'CHECK' && !confirmNotPaid) throw new BadRequestException('Confirm that the M-Pesa statement shows this was not paid');
    const bank = (await this.db.bankAccounts.findById(payout.bankAccountId).lean())!;
    // Retries count against today's limit like a new payout.
    await this.checkAmount(bank, dec(payout.amount));
    await this.db.payouts.updateOne({ _id: payout._id }, { status: 'QUEUED', originatorConversationId: randomUUID(), conversationId: null, resultCode: null, resultDescription: '', note: '', lockedUntil: null });
    await this.audit.log(user, { action: 'mpesa.payout_retry', recordType: payout.sourceType, recordId: payout.sourceId, summary: `Sent the M-Pesa payout for ${payout.sourceNumber} to ${payout.payeeName} again${payout.status === 'CHECK' ? ' after confirming it had not been paid' : ''}` });
    await this.deliverDue({ organisationId: user.organisationId, limit: 5 });
    return this.db.payouts.findById(payout._id).lean();
  }

  /** Gives up on a supplier payout that was not paid; the payment can then be voided or paid another way. */
  async cancel(user: AuthUser, id: Types.ObjectId, input: { confirmNotPaid: boolean; reason: string }) {
    const payout = await this.load(user, id);
    if (!['QUEUED', 'FAILED', 'CHECK'].includes(payout.status)) throw new BadRequestException('Only payouts that have not been paid can be cancelled');
    if (payout.status === 'CHECK' && !input.confirmNotPaid) throw new BadRequestException('Confirm that the M-Pesa statement shows this was not paid');
    await this.db.payouts.updateOne({ _id: payout._id, status: payout.status }, { status: 'CANCELLED', note: input.reason });
    await this.audit.log(user, { action: 'mpesa.payout_cancel', recordType: payout.sourceType, recordId: payout.sourceId, summary: `Cancelled the M-Pesa payout for ${payout.sourceNumber} to ${payout.payeeName}: ${input.reason}` });
    return this.db.payouts.findById(payout._id).lean();
  }
}
