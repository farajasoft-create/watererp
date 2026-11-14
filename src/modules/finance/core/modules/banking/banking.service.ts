import { BadRequestException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { BankAccount, BankStatementLine } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { LedgerEntry } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { SettlementService } from '../settlement/settlement.service';

export interface BankAccountInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  name: string;
  type?: 'BANK' | 'CASH' | 'MOBILE_MONEY' | 'PETTY_CASH';
  bankName?: string;
  accountNumber?: string;
  glAccountId: Types.ObjectId;
  reconcileFrom?: Date | null;
  isActive?: boolean;
}

export interface TransferInput {
  entityId: Types.ObjectId;
  fromBankAccountId: Types.ObjectId;
  toBankAccountId: Types.ObjectId;
  date: Date;
  amount: Decimal;
  toAmount?: Decimal | null;
  reference?: string;
  description?: string;
}

export interface StatementLineInput {
  date: Date;
  description?: string;
  reference?: string;
  amount: Decimal;
}

/** Signed amount of a ledger entry from the bank's point of view (money in positive). */
const signed = (e: Pick<LedgerEntry, 'debitTx' | 'creditTx'>) => dec(e.debitTx).minus(dec(e.creditTx));
const DAY = 86_400_000;

export class BankingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly settlement: SettlementService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Bank accounts
  // ------------------------------------------------------------------------------------------

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  /** What the app shows of an account: the M-Pesa connection without its credentials. */
  static present<T extends Pick<BankAccount, 'mpesa' | 'card' | 'feed'>>(bank: T) {
    const m = bank.mpesa;
    // Keys and tokens never leave the server; settings endpoints show whether they are set.
    return {
      ...bank,
      mpesa: m?.enabled ? { enabled: true, environment: m.environment, shortCode: m.shortCode, shortCodeType: m.shortCodeType } : { enabled: false },
      card: { enabled: !!bank.card?.enabled, provider: bank.card?.provider ?? 'STRIPE' },
      feed: { enabled: !!bank.feed?.enabled, provider: bank.feed?.provider ?? 'PUSH', lastSyncAt: bank.feed?.lastSyncAt ?? null, lastError: bank.feed?.lastError ?? '' },
    };
  }

  async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<BankAccount> {
    const bank = await this.db.bankAccounts.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    return bank;
  }

  /** Book balance in the account's currency, from the ledger. */
  async bookBalance(bank: BankAccount, asOf?: Date, session?: ClientSession): Promise<Decimal> {
    const [row] = await this.db.ledger
      .aggregate<{ debit: unknown; credit: unknown }>([
        { $match: { organisationId: bank.organisationId, entityId: bank.entityId, accountId: bank.glAccountId, ...(asOf && { date: { $lte: asOf } }) } },
        { $group: { _id: null, debit: { $sum: '$debitTx' }, credit: { $sum: '$creditTx' } } },
      ])
      .session(session ?? null);
    return row ? dec(row.debit as never).minus(dec(row.credit as never)) : new Decimal(0);
  }

  async list(user: AuthUser, entityId?: Types.ObjectId) {
    const filter = this.scope(user);
    if (entityId) filter.entityId = entityId;
    const banks = await this.db.bankAccounts.find(filter).sort({ name: 1 }).lean();
    const accounts = await this.db.accounts.find({ _id: { $in: banks.map((b) => b.glAccountId) } }, { code: 1, name: 1 }).lean();
    return Promise.all(
      banks.map(async (b) => {
        const [balance, unmatched] = await Promise.all([
          this.bookBalance(b),
          this.db.bankStatementLines.countDocuments({ organisationId: user.organisationId, bankAccountId: b._id, status: 'UNMATCHED' }),
        ]);
        const gl = accounts.find((a) => a._id.equals(b.glAccountId));
        return { ...BankingService.present(b), balance, unmatchedStatementLines: unmatched, glAccountCode: gl?.code, glAccountName: gl?.name };
      }),
    );
  }

  private async validate(user: AuthUser, input: Partial<BankAccountInput>, existing?: BankAccount) {
    const entityId = input.entityId ?? existing?.entityId;
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const branchId = input.branchId ?? existing?.branchId;
    const branch = await this.db.branches.findOne({ _id: branchId, organisationId: user.organisationId }).lean();
    if (!branch || !branch.entityId.equals(entity._id)) throw new BadRequestException('The branch must belong to the entity');
    assertBranchAccess(user, [branch._id]);
    const glId = input.glAccountId ?? existing?.glAccountId;
    const gl = await this.db.accounts.findOne({ _id: glId, organisationId: user.organisationId }).lean();
    if (!gl || !gl.isPostable || !['BANK', 'CASH'].includes(gl.accountType)) {
      throw new BadRequestException('Link a postable general-ledger account of type Bank or Cash');
    }
    if (gl.entityIds.length && !gl.entityIds.some((e) => e.equals(entity._id))) throw new BadRequestException(`${gl.code} is not available in ${entity.code}`);
    return { entity, currency: gl.currency ?? entity.functionalCurrency };
  }

  async create(user: AuthUser, input: BankAccountInput) {
    const { currency } = await this.validate(user, input);
    const [bank] = await this.db.bankAccounts.create([{ ...input, currency, organisationId: user.organisationId }]);
    await this.audit.log(user, { action: 'bank_account.create', recordType: 'BankAccount', recordId: bank._id, summary: `Created bank account ${bank.name}`, after: BankingService.present(bank.toObject() as BankAccount) });
    return BankingService.present(bank.toObject() as BankAccount);
  }

  async update(user: AuthUser, id: Types.ObjectId, input: Partial<BankAccountInput>) {
    const before = await this.load(user, id);
    if ((input.glAccountId && !input.glAccountId.equals(before.glAccountId)) || (input.entityId && !input.entityId.equals(before.entityId))) {
      const used = await this.db.payments.exists({ organisationId: user.organisationId, bankAccountId: before._id });
      const imported = await this.db.bankStatementLines.exists({ organisationId: user.organisationId, bankAccountId: before._id });
      if (used || imported) throw new BadRequestException('The ledger account or entity cannot change once the account has transactions');
    }
    const { currency } = await this.validate(user, input, before);
    const after = await this.db.bankAccounts.findByIdAndUpdate(before._id, { ...input, currency }, { new: true }).lean();
    await this.audit.log(user, { action: 'bank_account.update', recordType: 'BankAccount', recordId: before._id, summary: `Updated bank account ${before.name}`, before: BankingService.present(before), after: after && BankingService.present(after) });
    return after && BankingService.present(after);
  }

  // ------------------------------------------------------------------------------------------
  // Transfers between bank and cash accounts (with FX when the currencies differ)
  // ------------------------------------------------------------------------------------------

  async transfer(user: AuthUser, input: TransferInput) {
    if (input.fromBankAccountId.equals(input.toBankAccountId)) throw new BadRequestException('Choose two different accounts');
    if (input.amount.lte(0)) throw new BadRequestException('The amount must be positive');
    return this.db.transaction(async (session) => {
      const from = await this.load(user, input.fromBankAccountId, session);
      const to = await this.load(user, input.toBankAccountId, session);
      if (!from.entityId.equals(input.entityId) || !to.entityId.equals(input.entityId)) throw new BadRequestException('Both accounts must belong to the entity');
      if (!from.isActive || !to.isActive) throw new BadRequestException('Both accounts must be active');
      const entity = (await this.db.entities.findById(input.entityId).session(session).lean())!;
      const functional = entity.functionalCurrency;
      const fp = await this.currencies.precision(functional);
      const sameCurrency = from.currency === to.currency;
      const toAmount = sameCurrency ? input.amount : input.toAmount;
      if (!toAmount || toAmount.lte(0)) throw new BadRequestException(`Enter the amount received in ${to.currency}`);
      if (sameCurrency && input.toAmount && !input.toAmount.eq(input.amount)) throw new BadRequestException('Both sides of a same-currency transfer must match');

      const rateOf = async (currency: string) => {
        if (currency === functional) return new Decimal(1);
        const r = await this.currencies.findRate(user.organisationId, currency, functional, input.date, 'SPOT', session);
        if (!r) throw new BadRequestException(`No approved ${currency}/${functional} rate on or before ${input.date.toISOString().slice(0, 10)}`);
        return r.rate;
      };
      const fromRate = await rateOf(from.currency);
      const toRate = await rateOf(to.currency);
      const fromF = round(input.amount.times(fromRate), fp);
      const toF = round(toAmount.times(toRate), fp);
      const number = await this.db.nextNumber(user.organisationId, entity, 'TRF', session);
      const description = input.description || `Transfer ${from.name} → ${to.name}`;
      const lines: LineInput[] = [
        { accountId: to.glAccountId, branchId: to.branchId, currency: to.currency, exchangeRate: toRate, debit: toAmount, functionalDebit: toF, functionalCredit: new Decimal(0), description },
        { accountId: from.glAccountId, branchId: from.branchId, currency: from.currency, exchangeRate: fromRate, credit: input.amount, functionalDebit: new Decimal(0), functionalCredit: fromF, description },
      ];
      const diff = fromF.minus(toF); // positive: value lost on conversion
      if (!diff.isZero()) {
        const fx = await this.settlement.accounts(user.organisationId, session);
        const account = diff.gt(0) ? fx.fxLoss : fx.fxGain;
        if (!account) throw new BadRequestException('Set the realised FX gain and loss accounts in organisation settings first');
        const amount = diff.abs();
        lines.push({
          accountId: account,
          branchId: from.branchId,
          currency: functional,
          description: `FX on ${number}`,
          debit: diff.gt(0) ? amount : null,
          credit: diff.gt(0) ? null : amount,
          functionalDebit: diff.gt(0) ? amount : new Decimal(0),
          functionalCredit: diff.gt(0) ? new Decimal(0) : amount,
        });
      }
      const id = new Types.ObjectId();
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: entity._id, branchId: from.branchId, journalDate: input.date, description, reference: input.reference, lines },
        { sourceType: 'BankTransfer', sourceId: id, sourceNumber: number },
        session,
      );
      const [transfer] = await this.db.bankTransfers.create(
        [
          {
            _id: id,
            organisationId: user.organisationId,
            entityId: entity._id,
            branchId: from.branchId,
            number,
            date: input.date,
            fromBankAccountId: from._id,
            toBankAccountId: to._id,
            fromAmount: toD128(input.amount),
            toAmount: toD128(toAmount),
            fromRate: toD128(fromRate),
            toRate: toD128(toRate),
            reference: input.reference ?? '',
            description,
            journalId: journal._id,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.log(
        user,
        {
          action: 'bank_transfer.create',
          recordType: 'BankTransfer',
          recordId: transfer._id,
          summary: `${number}: ${input.amount.toFixed()} ${from.currency} from ${from.name} to ${to.name} (${journal.number})`,
        },
        session,
      );
      return transfer.toObject();
    });
  }

  async transfers(user: AuthUser, entityId?: Types.ObjectId) {
    const filter = this.scope(user);
    if (entityId) filter.entityId = entityId;
    return this.db.bankTransfers.find(filter).sort({ date: -1, number: -1 }).limit(200).lean();
  }

  // ------------------------------------------------------------------------------------------
  // Statements
  // ------------------------------------------------------------------------------------------

  /** Imports statement lines; lines already imported (same date, amount and reference/description) are skipped. */
  async importStatement(user: AuthUser, bankId: Types.ObjectId, input: { name?: string; closingBalance?: Decimal | null; lines: StatementLineInput[] }) {
    const bank = await this.load(user, bankId);
    const precision = await this.currencies.precision(bank.currency);
    if (!input.lines.length) throw new BadRequestException('The statement has no lines');
    for (const [i, l] of input.lines.entries()) {
      if (l.amount.isZero()) throw new BadRequestException(`Row ${i + 1}: amount cannot be zero`);
      if (l.amount.decimalPlaces() > precision) throw new BadRequestException(`Row ${i + 1}: ${bank.currency} allows at most ${precision} decimal places`);
    }
    const dates = input.lines.map((l) => l.date.getTime());
    const fromDate = new Date(Math.min(...dates));
    const toDate = new Date(Math.max(...dates));
    if (bank.lastReconciledDate && fromDate <= bank.lastReconciledDate) {
      throw new BadRequestException(`The account is reconciled to ${bank.lastReconciledDate.toISOString().slice(0, 10)}; import lines after that date`);
    }
    const existing = await this.db.bankStatementLines
      .find({ organisationId: user.organisationId, bankAccountId: bank._id, date: { $gte: fromDate, $lte: toDate } }, { date: 1, amount: 1, reference: 1, description: 1 })
      .lean();
    const key = (l: { date: Date; amount: unknown; reference?: string | null; description?: string | null }) =>
      `${l.date.toISOString().slice(0, 10)}|${dec(l.amount as never).toFixed()}|${(l.reference || l.description || '').trim().toLowerCase()}`;
    const seen = new Set(existing.map(key));
    const fresh = input.lines.filter((l) => {
      const k = key(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return this.db.transaction(async (session) => {
      const [statement] = await this.db.bankStatements.create(
        [
          {
            organisationId: user.organisationId,
            bankAccountId: bank._id,
            name: input.name ?? `Statement ${fromDate.toISOString().slice(0, 10)} – ${toDate.toISOString().slice(0, 10)}`,
            fromDate,
            toDate,
            closingBalance: input.closingBalance ? toD128(input.closingBalance) : null,
            lineCount: fresh.length,
            createdBy: user.id,
          },
        ],
        { session },
      );
      if (fresh.length) {
        await this.db.bankStatementLines.insertMany(
          fresh.map((l) => ({
            organisationId: user.organisationId,
            bankAccountId: bank._id,
            statementId: statement._id,
            date: l.date,
            description: l.description ?? '',
            reference: l.reference ?? '',
            amount: toD128(l.amount),
          })),
          { session },
        );
      }
      await this.audit.log(
        user,
        {
          action: 'bank_statement.import',
          recordType: 'BankAccount',
          recordId: bank._id,
          summary: `Imported ${fresh.length} statement line(s) into ${bank.name}${fresh.length < input.lines.length ? `; skipped ${input.lines.length - fresh.length} duplicate(s)` : ''}`,
        },
        session,
      );
      return { statementId: statement._id, imported: fresh.length, duplicates: input.lines.length - fresh.length };
    });
  }

  // ------------------------------------------------------------------------------------------
  // Reconciliation
  // ------------------------------------------------------------------------------------------

  private async unmatchedEntries(bank: BankAccount, asOf: Date | null, session?: ClientSession) {
    const filter: Record<string, unknown> = { organisationId: bank.organisationId, entityId: bank.entityId, accountId: bank.glAccountId };
    filter.date = { ...(bank.reconcileFrom && { $gte: bank.reconcileFrom }), ...(asOf && { $lte: asOf }) };
    if (!bank.reconcileFrom && !asOf) delete filter.date;
    const entries = await this.db.ledger.find(filter).sort({ date: 1, journalNumber: 1 }).limit(5000).session(session ?? null).lean();
    const matched = await this.db.bankMatches
      .find({ ledgerEntryIds: { $in: entries.map((e) => e._id) } }, { ledgerEntryIds: 1 })
      .session(session ?? null)
      .lean();
    const done = new Set(matched.flatMap((m) => m.ledgerEntryIds.map(String)));
    return entries.filter((e) => !done.has(e._id.toHexString()));
  }

  /**
   * The reconciliation workspace as at a date: unmatched statement lines and book entries, and the
   * check that the statement balance plus outstanding items agrees with the ledger.
   */
  async workspace(user: AuthUser, bankId: Types.ObjectId, asOf: Date, statementBalance?: Decimal | null) {
    const bank = await this.load(user, bankId);
    const [bookBalance, entries, lines, recent, last] = await Promise.all([
      this.bookBalance(bank, asOf),
      this.unmatchedEntries(bank, asOf),
      this.db.bankStatementLines.find({ organisationId: user.organisationId, bankAccountId: bank._id, status: 'UNMATCHED' }).sort({ date: 1 }).limit(2000).lean(),
      this.db.bankMatches.find({ organisationId: user.organisationId, bankAccountId: bank._id }).sort({ createdAt: -1 }).limit(50).lean(),
      this.db.bankReconciliations.findOne({ organisationId: user.organisationId, bankAccountId: bank._id }).sort({ statementDate: -1 }).lean(),
    ]);
    const linesToDate = lines.filter((l) => l.date <= asOf);
    const unpresented = sum(entries.map(signed));
    const unrecorded = sum(linesToDate.map((l) => l.amount));
    const latestStatement = await this.db.bankStatements
      .findOne({ organisationId: user.organisationId, bankAccountId: bank._id, toDate: { $lte: asOf }, closingBalance: { $ne: null } })
      .sort({ toDate: -1 })
      .lean();
    const balance = statementBalance ?? (latestStatement?.closingBalance ? dec(latestStatement.closingBalance) : null);
    // Book = statement + book items not yet on the statement - statement items not yet in the books.
    const expectedBook = balance ? balance.plus(unpresented).minus(unrecorded) : null;

    const matchedLines = await this.db.bankStatementLines.find({ _id: { $in: recent.flatMap((m) => m.statementLineIds) } }).lean();
    const matchedEntries = await this.db.ledger.find({ _id: { $in: recent.flatMap((m) => m.ledgerEntryIds) } }).lean();
    return {
      bankAccount: { id: bank._id, name: bank.name, currency: bank.currency, reconcileFrom: bank.reconcileFrom, lastReconciledDate: bank.lastReconciledDate },
      asOf,
      bookBalance,
      statementBalance: balance,
      statementBalanceSource: statementBalance ? 'entered' : latestStatement ? 'imported' : null,
      unpresentedTotal: unpresented,
      unrecordedTotal: unrecorded,
      difference: expectedBook ? bookBalance.minus(expectedBook) : null,
      canComplete: !!expectedBook && bookBalance.eq(expectedBook) && linesToDate.length === 0 && (!bank.lastReconciledDate || asOf > bank.lastReconciledDate),
      statementLines: lines,
      ledgerEntries: entries.map((e) => ({ ...e, amount: signed(e) })),
      recentMatches: recent.map((m) => ({
        ...m,
        lines: matchedLines.filter((l) => m.statementLineIds.some((x) => x.equals(l._id))),
        entries: matchedEntries.filter((e) => m.ledgerEntryIds.some((x) => x.equals(e._id))).map((e) => ({ ...e, amount: signed(e) })),
      })),
      lastReconciliation: last,
      suggestions: this.suggest(lines, entries),
    };
  }

  /** One-to-one candidates: same amount, within seven days, nearest date (and matching reference) first. */
  private suggest(lines: BankStatementLine[], entries: LedgerEntry[]) {
    const used = new Set<string>();
    const out: { statementLineId: Types.ObjectId; ledgerEntryId: Types.ObjectId; score: number }[] = [];
    for (const line of lines) {
      const amount = dec(line.amount);
      const candidates = entries
        .filter((e) => !used.has(e._id.toHexString()) && signed(e).eq(amount) && Math.abs(e.date.getTime() - line.date.getTime()) <= 7 * DAY)
        .map((e) => {
          const text = `${line.reference} ${line.description}`.toLowerCase();
          const ref = [e.journalNumber, e.description].some((t) => t && text.includes(t.toLowerCase().slice(0, 12)));
          return { e, score: Math.abs(e.date.getTime() - line.date.getTime()) / DAY - (ref ? 10 : 0) };
        })
        .sort((a, b) => a.score - b.score);
      if (candidates[0]) {
        used.add(candidates[0].e._id.toHexString());
        out.push({ statementLineId: line._id, ledgerEntryId: candidates[0].e._id, score: candidates[0].score });
      }
    }
    return out;
  }

  async autoMatch(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.load(user, bankId);
    const lines = await this.db.bankStatementLines.find({ organisationId: user.organisationId, bankAccountId: bank._id, status: 'UNMATCHED' }).lean();
    const entries = await this.unmatchedEntries(bank, null);
    const suggestions = this.suggest(lines, entries);
    let matched = 0;
    for (const s of suggestions) {
      await this.match(user, bankId, [s.statementLineId], [s.ledgerEntryId], 'AUTO');
      matched++;
    }
    return { matched };
  }

  /** Matches statement lines to ledger entries; the two sides must total the same. */
  async match(user: AuthUser, bankId: Types.ObjectId, statementLineIds: Types.ObjectId[], ledgerEntryIds: Types.ObjectId[], kind: 'MANUAL' | 'AUTO' | 'ADJUSTMENT' = 'MANUAL', session?: ClientSession) {
    const run = async (s: ClientSession) => {
      const bank = await this.load(user, bankId, s);
      if (!statementLineIds.length || !ledgerEntryIds.length) throw new BadRequestException('Select at least one statement line and one ledger entry');
      const lines = await this.db.bankStatementLines.find({ organisationId: user.organisationId, bankAccountId: bank._id, _id: { $in: statementLineIds }, status: 'UNMATCHED' }).session(s).lean();
      if (lines.length !== new Set(statementLineIds.map(String)).size) throw new BadRequestException('Statement lines not found or already matched');
      const entries = await this.db.ledger.find({ organisationId: user.organisationId, entityId: bank.entityId, accountId: bank.glAccountId, _id: { $in: ledgerEntryIds } }).session(s).lean();
      if (entries.length !== new Set(ledgerEntryIds.map(String)).size) throw new BadRequestException(`Ledger entries must be on ${bank.name}'s ledger account`);
      const lineTotal = sum(lines.map((l) => l.amount));
      const entryTotal = sum(entries.map(signed));
      if (!lineTotal.eq(entryTotal)) throw new BadRequestException(`The statement lines (${lineTotal.toFixed()}) and ledger entries (${entryTotal.toFixed()}) do not agree`);
      const [match] = await this.db.bankMatches.create([{ organisationId: user.organisationId, bankAccountId: bank._id, statementLineIds, ledgerEntryIds, kind, createdBy: user.id }], { session: s });
      const updated = await this.db.bankStatementLines.updateMany({ _id: { $in: statementLineIds }, status: 'UNMATCHED' }, { status: 'MATCHED', matchId: match._id }, { session: s });
      if (updated.modifiedCount !== lines.length) throw new BadRequestException('A statement line was matched by someone else; reload and try again');
      await this.audit.log(
        user,
        { action: 'bank.match', recordType: 'BankAccount', recordId: bank._id, summary: `${kind === 'AUTO' ? 'Auto-matched' : 'Matched'} ${lines.length} statement line(s) to ${entries.map((e) => e.journalNumber).join(', ')}` },
        s,
      );
      return match.toObject();
    };
    return session ? run(session) : this.db.transaction(run);
  }

  async unmatch(user: AuthUser, matchId: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const match = await this.db.bankMatches.findOne({ _id: matchId, organisationId: user.organisationId }).session(session).lean();
      if (!match) throw new NotFoundException('Match not found');
      await this.load(user, match.bankAccountId, session);
      if (match.reconciliationId) throw new BadRequestException('This match is part of a completed reconciliation and is locked');
      await this.db.bankMatches.deleteOne({ _id: match._id }, { session });
      await this.db.bankStatementLines.updateMany({ _id: { $in: match.statementLineIds } }, { status: 'UNMATCHED', matchId: null }, { session });
      await this.audit.log(user, { action: 'bank.unmatch', recordType: 'BankAccount', recordId: match.bankAccountId, summary: `Unmatched ${match.statementLineIds.length} statement line(s)` }, session);
      return { id: matchId, unmatched: true };
    });
  }

  /** Records a statement-only item (bank charges, interest, ...) in the ledger and matches it. */
  async adjust(user: AuthUser, bankId: Types.ObjectId, input: { statementLineId: Types.ObjectId; accountId: Types.ObjectId; description?: string }) {
    return this.db.transaction(async (session) => {
      const bank = await this.load(user, bankId, session);
      const line = await this.db.bankStatementLines.findOne({ _id: input.statementLineId, organisationId: user.organisationId, bankAccountId: bank._id }).session(session).lean();
      if (!line) throw new NotFoundException('Statement line not found');
      if (line.status !== 'UNMATCHED') throw new BadRequestException('The statement line is already matched');
      const contra = await this.db.accounts.findOne({ _id: input.accountId, organisationId: user.organisationId }).session(session).lean();
      if (!contra) throw new BadRequestException('Account not found');
      if (contra._id.equals(bank.glAccountId)) throw new BadRequestException('Choose the account the item belongs to, not the bank account');
      const amount = dec(line.amount);
      const inflow = amount.gt(0);
      const description = input.description || line.description || 'Bank adjustment';
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId: bank.entityId,
          branchId: bank.branchId,
          journalDate: line.date,
          description: `${bank.name}: ${description}`,
          reference: line.reference,
          lines: [
            { accountId: bank.glAccountId, currency: bank.currency, debit: inflow ? amount : null, credit: inflow ? null : amount.abs(), description },
            { accountId: contra._id, currency: contra.currency ?? bank.currency, debit: inflow ? null : amount.abs(), credit: inflow ? amount : null, description },
          ],
        },
        { sourceType: 'BankStatementLine', sourceId: line._id, sourceNumber: `${bank.name} ${line.date.toISOString().slice(0, 10)}` },
        session,
      );
      const entry = await this.db.ledger.findOne({ journalId: journal._id, lineNo: 1 }).session(session).lean();
      await this.match(user, bankId, [line._id], [entry!._id], 'ADJUSTMENT', session);
      return journal;
    });
  }

  /** Completes and locks a reconciliation once the statement agrees with the ledger. */
  async complete(user: AuthUser, bankId: Types.ObjectId, input: { statementDate: Date; statementBalance: Decimal; notes?: string }) {
    return this.db.transaction(async (session) => {
      const bank = await this.load(user, bankId, session);
      if (bank.lastReconciledDate && input.statementDate <= bank.lastReconciledDate) {
        throw new BadRequestException(`Already reconciled to ${bank.lastReconciledDate.toISOString().slice(0, 10)}`);
      }
      const bookBalance = await this.bookBalance(bank, input.statementDate, session);
      const entries = await this.unmatchedEntries(bank, input.statementDate, session);
      const pendingLines = await this.db.bankStatementLines
        .countDocuments({ organisationId: user.organisationId, bankAccountId: bank._id, status: 'UNMATCHED', date: { $lte: input.statementDate } })
        .session(session);
      if (pendingLines) throw new BadRequestException(`${pendingLines} statement line(s) on or before the statement date are unmatched; match or adjust them first`);
      const unpresented = sum(entries.map(signed));
      const expected = input.statementBalance.plus(unpresented);
      if (!expected.eq(bookBalance)) {
        throw new BadRequestException(
          `Not reconciled: statement ${input.statementBalance.toFixed()} + unpresented ${unpresented.toFixed()} = ${expected.toFixed()}, but the ledger shows ${bookBalance.toFixed()}`,
        );
      }
      const lockable = await this.db.bankMatches.find({ organisationId: user.organisationId, bankAccountId: bank._id, reconciliationId: null }).session(session).lean();
      const lineDates = await this.db.bankStatementLines.find({ _id: { $in: lockable.flatMap((m) => m.statementLineIds) } }, { date: 1 }).session(session).lean();
      const toLock = lockable.filter((m) => m.statementLineIds.every((id) => (lineDates.find((l) => l._id.equals(id))?.date ?? input.statementDate) <= input.statementDate));
      const [rec] = await this.db.bankReconciliations.create(
        [
          {
            organisationId: user.organisationId,
            bankAccountId: bank._id,
            statementDate: input.statementDate,
            statementBalance: toD128(input.statementBalance),
            bookBalance: toD128(bookBalance),
            unpresentedTotal: toD128(unpresented),
            outstanding: entries.map((e) => ({ ledgerEntryId: e._id, date: e.date, journalNumber: e.journalNumber, description: e.description, amount: toD128(signed(e)) })),
            matchedCount: toLock.length,
            notes: input.notes ?? '',
            completedBy: user.id,
            completedAt: new Date(),
          },
        ],
        { session },
      );
      await this.db.bankMatches.updateMany({ _id: { $in: toLock.map((m) => m._id) } }, { reconciliationId: rec._id }, { session });
      await this.db.bankAccounts.updateOne({ _id: bank._id }, { lastReconciledDate: input.statementDate, lastReconciledBalance: toD128(input.statementBalance) }, { session });
      await this.audit.log(
        user,
        {
          action: 'bank.reconcile',
          recordType: 'BankAccount',
          recordId: bank._id,
          summary: `Reconciled ${bank.name} to ${input.statementDate.toISOString().slice(0, 10)}: statement ${input.statementBalance.toFixed()} ${bank.currency}, ${entries.length} unpresented item(s)`,
        },
        session,
      );
      return rec.toObject();
    });
  }

  async reconciliations(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.load(user, bankId);
    return this.db.bankReconciliations.find({ organisationId: user.organisationId, bankAccountId: bank._id }).sort({ statementDate: -1 }).lean();
  }
}
