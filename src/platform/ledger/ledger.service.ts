import { Types } from 'mongoose';
import { BadRequestException, NotFoundException } from '../common/errors';
import { decryptSecret } from '../common/secrets';
import { Db } from '../db';
import { AccountingClient, LedgerError } from './accounting.client';
import { Journal, LedgerAccount, LedgerConfig, LedgerProvider } from './types';

type ClientFactory = (cfg: Pick<LedgerConfig, 'baseUrl' | 'apiKey'>) => AccountingClient;

/** Posts to FarajaSoft Accounting with the connection saved under Settings → Ledger. */
export class RemoteAccountingLedger implements LedgerProvider {
  readonly name = 'FarajaSoft Accounting';

  constructor(
    private readonly db: Db,
    private readonly clientFor: ClientFactory = (c) => new AccountingClient(c),
  ) {}

  async config(organisationId: Types.ObjectId): Promise<LedgerConfig | null> {
    const org = await this.db.organisations.findById(organisationId, { ledger: 1 }).lean();
    const l = org?.ledger;
    if (!l?.enabled || !l.baseUrl || !l.apiKeySealed || !l.entityId || !l.branchId) return null;
    return { baseUrl: l.baseUrl.replace(/\/+$/, ''), apiKey: decryptSecret(l.apiKeySealed), entityId: l.entityId, branchId: l.branchId, mode: (l.mode as LedgerConfig['mode']) ?? 'SUBMIT' };
  }

  async isConnected(organisationId: Types.ObjectId) {
    return Boolean(await this.config(organisationId));
  }

  async post(organisationId: Types.ObjectId, journal: Journal, idempotencyKey: string) {
    const config = await this.config(organisationId);
    if (!config) throw new LedgerError('The ledger connection is off');
    return this.clientFor(config).sendJournal(config, journal, idempotencyKey);
  }

  async accounts(organisationId: Types.ObjectId): Promise<LedgerAccount[]> {
    const config = await this.config(organisationId);
    if (!config) return [];
    const accounts = await this.clientFor(config).listAccounts(config.entityId);
    return accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }));
  }

  /** Checks an address and key before they are saved, and lists entities, branches and accounts. */
  async lookup(organisationId: Types.ObjectId, input: { baseUrl?: string; apiKey?: string; entityId?: string }) {
    const org = await this.db.organisations.findById(organisationId, { ledger: 1 }).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    const baseUrl = (input.baseUrl ?? org.ledger?.baseUrl ?? '').replace(/\/+$/, '');
    const apiKey = input.apiKey || (org.ledger?.apiKeySealed ? decryptSecret(org.ledger.apiKeySealed) : '');
    if (!baseUrl || !apiKey) throw new BadRequestException('Enter the accounting address and API key');
    const client = this.clientFor({ baseUrl, apiKey });
    try {
      const entities = await client.listEntities();
      const entityId = input.entityId ?? org.ledger?.entityId ?? entities[0]?.id;
      const [branches, accounts] = entityId ? await Promise.all([client.listBranches(entityId), client.listAccounts(entityId)]) : [[], []];
      return { ok: true, entities, branches, accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })) };
    } catch (err) {
      if (err instanceof LedgerError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}

/**
 * The one general ledger of the platform. Modules never talk to accounting themselves: they build a
 * balanced journal and call `post`. Which ledger receives it is decided here, once, for every module.
 */
export class LedgerService {
  readonly remote: RemoteAccountingLedger;
  private provider: LedgerProvider;

  constructor(db: Db, clientFor?: ClientFactory) {
    this.remote = new RemoteAccountingLedger(db, clientFor);
    this.provider = this.remote;
  }

  /** Called by a module that keeps the ledger itself (a finance module); replaces the remote connection. */
  use(provider: LedgerProvider) {
    this.provider = provider;
  }

  get providerName() {
    return this.provider.name;
  }

  isConnected(organisationId: Types.ObjectId) {
    return this.provider.isConnected(organisationId);
  }

  post(organisationId: Types.ObjectId, journal: Journal, idempotencyKey: string) {
    return this.provider.post(organisationId, journal, idempotencyKey);
  }

  async accounts(organisationId: Types.ObjectId) {
    try {
      return await this.provider.accounts(organisationId);
    } catch (err) {
      if (err instanceof LedgerError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /**
   * Posts a record's journal and keeps the outcome on the record (`<field>.status`, journalId, error),
   * the way every module shows "sent / failed / skipped" and retries later. Never throws, so the
   * ledger never blocks the work that raised the journal. Pass `missing` (unmapped accounts) to fail
   * with a clear message instead of posting.
   */
  async postTracked(t: { organisationId: Types.ObjectId; model: TrackedModel; id: Types.ObjectId; field?: string; journal: Journal; key: string; missing?: string[]; mappingHint?: string }): Promise<TrackedResult> {
    const field = t.field ?? 'accounting';
    const set = (update: Record<string, unknown>) => t.model.updateOne({ _id: t.id }, update);
    try {
      if (!(await this.isConnected(t.organisationId))) {
        await set({ [`${field}.status`]: 'SKIPPED', [`${field}.error`]: 'The ledger is not connected' });
        return { status: 'SKIPPED' };
      }
      if (t.missing?.length) {
        const error = `Map these accounts${t.mappingHint ? ` in ${t.mappingHint}` : ''}: ${t.missing.join(', ')}`;
        await set({ [`${field}.status`]: 'FAILED', [`${field}.error`]: error, [`${field}.lastAttemptAt`]: new Date(), $inc: { [`${field}.attempts`]: 1 } });
        return { status: 'FAILED', error };
      }
      await set({ [`${field}.status`]: 'PENDING', [`${field}.lastAttemptAt`]: new Date(), $inc: { [`${field}.attempts`]: 1 } });
      try {
        const journalId = await this.post(t.organisationId, t.journal, t.key);
        await set({ [`${field}.status`]: 'SENT', [`${field}.journalId`]: journalId, $unset: { [`${field}.error`]: 1 } });
        return { status: 'SENT', journalId };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await set({ [`${field}.status`]: 'FAILED', [`${field}.error`]: error });
        return { status: 'FAILED', error };
      }
    } catch (err) {
      console.error(`Ledger post ${t.key} failed`, err);
      return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Any module model whose records carry a ledger sync field (see `ledgerSyncSchema`). */
export interface TrackedModel {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): PromiseLike<unknown>;
}

export type TrackedResult = { status: 'SENT'; journalId: string } | { status: 'FAILED'; error: string } | { status: 'SKIPPED' };
