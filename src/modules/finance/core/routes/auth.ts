import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, AUTH_COOKIE, SESSION_SECONDS, signChallenge, signToken, verifyChallenge } from '../common/auth';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException, UnauthorizedException } from '../common/errors';
import { PERMISSION_DESCRIPTIONS } from '../common/permissions';
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateSecret, hashRecoveryCode, otpauthUri, verifyTotp } from '../common/totp';
import { parseId, zCurrency, zDate, safeNext } from '../common/validation';
import { User } from '../database/schemas';
import { normalisePhone } from '../modules/payments/daraja';
import { PASSWORD_ROUNDS } from '../modules/provisioning/provisioning.service';
import { route, RouteContext } from '../http/router';

export const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a digit');

const RegisterBody = z.object({
  organisationName: z.string().trim().min(2).max(200),
  adminName: z.string().trim().min(2).max(200),
  email: z.string().trim().email(),
  password: PasswordSchema,
  entityCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => v.toUpperCase()),
  entityName: z.string().trim().min(1).max(200),
  country: z.string().trim().max(100).optional(),
  functionalCurrency: zCurrency,
  fiscalYearStart: zDate,
});

const LoginBody = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: PasswordSchema });
const Code = z.string().trim().min(6).max(20);

/** Failed sign-ins before the account is locked, and for how long. */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const secureCookies = () => process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');

type SessionUser = Pick<User, 'organisationId' | 'tokenVersion'> & { _id: Types.ObjectId };

/** Starts a tracked session, signs its token and sets it as an httpOnly cookie (also returned for API clients). */
async function startSession(ctx: RouteContext<unknown, unknown>, user: SessionUser, method: 'password' | 'mfa' | 'recovery_code' | 'sso', opts: { mfa?: boolean } = {}) {
  const [session] = await ctx.s.db.sessions.create([
    {
      organisationId: user.organisationId,
      userId: user._id,
      ip: ctx.ip,
      userAgent: ctx.req.headers.get('user-agent'),
      method,
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
    },
  ]);
  const token = await signToken(user, { sessionId: session._id, mfa: opts.mfa ?? (method === 'mfa' || method === 'recovery_code') });
  ctx.setCookie(AUTH_COOKIE, token, { maxAge: SESSION_SECONDS, secure: secureCookies() });
  return token;
}

const clear = (ctx: RouteContext<unknown, unknown>) => ctx.setCookie(AUTH_COOKIE, '', { maxAge: 0, secure: secureCookies() });

/** Records a failed attempt and locks the account after too many. */
async function recordFailure(ctx: RouteContext<unknown, unknown>, user: { _id: Types.ObjectId; organisationId: Types.ObjectId; email: string; name: string; failedLogins?: number }) {
  const failures = (user.failedLogins ?? 0) + 1;
  if (failures >= MAX_FAILURES) {
    await ctx.s.db.users.updateOne({ _id: user._id }, { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) });
    await ctx.s.audit.log({ organisationId: user.organisationId, name: user.name }, { action: 'auth.locked', recordType: 'User', recordId: user._id, summary: `${user.email} locked for ${LOCK_MINUTES} minutes after ${MAX_FAILURES} failed sign-in attempts from ${ctx.ip ?? 'unknown address'}` });
  } else {
    await ctx.s.db.users.updateOne({ _id: user._id }, { failedLogins: failures });
  }
}

function assertNotLocked(user: { lockedUntil?: Date | null }) {
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

async function signedIn(ctx: RouteContext<unknown, unknown>, user: SessionUser & { email: string; name: string }, method: 'password' | 'mfa' | 'recovery_code') {
  await ctx.s.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null });
  await ctx.s.audit.log(
    { organisationId: user.organisationId, name: user.name },
    { action: 'auth.login', recordType: 'User', recordId: user._id, summary: `${user.email} signed in${method === 'mfa' ? ' with two-step verification' : method === 'recovery_code' ? ' with a recovery code' : ''}` },
  );
  return { token: await startSession(ctx, user, method) };
}

