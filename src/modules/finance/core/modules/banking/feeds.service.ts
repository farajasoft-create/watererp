import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { actorFor, AuthUser } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, toD128 } from '../../common/money';
import { decryptSecret, encryptSecret } from '../../common/totp';
import { BankAccount } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl } from '../communication/email.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { BankingService } from './banking.service';

export interface FeedTransaction {
  /** The provider's id for the transaction (used to skip ones already received). */
  id: string;
  date: Date;
  /** Signed: money in positive, money out negative. */
  amount: Decimal;
  description?: string;
  reference?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Mono (open banking for African banks): GET /v2/accounts/{id}/transactions, amounts in minor units. */
async function monoTransactions(secretKey: string, accountId: string, from: Date): Promise<FeedTransaction[]> {
  const base = process.env.MONO_API_BASE ?? 'https://api.withmono.com';
  const start = `${String(from.getUTCDate()).padStart(2, '0')}-${String(from.getUTCMonth() + 1).padStart(2, '0')}-${from.getUTCFullYear()}`;
  const out: FeedTransaction[] = [];
  let url: string | null = `${base}/v2/accounts/${encodeURIComponent(accountId)}/transactions?start=${start}&paginate=true&limit=200`;
  for (let page = 0; url && page < 50; page++) {
    const res = await fetch(url, { headers: { 'mono-sec-key': secretKey, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      data?: { id?: string; _id?: string; date?: string; amount?: number; type?: string; narration?: string; reference?: string }[];
      meta?: { next?: string | null };
    };
    if (!res.ok) throw new Error(`Bank feed (${res.status}): ${body.message ?? 'request failed'}`);
    for (const t of body.data ?? []) {
      const id = t.id ?? t._id;
      if (!id || !t.date || typeof t.amount !== 'number') continue;
      const amount = new Decimal(t.amount).div(100);
      out.push({ id, date: new Date(t.date), amount: t.type === 'debit' ? amount.abs().neg() : amount.abs(), description: t.narration ?? '', reference: t.reference ?? '' });
    }
    url = body.meta?.next ?? null;
  }
  return out;
}

/**
 * Bank feeds: transactions arrive as statement lines without importing files. A feed either pulls from an
 * open-banking aggregator (Mono) on the scheduled run, or accepts transactions pushed to its endpoint by
 * the bank or a connector with a bearer token. Each transaction is taken once (by the provider's id),
 * into a statement per day, and auto-matched to the ledger.
 */
export class BankFeedsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly banking: BankingService,
  ) {}

  private view(bank: BankAccount, token?: string) {
    const f = bank.feed;
    return {
      enabled: !!f?.enabled,
      provider: f?.provider ?? 'PUSH',
      externalAccountId: f?.externalAccountId ?? '',
      hasSecretKey: !!f?.secretKey,
      hasPushToken: !!f?.pushTokenHash,
      pushUrl: `${appUrl()}/api/v1/finance/bank-feeds/${bank._id.toHexString()}/transactions`,
      lastSyncAt: f?.lastSyncAt ?? null,
      syncFrom: f?.syncFrom ?? null,
      lastError: f?.lastError ?? '',
      postAsUserId: f?.postAsUserId ?? null,
      ...(token && { pushToken: token }),
    };
  }

  private async account(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    return bank;
  }

  async settings(user: AuthUser, bankId: Types.ObjectId) {
    return this.view(await this.account(user, bankId));
  }

  /** Sets up the feed. A push token is shown once, when created or rotated. */
  async configure(user: AuthUser, bankId: Types.ObjectId, input: { enabled: boolean; provider: 'MONO' | 'PUSH'; externalAccountId?: string; secretKey?: string; syncFrom?: Date | null; rotateToken?: boolean; postAsUserId?: Types.ObjectId | null }) {
    const bank = await this.account(user, bankId);
    const postAs = input.postAsUserId ?? bank.feed?.postAsUserId ?? user.id;
    if (input.enabled && input.provider === 'MONO') {
      if (!input.externalAccountId?.trim() && !bank.feed?.externalAccountId) throw new BadRequestException('Enter the connected account id from Mono');
      if (!input.secretKey && !bank.feed?.secretKey) throw new BadRequestException('Enter the Mono secret key');
    }
    const update: Record<string, unknown> = { 'feed.enabled': input.enabled, 'feed.provider': input.provider, 'feed.postAsUserId': postAs };
    if (input.externalAccountId !== undefined) update['feed.externalAccountId'] = input.externalAccountId.trim();
    if (input.secretKey) update['feed.secretKey'] = encryptSecret(input.secretKey.trim());
    if (input.syncFrom !== undefined) update['feed.syncFrom'] = input.syncFrom;
    let token: string | undefined;
    if (input.provider === 'PUSH' && (input.rotateToken || !bank.feed?.pushTokenHash)) {
      token = `bf_${randomBytes(24).toString('base64url')}`;
      update['feed.pushTokenHash'] = sha256(token);
    }
    await this.db.bankAccounts.updateOne({ _id: bank._id }, update);
    await this.audit.log(user, { action: 'bank_account.feed', recordType: 'BankAccount', recordId: bank._id, summary: `${input.enabled ? 'Enabled' : 'Disabled'} the ${input.provider === 'MONO' ? 'Mono' : 'push'} bank feed on ${bank.name}${token ? ' (new token)' : ''}` });
    return this.view((await this.db.bankAccounts.findById(bank._id).lean())!, token);
  }

  /** Transactions pushed by the bank or a connector (bearer token). */
  async push(bankId: string, authorization: string | null, transactions: FeedTransaction[]) {
    if (!Types.ObjectId.isValid(bankId)) throw new ForbiddenException('Unknown feed');
    const bank = await this.db.bankAccounts.findById(bankId).lean();
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expected = Buffer.from(bank?.feed?.pushTokenHash ?? '', 'hex');
    const given = Buffer.from(sha256(token), 'hex');
    if (!bank?.feed?.enabled || bank.feed.provider !== 'PUSH' || !token || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ForbiddenException('Unknown feed or invalid token');
    return this.receive(bank, transactions);
  }

  /** Pulls new transactions for one feed now (also run on the schedule). */
  async syncNow(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.account(user, bankId);
    if (!bank.feed?.enabled || bank.feed.provider !== 'MONO') throw new BadRequestException('This account has no Mono feed');
    return this.pull(bank);
  }

  /** Scheduled: pulls every enabled aggregator feed. */
  async syncAll() {
    const banks = await this.db.bankAccounts.find({ 'feed.enabled': true, 'feed.provider': 'MONO', isActive: true }).lean();
    let received = 0;
    let failed = 0;
    for (const bank of banks) {
      try {
        received += (await this.pull(bank)).received;
      } catch {
        failed++;
      }
    }
    return { feeds: banks.length, received, failed };
  }

  private async pull(bank: BankAccount) {
    // Re-read the last two days: banks post late, and transactions already taken are skipped.
    const from = bank.feed?.lastSyncAt ? new Date(bank.feed.lastSyncAt.getTime() - 2 * 86_400_000) : (bank.feed?.syncFrom ?? new Date(Date.now() - 30 * 86_400_000));
    try {
      const transactions = await monoTransactions(decryptSecret(bank.feed!.secretKey!), bank.feed!.externalAccountId, from);
      const result = await this.receive(bank, transactions.filter((t) => !bank.feed?.syncFrom || t.date >= bank.feed.syncFrom));
      await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'feed.lastSyncAt': new Date(), 'feed.lastError': '' });
      return result;
    } catch (err) {
      await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'feed.lastError': (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  /** Records new transactions as statement lines (one statement per day) and auto-matches them. */
  private async receive(bank: BankAccount, transactions: FeedTransaction[]) {
    const precision = await this.currencies.precision(bank.currency);
    const valid = transactions.filter((t) => t.id && !t.amount.isZero() && t.amount.decimalPlaces() <= precision && !Number.isNaN(t.date.getTime()));
    const after = bank.lastReconciledDate;
    const fresh = valid.filter((t) => !after || day(t.date) > after);
    const known = new Set((await this.db.bankStatementLines.find({ bankAccountId: bank._id, externalId: { $in: fresh.map((t) => t.id) } }, { externalId: 1 }).lean()).map((l) => l.externalId));
    const seen = new Set<string>();
    const todo = fresh.filter((t) => !known.has(t.id) && !seen.has(t.id) && seen.add(t.id));
    const byDay = new Map<string, FeedTransaction[]>();
    for (const t of todo) byDay.set(day(t.date).toISOString().slice(0, 10), [...(byDay.get(day(t.date).toISOString().slice(0, 10)) ?? []), t]);
    let received = 0;
    for (const [d, list] of byDay) {
      const name = `Feed ${d}`;
      const statement = await this.db.bankStatements
        .findOneAndUpdate(
          { organisationId: bank.organisationId, bankAccountId: bank._id, name },
          { $setOnInsert: { organisationId: bank.organisationId, bankAccountId: bank._id, name, fromDate: new Date(d), toDate: new Date(d), closingBalance: null, lineCount: 0, createdBy: bank.feed?.postAsUserId ?? bank._id } },
          { upsert: true, new: true },
        )
        .lean();
      const inserted = await this.db.bankStatementLines
        .insertMany(
          list.map((t) => ({ organisationId: bank.organisationId, bankAccountId: bank._id, statementId: statement!._id, date: day(t.date), description: (t.description ?? '').slice(0, 500), reference: (t.reference ?? '').slice(0, 100), amount: toD128(t.amount), externalId: t.id })),
          { ordered: false },
        )
        .then((r) => r.length)
        .catch((err: { insertedDocs?: unknown[] }) => err.insertedDocs?.length ?? 0);
      received += inserted;
      await this.db.bankStatements.updateOne({ _id: statement!._id }, { $inc: { lineCount: inserted } });
    }
    let matched = 0;
    if (received) {
      const actor = bank.feed?.postAsUserId ? await actorFor(this.db, bank.feed.postAsUserId) : null;
      if (actor) matched = (await this.banking.autoMatch(actor, bank._id).catch(() => ({ matched: 0 }))).matched;
      await this.audit.log({ organisationId: bank.organisationId, name: 'Bank feed' }, { action: 'bank_feed.receive', recordType: 'BankAccount', recordId: bank._id, summary: `${received} transaction(s) from the bank feed into ${bank.name}${matched ? `; ${matched} matched` : ''}` });
    }
    return { received, skipped: transactions.length - received, matched };
  }
}
