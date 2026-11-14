import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { CacheItem, CacheProvider, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import { Types } from 'mongoose';
import { AuthUser, signFlowToken, verifyFlowToken } from '../../common/auth';
import { BadRequestException, HttpError, UnauthorizedException } from '../../common/errors';
import { decryptSecret, encryptSecret } from '../../common/totp';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl } from './email.service';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const FLOW_SECONDS = 10 * 60;
const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const b64url = (b: Buffer) => b.toString('base64url');

export interface SsoSettingsInput {
  enabled: boolean;
  protocol?: 'OIDC' | 'SAML';
  label?: string;
  saml?: { entryPoint: string; idpIssuer?: string; idpCert: string };
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
  allowedDomains: string[];
  allowPasswordLogin: boolean;
}

const SAML_FLOWS = 'finance_samlflows';
const SAML_REQUESTS = 'finance_samlrequests';

/** SAML request IDs kept in the database so InResponseTo is checked whichever instance answers. */
class MongoSamlCache implements CacheProvider {
  constructor(private readonly db: Db) {}
  private get col() {
    return this.db.connection.collection<{ _id: string; value: string; createdAt: Date }>(SAML_REQUESTS);
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const createdAt = new Date();
    await this.col.updateOne({ _id: key }, { $setOnInsert: { value, createdAt } }, { upsert: true });
    return { value, createdAt: createdAt.getTime() };
  }
  async getAsync(key: string) {
    const doc = await this.col.findOne({ _id: key, createdAt: { $gte: new Date(Date.now() - FLOW_SECONDS * 1000) } });
    return doc?.value ?? null;
  }
  async removeAsync(key: string | null) {
    if (!key) return null;
    const doc = await this.col.findOneAndDelete({ _id: key });
    return doc?.value ?? null;
  }
}

/** Normalises a pasted certificate (PEM, or bare base64) and checks it parses. */
export function normaliseCert(input: string): string {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(body)) throw new BadRequestException("Paste the identity provider's signing certificate");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
  try {
    new X509Certificate(pem);
  } catch {
    throw new BadRequestException('That certificate could not be read');
  }
  return pem;
}

/**
 * Single sign-on with OpenID Connect (authorization code flow with PKCE) or SAML 2.0 (signed assertions
 * posted to the organisation's assertion consumer service). Only people who already
 * have a user in the organisation can sign in this way; the identity provider proves who they are,
 * FarajaSoft still decides what they can do.
 */
