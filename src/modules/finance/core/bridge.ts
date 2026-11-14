import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { authenticate as platformAuthenticate } from '@/platform/auth';
import type { Platform } from '@/platform/container';
import type { AuthUser } from './common/auth';
import { SYSTEM_ROLES } from './common/permissions';
import { ForbiddenException } from './common/errors';
import type { Db } from './database/db.service';
import type { Services } from './container';

/**
 * Finance runs inside the platform: people sign in once (platform session, two-step sign-in, SSO) and
 * finance builds its own caller from that. Each platform user with a role in the finance module has a
 * finance profile with the same _id, carrying finance's richer access model: several finance roles,
 * branch restrictions and an approval limit, set under Finance → Setup → Users.
 */

/** Platform role in the finance module → finance system roles granted when the profile is created or the role changes. */
export const PLATFORM_ROLE_TO_FINANCE: Record<string, string[]> = {
  ADMINISTRATOR: ['Administrator', 'Finance Director'],
  FINANCE_DIRECTOR: ['Finance Director'],
  ACCOUNTANT: ['Accountant'],
  FINANCE_REVIEWER: ['Finance Reviewer'],
  BRANCH_MANAGER: ['Branch Manager'],
  AUDITOR: ['Auditor'],
  STAFF: ['Staff Requester'],
};

/** A password hash no password can match: platform users never sign in to finance directly. */
const NO_PASSWORD = '!platform-sign-in';

const ready = new Map<string, Promise<void>>();

/** The platform's organisation becomes a finance organisation (same _id) the first time finance is opened. */
export function ensureFinanceOrganisation(platform: Platform, s: Services, organisationId: Types.ObjectId): Promise<void> {
  const key = organisationId.toHexString();
  let p = ready.get(key);
  if (!p) {
    p = (async () => {
      if (await s.db.organisations.exists({ _id: organisationId })) return;
      const org = await platform.core.db.organisations.findById(organisationId).lean();
      if (!org) throw new ForbiddenException('Organisation not found');
      // Kenyan public bodies and most utilities keep a July–June financial year.
      const now = new Date();
      const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      await s.provisioning.provisionPlatformOrganisation({
        organisationId,
        organisationName: org.name,
        entityCode: org.code.slice(0, 10),
        entityName: org.name,
        country: 'KE',
        functionalCurrency: org.currency || 'KES',
        fiscalYearStart: new Date(Date.UTC(startYear, 6, 1)),
      });
    })().catch((err) => {
      ready.delete(key);
      throw err;
    });
    ready.set(key, p);
  }
  return p;
}

/** The finance profile of a platform user, created or brought in line with their platform role. */
export async function ensureFinanceUser(db: Db, user: { id: Types.ObjectId; organisationId: Types.ObjectId; email: string; name: string }, platformRole: string) {
  const roleNames = PLATFORM_ROLE_TO_FINANCE[platformRole] ?? [];
  const existing = await db.users.findById(user.id).lean();
  if (existing && existing.platformRole === platformRole && existing.email === user.email && existing.name === user.name && existing.isActive) return existing;
  let roles = await db.roles.find({ organisationId: user.organisationId, name: { $in: roleNames } }, { _id: 1, name: 1 }).lean();
  // System roles added after an organisation was set up are created the first time someone needs them.
  const missing = SYSTEM_ROLES.filter((t) => roleNames.includes(t.name) && !roles.some((r) => r.name === t.name));
  if (missing.length) {
    await db.roles.insertMany(missing.map((t) => ({ organisationId: user.organisationId, name: t.name, description: t.description, permissions: t.permissions, isSystem: true })));
    roles = await db.roles.find({ organisationId: user.organisationId, name: { $in: roleNames } }, { _id: 1, name: 1 }).lean();
  }
  if (!existing) {
    await db.users.create([{ _id: user.id, organisationId: user.organisationId, email: user.email, name: user.name, passwordHash: NO_PASSWORD, roleIds: roles.map((r) => r._id), platformRole }]);
  } else {
    // A changed platform role resets the finance roles to the role's defaults; name and email follow the platform.
    const update: Record<string, unknown> = { email: user.email, name: user.name, isActive: true };
    if (existing.platformRole !== platformRole) Object.assign(update, { platformRole, roleIds: roles.map((r) => r._id) });
    await db.users.updateOne({ _id: user.id }, update);
  }
  return (await db.users.findById(user.id).lean())!;
}

/**
 * Authenticates a finance request from the platform session: the finance module must be on for the
 * organisation and the person must hold a finance role (administrators always do).
 */
export async function authenticateFromPlatform(platform: Platform, s: Services, req: Request, meta: { ip: string | null }, toAuthUser: (user: NonNullable<Awaited<ReturnType<typeof ensureFinanceUser>>>) => Promise<AuthUser>): Promise<AuthUser> {
  const caller = await platformAuthenticate(platform.core.db, req, meta, platform.core.manifests);
  if (!caller.modules.includes('finance')) throw new ForbiddenException('The Finance module is not switched on for your organisation');
  if (caller.mustEnrolTwoFactor) throw new ForbiddenException('Set up two-step sign-in first (your organisation requires it)');
  const role = caller.isAdmin ? 'ADMINISTRATOR' : caller.access.finance?.role;
  if (!role) throw new ForbiddenException('You have no role in Finance');
  await ensureFinanceOrganisation(platform, s, caller.organisationId);
  const profile = await ensureFinanceUser(s.db, caller, role);
  return { ...(await toAuthUser(profile)), mfa: true, mfaEnrollmentRequired: false };
}

/** A random value for records that need one (kept here so callers need no crypto import). */
export const randomToken = () => randomBytes(24).toString('base64url');

/** Every platform user holding a finance role (or an administrator) gets a finance profile, so finance lists them all. */
export async function syncFinanceUsers(platform: Platform, s: Services, organisationId: Types.ObjectId) {
  const people = await platform.core.db.users.find({ organisationId, active: true, $or: [{ isAdmin: true }, { 'access.module': 'finance' }] }).lean();
  for (const p of people) {
    const role = p.isAdmin ? 'ADMINISTRATOR' : p.access.find((a) => a.module === 'finance')?.role;
    if (role) await ensureFinanceUser(s.db, { id: p._id, organisationId, email: p.email, name: p.name }, role);
  }
  // People whose finance role was taken away on the platform lose finance access.
  const keep = people.filter((p) => p.isAdmin || p.access.some((a) => a.module === 'finance')).map((p) => p._id);
  await s.db.users.updateMany({ organisationId, isServiceAccount: { $ne: true }, platformRole: { $ne: null }, _id: { $nin: keep } }, { isActive: false });
}
