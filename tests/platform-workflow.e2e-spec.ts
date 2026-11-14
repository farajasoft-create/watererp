import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { totp } from '../src/platform/common/totp';
import { startApp, TestApp } from './helpers';

/**
 * Platform features every module uses: two-step sign-in, single sign-on, email, documents with
 * versions and an audit trail, tasks with escalation, and configurable approval chains with signatures.
 */

let app: TestApp;
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await startApp('platform_workflow_e2e', {
    modules: ['water', 'hr'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'clerk', access: [{ module: 'water', role: 'BILLING' }] },
      { who: 'boss', access: [{ module: 'water', role: 'MANAGER' }] },
      { who: 'hrofficer', access: [{ module: 'hr', role: 'HR_OFFICER' }] },
    ],
  });
  const users = await app.platform.core.db.users.find({}, { email: 1 }).lean();
  for (const u of users) ids[u.email.split('@')[0]] = u._id.toHexString();
});

afterAll(async () => app?.stop());

describe('two-step sign-in', () => {
  let secret: string;

  it('enrols an authenticator and then asks for its code at sign-in', async () => {
    const setup = await app.call<{ secret: string; otpauthUrl: string }>('clerk', 'POST', '/auth/2fa/setup', {}, 200);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    secret = setup.secret;
    await app.call('clerk', 'POST', '/auth/2fa/enable', { code: '000000' === totp(secret) ? '111111' : '000000' }, 400);
    const { recoveryCodes } = await app.call<{ recoveryCodes: string[] }>('clerk', 'POST', '/auth/2fa/enable', { code: totp(secret) }, 200);
    expect(recoveryCodes).toHaveLength(10);

    const step1 = await app.call<{ twoFactorRequired: boolean; ticket: string }>('clerk2', 'POST', '/auth/login', { email: 'clerk@test.co', password: 'password-123456' }, 200);
    expect(step1.twoFactorRequired).toBe(true);
    await app.call('clerk2', 'GET', '/auth/me', undefined, 401);
    await app.call('clerk2', 'POST', '/auth/login/2fa', { ticket: step1.ticket, code: '123456' === totp(secret) ? '654321' : '123456' }, 401);
    const me = await app.call<{ twoFactorEnabled: boolean }>('clerk2', 'POST', '/auth/login/2fa', { ticket: step1.ticket, code: totp(secret) }, 200);
    expect(me.twoFactorEnabled).toBe(true);

    // A recovery code works once.
    const again = await app.call<{ ticket: string }>('clerk3', 'POST', '/auth/login', { email: 'clerk@test.co', password: 'password-123456' }, 200);
    await app.call('clerk3', 'POST', '/auth/login/2fa', { ticket: again.ticket, code: recoveryCodes[0] }, 200);
    const third = await app.call<{ ticket: string }>('clerk4', 'POST', '/auth/login', { email: 'clerk@test.co', password: 'password-123456' }, 200);
    await app.call('clerk4', 'POST', '/auth/login/2fa', { ticket: third.ticket, code: recoveryCodes[0] }, 401);
  });

  it('makes users enrol before anything else when the organisation requires it', async () => {
    await app.call('admin', 'PATCH', '/settings/security', { requireTwoFactor: 'ALL', sso: { enabled: false, domains: [] } }, 400);
    const adminSecret = (await app.call<{ secret: string }>('admin', 'POST', '/auth/2fa/setup', {}, 200)).secret;
    await app.call('admin', 'POST', '/auth/2fa/enable', { code: totp(adminSecret) }, 200);
    await app.call('admin', 'PATCH', '/settings/security', { requireTwoFactor: 'ALL', sso: { enabled: false, domains: [] } });
    const me = await app.call<{ mustEnrolTwoFactor: boolean }>('boss', 'GET', '/auth/me');
    expect(me.mustEnrolTwoFactor).toBe(true);
    await app.call('boss', 'GET', '/water/customers', undefined, 403);
    await app.call('admin', 'PATCH', '/settings/security', { requireTwoFactor: 'NONE', sso: { enabled: false, domains: [] } });
    await app.call('boss', 'GET', '/water/customers', undefined, 200);
  });
});

