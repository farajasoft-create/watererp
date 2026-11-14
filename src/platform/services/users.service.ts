import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { API_KEY_PREFIX, AuthUser, hashApiKey, signToken, toAuthUser, twoFactorRequired } from '../auth';
import { decryptSecret, encryptSecret } from '../common/secrets';
import { newTotpSecret, otpauthUrl, recoveryCodes, verifyTotp } from '../common/totp';
import { BadRequestException, NotFoundException, UnauthorizedException } from '../common/errors';
import { Db } from '../db';
import { CustomRole, ModuleManifest, withCustomRoles } from '../manifest';
import { AuditService } from './audit.service';

export interface AccessInput {
  module: string;
  role: string;
  scope?: Types.ObjectId[];
}

export interface UserInput {
  name: string;
  email: string;
  phone?: string;
  isAdmin?: boolean;
  access?: AccessInput[];
  active?: boolean;
}

const mfaKey = () => new TextEncoder().encode(process.env.JWT_SECRET ?? '');
const hashRecovery = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

/** A dummy hash keeps sign-in timing the same whether or not the email exists. */
let dummyHash: string | null = null;
const dummy = () => (dummyHash ??= bcrypt.hashSync('not-a-password', 10));

/** Keeps one role per installed module and drops roles a module does not define. */
function checkedAccess(manifests: readonly ModuleManifest[], access: AccessInput[] = []): AccessInput[] {
  const seen = new Set<string>();
  for (const a of access) {
    const manifest = manifests.find((m) => m.key === a.module);
    if (!manifest) throw new BadRequestException(`There is no ${a.module} module`);
    if (!manifest.roles[a.role]) throw new BadRequestException(`${manifest.name} has no role ${a.role}`);
    if (seen.has(a.module)) throw new BadRequestException(`Give one role per module (${manifest.name} appears twice)`);
    seen.add(a.module);
  }
  return access.map((a) => ({ module: a.module, role: a.role, scope: a.scope ?? [] }));
}

