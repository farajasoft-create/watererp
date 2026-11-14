import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, toD128 } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';

export const API_KEY_PREFIX = 'fsk_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Permissions a service account may never hold, so a leaked key cannot take over the tenant. */
const FORBIDDEN_FOR_SERVICE = [PERMISSIONS.USERS_MANAGE, PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.ORG_MANAGE] as string[];

export interface ServiceAccountInput {
  name: string;
  description?: string;
  roleIds: Types.ObjectId[];
  allBranches: boolean;
  branchIds: Types.ObjectId[];
  approvalLimit?: Decimal | null;
  isActive?: boolean;
}

/**
 * Service accounts for system-to-system access. A service account is a user that can never sign in;
 * it acts through API keys and is governed by the same roles, branch restrictions, approval limits and
 * segregation of duties as people, and every action it takes is in the audit trail under its name.
 */
export class ApiKeysService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser) {
    const accounts = await this.db.users.find({ organisationId: user.organisationId, isServiceAccount: true }, { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 }).sort({ name: 1 }).lean();
    const keys = await this.db.apiKeys.find({ organisationId: user.organisationId, userId: { $in: accounts.map((a) => a._id) } }, { hash: 0 }).sort({ createdAt: -1 }).lean();
    return accounts.map((a) => ({ ...a, keys: keys.filter((k) => k.userId.equals(a._id)) }));
  }

  private async assertRoles(user: AuthUser, input: Pick<ServiceAccountInput, 'roleIds' | 'branchIds'>) {
    const roles = await this.db.roles.find({ organisationId: user.organisationId, _id: { $in: input.roleIds } }).lean();
    if (roles.length !== new Set(input.roleIds.map(String)).size) throw new BadRequestException('Unknown role');
    const forbidden = roles.find((r) => r.permissions.some((p) => FORBIDDEN_FOR_SERVICE.includes(p)));
    if (forbidden) throw new BadRequestException(`Role ${forbidden.name} manages users, integrations or the organisation; service accounts cannot hold it`);
    const branches = await this.db.branches.countDocuments({ organisationId: user.organisationId, _id: { $in: input.branchIds } });
    if (branches !== new Set(input.branchIds.map(String)).size) throw new BadRequestException('Unknown branch');
  }

  async createAccount(user: AuthUser, input: ServiceAccountInput) {
    await this.assertRoles(user, input);
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'service';
    const [account] = await this.db.users.create([
      {
        organisationId: user.organisationId,
        name: input.name,
        email: `${slug}.${randomBytes(4).toString('hex')}@service.farajasoft.invalid`,
        // Not a bcrypt hash, so no password can ever match.
        passwordHash: '!service-account',
        isServiceAccount: true,
        roleIds: input.roleIds,
        allBranches: input.allBranches,
        branchIds: input.branchIds,
        approvalLimit: input.approvalLimit ? toD128(input.approvalLimit) : null,
      },
    ]);
    const safe = { ...account.toObject(), passwordHash: undefined };
    await this.audit.log(user, { action: 'service_account.create', recordType: 'User', recordId: account._id, summary: `Created service account ${input.name}`, after: safe });
    return safe;
  }

  async updateAccount(user: AuthUser, id: Types.ObjectId, input: Partial<ServiceAccountInput>) {
    const before = await this.db.users.findOne({ _id: id, organisationId: user.organisationId, isServiceAccount: true }, { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 }).lean();
    if (!before) throw new NotFoundException('Service account not found');
    if (input.roleIds || input.branchIds) await this.assertRoles(user, { roleIds: input.roleIds ?? before.roleIds, branchIds: input.branchIds ?? before.branchIds });
    const { approvalLimit, ...rest } = input;
    const update: Record<string, unknown> = { ...rest };
    if (approvalLimit !== undefined) update.approvalLimit = approvalLimit ? toD128(approvalLimit) : null;
    const after = await this.db.users.findByIdAndUpdate(id, update, { new: true, projection: { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 } }).lean();
    await this.audit.log(user, { action: 'service_account.update', recordType: 'User', recordId: id, summary: `Updated service account ${before.name}`, before, after });
    return after;
  }

  /** Issues a key. The plain key is returned once and never stored. */
  async createKey(user: AuthUser, accountId: Types.ObjectId, input: { name: string; expiresInDays?: number | null }) {
    const account = await this.db.users.findOne({ _id: accountId, organisationId: user.organisationId, isServiceAccount: true }).lean();
    if (!account) throw new NotFoundException('Service account not found');
    const key = `${API_KEY_PREFIX}${randomBytes(30).toString('base64url')}`;
    const [doc] = await this.db.apiKeys.create([
      {
        organisationId: user.organisationId,
        userId: account._id,
        name: input.name,
        prefix: key.slice(0, 12),
        hash: hashApiKey(key),
        createdBy: user.id,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      },
    ]);
    await this.audit.log(user, { action: 'api_key.create', recordType: 'ApiKey', recordId: doc._id, summary: `Issued API key ${doc.prefix}… (${input.name}) for ${account.name}` });
    const { hash: _hash, ...safe } = doc.toObject();
    return { ...safe, key };
  }

  async revokeKey(user: AuthUser, id: Types.ObjectId) {
    const key = await this.db.apiKeys.findOneAndUpdate({ _id: id, organisationId: user.organisationId, revokedAt: null }, { revokedAt: new Date(), revokedBy: user.id }, { new: true, projection: { hash: 0 } }).lean();
    if (!key) throw new NotFoundException('Active API key not found');
    await this.audit.log(user, { action: 'api_key.revoke', recordType: 'ApiKey', recordId: id, summary: `Revoked API key ${key.prefix}… (${key.name})` });
    return key;
  }
}