describe('single sign-on', () => {
  it('signs in a known user from the identity provider', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const issuer = 'https://login.idp.test/tenant';
    let nonce = '';
    const realFetch = globalThis.fetch;
    const idp = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
      if (url === `${issuer}/keys`) return Response.json({ keys: [jwk] });
      if (url === `${issuer}/token`) {
        expect(String(init?.body)).toContain('code_verifier=');
        const idToken = await new SignJWT({ email: 'boss@test.co', nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('client-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
        return Response.json({ id_token: idToken });
      }
      return realFetch(input, init);
    });
    const outer = globalThis.fetch;
    vi.stubGlobal('fetch', (i: string | URL | Request, init?: RequestInit) => (String(i instanceof Request ? i.url : i).startsWith(issuer) ? idp(i, init) : outer(i, init)));
    try {
      await app.call('admin', 'PATCH', '/settings/security', { requireTwoFactor: 'NONE', sso: { enabled: true, issuer, clientId: 'client-1', clientSecret: 's3cret', domains: ['test.co'] } });
      const start = await app.raw('anon', 'GET', '/auth/sso/start?org=TWC');
      expect(start.status).toBe(302);
      const authorize = new URL(start.headers.get('location')!);
      expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
      nonce = authorize.searchParams.get('nonce')!;
      const back = await app.raw('sso', 'GET', `/auth/sso/callback?code=abc&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`);
      expect(back.status).toBe(302);
      const me = await app.call<{ email: string }>('sso', 'GET', '/auth/me');
      expect(me.email).toBe('boss@test.co');
      const forged = await app.raw('sso2', 'GET', '/auth/sso/callback?code=abc&state=forged');
      // A failure goes back to the sign-in page with the reason, and signs nobody in.
      expect(forged.status).toBe(302);
      const failed = new URL(forged.headers.get('location')!);
      expect(failed.pathname).toBe('/login');
      expect(failed.searchParams.get('error')).toMatch(/start again/);
      expect(forged.headers.get('set-cookie')).toBeNull();
      const unknown = await app.raw('anon', 'GET', '/auth/sso/start?org=NOWHERE');
      expect(unknown.status).toBe(302);
      expect(new URL(unknown.headers.get('location')!).searchParams.get('error')).toMatch(/not set up/);
    } finally {
      vi.stubGlobal('fetch', outer);
    }
  });
});

describe('email', () => {
  it('queues mail and sends it through the configured server', async () => {
    await app.call('admin', 'PATCH', '/settings/email', { enabled: true, host: 'json', port: 587, secure: false, from: 'billing@tachwasco.co.ke' });
    const r = await app.call<{ sent: number }>('admin', 'POST', '/settings/email/test', { to: 'it@tachwasco.co.ke' }, 200);
    expect(r.sent).toBe(1);
    const [m] = await app.call<{ status: string; to: string }[]>('admin', 'GET', '/emails');
    expect(m).toMatchObject({ status: 'SENT', to: 'it@tachwasco.co.ke' });
  });
});

