import { createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { Types } from 'mongoose';
import { UnauthorizedException } from './common/errors';
import { Db } from './db';
import { ModuleManifest, resolvePermissions, withCustomRoles } from './manifest';

export const AUTH_COOKIE = 'fs_token';
/** Field staff work long days offline; sessions last a week. */
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

export interface ModuleAccess {
  role: string;
  /** Records the user is limited to in that module (zones, branches…); empty means all. */
  scope: Types.ObjectId[];
}

/** The authenticated caller, resolved fresh from the database on every request. */
export interface AuthUser {
  id: Types.ObjectId;
  organisationId: Types.ObjectId;
  email: string;
  name: string;
  isAdmin: boolean;
  /** The user's role in each module, by module key. */
  access: Record<string, ModuleAccess>;
  /** Modules switched on for the organisation. */
  modules: string[];
  permissions: string[];
  ip: string | null;
  /** The organisation requires two-step sign-in of this user and it is not set up yet. */
  mustEnrolTwoFactor?: boolean;
}

/** Whether the organisation's policy requires two-step sign-in of this user. */
export function twoFactorRequired(policy: string | null | undefined, isAdmin: boolean) {
  return policy === 'ALL' || (policy === 'ADMINS' && isAdmin);
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(value);
}

export async function signToken(user: { _id: Types.ObjectId; organisationId: Types.ObjectId; tokenVersion: number }): Promise<string> {
  return new SignJWT({ org: user.organisationId.toHexString(), tv: user.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id.toHexString())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secret());
}

function readToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

type AccessRow = { module: string; role: string; scope?: Types.ObjectId[] | null };

/** Builds the caller from the stored user and organisation. */
export function toAuthUser(
  user: { _id: Types.ObjectId; organisationId: Types.ObjectId; email: string; name: string; isAdmin?: boolean | null; access?: AccessRow[] | null },
  modules: string[],
  ip: string | null,
  manifests: readonly ModuleManifest[],
): AuthUser {
  const rows = user.access ?? [];
  const isAdmin = Boolean(user.isAdmin);
  return {
    id: user._id,
    organisationId: user.organisationId,
    email: user.email,
    name: user.name,
    isAdmin,
    access: Object.fromEntries(rows.filter((a) => modules.includes(a.module)).map((a) => [a.module, { role: a.role, scope: a.scope ?? [] }])),
    modules,
    permissions: resolvePermissions(manifests, { isAdmin, access: rows.map((a) => ({ module: a.module, role: a.role })) }, modules),
    ip,
  };
}

export async function authenticate(db: Db, req: Request, meta: { ip: string | null }, manifests: readonly ModuleManifest[]): Promise<AuthUser> {
  const token = readToken(req);
  if (!token) throw new UnauthorizedException();
  if (token.startsWith(API_KEY_PREFIX)) return authenticateKey(db, token, meta, manifests);
  let payload: { sub?: string; org?: unknown; tv?: unknown };
  try {
    ({ payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] }));
  } catch {
    throw new UnauthorizedException('Your session has expired; sign in again');
  }
  if (!payload.sub || !Types.ObjectId.isValid(payload.sub)) throw new UnauthorizedException();
  const user = await db.users.findById(payload.sub).lean();
  if (!user || !user.active || user.tokenVersion !== payload.tv || user.organisationId.toHexString() !== payload.org) {
    throw new UnauthorizedException('Your session has ended; sign in again');
  }
  const org = await db.organisations.findById(user.organisationId, { modules: 1, customRoles: 1, 'security.requireTwoFactor': 1 }).lean();
  const auth = toAuthUser(user, org?.modules ?? [], meta.ip, withCustomRoles(manifests, org?.customRoles));
  if (twoFactorRequired(org?.security?.requireTwoFactor, auth.isAdmin) && !user.twoFactor?.enabled) auth.mustEnrolTwoFactor = true;
  return auth;
}

export const API_KEY_PREFIX = 'gk_';
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** A caller presenting an API key acts as the user the key was issued to, with that user's roles. */
async function authenticateKey(db: Db, key: string, meta: { ip: string | null }, manifests: readonly ModuleManifest[]): Promise<AuthUser> {
  const hash = hashApiKey(key);
  const user = await db.users.findOne({ 'apiKeys.hash': hash }).lean();
  const k = user?.apiKeys?.find((x) => x.hash === hash);
  if (!user || !user.active || !k) throw new UnauthorizedException('This API key is not valid');
  if (k.expiresAt && k.expiresAt.getTime() < Date.now()) throw new UnauthorizedException('This API key has expired');
  if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) await db.users.updateOne({ _id: user._id, 'apiKeys.hash': hash }, { $set: { 'apiKeys.$.lastUsedAt': new Date() } });
  const org = await db.organisations.findById(user.organisationId, { modules: 1, customRoles: 1 }).lean();
  return toAuthUser(user, org?.modules ?? [], meta.ip, withCustomRoles(manifests, org?.customRoles));
}

export function hasPermission(user: AuthUser, permission: string): boolean {
  return user.permissions.includes(permission);
}
