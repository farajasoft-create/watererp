import { AuthUser } from '../auth';
import { BadRequestException, NotFoundException } from '../common/errors';
import { decryptSecret, encryptSecret, maskSecret } from '../common/secrets';
import { Db } from '../db';
import { LedgerService } from '../ledger/ledger.service';
import { ModuleManifest } from '../manifest';
import { AuditService } from './audit.service';

export interface GeneralInput {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  kraPin?: string;
  currency?: string;
}

export interface LedgerInput {
  enabled: boolean;
  baseUrl?: string;
  /** Leave out to keep the stored key. */
  apiKey?: string;
  entityId?: string;
  branchId?: string;
  mode: 'DRAFT' | 'SUBMIT' | 'POST';
}

/** Settings shared by every module: the organisation, which modules it uses, SMS and the ledger. */
export class OrganisationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly manifests: readonly ModuleManifest[],
  ) {}

  private async org(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  async get(user: AuthUser) {
    const org = await this.org(user);
    return {
      ...org,
      ledger: { ...org.ledger, apiKeySealed: undefined, apiKey: org.ledger?.apiKeySealed ? maskSecret(decryptSecret(org.ledger.apiKeySealed)) : null, provider: this.ledger.providerName },
      sms: { ...org.sms, apiKeySealed: undefined, apiKey: org.sms?.apiKeySealed ? maskSecret(decryptSecret(org.sms.apiKeySealed)) : null },
      mail: { ...org.mail, passwordSealed: undefined, password: org.mail?.passwordSealed ? '••••••' : null },
      security: { requireTwoFactor: org.security?.requireTwoFactor ?? 'NONE', sso: { ...org.security?.sso, clientSecretSealed: undefined, clientSecret: org.security?.sso?.clientSecretSealed ? maskSecret(decryptSecret(org.security.sso.clientSecretSealed)) : null } },
    };
  }

  async updateGeneral(user: AuthUser, input: GeneralInput) {
    await this.db.organisations.updateOne({ _id: user.organisationId }, input);
    await this.audit.record(user, 'settings.general', 'organisation', user.organisationId, { name: input.name });
    return this.get(user);
  }

  /** Every installed module, and whether this organisation uses it. */
  async listModules(user: AuthUser) {
    const org = await this.org(user);
    return this.manifests.map((m) => ({ key: m.key, name: m.name, description: m.description, home: m.home, dependsOn: m.dependsOn ?? [], enabled: org.modules.includes(m.key) }));
  }

  async setModules(user: AuthUser, keys: string[]) {
    const unknown = keys.filter((k) => !this.manifests.some((m) => m.key === k));
    if (unknown.length) throw new BadRequestException(`Not installed: ${unknown.join(', ')}`);
    for (const k of keys) {
      const missing = (this.manifests.find((m) => m.key === k)!.dependsOn ?? []).filter((d) => !keys.includes(d));
      if (missing.length) throw new BadRequestException(`${k} needs ${missing.join(', ')} switched on too`);
    }
    await this.db.organisations.updateOne({ _id: user.organisationId }, { modules: [...new Set(keys)] });
    await this.audit.record(user, 'settings.modules', 'organisation', user.organisationId, { modules: keys });
    return this.listModules(user);
  }

  async updateLedger(user: AuthUser, input: LedgerInput) {
    const org = await this.org(user);
    if (input.baseUrl && !/^https?:\/\//.test(input.baseUrl)) throw new BadRequestException('The accounting address must start with https://');
    if (input.apiKey && !input.apiKey.startsWith('fsk_')) throw new BadRequestException('Use an API key from Accounting → Setup → Developers (it starts with fsk_)');
    const sealed = input.apiKey ? encryptSecret(input.apiKey) : org.ledger?.apiKeySealed;
    if (input.enabled && (!input.baseUrl || !sealed || !input.entityId || !input.branchId)) throw new BadRequestException('Enter the address, API key, entity and branch before switching the ledger on');
    await this.db.organisations.updateOne(
      { _id: user.organisationId },
      { ledger: { enabled: input.enabled, baseUrl: input.baseUrl?.replace(/\/+$/, ''), apiKeySealed: sealed, entityId: input.entityId, branchId: input.branchId, mode: input.mode } },
    );
    await this.audit.record(user, 'settings.ledger', 'organisation', user.organisationId, { enabled: input.enabled, baseUrl: input.baseUrl, mode: input.mode });
    return this.get(user);
  }

  async updateSms(user: AuthUser, input: { provider: 'NONE' | 'AFRICASTALKING'; username?: string; apiKey?: string; senderId?: string }) {
    const org = await this.org(user);
    const sealed = input.apiKey ? encryptSecret(input.apiKey) : org.sms?.apiKeySealed;
    await this.db.organisations.updateOne({ _id: user.organisationId }, { sms: { provider: input.provider, username: input.username, apiKeySealed: sealed, senderId: input.senderId } });
    await this.audit.record(user, 'settings.sms', 'organisation', user.organisationId, { provider: input.provider });
    return this.get(user);
  }

  async updateEmail(user: AuthUser, input: { enabled: boolean; host?: string; port: number; secure: boolean; username?: string; password?: string; from?: string }) {
    const org = await this.org(user);
    const sealed = input.password ? encryptSecret(input.password) : org.mail?.passwordSealed;
    if (input.enabled && (!input.host || !input.from)) throw new BadRequestException('Enter the mail server and the sender address');
    await this.db.organisations.updateOne({ _id: user.organisationId }, { mail: { enabled: input.enabled, host: input.host, port: input.port, secure: input.secure, username: input.username, passwordSealed: sealed, from: input.from } });
    await this.audit.record(user, 'settings.email', 'organisation', user.organisationId, { enabled: input.enabled, host: input.host });
    return this.get(user);
  }

  async updateSecurity(user: AuthUser, input: { requireTwoFactor: 'NONE' | 'ADMINS' | 'ALL'; sso: { enabled: boolean; issuer?: string; clientId?: string; clientSecret?: string; domains: string[] } }) {
    const org = await this.org(user);
    // Turning the requirement on must not lock the administrator out of settings.
    const me = await this.db.users.findById(user.id, { 'twoFactor.enabled': 1 }).lean();
    if ((input.requireTwoFactor === 'ALL' || (input.requireTwoFactor === 'ADMINS' && user.isAdmin)) && !me?.twoFactor?.enabled) throw new BadRequestException('Set up two-step sign-in for yourself first (My account), then require it of others');
    const sealed = input.sso.clientSecret ? encryptSecret(input.sso.clientSecret) : org.security?.sso?.clientSecretSealed;
    if (input.sso.enabled && (!input.sso.issuer || !input.sso.clientId || !sealed)) throw new BadRequestException('Enter the issuer, client id and client secret before switching single sign-on on');
    if (input.sso.issuer && !/^https:\/\//.test(input.sso.issuer)) throw new BadRequestException('The issuer must start with https://');
    await this.db.organisations.updateOne(
      { _id: user.organisationId },
      { security: { requireTwoFactor: input.requireTwoFactor, sso: { enabled: input.sso.enabled, issuer: input.sso.issuer, clientId: input.sso.clientId, clientSecretSealed: sealed, domains: input.sso.domains.map((d) => d.trim().toLowerCase()).filter(Boolean) } } },
    );
    await this.audit.record(user, 'settings.security', 'organisation', user.organisationId, { requireTwoFactor: input.requireTwoFactor, sso: input.sso.enabled });
    return this.get(user);
  }
}