describe('documents', () => {
  let docId: string;
  it('stores a file with versions, restricts access by module and logs who opened it', async () => {
    const up = await app.raw('clerk', 'POST', `/documents?name=${encodeURIComponent('KYC Kiprono.pdf')}&module=water&entity=customer&category=KYC&tags=id,kyc`, '%PDF-1.4 first', 'application/pdf');
    expect(up.status).toBe(201);
    docId = ((await up.json()) as { id: string }).id;
    const v2 = await app.raw('clerk', 'POST', `/documents?name=${encodeURIComponent('KYC Kiprono v2.pdf')}&replaces=${docId}`, '%PDF-1.4 second', 'application/pdf');
    const second = (await v2.json()) as { id: string; version: number; category: string };
    expect(second).toMatchObject({ version: 2, category: 'KYC' });
    const list = await app.call<{ items: { id: string }[] }>('clerk', 'GET', '/documents?module=water');
    expect(list.items.map((d) => d.id)).toEqual([second.id]);
    // An HR user has no role in water and does not see it.
    const hr = await app.call<{ items: unknown[] }>('hrofficer', 'GET', '/documents?module=water');
    expect(hr.items).toHaveLength(0);
    const file = await app.raw('boss', 'GET', `/documents/${second.id}/download`);
    expect(await file.text()).toBe('%PDF-1.4 second');
    const trail = await app.call<{ action: string; userName: string }[]>('clerk', 'GET', `/documents/${second.id}/trail`);
    expect(trail.map((t) => t.action)).toEqual(['document.download', 'document.upload', 'document.upload']);
    const bad = await app.raw('clerk', 'POST', '/documents?name=x.exe', 'MZ', 'application/x-msdownload');
    expect(bad.status).toBe(400);
  });
});

describe('tasks', () => {
  it('assigns, notifies, escalates and measures', async () => {
    const t = await app.call<{ id: string; number: string }>('boss', 'POST', '/tasks', { title: 'Reconcile October M-Pesa', assignedTo: ids.clerk, dueAt: '2026-01-01' });
    const n = await app.call<{ unread: number; items: { title: string }[] }>('clerk', 'GET', '/notifications');
    expect(n.items[0].title).toContain(t.number);
    const esc = await app.call<{ escalated: number }>('admin', 'POST', '/tasks/escalate', {}, 200);
    expect(esc.escalated).toBe(1);
    await app.call('hrofficer', 'PATCH', `/tasks/${t.id}`, { status: 'DONE' }, 403);
    await app.call('clerk', 'PATCH', `/tasks/${t.id}`, { status: 'DONE', comment: 'Done, 2 unmatched' });
    const a = await app.call<{ total: number; done: number }>('boss', 'GET', '/tasks/analytics?from=2020-01-01&to=2030-01-01');
    expect(a).toMatchObject({ total: 1, done: 1 });
  });
});

