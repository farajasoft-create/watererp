import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, HttpError, NotFoundException, UnauthorizedException } from '../../common/errors';
import { PERMISSIONS } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl } from './email.service';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ScimUserInput {
  userName?: string;
  externalId?: string;
  active?: boolean;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: { value?: string; primary?: boolean; type?: string }[];
  phoneNumbers?: { value?: string; type?: string; primary?: boolean }[];
}

interface ScimUserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  phone?: string | null;
  isActive: boolean;
  scimExternalId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * SCIM 2.0 user provisioning (RFC 7643/7644) for identity providers such as Entra ID, Okta and Google:
 * they create people, keep their name, email and status in step, and deactivate leavers. Provisioned
 * users get the organisation's default roles and sign in through single sign-on (they have no password).
 * Users are never deleted, only deactivated, so the audit trail keeps its names.
 */
export class ScimService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ----- Settings ------------------------------------------------------------------------------

  private view(org: { _id: Types.ObjectId; settings?: { scim?: { enabled?: boolean | null; tokenHash?: string | null; defaultRoleIds?: Types.ObjectId[] | null; lastUsedAt?: Date | null } | null } | null }, token?: string) {
    const s = org.settings?.scim;
    return {
      enabled: !!s?.enabled,
      baseUrl: `${appUrl()}/api/v1/scim/v2`,
      hasToken: !!s?.tokenHash,
      defaultRoleIds: s?.defaultRoleIds ?? [],
      lastUsedAt: s?.lastUsedAt ?? null,
      ...(token && { token }),
    };
  }

  async settings(user: AuthUser) {
    const org = (await this.db.organisations.findById(user.organisationId, { 'settings.scim': 1 }).lean())!;
    return this.view(org);
  }

  async configure(user: AuthUser, input: { enabled: boolean; defaultRoleIds: Types.ObjectId[]; rotateToken?: boolean }) {
    const roles = await this.db.roles.find({ organisationId: user.organisationId, _id: { $in: input.defaultRoleIds } }).lean();
    if (roles.length !== input.defaultRoleIds.length) throw new BadRequestException('Role not found');
    if (roles.some((r) => r.permissions.includes(PERMISSIONS.USERS_MANAGE) || r.permissions.includes(PERMISSIONS.ORG_MANAGE))) {
      throw new BadRequestException('Provisioned users cannot be given administrator roles automatically; grant those by hand');
    }
    const org = (await this.db.organisations.findById(user.organisationId, { 'settings.scim': 1 }).lean())!;
    const update: Record<string, unknown> = { 'settings.scim.enabled': input.enabled, 'settings.scim.defaultRoleIds': input.defaultRoleIds };
    let token: string | undefined;
    if (input.rotateToken || !org.settings?.scim?.tokenHash) {
      token = `scim_${randomBytes(30).toString('base64url')}`;
      update['settings.scim.tokenHash'] = sha256(token);
    }
    await this.db.organisations.updateOne({ _id: user.organisationId }, update);
    await this.audit.log(user, { action: 'organisation.scim', recordType: 'Organisation', recordId: user.organisationId, summary: `${input.enabled ? 'Enabled' : 'Disabled'} SCIM user provisioning${token ? ' (new token)' : ''}` });
    return this.view((await this.db.organisations.findById(user.organisationId, { 'settings.scim': 1 }).lean())!, token);
  }

  // ----- Authentication ------------------------------------------------------------------------

  /** The organisation a bearer token provisions for. */
  async authenticate(authorization: string | null) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token.startsWith('scim_')) throw new UnauthorizedException('A SCIM bearer token is required');
    const hash = sha256(token);
    const org = await this.db.organisations.findOne({ 'settings.scim.tokenHash': hash, 'settings.scim.enabled': true }, { name: 1, settings: 1 }).lean();
    if (!org || !timingSafeEqual(Buffer.from(org.settings!.scim!.tokenHash!, 'hex'), Buffer.from(hash, 'hex'))) throw new UnauthorizedException('Invalid SCIM token');
    await this.db.organisations.updateOne({ _id: org._id }, { 'settings.scim.lastUsedAt': new Date() });
    return org;
  }

  private actor(organisationId: Types.ObjectId) {
    return { organisationId, name: 'SCIM provisioning' };
  }

  // ----- Resources -----------------------------------------------------------------------------

  private resource(u: ScimUserDoc) {
    const [givenName, ...rest] = u.name.split(' ');
    return {
      schemas: [USER_SCHEMA],
      id: u._id.toHexString(),
      ...(u.scimExternalId && { externalId: u.scimExternalId }),
      userName: u.email,
      displayName: u.name,
      name: { formatted: u.name, givenName, familyName: rest.join(' ') },
      emails: [{ value: u.email, type: 'work', primary: true }],
      ...(u.phone && { phoneNumbers: [{ value: u.phone, type: 'mobile', primary: true }] }),
      active: u.isActive,
      meta: { resourceType: 'User', created: u.createdAt, lastModified: u.updatedAt, location: `${appUrl()}/api/v1/scim/v2/Users/${u._id.toHexString()}` },
    };
  }

  private fields(input: ScimUserInput) {
    const email = (input.emails?.find((e) => e.primary)?.value ?? input.emails?.[0]?.value ?? input.userName ?? '').trim().toLowerCase();
    const name = (input.displayName ?? input.name?.formatted ?? [input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ')).trim();
    const phone = input.phoneNumbers?.find((p) => p.primary)?.value ?? input.phoneNumbers?.[0]?.value;
    return { email, name, phone, active: input.active, externalId: input.externalId };
  }

  private async load(organisationId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('User not found');
    const u = await this.db.users.findOne({ _id: id, organisationId, isServiceAccount: { $ne: true } }).lean();
    if (!u) throw new NotFoundException('User not found');
    return u as unknown as ScimUserDoc & { roleIds: Types.ObjectId[] };
  }

  async list(authorization: string | null, q: { filter?: string; startIndex?: number; count?: number }) {
    const org = await this.authenticate(authorization);
    const filter: Record<string, unknown> = { organisationId: org._id, isServiceAccount: { $ne: true } };
    if (q.filter) {
      const m = /^\s*(userName|externalId|emails(?:\.value)?|emails\[type eq "work"\]\.value)\s+eq\s+"([^"]*)"\s*$/i.exec(q.filter);
      if (!m) throw new HttpError(400, 'Only "userName eq", "externalId eq" and "emails eq" filters are supported');
      if (m[1].toLowerCase() === 'externalid') filter.scimExternalId = m[2];
      else filter.email = m[2].toLowerCase();
    }
    const startIndex = Math.max(1, q.startIndex ?? 1);
    const count = Math.min(Math.max(0, q.count ?? 100), 200);
    const [total, users] = await Promise.all([this.db.users.countDocuments(filter), this.db.users.find(filter).sort({ createdAt: 1 }).skip(startIndex - 1).limit(count).lean()]);
    return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: users.length, Resources: users.map((u) => this.resource(u as unknown as ScimUserDoc)) };
  }

  async get(authorization: string | null, id: string) {
    const org = await this.authenticate(authorization);
    return this.resource(await this.load(org._id, id));
  }

  async create(authorization: string | null, input: ScimUserInput) {
    const org = await this.authenticate(authorization);
    const f = this.fields(input);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw new HttpError(400, 'userName (or a primary email) must be an email address');
    if (await this.db.users.exists({ email: f.email })) throw new HttpError(409, `A user with ${f.email} already exists`);
    const [u] = await this.db.users.create([
      {
        organisationId: org._id,
        email: f.email,
        name: f.name || f.email,
        phone: f.phone ?? '',
        // No password: provisioned people sign in through single sign-on.
        passwordHash: '!scim',
        isActive: f.active ?? true,
        roleIds: org.settings?.scim?.defaultRoleIds ?? [],
        scimExternalId: f.externalId ?? null,
      },
    ]);
    await this.audit.log(this.actor(org._id), { action: 'user.create', recordType: 'User', recordId: u._id, summary: `Provisioned ${f.email} through SCIM` });
    return this.resource(u.toObject() as unknown as ScimUserDoc);
  }

  /** PUT: the provider's full view of the user. */
  async replace(authorization: string | null, id: string, input: ScimUserInput) {
    const org = await this.authenticate(authorization);
    const before = await this.load(org._id, id);
    const f = this.fields(input);
    return this.apply(org._id, before, { email: f.email || before.email, name: f.name || before.name, phone: f.phone ?? before.phone ?? '', active: f.active ?? before.isActive, externalId: f.externalId ?? before.scimExternalId ?? null });
  }

  /** PATCH: SCIM patch operations (replace/add/remove), with or without paths. */
  async patch(authorization: string | null, id: string, body: { Operations?: { op?: string; path?: string; value?: unknown }[] }) {
    const org = await this.authenticate(authorization);
    const before = await this.load(org._id, id);
    const next = { email: before.email, name: before.name, phone: before.phone ?? '', active: before.isActive, externalId: before.scimExternalId ?? null };
    const [given0, ...family0] = before.name.split(' ');
    let given = given0;
    let family = family0.join(' ');
    let nameSet: string | null = null;
    const set = (path: string, value: unknown) => {
      const p = path.toLowerCase();
      if (p === 'active') next.active = value === true || value === 'True' || value === 'true';
      else if (p === 'username' || p.startsWith('emails')) next.email = String(Array.isArray(value) ? ((value[0] as { value?: string })?.value ?? '') : value).toLowerCase();
      else if (p === 'displayname' || p === 'name.formatted') nameSet = String(value);
      else if (p === 'name.givenname') given = String(value);
      else if (p === 'name.familyname') family = String(value);
      else if (p === 'externalid') next.externalId = String(value);
      else if (p.startsWith('phonenumbers')) next.phone = String(Array.isArray(value) ? ((value[0] as { value?: string })?.value ?? '') : value);
      else if (p === 'name' && value && typeof value === 'object') {
        const n = value as { givenName?: string; familyName?: string; formatted?: string };
        if (n.formatted) nameSet = n.formatted;
        if (n.givenName) given = n.givenName;
        if (n.familyName) family = n.familyName;
      }
    };
    for (const operation of body.Operations ?? []) {
      const op = (operation.op ?? '').toLowerCase();
      if (!['replace', 'add', 'remove'].includes(op)) throw new HttpError(400, `Unsupported operation ${operation.op}`);
      if (op === 'remove') {
        if (operation.path?.toLowerCase().startsWith('phonenumbers')) next.phone = '';
        continue;
      }
      if (operation.path) set(operation.path, operation.value);
      else if (operation.value && typeof operation.value === 'object') for (const [k, v] of Object.entries(operation.value)) set(k, v);
    }
    next.name = (nameSet ?? [given, family].filter(Boolean).join(' ')).trim() || before.name;
    return this.apply(org._id, before, next);
  }

  /** DELETE: the person has left; they are deactivated (never deleted). */
  async remove(authorization: string | null, id: string) {
    const org = await this.authenticate(authorization);
    const before = await this.load(org._id, id);
    await this.apply(org._id, before, { email: before.email, name: before.name, phone: before.phone ?? '', active: false, externalId: before.scimExternalId ?? null });
    return null;
  }

  private async apply(organisationId: Types.ObjectId, before: ScimUserDoc & { roleIds: Types.ObjectId[] }, next: { email: string; name: string; phone: string; active: boolean; externalId: string | null }) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) throw new HttpError(400, 'The email must be an email address');
    if (next.email !== before.email && (await this.db.users.exists({ email: next.email }))) throw new HttpError(409, `A user with ${next.email} already exists`);
    if (next.email !== before.email) {
      const adminRoles = await this.db.roles.find({ organisationId, permissions: { $in: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.ORG_MANAGE] } }, { _id: 1 }).lean();
      if (before.roleIds.some((r) => adminRoles.some((a) => a._id.equals(r)))) throw new HttpError(409, `${before.email} is an administrator; their email can only be changed in FarajaSoft`);
    }
    if (before.isActive && !next.active) {
      // Never leave the organisation without an active administrator.
      const adminRoles = (await this.db.roles.find({ organisationId, permissions: PERMISSIONS.USERS_MANAGE }, { _id: 1 }).lean()).map((r) => r._id);
      if (before.roleIds.some((r) => adminRoles.some((a) => a.equals(r)))) {
        const others = await this.db.users.countDocuments({ organisationId, _id: { $ne: before._id }, isActive: true, roleIds: { $in: adminRoles } });
        if (!others) throw new HttpError(409, `${before.email} is the last active administrator and cannot be deactivated`);
      }
    }
    const changes: Record<string, unknown> = { email: next.email, name: next.name, phone: next.phone, isActive: next.active, scimExternalId: next.externalId };
    // Deactivation and a new email end every session.
    const revoke = (before.isActive && !next.active) || next.email !== before.email;
    await this.db.users.updateOne({ _id: before._id }, { ...changes, ...(revoke && { $inc: { tokenVersion: 1 } }) });
    const what = [next.email !== before.email && `email ${before.email} → ${next.email}`, next.name !== before.name && `name → ${next.name}`, next.active !== before.isActive && (next.active ? 'reactivated' : 'deactivated')].filter(Boolean);
    if (what.length) await this.audit.log(this.actor(organisationId), { action: 'user.update', recordType: 'User', recordId: before._id, summary: `SCIM: ${before.email} ${what.join(', ')}` });
    return this.resource((await this.db.users.findById(before._id).lean()) as unknown as ScimUserDoc);
  }

  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token from Settings → Single sign-on → User provisioning', primary: true }],
    };
  }
}