export const authRoutes = [
  route({
    method: 'POST',
    path: '/auth/register',
    public: true,
    rateLimit: 5,
    body: RegisterBody,
    handler: async (ctx) => {
      const { organisation, user } = await ctx.s.provisioning.provision(ctx.body);
      const token = await startSession(ctx, user, 'password');
      return { token, organisationId: organisation._id, userId: user._id };
    },
  }),

  /** Password step. With two-step verification on, returns a short-lived challenge instead of a session. */
  route({
    method: 'POST',
    path: '/auth/login',
    public: true,
    rateLimit: 10,
    status: 200,
    body: LoginBody,
    handler: async (ctx) => {
      const user = await ctx.s.db.users.findOne({ email: ctx.body.email.toLowerCase() }).lean();
      if (!user || !user.isActive || user.isServiceAccount) {
        // Same work and message as a wrong password, so accounts cannot be discovered.
        await bcrypt.compare(ctx.body.password, '$2b$12$C6UzMDM.H6dfI/f/IKcEeO6Hq2dE6t6v3b8bA3v4uJ3vQyT5YqU1e').catch(() => false);
        throw new UnauthorizedException('Invalid email or password');
      }
      assertNotLocked(user);
      // Invited users have no password until they accept the invitation.
      const ok = !user.passwordHash.startsWith('!') && (await bcrypt.compare(ctx.body.password, user.passwordHash));
      if (!ok) {
        await recordFailure(ctx, user);
        throw new UnauthorizedException(user.passwordHash.startsWith('!invited') ? 'Accept the invitation emailed to you to set your password' : 'Invalid email or password');
      }
      // Organisations that require single sign-on: only administrators keep password sign-in, for emergencies.
      const sso = await ctx.s.sso.lookup(user.email);
      if (sso.sso && !sso.passwordAllowed) {
        const roles = await ctx.s.db.roles.find({ _id: { $in: user.roleIds } }, { permissions: 1 }).lean();
        if (!roles.some((r) => r.permissions.includes('users.manage'))) throw new HttpError(403, `Your organisation signs in with ${sso.label}. Use the single sign-on button.`);
      }
      if (user.mfa?.enabled) return { mfaRequired: true, challenge: await signChallenge(user) };
      return signedIn(ctx, user, 'password');
    },
  }),

  /** Second step: a code from the authenticator app, or a one-time recovery code. */
  route({
    method: 'POST',
    path: '/auth/mfa/verify',
    public: true,
    rateLimit: 10,
    status: 200,
    body: z.object({ challenge: z.string().min(10), code: Code.optional(), recoveryCode: Code.optional() }),
    handler: async (ctx) => {
      const claim = await verifyChallenge(ctx.body.challenge);
      const user = await ctx.s.db.users.findOne({ _id: claim.sub, organisationId: claim.org }).lean();
      if (!user || !user.isActive || user.tokenVersion !== claim.tv || !user.mfa?.enabled || !user.mfa.secret) throw new UnauthorizedException('The sign-in attempt expired; enter your password again');
      assertNotLocked(user);
      if (ctx.body.recoveryCode) {
        const hash = hashRecoveryCode(ctx.body.recoveryCode);
        const updated = await ctx.s.db.users.findOneAndUpdate({ _id: user._id, 'mfa.recoveryCodes': hash }, { $pull: { 'mfa.recoveryCodes': hash } }, { new: true }).lean();
        if (!updated) {
          await recordFailure(ctx, user);
          throw new UnauthorizedException('That recovery code is not valid or was already used');
        }
        return { ...(await signedIn(ctx, user, 'recovery_code')), recoveryCodesLeft: updated.mfa?.recoveryCodes.length ?? 0 };
      }
      const step = ctx.body.code ? verifyTotp(decryptSecret(user.mfa.secret), ctx.body.code, { afterStep: user.mfa.lastUsedStep }) : null;
      if (step === null) {
        await recordFailure(ctx, user);
        throw new UnauthorizedException('The code is not valid. Check the time on your phone and try the newest code.');
      }
      // A code is accepted once, so an intercepted code cannot be replayed.
      const claimed = await ctx.s.db.users.updateOne({ _id: user._id, $or: [{ 'mfa.lastUsedStep': null }, { 'mfa.lastUsedStep': { $lt: step } }] }, { 'mfa.lastUsedStep': step });
      if (!claimed.modifiedCount) throw new UnauthorizedException('That code was already used; wait for the next one');
      return signedIn(ctx, user, 'mfa');
    },
  }),

  // ----- Password reset and invitations -------------------------------------------------------------

  route({
    method: 'POST',
    path: '/auth/forgot-password',
    public: true,
    rateLimit: 5,
    status: 200,
    body: z.object({ email: z.string().trim().email() }),
    handler: async (ctx) => {
      await ctx.s.account.forgot(ctx.body.email, ctx.ip);
      return { ok: true, message: 'If that address has an account, a reset link is on its way.' };
    },
  }),
  route({ method: 'GET', path: '/auth/reset-password', public: true, rateLimit: 20, query: z.object({ token: z.string().min(20).max(200) }), handler: ({ s, query }) => s.account.tokenInfo(query.token) }),
  route({
    method: 'POST',
    path: '/auth/reset-password',
    public: true,
    rateLimit: 10,
    status: 200,
    body: z.object({ token: z.string().min(20).max(200), password: PasswordSchema }),
    handler: ({ s, body, ip }) => s.account.complete(body.token, body.password, ip),
  }),

  // ----- Single sign-on ---------------------------------------------------------------------------

  route({ method: 'GET', path: '/auth/sso/lookup', public: true, rateLimit: 30, query: z.object({ email: z.string().trim().email() }), handler: ({ s, query }) => s.sso.lookup(query.email) }),
  route({
    method: 'GET',
    path: '/auth/sso/start',
    public: true,
    rateLimit: 20,
    query: z.object({ email: z.string().trim().email(), next: z.string().max(500).optional() }),
    handler: async (ctx) => {
      const next = safeNext(ctx.query.next);
      const origin = new URL(ctx.req.url).origin;
      try {
        const { url, flow } = await ctx.s.sso.start(ctx.query.email, next, `${origin}/api/v1/auth/sso/callback`);
        // SAML keeps its flow server-side (the provider posts back cross-site); OIDC keeps it in a cookie.
        if (!flow) return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
        return new Response(null, { status: 302, headers: { location: url, 'set-cookie': `fs_sso=${flow}; Path=/api/v1/auth/sso; Max-Age=600; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`, 'cache-control': 'no-store' } });
      } catch (err) {
        return new Response(null, { status: 302, headers: { location: `/login?error=${encodeURIComponent(err instanceof Error ? err.message : 'Single sign-on failed')}` } });
      }
    },
  }),
  route({
    method: 'GET',
    path: '/auth/sso/callback',
    public: true,
    rateLimit: 30,
    query: z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() }),
    handler: async (ctx) => {
      const fail = (message: string) => new Response(null, { status: 302, headers: { location: `/login?error=${encodeURIComponent(message)}`, 'set-cookie': 'fs_sso=; Path=/api/v1/auth/sso; Max-Age=0' } });
      if (ctx.query.error) return fail(ctx.query.error_description ?? ctx.query.error);
      const flow = (ctx.req.headers.get('cookie') ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('fs_sso='))?.slice(7);
      if (!ctx.query.code || !ctx.query.state || !flow) return fail('The sign-in was interrupted; start again');
      try {
        const { user, idpMfa, next } = await ctx.s.sso.callback({ code: ctx.query.code, state: ctx.query.state, flow });
        // Users with their own second factor still enter it unless the provider already verified one.
        if (user.mfa?.enabled && !idpMfa) {
          return new Response(null, { status: 302, headers: { location: `/login?challenge=${encodeURIComponent(await signChallenge(user))}&next=${encodeURIComponent(next)}`, 'set-cookie': 'fs_sso=; Path=/api/v1/auth/sso; Max-Age=0' } });
        }
        await ctx.s.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null });
        await startSession(ctx, user, 'sso', { mfa: idpMfa });
        const res = new Response(null, { status: 302, headers: { location: next } });
        res.headers.append('set-cookie', 'fs_sso=; Path=/api/v1/auth/sso; Max-Age=0');
        return res;
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Single sign-on failed');
      }
    },
  }),

  route({
    method: 'POST',
    path: '/auth/saml/:org/acs',
    public: true,
    raw: true,
    rateLimit: 30,
    handler: async (ctx) => {
      const fail = (message: string) => new Response(null, { status: 302, headers: { location: `/login?error=${encodeURIComponent(message)}` } });
      try {
        const form = new URLSearchParams(await ctx.req.text());
        const { user, idpMfa, next } = await ctx.s.sso.samlAcs(ctx.params.org, { SAMLResponse: form.get('SAMLResponse') ?? undefined, RelayState: form.get('RelayState') ?? undefined });
        if (user.mfa?.enabled && !idpMfa) return new Response(null, { status: 302, headers: { location: `/login?challenge=${encodeURIComponent(await signChallenge(user))}&next=${encodeURIComponent(next)}` } });
        await ctx.s.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null });
        await startSession(ctx, user, 'sso', { mfa: idpMfa });
        return new Response(null, { status: 302, headers: { location: next } });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Single sign-on failed');
      }
    },
  }),
  route({
    method: 'GET',
    path: '/auth/saml/:org/metadata',
    public: true,
    rateLimit: 30,
    handler: async ({ s, params }) => new Response(await s.sso.samlMetadata(params.org), { headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' } }),
  }),

  route({
    method: 'PATCH',
    path: '/auth/preferences',
    duringMfaEnrollment: true,
    body: z.object({ approvals: z.enum(['immediate', 'digest', 'off']).optional(), smsApprovals: z.boolean().optional(), phone: z.string().trim().max(20).optional() }),
    handler: async ({ s, user, body }) => {
      const update: Record<string, unknown> = {};
      if (body.approvals) update['emailPreferences.approvals'] = body.approvals;
      if (body.smsApprovals !== undefined) update['smsPreferences.approvals'] = body.smsApprovals;
      if (body.phone !== undefined) {
        const phone = body.phone ? normalisePhone(body.phone) : '';
        if (phone === null) throw new BadRequestException('Enter a Safaricom number such as 0712 345 678');
        update.phone = phone;
      }
      await s.db.users.updateOne({ _id: user.id }, update);
      const after = await s.db.users.findById(user.id, { emailPreferences: 1, smsPreferences: 1, phone: 1 }).lean();
      return { approvals: after?.emailPreferences?.approvals ?? 'immediate', smsApprovals: !!after?.smsPreferences?.approvals, phone: after?.phone ?? '' };
    },
  }),

  route({
    method: 'POST',
    path: '/auth/logout',
    public: true,
    status: 200,
    handler: async (ctx) => {
      // Best effort: revoke the session behind the cookie, if any.
      try {
        const user = await authenticate(ctx.s.db, ctx.req, { ip: ctx.ip });
        if (user.sessionId) await ctx.s.db.sessions.updateOne({ _id: user.sessionId }, { revokedAt: new Date(), revokedReason: 'Signed out' });
      } catch {
        // Already signed out.
      }
      clear(ctx);
      return { ok: true };
    },
  }),

  /** Invalidates every session for the current user, on every device. */
  route({
    method: 'POST',
    path: '/auth/logout-all',
    status: 200,
    duringMfaEnrollment: true,
    handler: async (ctx) => {
      await ctx.s.db.users.updateOne({ _id: ctx.user.id }, { $inc: { tokenVersion: 1 } });
      await ctx.s.db.sessions.updateMany({ userId: ctx.user.id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'Signed out everywhere' });
      clear(ctx);
      return { ok: true };
    },
  }),

  route({
    method: 'POST',
    path: '/auth/change-password',
    status: 200,
    body: ChangePasswordBody,
    handler: async (ctx) => {
      const { db, audit } = ctx.s;
      const doc = await db.users.findById(ctx.user.id).lean();
      if (!doc || !(await bcrypt.compare(ctx.body.currentPassword, doc.passwordHash))) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      const updated = await db.users
        .findByIdAndUpdate(ctx.user.id, { passwordHash: await bcrypt.hash(ctx.body.newPassword, PASSWORD_ROUNDS), $inc: { tokenVersion: 1 } }, { new: true })
        .lean();
      await db.sessions.updateMany({ userId: ctx.user.id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'Password changed' });
      await audit.log(ctx.user, { action: 'auth.change_password', recordType: 'User', recordId: ctx.user.id, summary: 'Changed password; other sessions were signed out' });
      await startSession(ctx, updated!, ctx.user.mfa ? 'mfa' : 'password');
      return { ok: true };
    },
  }),

  route({
    method: 'GET',
    path: '/auth/me',
    duringMfaEnrollment: true,
    handler: async ({ s, user }) => {
      const org = await s.db.organisations.findById(user.organisationId, { 'settings.sso.clientSecret': 0, 'settings.sso.saml.idpCert': 0, 'settings.scim.tokenHash': 0 }).lean();
      const doc = await s.db.users.findById(user.id, { 'mfa.enabled': 1, 'mfa.recoveryCodes': 1, emailPreferences: 1, smsPreferences: 1, phone: 1 }).lean();
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        permissions: user.permissions,
        allBranches: user.allBranches,
        branchIds: user.branchIds,
        approvalLimit: user.approvalLimit,
        organisation: org,
        permissionCatalog: PERMISSION_DESCRIPTIONS,
        mfaEnabled: !!doc?.mfa?.enabled,
        recoveryCodesLeft: doc?.mfa?.recoveryCodes.length ?? 0,
        mfaEnrollmentRequired: !!user.mfaEnrollmentRequired,
        emailPreferences: { approvals: doc?.emailPreferences?.approvals ?? 'immediate' },
        smsPreferences: { approvals: !!doc?.smsPreferences?.approvals },
        smsApprovalAlerts: (await s.sms.settings(user.organisationId)).approvalAlerts,
        phone: doc?.phone ?? '',
      };
    },
  }),

  // ----- Two-step verification ----------------------------------------------------------------------

  /** Starts enrolment: a new secret, shown as a QR code for the authenticator app. */
  route({
    method: 'POST',
    path: '/auth/mfa/setup',
    status: 200,
    duringMfaEnrollment: true,
    handler: async ({ s, user }) => {
      const org = await s.db.organisations.findById(user.organisationId, { name: 1 }).lean();
      const secret = generateSecret();
      await s.db.users.updateOne({ _id: user.id }, { 'mfa.pendingSecret': encryptSecret(secret) });
      const uri = otpauthUri(secret, user.email, `FarajaSoft (${org?.name ?? 'Accounting'})`);
      return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauthUri: uri, qrCode: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    },
  }),

  /** Confirms enrolment with a first code and returns recovery codes (shown once). */
  route({
    method: 'POST',
    path: '/auth/mfa/enable',
    status: 200,
    duringMfaEnrollment: true,
    body: z.object({ code: Code }),
    handler: async (ctx) => {
      const doc = await ctx.s.db.users.findById(ctx.user.id).lean();
      if (!doc?.mfa?.pendingSecret) throw new BadRequestException('Start the setup again');
      const secret = decryptSecret(doc.mfa.pendingSecret);
      const step = verifyTotp(secret, ctx.body.code);
      if (step === null) throw new BadRequestException('The code is not valid. Check that the time on your phone is correct.');
      const codes = generateRecoveryCodes();
      await ctx.s.db.users.updateOne(
        { _id: ctx.user.id },
        { 'mfa.enabled': true, 'mfa.secret': doc.mfa.pendingSecret, 'mfa.pendingSecret': null, 'mfa.recoveryCodes': codes.map(hashRecoveryCode), 'mfa.enabledAt': new Date(), 'mfa.lastUsedStep': step },
      );
      await ctx.s.audit.log(ctx.user, { action: 'auth.mfa_enable', recordType: 'User', recordId: ctx.user.id, summary: 'Turned on two-step verification' });
      // This session now counts as verified.
      if (ctx.user.sessionId) await ctx.s.db.sessions.updateOne({ _id: ctx.user.sessionId }, { revokedAt: new Date(), revokedReason: 'Upgraded to two-step verification' });
      return { recoveryCodes: codes, token: await startSession(ctx, doc, 'mfa') };
    },
  }),

  route({
    method: 'POST',
    path: '/auth/mfa/disable',
    status: 200,
    body: z.object({ password: z.string().min(1), code: Code }),
    handler: async (ctx) => {
      const org = await ctx.s.db.organisations.findById(ctx.user.organisationId, { 'settings.requireMfa': 1 }).lean();
      if (org?.settings?.requireMfa) throw new ForbiddenException('Your organisation requires two-step verification');
      const doc = await ctx.s.db.users.findById(ctx.user.id).lean();
      if (!doc?.mfa?.enabled || !doc.mfa.secret) throw new BadRequestException('Two-step verification is not on');
      if (!(await bcrypt.compare(ctx.body.password, doc.passwordHash))) throw new UnauthorizedException('Password is incorrect');
      if (verifyTotp(decryptSecret(doc.mfa.secret), ctx.body.code) === null) throw new UnauthorizedException('The code is not valid');
      await ctx.s.db.users.updateOne({ _id: ctx.user.id }, { mfa: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null, lastUsedStep: null } });
      await ctx.s.audit.log(ctx.user, { action: 'auth.mfa_disable', recordType: 'User', recordId: ctx.user.id, summary: 'Turned off two-step verification' });
      return { ok: true };
    },
  }),

  route({
    method: 'POST',
    path: '/auth/mfa/recovery-codes',
    status: 200,
    body: z.object({ code: Code }),
    handler: async (ctx) => {
      const doc = await ctx.s.db.users.findById(ctx.user.id).lean();
      if (!doc?.mfa?.enabled || !doc.mfa.secret) throw new BadRequestException('Two-step verification is not on');
      if (verifyTotp(decryptSecret(doc.mfa.secret), ctx.body.code) === null) throw new UnauthorizedException('The code is not valid');
      const codes = generateRecoveryCodes();
      await ctx.s.db.users.updateOne({ _id: ctx.user.id }, { 'mfa.recoveryCodes': codes.map(hashRecoveryCode) });
      await ctx.s.audit.log(ctx.user, { action: 'auth.mfa_recovery_codes', recordType: 'User', recordId: ctx.user.id, summary: 'Generated new recovery codes' });
      return { recoveryCodes: codes };
    },
  }),

  // ----- Sessions -------------------------------------------------------------------------------------

  route({
    method: 'GET',
    path: '/auth/sessions',
    duringMfaEnrollment: true,
    handler: async ({ s, user }) => {
      const rows = await s.db.sessions.find({ userId: user.id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean();
      return rows.map((r) => ({ id: r._id, ip: r.ip, userAgent: r.userAgent, method: r.method, createdAt: (r as { createdAt?: Date }).createdAt, lastSeenAt: r.lastSeenAt, expiresAt: r.expiresAt, current: !!user.sessionId?.equals(r._id) }));
    },
  }),
  route({
    method: 'POST',
    path: '/auth/sessions/:id/revoke',
    status: 200,
    duringMfaEnrollment: true,
    handler: async ({ s, user, params }) => {
      const res = await s.db.sessions.updateOne({ _id: parseId(params.id), userId: user.id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'Signed out from another device' });
      if (!res.modifiedCount) throw new NotFoundException('Session not found');
      await s.audit.log(user, { action: 'auth.session_revoke', recordType: 'Session', recordId: parseId(params.id), summary: 'Signed out a session' });
      return { ok: true };
    },
  }),
];

