import { createHash } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 8: email outbox, password reset, invitations, notification emails and
 * digests, emailed collection reminders, scheduled management packs and OpenID Connect single sign-on
 * (against a stand-in identity provider).
 */

const PASSWORD = 'Password1234';
const NEW_PASSWORD = 'NewPassword5678';

describe('Communication and identity (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  const acc: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string, password = PASSWORD) => (await api().post('/api/v1/auth/login').send({ email, password }).expect(200)).body.token as string;
  /** The newest email to an address (the capture driver keeps them in the outbox). */
  const lastEmail = async (to: string) => {
    const { db } = await getServices();
    return db.emails.findOne({ to: to.toLowerCase() }).sort({ createdAt: -1, _id: -1 }).lean();
  };
  const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1];

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Comms E2E', adminName: 'Owner', email: 'owner@sso.test', password: PASSWORD, entityCode: 'KE', entityName: 'Comms Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const r of (await as(owner).get('/roles').expect(200)).body) roleIds[r.name] = r.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@sso.test', password: PASSWORD, roleIds: [roleIds['Accountant']] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@comms.test', password: PASSWORD, roleIds: [roleIds['Finance Reviewer']] }).expect(201);
    preparer = await login('prep@sso.test');
    reviewer = await login('rev@comms.test');
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('password reset', () => {
    it('emails a single-use link without revealing whether an account exists', async () => {
      const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@comms.test' }).expect(200);
      const known = await api().post('/api/v1/auth/forgot-password').send({ email: 'rev@comms.test' }).expect(200);
      expect(unknown.body).toEqual(known.body);
      expect(await lastEmail('nobody@comms.test')).toBeNull();
      const mail = (await lastEmail('rev@comms.test'))!;
      expect(mail).toMatchObject({ subject: 'Reset your FarajaSoft password', category: 'account', sensitive: true });
      const token = tokenFrom(mail.text);
      const { db } = await getServices();
      expect(await db.authTokens.findOne({ tokenHash: token })).toBeNull();

      const info = await api().get(`/api/v1/auth/reset-password?token=${token}`).expect(200);
      expect(info.body).toMatchObject({ purpose: 'password_reset', email: 'rev@comms.test' });
      await api().post('/api/v1/auth/reset-password').send({ token, password: 'short' }).expect(400);
      await api().post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }).expect(200);
      await api().post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }).expect(400);
      // Sessions from before the reset are signed out; the new password works.
      await as(reviewer).get('/accounts').expect(401);
      reviewer = await login('rev@comms.test', NEW_PASSWORD);
      expect((await lastEmail('rev@comms.test'))!.subject).toBe('Your FarajaSoft password was changed');
    });

    it('limits how many reset emails one account can trigger', async () => {
      for (let i = 0; i < 4; i++) await api().post('/api/v1/auth/forgot-password').set('x-forwarded-for', `10.1.1.${i}`).send({ email: 'prep@sso.test' }).expect(200);
      const { db } = await getServices();
      const user = await db.users.findOne({ email: 'prep@sso.test' }).lean();
      expect(await db.authTokens.countDocuments({ userId: user!._id, purpose: 'password_reset' })).toBe(3);
      expect(await db.authTokens.countDocuments({ userId: user!._id, purpose: 'password_reset', usedAt: null })).toBe(1);
    });
  });

  describe('invitations', () => {
    it('invites a user to choose their own password', async () => {
      const created = await as(owner).post('/users', { name: 'New Starter', email: 'new@comms.test', roleIds: [roleIds['Accountant']] }).expect(201);
      const mail = (await lastEmail('new@comms.test'))!;
      expect(mail.subject).toBe('Owner invited you to FarajaSoft');
      expect(mail.replyTo).toBe('owner@sso.test');
      const refused = await api().post('/api/v1/auth/login').send({ email: 'new@comms.test', password: PASSWORD }).expect(401);
      expect(refused.body.message).toMatch(/Accept the invitation/);
      // Re-sending invalidates the first link.
      const first = tokenFrom(mail.text);
      await as(owner).post(`/users/${created.body.id}/invite`).expect(200);
      const second = tokenFrom((await lastEmail('new@comms.test'))!.text);
      await api().get(`/api/v1/auth/reset-password?token=${first}`).expect(400);
      expect((await api().get(`/api/v1/auth/reset-password?token=${second}`).expect(200)).body.purpose).toBe('invitation');
      await api().post('/api/v1/auth/reset-password').send({ token: second, password: PASSWORD }).expect(200);
      await login('new@comms.test');
      await as(owner).post(`/users/${created.body.id}/invite`).expect(400);
    });
  });

  describe('notification emails', () => {
    it('emails approvers at once, or in a daily digest if they prefer', async () => {
      const journal = async (amount: string) => {
        const j = await as(preparer).post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-15', description: `Accrual ${amount}`, lines: [{ accountId: acc['6200'], debit: amount }, { accountId: acc['1120'], credit: amount }] }).expect(201);
        await as(preparer).post(`/journals/${j.body.id}/submit`).expect(201);
      };
      await journal('100');
      const immediate = (await lastEmail('rev@comms.test'))!;
      expect(immediate.subject).toMatch(/awaits your approval/);
      expect(immediate.html).toContain('/journals/');

      await as(reviewer).patch('/auth/preferences', { approvals: 'digest' }).expect(200);
      const { db } = await getServices();
      const before = await db.emails.countDocuments({ to: 'rev@comms.test' });
      await journal('200');
      expect(await db.emails.countDocuments({ to: 'rev@comms.test' })).toBe(before);
      const s = await getServices();
      expect((await s.notificationEmails.sendDigests()).digests).toBeGreaterThanOrEqual(1);
      const digest = (await lastEmail('rev@comms.test'))!;
      expect(digest.category).toBe('digest');
      expect(digest.subject).toMatch(/item/);
      expect((await s.notificationEmails.sendDigests()).digests).toBe(0);
    });

    it('delivers queued email and shows it in the email log', async () => {
      const s = await getServices();
      await s.email.deliverDue({ limit: 500 });
      const log = await as(owner).get('/emails').expect(200);
      expect(log.body.driver).toBe('capture');
      expect(log.body.items.every((m: { status: string }) => m.status === 'SENT')).toBe(true);
      await as(preparer).get('/emails').expect(403);
    });
  });

  describe('emailed reminders and packs', () => {
    it('emails a reminder letter to the customer and records it', async () => {
      const customer = (await as(preparer).post('/customers', { code: 'LATE', name: 'Late Payers Ltd', email: 'ap@late.test', currency: 'KES', paymentTermsDays: 30 }).expect(201)).body.id;
      const inv = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-02-01', lines: [{ description: 'Goods', accountId: acc['4100'], quantity: '1', unitPrice: '50000' }] }).expect(201);
      await as(preparer).post(`/invoices/${inv.body.id}/submit`).expect(201);
      await as(reviewer).post(`/invoices/${inv.body.id}/approve`).expect(201);
      const sent = await as(preparer).post(`/collections/${customer}/send-reminder`, { entityId: ke, asOf: '2026-05-15' }).expect(200);
      expect(sent.body).toEqual({ sentTo: 'ap@late.test', stage: 'final' });
      const mail = (await lastEmail('ap@late.test'))!;
      expect(mail).toMatchObject({ replyTo: 'prep@sso.test', category: 'reminder' });
      expect(mail.html).toContain('INV-');
      const activity = await as(preparer).get(`/collections/${customer}/activities?entityId=${ke}`).expect(200);
      expect(activity.body[0]).toMatchObject({ type: 'EMAIL' });
    });

    it('emails the monthly pack to each subscriber, once', async () => {
      const users = (await as(owner).get('/users').expect(200)).body as { id: string; email: string }[];
      const ids = users.filter((u) => ['owner@sso.test', 'prep@sso.test'].includes(u.email)).map((u) => u.id);
      await as(owner).patch('/report-subscriptions', { entityId: ke, userIds: ids, dayOfMonth: 5 }).expect(200);
      const s = await getServices();
      expect((await s.notificationEmails.sendPacks(new Date('2026-04-06T08:00:00Z'))).packs).toBe(2);
      const mail = (await lastEmail('prep@sso.test'))!;
      expect(mail.subject).toBe('Comms Kenya — March 2026 management pack');
      expect(mail.html).toContain('/reports/pack?month=2026-03');
      expect((await s.notificationEmails.sendPacks(new Date('2026-04-07T08:00:00Z'))).packs).toBe(0);
    });
  });

  describe('single sign-on (OpenID Connect)', () => {
    let idp: Server;
    let issuer: string;
    const clientId = 'farajasoft-test';
    const clientSecret = 'idp-client-secret';
    let next: { email: string; amr?: string[]; nonce?: string } = { email: '' };
    let lastChallenge = '';

    beforeAll(async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
      idp = createServer((req, res) => {
        const url = new URL(req.url!, issuer);
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
        if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
        if (url.pathname === '/token' && req.method === 'POST') {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', async () => {
            const form = new URLSearchParams(raw);
            const verifier = form.get('code_verifier') ?? '';
            if (form.get('code') !== 'good-code' || form.get('client_secret') !== clientSecret || createHash('sha256').update(verifier).digest('base64url') !== lastChallenge) {
              return json(400, { error: 'invalid_grant', error_description: 'Code or PKCE verifier is wrong' });
            }
            const idToken = await new SignJWT({ email: next.email, email_verified: true, nonce: next.nonce, ...(next.amr && { amr: next.amr }) })
              .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
              .setIssuer(issuer)
              .setAudience(clientId)
              .setSubject(next.email)
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(privateKey);
            json(200, { access_token: 'x', token_type: 'Bearer', id_token: idToken });
          });
          return;
        }
        json(404, {});
      });
      await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
      issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      idp.close();
    });

    /** Starts SSO for an address and returns what the browser would carry to the callback. */
    async function start(email: string) {
      const res = await api().get(`/api/v1/auth/sso/start?email=${encodeURIComponent(email)}&next=/journals`);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      lastChallenge = location.searchParams.get('code_challenge')!;
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('fs_sso='))!.split(';')[0];
      return { location, cookie, state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')! };
    }
    const callback = (q: string, cookie: string) => api().get(`/api/v1/auth/sso/callback?${q}`).set('cookie', cookie);

    it('is configured by an administrator and keeps the client secret private', async () => {
      await as(owner).patch('/organisation/sso', { enabled: true, label: 'Test IdP', issuer, clientId, clientSecret, allowedDomains: ['sso.test'], allowPasswordLogin: false }).expect(200);
      const settings = await as(owner).get('/organisation/sso').expect(200);
      expect(settings.body).toMatchObject({ enabled: true, hasClientSecret: true, allowPasswordLogin: false });
      expect(settings.body.clientSecret).toBeUndefined();
      const me = await as(owner).get('/auth/me').expect(200);
      expect(JSON.stringify(me.body)).not.toContain('clientSecret');
      expect((await api().get('/api/v1/auth/sso/lookup?email=prep@sso.test').expect(200)).body).toEqual({ sso: true, label: 'Test IdP', passwordAllowed: false });
      expect((await api().get('/api/v1/auth/sso/lookup?email=rev@comms.test').expect(200)).body.sso).toBe(false);
    });

    it('requires SSO for its domain but keeps password sign-in for administrators', async () => {
      const blocked = await api().post('/api/v1/auth/login').send({ email: 'prep@sso.test', password: PASSWORD }).expect(403);
      expect(blocked.body.message).toMatch(/single sign-on/);
      owner = await login('owner@sso.test');
    });

    it('signs in through the provider with PKCE and a verified ID token', async () => {
      const { location, cookie, state, nonce } = await start('prep@sso.test');
      expect(location.origin + location.pathname).toBe(`${issuer}/authorize`);
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('client_id')).toBe(clientId);
      next = { email: 'prep@sso.test', nonce };
      const res = await callback(`code=good-code&state=${state}`, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/journals');
      const session = res.headers.getSetCookie().find((c) => c.startsWith('fs_token='))!.split(';')[0].slice('fs_token='.length);
      const me = await api().get('/api/v1/auth/me').set('cookie', `fs_token=${session}`).expect(200);
      expect(me.body.email).toBe('prep@sso.test');
      const sessions = await api().get('/api/v1/auth/sessions').set('cookie', `fs_token=${session}`).expect(200);
      expect(sessions.body.find((x: { current: boolean }) => x.current).method).toBe('sso');
    });

    it('rejects forged or mismatched responses', async () => {
      const a = await start('prep@sso.test');
      next = { email: 'prep@sso.test', nonce: 'not-the-nonce' };
      expect(decodeURIComponent((await callback(`code=good-code&state=${a.state}`, a.cookie)).headers.get('location')!)).toMatch(/not issued for this sign-in/);
      const b = await start('prep@sso.test');
      expect(decodeURIComponent((await callback('code=good-code&state=wrong', b.cookie)).headers.get('location')!)).toMatch(/does not match/);
      const c = await start('prep@sso.test');
      next = { email: 'stranger@sso.test', nonce: c.nonce };
      expect(decodeURIComponent((await callback(`code=good-code&state=${c.state}`, c.cookie)).headers.get('location')!)).toMatch(/does not have a user/);
      const d = await start('prep@sso.test');
      next = { email: 'prep@sso.test', nonce: d.nonce };
      expect(decodeURIComponent((await callback(`code=bad-code&state=${d.state}`, d.cookie)).headers.get('location')!)).toMatch(/refused the sign-in/);
      expect((await callback(`code=good-code&state=${d.state}`, '')).headers.get('location')).toMatch(/interrupted/);
    });

    it('still asks for the user’s own code unless the provider verified a second factor', async () => {
      const { db } = await getServices();
      await db.users.updateOne({ email: 'prep@sso.test' }, { 'mfa.enabled': true, 'mfa.secret': 'v1.x.y.z' });
      const a = await start('prep@sso.test');
      next = { email: 'prep@sso.test', nonce: a.nonce, amr: ['pwd'] };
      expect((await callback(`code=good-code&state=${a.state}`, a.cookie)).headers.get('location')).toMatch(/^\/login\?challenge=/);
      const b = await start('prep@sso.test');
      next = { email: 'prep@sso.test', nonce: b.nonce, amr: ['pwd', 'mfa'] };
      expect((await callback(`code=good-code&state=${b.state}`, b.cookie)).headers.get('location')).toBe('/journals');
    });
  });
});
