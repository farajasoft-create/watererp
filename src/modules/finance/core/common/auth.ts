import { createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { Types } from 'mongoose';
import { Db } from '../database/db.service';
import { UnauthorizedException } from './errors';
import { Permission } from './permissions';

export const AUTH_COOKIE = 'fs_token';
export const SESSION_SECONDS = 8 * 60 * 60;

export interface JwtPayload {
  sub: string;
  org: string;
  tv: number;
  /** Session id (absent on tokens issued before session tracking). */
  sid?: string;
  /** Authentication method: password only, or with a second factor. */
  amr?: 'pwd' | 'mfa';
}

/** A challenge proves the password step passed; the second factor completes the sign-in. */
const CHALLENGE_SECONDS = 5 * 60;

/** The authenticated caller, resolved fresh from the database on every request. */
export interface AuthUser {
  id: Types.ObjectId;
  organisationId: Types.ObjectId;
  email: string;
  name: string;
  permissions: string[];
  allBranches: boolean;
  branchIds: Types.ObjectId[];
  approvalLimit: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Set when the caller authenticated with an API key (a service account). */
  apiKeyId?: Types.ObjectId | null;
  sessionId?: Types.ObjectId | null;
  /** The session was established with a second factor. */
  mfa?: boolean;
  /** The organisation requires MFA and this user has not set it up: only enrolment is allowed. */
  mfaEnrollmentRequired?: boolean;
}

export function hasPermission(user: AuthUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(value);
}

export async function signToken(
  user: { _id: Types.ObjectId; organisationId: Types.ObjectId; tokenVersion: number },
  opts: { sessionId?: Types.ObjectId; mfa?: boolean } = {},
): Promise<string> {
  return new SignJWT({ org: user.organisationId.toHexString(), tv: user.tokenVersion, ...(opts.sessionId && { sid: opts.sessionId.toHexString() }), amr: opts.mfa ? 'mfa' : 'pwd' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id.toHexString())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secret());
}

export async function signChallenge(user: { _id: Types.ObjectId; organisationId: Types.ObjectId; tokenVersion: number }): Promise<string> {
  return new SignJWT({ org: user.organisationId.toHexString(), tv: user.tokenVersion, purpose: 'mfa-challenge' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id.toHexString())
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_SECONDS}s`)
    .sign(secret());
}

export async function verifyChallenge(token: string): Promise<{ sub: string; org: string; tv: number }> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'mfa-challenge') throw new Error('wrong purpose');
    return { sub: payload.sub!, org: payload.org as string, tv: payload.tv as number };
  } catch {
    throw new UnauthorizedException('The sign-in attempt expired; enter your password again');
  }
}

/** A short-lived signed token for multi-step flows (SSO state). Never accepted as a session. */
export async function signFlowToken(purpose: string, claims: Record<string, unknown>, seconds: number): Promise<string> {
  return new SignJWT({ ...claims, purpose }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${seconds}s`).sign(secret());
}

export async function verifyFlowToken<T extends Record<string, unknown>>(token: string, purpose: string): Promise<T> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  if (payload.purpose !== purpose) throw new UnauthorizedException('Invalid sign-in state');
  return payload as unknown as T;
}

/** Organisation MFA policy, cached briefly so it is not read on every request. */
const mfaPolicy = new Map<string, { required: boolean; at: number }>();
async function orgRequiresMfa(db: Db, organisationId: Types.ObjectId): Promise<boolean> {
  const key = organisationId.toHexString();
  const cached = mfaPolicy.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.required;
  const org = await db.organisations.findById(organisationId, { 'settings.requireMfa': 1 }).lean();
  const required = !!org?.settings?.requireMfa;
  mfaPolicy.set(key, { required, at: Date.now() });
  return required;
}
export function forgetMfaPolicy(organisationId: Types.ObjectId) {
  mfaPolicy.delete(organisationId.toHexString());
}

export function extractToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Verifies the session token and loads the user with their current roles. Deactivated users and
 * tokens issued before a logout-everywhere or password change (tokenVersion) are rejected.
 */