export class SsoService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async discovery(issuer: string): Promise<Discovery> {
    const key = issuer.replace(/\/$/, '');
    const cached = discoveryCache.get(key);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
    let doc: Discovery;
    try {
      const res = await fetch(`${key}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = (await res.json()) as Discovery;
    } catch (err) {
      throw new BadRequestException(`Could not read the provider's OpenID configuration from ${key}: ${err instanceof Error ? err.message : err}`);
    }
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) throw new BadRequestException('The provider configuration is incomplete');
    discoveryCache.set(key, { doc, at: Date.now() });
    return doc;
  }

  private jwks(uri: string) {
    let set = jwksCache.get(uri);
    if (!set) jwksCache.set(uri, (set = createRemoteJWKSet(new URL(uri))));
    return set;
  }

  private domainOf(email: string) {
    return email.split('@')[1]?.toLowerCase() ?? '';
  }

  private async orgFor(email: string) {
    const user = await this.db.users.findOne({ email: email.toLowerCase(), isActive: true, isServiceAccount: { $ne: true } }, { organisationId: 1 }).lean();
    if (!user) return null;
    const org = await this.db.organisations.findById(user.organisationId, { settings: 1, name: 1 }).lean();
    const sso = org?.settings?.sso;
    const configured = sso?.protocol === 'SAML' ? !!(sso.saml?.entryPoint && sso.saml.idpCert) : !!(sso?.issuer && sso.clientId);
    if (!org || !sso?.enabled || !configured) return null;
    if (sso.allowedDomains.length && !sso.allowedDomains.includes(this.domainOf(email))) return null;
    return { org, sso };
  }

  /** Whether an email address signs in through SSO (the login page asks before showing the password). */
  async lookup(email: string) {
    const found = await this.orgFor(email);
    return found ? { sso: true, label: found.sso.label || 'single sign-on', passwordAllowed: found.sso.allowPasswordLogin } : { sso: false, label: null, passwordAllowed: true };
  }

  /** Builds the provider's sign-in URL and the signed state to keep in a cookie. */
  async start(email: string, next: string, redirectUri: string) {
    const found = await this.orgFor(email);
    if (!found) throw new BadRequestException('Single sign-on is not set up for this email address');
    if (found.sso.protocol === 'SAML') return { url: await this.samlStart(found.org._id, email, next), flow: '' };
    const d = await this.discovery(found.sso.issuer);
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: found.sso.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      login_hint: email,
    }).toString();
    const flow = await signFlowToken('sso', { org: found.org._id.toHexString(), state, nonce, verifier, next, redirectUri }, FLOW_SECONDS);
    return { url: url.toString(), flow };
  }

  /** Completes the sign-in: exchanges the code, verifies the ID token and finds the user. */
  async callback(input: { code: string; state: string; flow: string }) {
    let flow: { org: string; state: string; nonce: string; verifier: string; next: string; redirectUri: string };
    try {
      flow = await verifyFlowToken(input.flow, 'sso');
    } catch {
      throw new UnauthorizedException('The sign-in took too long or came from another browser; start again');
    }
    if (flow.state !== input.state) throw new UnauthorizedException('The sign-in response does not match this browser; start again');
    const org = await this.db.organisations.findById(flow.org, { settings: 1 }).lean();
    const sso = org?.settings?.sso;
    if (!org || !sso?.enabled) throw new UnauthorizedException('Single sign-on is no longer enabled');
    const d = await this.discovery(sso.issuer);
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: flow.redirectUri,
        client_id: sso.clientId,
        ...(sso.clientSecret && { client_secret: decryptSecret(sso.clientSecret) }),
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !tokens.id_token) throw new HttpError(502, `The identity provider refused the sign-in: ${tokens.error_description ?? tokens.error ?? res.status}`);
    let claims: JWTPayload & { email?: string; preferred_username?: string; upn?: string; email_verified?: boolean; amr?: string[] };
    try {
      ({ payload: claims } = await jwtVerify(tokens.id_token, this.jwks(d.jwks_uri), { issuer: d.issuer, audience: sso.clientId }));
    } catch (err) {
      throw new UnauthorizedException(`The identity token could not be verified: ${err instanceof Error ? err.message : err}`);
    }
    if (claims.nonce !== flow.nonce) throw new UnauthorizedException('The identity token was not issued for this sign-in');
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase();
    if (!email.includes('@')) throw new UnauthorizedException('The identity provider did not share an email address');
    if (claims.email_verified === false) throw new UnauthorizedException('The email address is not verified with the identity provider');
    if (sso.allowedDomains.length && !sso.allowedDomains.includes(this.domainOf(email))) throw new UnauthorizedException(`${email} is not in a domain allowed for single sign-on`);
    const user = await this.db.users.findOne({ email, organisationId: org._id, isActive: true, isServiceAccount: { $ne: true } }).lean();
    if (!user) throw new UnauthorizedException(`${email} does not have a user in this organisation; ask an administrator to add you`);
    const idpMfa = Array.isArray(claims.amr) && claims.amr.some((m) => ['mfa', 'otp', 'hwk', 'swk', 'fido'].includes(m));
    await this.audit.log({ organisationId: org._id, name: user.name }, { action: 'auth.sso', recordType: 'User', recordId: user._id, summary: `${email} signed in through ${sso.label || 'single sign-on'}${idpMfa ? ' (provider verified a second factor)' : ''}` });
    return { user, idpMfa, next: flow.next };
  }

  // ----- SAML 2.0 -------------------------------------------------------------------------------------

  /** Where the identity provider is configured to send people (and what it calls us). */
  samlUrls(organisationId: Types.ObjectId | string) {
    const base = `${appUrl()}/api/v1/auth/saml/${organisationId.toString()}`;
    return { entityId: base, acs: `${base}/acs`, metadata: `${base}/metadata` };
  }

  private samlClient(organisationId: Types.ObjectId, saml: { entryPoint: string; idpIssuer?: string | null; idpCert: string }) {
    const urls = this.samlUrls(organisationId);
    return new SAML({
      issuer: urls.entityId,
      callbackUrl: urls.acs,
      entryPoint: saml.entryPoint,
      idpCert: saml.idpCert,
      idpIssuer: saml.idpIssuer || undefined,
      audience: urls.entityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: FLOW_SECONDS * 1000,
      acceptedClockSkewMs: 120_000,
      disableRequestedAuthnContext: true,
      cacheProvider: new MongoSamlCache(this.db),
    });
  }

  private async samlStart(organisationId: Types.ObjectId, email: string, next: string) {
    const org = (await this.db.organisations.findById(organisationId, { settings: 1 }).lean())!;
    const relay = b64url(randomBytes(18));
    // The provider posts back cross-site, so the flow is kept server-side under a short RelayState.
    await this.db.connection.collection<{ _id: string; org: string; next: string; email: string; createdAt: Date }>(SAML_FLOWS).insertOne({ _id: relay, org: organisationId.toHexString(), next, email: email.toLowerCase(), createdAt: new Date() });
    return this.samlClient(organisationId, org.settings!.sso!.saml as never).getAuthorizeUrlAsync(relay, undefined, { additionalParams: { login_hint: email } });
  }

  /** Validates a SAML response posted to the organisation's ACS and finds the user. */
  async samlAcs(organisationId: string, input: { SAMLResponse?: string; RelayState?: string }) {
    if (!Types.ObjectId.isValid(organisationId)) throw new UnauthorizedException('Unknown organisation');
    const org = await this.db.organisations.findById(organisationId, { settings: 1 }).lean();
    const sso = org?.settings?.sso;
    if (!org || !sso?.enabled || sso.protocol !== 'SAML' || !sso.saml?.idpCert) throw new UnauthorizedException('SAML sign-in is not enabled for this organisation');
    if (!input.SAMLResponse) throw new UnauthorizedException('No SAML response was received');
    const flows = this.db.connection.collection<{ _id: string; org: string; next: string; createdAt: Date }>(SAML_FLOWS);
    const flow = input.RelayState ? await flows.findOneAndDelete({ _id: input.RelayState, org: organisationId, createdAt: { $gte: new Date(Date.now() - FLOW_SECONDS * 1000) } }) : null;
    if (!flow) throw new UnauthorizedException('The sign-in took too long or did not start here; start again');
    let profile;
    try {
      ({ profile } = await this.samlClient(org._id, sso.saml as never).validatePostResponseAsync({ SAMLResponse: input.SAMLResponse }));
    } catch (err) {
      throw new UnauthorizedException(`The SAML response could not be verified: ${err instanceof Error ? err.message : err}`);
    }
    if (!profile) throw new UnauthorizedException('The SAML response did not identify anyone');
    const candidates = [profile.email, profile.mail, profile['urn:oid:0.9.2342.19200300.100.1.3'], profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'], profile.nameID];
    const email = String(candidates.find((c) => typeof c === 'string' && c.includes('@')) ?? '').toLowerCase();
    if (!email) throw new UnauthorizedException('The identity provider did not share an email address');
    if (sso.allowedDomains.length && !sso.allowedDomains.includes(this.domainOf(email))) throw new UnauthorizedException(`${email} is not in a domain allowed for single sign-on`);
    const user = await this.db.users.findOne({ email, organisationId: org._id, isActive: true, isServiceAccount: { $ne: true } }).lean();
    if (!user) throw new UnauthorizedException(`${email} does not have a user in this organisation; ask an administrator to add you`);
    const methods = String((profile.getAssertion?.() as { Assertion?: { AuthnStatement?: { AuthnContext?: { AuthnContextClassRef?: { _: string }[] }[] }[] } } | undefined)?.Assertion?.AuthnStatement?.[0]?.AuthnContext?.[0]?.AuthnContextClassRef?.[0]?._ ?? '');
    const idpMfa = /MultiFactor|TimeSyncToken|mfa/i.test(methods);
    await this.audit.log({ organisationId: org._id, name: user.name }, { action: 'auth.sso', recordType: 'User', recordId: user._id, summary: `${email} signed in through ${sso.label || 'SAML single sign-on'}${idpMfa ? ' (provider verified a second factor)' : ''}` });
    return { user, idpMfa, next: flow.next };
  }

  /** Service-provider metadata for the identity provider's set-up. */
  async samlMetadata(organisationId: string) {
    if (!Types.ObjectId.isValid(organisationId)) throw new UnauthorizedException('Unknown organisation');
    const org = await this.db.organisations.findById(organisationId, { settings: 1 }).lean();
    if (!org) throw new UnauthorizedException('Unknown organisation');
    const saml = org.settings?.sso?.saml;
    return this.samlClient(org._id, { entryPoint: saml?.entryPoint || 'https://idp.invalid/sso', idpCert: saml?.idpCert || 'none', idpIssuer: saml?.idpIssuer }).generateServiceProviderMetadata(null);
  }

  // ----- Settings ---------------------------------------------------------------------------------

  async settings(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId, { 'settings.sso': 1 }).lean();
    const sso = org?.settings?.sso;
    return {
      enabled: !!sso?.enabled,
      protocol: sso?.protocol ?? 'OIDC',
      label: sso?.label ?? '',
      issuer: sso?.issuer ?? '',
      clientId: sso?.clientId ?? '',
      hasClientSecret: !!sso?.clientSecret,
      saml: { entryPoint: sso?.saml?.entryPoint ?? '', idpIssuer: sso?.saml?.idpIssuer ?? '', hasCertificate: !!sso?.saml?.idpCert, ...this.samlUrls(user.organisationId) },
      allowedDomains: sso?.allowedDomains ?? [],
      allowPasswordLogin: sso?.allowPasswordLogin ?? true,
    };
  }

  async update(user: AuthUser, input: SsoSettingsInput) {
    const domains = [...new Set(input.allowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
    const protocol = input.protocol ?? 'OIDC';
    const current = (await this.db.organisations.findById(user.organisationId, { 'settings.sso': 1 }).lean())?.settings?.sso;
    let cert: string | null = null;
    if (protocol === 'SAML' && input.saml?.idpCert?.trim()) cert = normaliseCert(input.saml.idpCert);
    if (input.enabled) {
      if (protocol === 'SAML') {
        if (!input.saml?.entryPoint || !/^https?:\/\//.test(input.saml.entryPoint)) throw new BadRequestException("Enter the identity provider's single sign-on URL");
        if (!/^https:\/\//.test(input.saml.entryPoint) && process.env.NODE_ENV === 'production') throw new BadRequestException('The single sign-on URL must be https');
        if (!cert && !current?.saml?.idpCert) throw new BadRequestException("Paste the identity provider's signing certificate");
      } else {
        if (!input.issuer || !input.clientId) throw new BadRequestException('Enter the issuer URL and client ID');
        if (!/^https:\/\//.test(input.issuer) && process.env.NODE_ENV === 'production') throw new BadRequestException('The issuer must be an https URL');
        await this.discovery(input.issuer);
      }
      if (!domains.length) throw new BadRequestException('List the email domains that sign in through SSO');
      if (!input.allowPasswordLogin && !domains.includes(this.domainOf(user.email))) {
        throw new BadRequestException(`Your own address (${user.email}) is outside the SSO domains; keep password sign-in on or add the domain`);
      }
    }
    const update: Record<string, unknown> = {
      'settings.sso.enabled': input.enabled,
      'settings.sso.protocol': protocol,
      ...(input.saml && { 'settings.sso.saml.entryPoint': input.saml.entryPoint.trim(), 'settings.sso.saml.idpIssuer': input.saml.idpIssuer?.trim() ?? '' }),
      ...(cert && { 'settings.sso.saml.idpCert': cert }),
      'settings.sso.label': input.label ?? '',
      'settings.sso.issuer': input.issuer.replace(/\/$/, ''),
      'settings.sso.clientId': input.clientId,
      'settings.sso.allowedDomains': domains,
      'settings.sso.allowPasswordLogin': input.allowPasswordLogin,
    };
    if (input.clientSecret !== undefined) update['settings.sso.clientSecret'] = input.clientSecret ? encryptSecret(input.clientSecret) : null;
    await this.db.organisations.updateOne({ _id: user.organisationId }, update);
    await this.audit.log(user, { action: 'organisation.sso', recordType: 'Organisation', recordId: user.organisationId, summary: `${input.enabled ? 'Enabled' : 'Disabled'} single sign-on${input.enabled ? ` via ${protocol === 'SAML' ? `SAML (${input.saml?.entryPoint})` : input.issuer} for ${domains.join(', ')}${input.allowPasswordLogin ? '' : ' (SSO required)'}` : ''}` });
    return this.settings(user);
  }
}

