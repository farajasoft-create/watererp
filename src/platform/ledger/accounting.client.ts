import { BadRequestException } from '../common/errors';
import { isBalanced, Journal, LedgerConfig } from './types';

export class LedgerError extends Error {}

/**
 * Talks to FarajaSoft Accounting's REST API (`/api/v1`) with a service-account API key (`fsk_…`).
 * Every journal carries an Idempotency-Key derived from the source record, so a retry never posts twice.
 */
export class AccountingClient {
  constructor(
    private readonly config: Pick<LedgerConfig, 'baseUrl' | 'apiKey'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new LedgerError(`Accounting is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = Array.isArray(data?.errors) ? `: ${data.errors.map((e: { path: string; message: string }) => `${e.path} ${e.message}`).join('; ')}` : '';
      throw new LedgerError(`Accounting rejected the request (${res.status}): ${data?.message ?? res.statusText}${detail}`);
    }
    return data as T;
  }

  listEntities() {
    return this.call<{ id: string; code: string; name: string }[]>('GET', '/entities');
  }

  listBranches(entityId: string) {
    return this.call<{ id: string; code: string; name: string }[]>('GET', `/branches?entityId=${encodeURIComponent(entityId)}&activeOnly=true`);
  }

  listAccounts(entityId: string) {
    return this.call<{ id: string; code: string; name: string; type: string }[]>('GET', `/accounts?entityId=${encodeURIComponent(entityId)}&activeOnly=true&postableOnly=true`);
  }

  /** Creates the journal and moves it as far as the configured mode allows; returns its id. */
  async sendJournal(config: LedgerConfig, journal: Journal, idempotencyKey: string): Promise<string> {
    if (!isBalanced(journal.lines)) throw new BadRequestException('The journal does not balance');
    const created = await this.call<{ id: string; status: string }>(
      'POST',
      '/journals',
      {
        entityId: config.entityId,
        branchId: config.branchId,
        journalDate: journal.date,
        description: journal.description,
        reference: journal.reference.slice(0, 100),
        lines: journal.lines,
      },
      idempotencyKey,
    );
    // A replayed create returns the journal as it was; later steps may already have happened.
    if (config.mode !== 'DRAFT' && created.status === 'DRAFT') await this.call('POST', `/journals/${created.id}/submit`, {}, `${idempotencyKey}:submit`);
    if (config.mode === 'POST' && created.status !== 'POSTED') await this.call('POST', `/journals/${created.id}/post`, {}, `${idempotencyKey}:post`);
    return created.id;
  }
}