export async function authenticate(db: Db, req: Request, meta: { ip: string | null }): Promise<AuthUser> {
  const token = extractToken(req);
  if (!token) throw new UnauthorizedException('Authentication required');
  if (token.startsWith('fsk_')) return authenticateApiKey(db, req, token, meta);
  // Inside the platform, people sign in to the platform; finance builds its caller from that session.
  if (process.env.FINANCE_STANDALONE !== 'true') {
    const { getPlatform } = await import('@/platform/container');
    const { authenticateFromPlatform } = await import('../bridge');
    const { getServices } = await import('../container');
    return authenticateFromPlatform(await getPlatform(), await getServices(), req, meta, (u) => toAuthUser(db, u, req, meta));
  }
  let payload: JwtPayload;
  try {
    const verified = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (verified.payload.purpose) throw new Error('not a session token');
    payload = { sub: verified.payload.sub!, org: verified.payload.org as string, tv: verified.payload.tv as number, sid: verified.payload.sid as string | undefined, amr: verified.payload.amr as 'pwd' | 'mfa' | undefined };
  } catch {
    throw new UnauthorizedException('Session expired or invalid');
  }
  if (!Types.ObjectId.isValid(payload.sub) || !Types.ObjectId.isValid(payload.org)) throw new UnauthorizedException('Session expired or invalid');
  const user = await db.users.findOne({ _id: payload.sub, organisationId: payload.org }).lean();
  if (!user || !user.isActive || user.isServiceAccount || user.tokenVersion !== payload.tv) throw new UnauthorizedException('Session expired or invalid');
  let sessionId: Types.ObjectId | null = null;
  if (payload.sid && Types.ObjectId.isValid(payload.sid)) {
    const session = await db.sessions.findOne({ _id: payload.sid, userId: user._id }, { revokedAt: 1, lastSeenAt: 1, expiresAt: 1 }).lean();
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedException('This session was signed out');
    sessionId = session._id;
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) await db.sessions.updateOne({ _id: session._id }, { lastSeenAt: new Date(), ip: meta.ip });
  }
  const mfaEnrollmentRequired = !user.mfa?.enabled && (await orgRequiresMfa(db, user.organisationId));
  return { ...(await toAuthUser(db, user, req, meta)), sessionId, mfa: payload.amr === 'mfa', mfaEnrollmentRequired };
}

/** API keys belong to service accounts; only a SHA-256 hash of the key is stored. */
async function authenticateApiKey(db: Db, req: Request, token: string, meta: { ip: string | null }): Promise<AuthUser> {
  const key = await db.apiKeys.findOne({ hash: createHash('sha256').update(token).digest('hex') }).lean();
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) throw new UnauthorizedException('Invalid, expired or revoked API key');
  const user = await db.users.findOne({ _id: key.userId, organisationId: key.organisationId }).lean();
  if (!user || !user.isActive || !user.isServiceAccount) throw new UnauthorizedException('The service account for this API key is inactive');
  // Recording every request would make each read a write; once a minute is enough to show activity.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await db.apiKeys.updateOne({ _id: key._id }, { lastUsedAt: new Date(), lastUsedIp: meta.ip });
  }
  return { ...(await toAuthUser(db, user, req, meta)), apiKeyId: key._id };
}

/** The user as an actor for background work done in their name (recurring journals, scheduled jobs). */
export async function actorFor(db: Db, userId: Types.ObjectId): Promise<AuthUser | null> {
  const user = await db.users.findById(userId).lean();
  if (!user || !user.isActive) return null;
  return toAuthUser(db, user, new Request('http://localhost/', { headers: { 'user-agent': 'scheduler' } }), { ip: null });
}

async function toAuthUser(
  db: Db,
  user: { _id: Types.ObjectId; organisationId: Types.ObjectId; email: string; name: string; roleIds: Types.ObjectId[]; allBranches: boolean; branchIds: Types.ObjectId[]; approvalLimit?: { toString(): string } | null },
  req: Request,
  meta: { ip: string | null },
): Promise<AuthUser> {
  const roles = await db.roles.find({ _id: { $in: user.roleIds }, organisationId: user.organisationId }).lean();
  return {
    id: user._id,
    organisationId: user.organisationId,
    email: user.email,
    name: user.name,
    permissions: [...new Set(roles.flatMap((r) => r.permissions))],
    allBranches: user.allBranches,
    branchIds: user.branchIds,
    approvalLimit: user.approvalLimit ? user.approvalLimit.toString() : null,
    ip: meta.ip,
    userAgent: req.headers.get('user-agent'),
  };
}
