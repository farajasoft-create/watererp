import { Types } from 'mongoose';
import type { CoreServices, Platform } from '@/platform/container';
import { BadRequestException } from '@/platform/common/errors';
import { Journal, LedgerAccount, LedgerProvider } from '@/platform/ledger/types';
import { ensureFinanceOrganisation } from './core/bridge';
import type { AuthUser } from './core/common/auth';
import { ALL_PERMISSIONS } from './core/common/permissions';
import { Decimal } from './core/common/money';
import type { Services } from './core/container';

/**
 * The platform ledger when the finance module is on: water, HR and every other module post their
 * journals straight into finance's general ledger in the same database (no HTTP, no API key).
 * Organisations without finance still post to FarajaSoft Accounting over its API.
 */
export class FinanceLedger implements LedgerProvider {
  readonly name = 'Finance (this system)';

  constructor(
    private readonly core: CoreServices,
    private readonly s: Services & { ready: () => Promise<void> },
  ) {}

  private async financeOn(organisationId: Types.ObjectId) {
    return Boolean(await this.core.db.organisations.exists({ _id: organisationId, modules: 'finance' }));
  }

  /** Posting from other modules is done as the system, with every finance permission. */
  private actor(organisationId: Types.ObjectId): AuthUser {
    return { id: new Types.ObjectId('000000000000000000000000'), organisationId, email: 'system@platform', name: 'System (platform modules)', permissions: [...ALL_PERMISSIONS], allBranches: true, branchIds: [], approvalLimit: null, ip: null, userAgent: 'platform-ledger' };
  }

  private async prepare(organisationId: Types.ObjectId) {
    await this.s.ready();
    await ensureFinanceOrganisation({ core: this.core } as Platform, this.s, organisationId);
    const org = await this.core.db.organisations.findById(organisationId, { ledger: 1 }).lean();
    const entity = org?.ledger?.entityId && Types.ObjectId.isValid(org.ledger.entityId) ? await this.s.db.entities.findOne({ _id: org.ledger.entityId, organisationId }).lean() : await this.s.db.entities.findOne({ organisationId }).sort({ createdAt: 1 }).lean();
    if (!entity) throw new BadRequestException('Finance has no legal entity yet');
    const branch = org?.ledger?.branchId && Types.ObjectId.isValid(org.ledger.branchId) ? await this.s.db.branches.findOne({ _id: org.ledger.branchId, entityId: entity._id }).lean() : await this.s.db.branches.findOne({ organisationId, entityId: entity._id }).sort({ createdAt: 1 }).lean();
    if (!branch) throw new BadRequestException('Finance has no branch for the entity');
    return { entity, branch, mode: (org?.ledger?.mode as 'DRAFT' | 'SUBMIT' | 'POST' | undefined) ?? 'SUBMIT' };
  }

  async isConnected(organisationId: Types.ObjectId) {
    return (await this.financeOn(organisationId)) || this.core.ledger.remote.isConnected(organisationId);
  }

  async post(organisationId: Types.ObjectId, journal: Journal, idempotencyKey: string) {
    if (!(await this.financeOn(organisationId))) return this.core.ledger.remote.post(organisationId, journal, idempotencyKey);
    const { entity, branch, mode } = await this.prepare(organisationId);
    const actor = this.actor(organisationId);
    const created = await this.s.journals.create(
      actor,
      {
        entityId: entity._id,
        branchId: branch._id,
        journalDate: new Date(`${journal.date}T00:00:00.000Z`),
        description: journal.description.slice(0, 500),
        reference: journal.reference.slice(0, 100),
        lines: journal.lines.map((l) => ({ accountId: new Types.ObjectId(l.accountId), description: l.description, debit: l.debit ? new Decimal(l.debit) : null, credit: l.credit ? new Decimal(l.credit) : null })),
      },
      { source: 'API', idempotencyKey },
    );
    // A replayed post returns the journal as it was; move it on only as far as the ledger mode says.
    if (mode !== 'DRAFT' && created.status === 'DRAFT') await this.s.journals.submit(actor, created._id);
    if (mode === 'POST') {
      const now = await this.s.db.journals.findById(created._id, { status: 1 }).lean();
      if (now?.status === 'SUBMITTED') await this.s.journals.approve(actor, created._id, { post: true, comment: 'Posted by the platform ledger' });
      else if (now?.status === 'APPROVED') await this.s.journals.post(actor, created._id);
    }
    return created._id.toHexString();
  }

  async accounts(organisationId: Types.ObjectId): Promise<LedgerAccount[]> {
    if (!(await this.financeOn(organisationId))) return this.core.ledger.remote.accounts(organisationId);
    await this.prepare(organisationId);
    const rows = await this.s.db.accounts.find({ organisationId, isPostable: true, isActive: { $ne: false } }, { code: 1, name: 1, accountType: 1 }).sort({ code: 1 }).lean();
    return rows.map((a) => ({ id: a._id.toHexString(), code: a.code, name: a.name, type: String(a.accountType) }));
  }
}
