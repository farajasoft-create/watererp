import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { BadRequestException, UnauthorizedException } from '../common/errors';
import { decryptSecret } from '../common/secrets';
import { Db } from '../db';
import { signToken } from '../auth';
import { AuditService } from './audit.service';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET ?? '');
}

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Single sign-on with the organisation's identity provider over OpenID Connect (authorization code
 * flow with PKCE): Microsoft Entra ID / Office 365, Google Workspace, Keycloak and others. A person
 * signs in there and lands here as the user with the same email address.
 */
export class SsoService {
  private readonly discoveries = new Map<string, { at: number; doc: Discovery }>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async config(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase() }, { security: 1 }).lean();
    const sso = org?.security?.sso;
    if (!org || !sso?.enabled || !sso.issuer || !sso.clientId || !sso.clientSecretSealed) throw new BadRequestException('Single sign-on is not set up for this organisation');
    return { orgId: org._id, issuer: sso.issuer.replace(/\/+$/, ''), clientId: sso.clientId, clientSecret: decryptSecret(sso.clientSecretSealed), domains: (sso.domains ?? []).map((d) => d.toLowerCase()) };
  }

  private async discover(issuer: string): Promise<Discovery> {
    const cached = this.discoveries.get(issuer);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
    const res = await this.fetchImpl(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new BadRequestException(`The identity provider did not answer (${res.status})`);
    const doc = (await res.json()) as Discovery;
    this.discoveries.set(issuer, { at: Date.now(), doc });
    return doc;
  }

  /** Where to send the browser: the provider's sign-in page, with a signed state carrying the PKCE verifier. */
  async start(orgCode: string, origin: string, next = '/') {
    const cfg = await this.config(orgCode);
    const d = await this.discover(cfg.issuer);
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    const state = await new SignJWT({ org: orgCode.toUpperCase(), v: verifier, n: nonce, next })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .setAudience('sso-state')
      .sign(secret());
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: `${origin}/api/v1/auth/sso/callback`,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** The provider sends the browser back with a code: exchange it, check the ID token, find the user. */
  async callback(code: string, state: string, origin: string, ip: string | null) {
    let s: { org: string; v: string; n: string; next?: string };
    try {
      ({ payload: s } = (await jwtVerify(state, secret(), { audience: 'sso-state' })) as unknown as { payload: typeof s });
    } catch {
      throw new UnauthorizedException('The sign-in took too long or was tampered with; start again');
    }
    const cfg = await this.config(s.org);
    const d = await this.discover(cfg.issuer);
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${origin}/api/v1/auth/sso/callback`, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: s.v }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = (await res.json().catch(() => null)) as { id_token?: string; error_description?: string } | null;
    if (!res.ok || !tokens?.id_token) throw new UnauthorizedException(`The identity provider refused the sign-in: ${tokens?.error_description ?? res.status}`);
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(d.jwks_uri)), { issuer: d.issuer, audience: cfg.clientId });
    if (payload.nonce !== s.n) throw new UnauthorizedException('The sign-in does not match the request');
    const email = String(payload.email ?? payload.preferred_username ?? payload.upn ?? '').toLowerCase();
    if (!email.includes('@')) throw new UnauthorizedException('The identity provider did not give an email address');
    if (cfg.domains.length && !cfg.domains.includes(email.split('@')[1])) throw new UnauthorizedException(`${email} is not in an allowed domain`);
    const user = await this.db.users.findOne({ organisationId: cfg.orgId, email, active: true }).lean();
    if (!user) throw new UnauthorizedException(`No active user ${email} here; ask an administrator to add you`);
    await this.db.users.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    await this.audit.record({ id: user._id, organisationId: user.organisationId, ip }, 'auth.login.sso', 'user', user._id, { issuer: cfg.issuer });
    return { token: await signToken(user), next: s.next && /^\/(?![\/\\])/.test(s.next) ? s.next : '/' };
  }
}