describe('approval chains', () => {
  it('runs a configured chain with an amount threshold, signatures and events', async () => {
    const heard: string[] = [];
    app.platform.core.events.on('water.approval.approved', (e) => void heard.push(String(e.data.docId)));
    await app.call('admin', 'PUT', '/approvals/rules', { module: 'water', docType: 'refund', steps: [{ name: 'Commercial manager', roles: ['MANAGER'] }, { name: 'Managing director', userIds: [ids.admin], minAmount: 50000 }] }, 200);
    const docId = '6a0000000000000000000001';
    const core = app.platform.core;
    const clerk = await core.db.users.findById(ids.clerk).lean();
    const { toAuthUser } = await import('../src/platform/auth');
    const asClerk = toAuthUser(clerk!, ['water', 'hr'], '10.0.0.1', core.manifests);
    const small = await core.approvals.start(asClerk, { module: 'water', docType: 'refund', docId: new (await import('mongoose')).Types.ObjectId(docId), title: 'Refund KML-00002', amount: 2000, content: { amount: 2000 }, defaultSteps: [] });
    expect(small.steps).toHaveLength(1);
    await app.call('clerk', 'POST', `/approvals/${small._id}/decide`, { decision: 'APPROVED' }, 403);
    const inbox = await app.call<{ id: string }[]>('boss', 'GET', '/approvals/inbox');
    expect(inbox.map((r) => r.id)).toEqual([String(small._id)]);
    await app.call('boss', 'POST', `/approvals/${small._id}/decide`, { decision: 'APPROVED', note: 'OK' }, 200);
    expect(heard).toEqual([docId]);
    const signed = await app.call<{ status: string; valid: boolean; steps: { signature: { signatureHash: string } }[] }>('boss', 'GET', `/approvals/${small._id}`);
    expect(signed).toMatchObject({ status: 'APPROVED', valid: true });
    expect(signed.steps[0].signature.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    // Tampering with a recorded decision breaks the signature.
    await core.db.approvalRequests.updateOne({ _id: small._id }, { 'steps.0.byName': 'x', 'steps.0.at': new Date('2020-01-01') });
    expect((await app.call<{ valid: boolean }>('boss', 'GET', `/approvals/${small._id}`)).valid).toBe(false);

    const big = await core.approvals.start(asClerk, { module: 'water', docType: 'refund', docId: new (await import('mongoose')).Types.ObjectId(), title: 'Refund school', amount: 80000, defaultSteps: [] });
    expect(big.steps.map((s) => s.name)).toEqual(['Commercial manager', 'Managing director']);
    await app.call('boss', 'POST', `/approvals/${big._id}/decide`, { decision: 'APPROVED' }, 200);
    await app.call('boss', 'POST', `/approvals/${big._id}/decide`, { decision: 'APPROVED' }, 403);
    await app.call('admin', 'POST', `/approvals/${big._id}/decide`, { decision: 'REJECTED' }, 400);
    const done = await app.call<{ status: string }>('admin', 'POST', `/approvals/${big._id}/decide`, { decision: 'REJECTED', note: 'Over budget' }, 200);
    expect(done.status).toBe('REJECTED');
  });

  it('collects parallel signatures and verifies certificate-based signing', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { Types } = await import('mongoose');
    const core = app.platform.core;
    await app.call('admin', 'PUT', '/approvals/rules', { module: 'water', docType: 'tariff', steps: [{ name: 'Board', userIds: [ids.boss], parallel: true }] }, 400); // needs two signers
    await app.call('admin', 'PUT', '/approvals/rules', { module: 'water', docType: 'tariff', steps: [{ name: 'Joint signatories', userIds: [ids.boss, ids.admin], parallel: true }] }, 200);
    const { toAuthUser } = await import('../src/platform/auth');
    const asClerk = toAuthUser((await core.db.users.findById(ids.clerk).lean())!, ['water', 'hr'], null, core.manifests);
    const req = await core.approvals.start(asClerk, { module: 'water', docType: 'tariff', docId: new Types.ObjectId(), title: 'Tariff review 2027', content: { rate: 120 }, defaultSteps: [] });

    // The boss signs with a key pair whose private half never leaves their device.
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keys = await app.call<{ id: string; fingerprint: string }[]>('boss', 'POST', '/signing-keys', { label: 'My laptop', pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, 201);
    const payload = `${req._id}|0|${req.documentHash}|APPROVED`;
    await app.call('boss', 'POST', `/approvals/${req._id}/decide`, { decision: 'APPROVED', certificate: { keyId: keys[0].id, signature: sign('sha256', Buffer.from(`${req._id}|0|${req.documentHash}|REJECTED`), privateKey).toString('base64') } }, 400); // signed something else
    const first = await app.call<{ status: string; steps: { signers: { decision: string | null; signature?: { method: string; keyFingerprint: string } }[] }[] }>('boss', 'POST', `/approvals/${req._id}/decide`, { decision: 'APPROVED', certificate: { keyId: keys[0].id, signature: sign('sha256', Buffer.from(payload), privateKey).toString('base64') } }, 200);
    expect(first.status).toBe('PENDING'); // waiting for the other signatory
    expect(first.steps[0].signers[0].signature).toMatchObject({ method: 'CERTIFICATE', keyFingerprint: keys[0].fingerprint });
    await app.call('boss', 'POST', `/approvals/${req._id}/decide`, { decision: 'APPROVED' }, 403); // already signed
    const second = await app.call<{ status: string }>('admin', 'POST', `/approvals/${req._id}/decide`, { decision: 'APPROVED' }, 200);
    expect(second.status).toBe('APPROVED');
    expect((await app.call<{ valid: boolean }>('boss', 'GET', `/approvals/${req._id}`)).valid).toBe(true);
    await app.call('boss', 'DELETE', `/signing-keys/${keys[0].id}`, undefined, 200);
    expect((await app.call<{ revokedAt: string | null }[]>('boss', 'GET', '/signing-keys'))[0].revokedAt).not.toBeNull();
  });
});