export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly manifests: readonly ModuleManifest[],
  ) {}

  async login(email: string, password: string, ip: string | null) {
    const user = await this.db.users.findOne({ email: email.toLowerCase().trim() }).lean();
    const ok = await bcrypt.compare(password, user?.passwordHash ?? dummy());
    if (!user || !ok || !user.active) throw new UnauthorizedException('Wrong email or password');
    // With two-step sign-in on, the password only earns a short ticket to exchange with the app's code.
    if (user.twoFactor?.enabled) {
      const ticket = await new SignJWT({ kind: 'mfa' }).setProtectedHeader({ alg: 'HS256' }).setSubject(user._id.toHexString()).setIssuedAt().setExpirationTime('5m').sign(mfaKey());
      return { twoFactorRequired: true as const, ticket };
    }
    await this.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    await this.audit.record({ id: user._id, organisationId: user.organisationId, ip }, 'auth.login', 'user', user._id);
    return { token: await signToken(user), user: await this.me(user._id) };
  }

  /** Second step of sign-in: the authenticator code, or one of the recovery codes (each works once). */
  async loginTwoFactor(ticket: string, code: string, ip: string | null) {
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(ticket, mfaKey(), { algorithms: ['HS256'] });
      if (payload.kind !== 'mfa') throw new Error();
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('The sign-in took too long; enter your password again');
    }
    const user = await this.db.users.findById(sub).lean();
    if (!user?.active || !user.twoFactor?.enabled || !user.twoFactor.secretSealed) throw new UnauthorizedException();
    const clean = code.replace(/\s/g, '');
    let ok = /^\d{6}$/.test(clean) && verifyTotp(decryptSecret(user.twoFactor.secretSealed), clean);
    let usedRecovery = false;
    if (!ok && (user.twoFactor.recoveryHashes ?? []).includes(hashRecovery(code))) {
      ok = true;
      usedRecovery = true;
      await this.db.users.updateOne({ _id: user._id }, { $pull: { 'twoFactor.recoveryHashes': hashRecovery(code) } });
    }
    if (!ok) {
      await this.audit.record({ id: user._id, organisationId: user.organisationId, ip }, 'auth.login.2fa-failed', 'user', user._id);
      throw new UnauthorizedException('The code is wrong');
    }
    await this.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    await this.audit.record({ id: user._id, organisationId: user.organisationId, ip }, 'auth.login', 'user', user._id, { twoFactor: usedRecovery ? 'recovery-code' : 'app' });
    return { token: await signToken(user), user: await this.me(user._id) };
  }

  /** Starts enrolment: a new secret to type or scan into the authenticator app. */
  async setupTwoFactor(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    const secret = newTotpSecret();
    await this.db.users.updateOne({ _id: user.id }, { 'twoFactor.pendingSecretSealed': encryptSecret(secret) });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, org?.name ?? 'FarajaSoft') };
  }

  /** Confirms enrolment with a first code; returns the recovery codes, shown this once. */
  async enableTwoFactor(user: AuthUser, code: string) {
    const doc = await this.db.users.findById(user.id).lean();
    const pending = doc?.twoFactor?.pendingSecretSealed;
    if (!pending) throw new BadRequestException('Start the set-up first');
    if (!verifyTotp(decryptSecret(pending), code)) throw new BadRequestException('The code is wrong; check the phone clock and try again');
    const codes = recoveryCodes();
    await this.db.users.updateOne({ _id: user.id }, { twoFactor: { enabled: true, secretSealed: pending, recoveryHashes: codes.map(hashRecovery), enrolledAt: new Date() }, $inc: { tokenVersion: 1 } });
    await this.audit.record(user, 'auth.2fa.enable', 'user', user.id);
    const updated = await this.db.users.findById(user.id).lean();
    return { recoveryCodes: codes, token: await signToken(updated!) };
  }

  async disableTwoFactor(user: AuthUser, password: string, code: string) {
    const doc = await this.db.users.findById(user.id).lean();
    if (!doc?.twoFactor?.enabled || !doc.twoFactor.secretSealed) throw new BadRequestException('Two-step sign-in is not on');
    const org = await this.db.organisations.findById(user.organisationId, { security: 1 }).lean();
    if (twoFactorRequired(org?.security?.requireTwoFactor, user.isAdmin)) throw new BadRequestException('Your organisation requires two-step sign-in');
    if (!(await bcrypt.compare(password, doc.passwordHash)) || !verifyTotp(decryptSecret(doc.twoFactor.secretSealed), code)) throw new BadRequestException('The password or code is wrong');
    await this.db.users.updateOne({ _id: user.id }, { twoFactor: { enabled: false } });
    await this.audit.record(user, 'auth.2fa.disable', 'user', user.id);
    return { ok: true };
  }

  async me(id: Types.ObjectId) {
    const user = await this.db.users.findById(id).lean();
    if (!user) throw new NotFoundException('User not found');
    const org = await this.db.organisations.findById(user.organisationId, { name: 1, code: 1, currency: 1, modules: 1, security: 1, customRoles: 1 }).lean();
    const manifests = withCustomRoles(this.manifests, org?.customRoles);
    const auth = toAuthUser(user, org?.modules ?? [], null, manifests);
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      isAdmin: auth.isAdmin,
      twoFactorEnabled: Boolean(user.twoFactor?.enabled),
      mustEnrolTwoFactor: twoFactorRequired(org?.security?.requireTwoFactor, auth.isAdmin) && !user.twoFactor?.enabled,
      access: Object.entries(auth.access).map(([module, a]) => ({
        module,
        role: a.role,
        roleLabel: manifests.find((m) => m.key === module)?.roles[a.role]?.label ?? a.role,
        scope: a.scope,
      })),
      modules: auth.modules,
      permissions: auth.permissions,
      organisation: org ? { id: org._id, name: org.name, code: org.code, currency: org.currency } : null,
    };
  }

  /** Signs out every device by invalidating issued tokens. */
  async logoutEverywhere(user: AuthUser) {
    await this.db.users.updateOne({ _id: user.id }, { $inc: { tokenVersion: 1 } });
  }

  list(user: AuthUser) {
    return this.db.users.find({ organisationId: user.organisationId }, { passwordHash: 0, 'twoFactor.secretSealed': 0, 'twoFactor.pendingSecretSealed': 0, 'twoFactor.recoveryHashes': 0, 'apiKeys.hash': 0 }).sort({ name: 1 }).lean();
  }

  /** An administrator clears a user's authenticator (lost phone); they enrol again at next sign-in. */
  async resetTwoFactor(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.users.updateOne({ _id: id, organisationId: user.organisationId }, { twoFactor: { enabled: false }, $inc: { tokenVersion: 1 } });
    if (!r.matchedCount) throw new NotFoundException('User not found');
    await this.audit.record(user, 'auth.2fa.reset', 'user', id);
    return { ok: true };
  }

  /** API keys of a user (never the key itself). */
  async apiKeys(user: AuthUser, id: Types.ObjectId) {
    const u = await this.db.users.findOne({ _id: id, organisationId: user.organisationId }, { apiKeys: 1 }).lean();
    if (!u) throw new NotFoundException('User not found');
    return (u.apiKeys ?? []).map((k) => ({ id: k._id, label: k.label, prefix: k.prefix, createdAt: k.createdAt, expiresAt: k.expiresAt ?? null, lastUsedAt: k.lastUsedAt ?? null }));
  }

  /** Issues a key; it is shown once. Give it to a service user holding only the roles the other system needs. */
  async createApiKey(user: AuthUser, id: Types.ObjectId, input: { label: string; days?: number | null }) {
    const u = await this.db.users.findOne({ _id: id, organisationId: user.organisationId }, { name: 1, isAdmin: 1, apiKeys: 1 }).lean();
    if (!u) throw new NotFoundException('User not found');
    if (u.isAdmin) throw new BadRequestException('Issue keys to a service user with limited roles, not to an administrator');
    if ((u.apiKeys ?? []).length >= 10) throw new BadRequestException('A user can hold at most ten keys; revoke an old one');
    const key = `${API_KEY_PREFIX}${randomBytes(30).toString('base64url')}`;
    const expiresAt = input.days ? new Date(Date.now() + input.days * 86_400_000) : null;
    await this.db.users.updateOne({ _id: id }, { $push: { apiKeys: { hash: hashApiKey(key), prefix: key.slice(0, 9), label: input.label, createdAt: new Date(), createdBy: user.id, expiresAt } } });
    await this.audit.record(user, 'users.apikey.create', 'user', id, { label: input.label, expiresAt });
    return { key, label: input.label, expiresAt };
  }

  async revokeApiKey(user: AuthUser, id: Types.ObjectId, keyId: Types.ObjectId) {
    const r = await this.db.users.updateOne({ _id: id, organisationId: user.organisationId }, { $pull: { apiKeys: { _id: keyId } } });
    if (!r.modifiedCount) throw new NotFoundException('Key not found');
    await this.audit.record(user, 'users.apikey.revoke', 'user', id, { keyId });
    return this.apiKeys(user, id);
  }

  /** The installed modules with this organisation's own roles added. */
  async manifestsFor(organisationId: Types.ObjectId) {
    const org = await this.db.organisations.findById(organisationId, { customRoles: 1 }).lean();
    return withCustomRoles(this.manifests, org?.customRoles);
  }

  async customRoles(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId, { customRoles: 1 }).lean();
    return org?.customRoles ?? [];
  }

  /** Adds or replaces one of the organisation's own roles; holders get the new permissions at their next request. */
  async saveCustomRole(user: AuthUser, input: CustomRole) {
    const manifest = this.manifests.find((m) => m.key === input.module);
    if (!manifest) throw new BadRequestException(`There is no ${input.module} module`);
    const key = input.key.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(key)) throw new BadRequestException('The role key is 2 to 30 letters, digits or _');
    if (manifest.roles[key]) throw new BadRequestException(`${key} is one of ${manifest.name}'s standard roles; choose another key`);
    const own = new Set(Object.values(manifest.permissions));
    const unknown = input.permissions.filter((p) => !own.has(p));
    if (unknown.length) throw new BadRequestException(`Not ${manifest.name} permissions: ${unknown.join(', ')}`);
    if (!input.permissions.length) throw new BadRequestException('Give the role at least one permission');
    const role = { module: input.module, key, label: input.label, description: input.description ?? '', permissions: [...new Set(input.permissions)] };
    await this.db.organisations.updateOne({ _id: user.organisationId }, { $pull: { customRoles: { module: input.module, key } } });
    await this.db.organisations.updateOne({ _id: user.organisationId }, { $push: { customRoles: role } });
    await this.audit.record(user, 'roles.custom.save', 'organisation', user.organisationId, role);
    return this.customRoles(user);
  }

  async deleteCustomRole(user: AuthUser, module: string, key: string) {
    const holders = await this.db.users.countDocuments({ organisationId: user.organisationId, access: { $elemMatch: { module, role: key } } });
    if (holders) throw new BadRequestException(`${holders} user(s) hold this role; give them another role first`);
    await this.db.organisations.updateOne({ _id: user.organisationId }, { $pull: { customRoles: { module, key } } });
    await this.audit.record(user, 'roles.custom.delete', 'organisation', user.organisationId, { module, key });
    return this.customRoles(user);
  }

  async create(user: AuthUser, input: UserInput & { password: string }) {
    const { password, ...data } = input;
    const access = checkedAccess(await this.manifestsFor(user.organisationId), input.access);
    const [created] = await this.db.users.create([{ ...data, access, organisationId: user.organisationId, passwordHash: await bcrypt.hash(password, 10) }]);
    await this.audit.record(user, 'user.create', 'user', created._id, { email: input.email, isAdmin: input.isAdmin, access: access.map((a) => `${a.module}:${a.role}`) });
    return this.db.users.findById(created._id, { passwordHash: 0, twoFactor: 0, 'apiKeys.hash': 0 }).lean();
  }

  async update(user: AuthUser, id: Types.ObjectId, input: UserInput & { password?: string }) {
    if (id.equals(user.id) && (input.active === false || input.isAdmin === false)) throw new BadRequestException('You cannot remove your own administrator rights or deactivate yourself');
    const { password, ...data } = input;
    const update: Record<string, unknown> = { ...data, ...(input.access && { access: checkedAccess(await this.manifestsFor(user.organisationId), input.access) }) };
    // A password reset or deactivation signs the user out everywhere.
    if (password) update.passwordHash = await bcrypt.hash(password, 10);
    const inc = password || input.active === false ? { $inc: { tokenVersion: 1 } } : {};
    const updated = await this.db.users.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { ...update, ...inc }, { new: true, projection: { passwordHash: 0, twoFactor: 0, 'apiKeys.hash': 0 } }).lean();
    if (!updated) throw new NotFoundException('User not found');
    await this.audit.record(user, 'user.update', 'user', id, { isAdmin: input.isAdmin, access: input.access?.map((a) => `${a.module}:${a.role}`), active: input.active, passwordReset: Boolean(password) });
    return updated;
  }

  async changePassword(user: AuthUser, current: string, next: string) {
    const doc = await this.db.users.findById(user.id).lean();
    if (!doc || !(await bcrypt.compare(current, doc.passwordHash))) throw new BadRequestException('The current password is wrong');
    await this.db.users.updateOne({ _id: user.id }, { passwordHash: await bcrypt.hash(next, 10), $inc: { tokenVersion: 1 } });
    const updated = await this.db.users.findById(user.id).lean();
    return { token: await signToken(updated!) };
  }
}
