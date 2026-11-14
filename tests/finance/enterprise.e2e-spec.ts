import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Types } from 'mongoose';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 19 (enterprise): SAML 2.0 single sign-on against a test identity provider
 * (signed assertions, tampering, replay), SCIM 2.0 user provisioning, and expense claims spent in other
 * currencies and reimbursed from a foreign-currency account.
 */

const PASSWORD = 'Password1234';
const IDP_KEY = readFileSync('tests/finance/fixtures/saml-idp.key', 'utf8');
const IDP_CERT = readFileSync('tests/finance/fixtures/saml-idp.crt', 'utf8');

describe('Enterprise (e2e)', () => {
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
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Enterprise E2E', adminName: 'Owner', email: 'owner@ent.test', password: PASSWORD, entityCode: 'KE', entityName: 'Enterprise Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const r of (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[]) roleIds[r.name] = r.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@ent.test', password: PASSWORD, roleIds: [roleIds.Accountant] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@ent.test', password: PASSWORD, roleIds: [roleIds['Finance Reviewer']] }).expect(201);
    preparer = await login('prep@ent.test');
    reviewer = await login('rev@ent.test');
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('SAML single sign-on', () => {
    let urls: { entityId: string; acs: string; metadata: string };

    /** What the test identity provider posts back: a response with a signed assertion. */
    function samlResponse(email: string, inResponseTo: string, opts: { tamperTo?: string; audience?: string } = {}) {
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000);
      const before = new Date(now.getTime() - 60_000);
      const id = `_a${randomBytes(8).toString('hex')}`;
      const assertion =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
        `<saml:Issuer>https://idp.test</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${later.toISOString()}" Recipient="${urls.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${before.toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? urls.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `</saml:Assertion>`;
      const sig = new SignedXml({ privateKey: IDP_KEY, publicCert: IDP_CERT, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
      sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
      sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
      let signed = sig.getSignedXml();
      if (opts.tamperTo) signed = signed.replace(`>${email}<`, `>${opts.tamperTo}<`);
      const response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${urls.acs}" InResponseTo="${inResponseTo}">` +
        `<saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
      return Buffer.from(response).toString('base64');
    }
    /** Starts a sign-in and returns the request the identity provider would receive. */
    async function start(email: string) {
      const res = await api().get(`/api/v1/auth/sso/start?email=${encodeURIComponent(email)}&next=/journals`).expect(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.origin + location.pathname).toBe('https://idp.test/sso');
      const xml = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString();
      return { requestId: /ID="([^"]+)"/.exec(xml)![1], relay: location.searchParams.get('RelayState')!, xml };
    }
    const post = (form: Record<string, string>) => api().post(`/api/v1${new URL(urls.acs).pathname.replace('/api/v1', '')}`).raw(new URLSearchParams(form).toString(), 'application/x-www-form-urlencoded');

    it('is configured with the identity provider certificate and publishes metadata', async () => {
      await as(owner).patch('/organisation/sso', { enabled: true, protocol: 'SAML', saml: { entryPoint: 'https://idp.test/sso', idpIssuer: 'https://idp.test', idpCert: 'not a certificate' }, allowedDomains: ['ent.test'], allowPasswordLogin: true }).expect(400);
      const settings = (
        await as(owner).patch('/organisation/sso', { enabled: true, protocol: 'SAML', label: 'Entra ID', saml: { entryPoint: 'https://idp.test/sso', idpIssuer: 'https://idp.test', idpCert: IDP_CERT }, allowedDomains: ['ent.test'], allowPasswordLogin: true }).expect(200)
      ).body;
      expect(settings).toMatchObject({ enabled: true, protocol: 'SAML', saml: { entryPoint: 'https://idp.test/sso', hasCertificate: true } });
      urls = settings.saml;
      const metadata = await api().get(`/api/v1${new URL(urls.metadata).pathname.replace('/api/v1', '')}`).expect(200);
      expect(metadata.body).toContain(`entityID="${urls.entityId}"`);
      expect(metadata.body).toContain(urls.acs);
      expect((await api().get('/api/v1/auth/sso/lookup?email=prep@ent.test').expect(200)).body).toMatchObject({ sso: true, label: 'Entra ID' });
    });

    it('signs a user in from a signed assertion, once', async () => {
      const { requestId, relay, xml } = await start('prep@ent.test');
      expect(xml).toContain(`AssertionConsumerServiceURL="${urls.acs}"`);
      const body = { SAMLResponse: samlResponse('prep@ent.test', requestId), RelayState: relay };
      const res = await post(body).expect(302);
      expect(res.headers.get('location')).toBe('/journals');
      expect(res.headers.get('set-cookie')).toBeTruthy();
      const { db } = await getServices();
      expect(await db.auditEvents.countDocuments({ action: 'auth.sso', summary: /prep@ent\.test signed in through Entra ID/ })).toBe(1);
      // The same response cannot be used again.
      const replay = await post(body).expect(302);
      expect(replay.headers.get('location')).toMatch(/^\/login\?error=/);
    });

    it('refuses tampered assertions, other audiences and unknown people', async () => {
      const a = await start('prep@ent.test');
      const tampered = await post({ SAMLResponse: samlResponse('prep@ent.test', a.requestId, { tamperTo: 'owner@ent.test' }), RelayState: a.relay }).expect(302);
      expect(decodeURIComponent(tampered.headers.get('location')!)).toMatch(/could not be verified/);
      const b = await start('prep@ent.test');
      const audience = await post({ SAMLResponse: samlResponse('prep@ent.test', b.requestId, { audience: 'https://someone-else.test' }), RelayState: b.relay }).expect(302);
      expect(decodeURIComponent(audience.headers.get('location')!)).toMatch(/could not be verified/);
      const c = await start('prep@ent.test');
      const stranger = await post({ SAMLResponse: samlResponse('nobody@ent.test', c.requestId), RelayState: c.relay }).expect(302);
      expect(decodeURIComponent(stranger.headers.get('location')!)).toMatch(/does not have a user/);
      const forged = await post({ SAMLResponse: samlResponse('prep@ent.test', 'made-up-id'), RelayState: 'made-up-relay' }).expect(302);
      expect(decodeURIComponent(forged.headers.get('location')!)).toMatch(/start again/);
    });
  });

  describe('SCIM provisioning', () => {
    let token: string;
    let jane: string;
    const scim = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, t = token) => {
      const r = api()[method](`/api/v1/scim/v2${path}`);
      return t ? r.set('Authorization', `Bearer ${t}`) : r;
    };

    it('is enabled with a token and default roles (never administrator roles)', async () => {
      await as(preparer).patch('/organisation/scim', { enabled: true, defaultRoleIds: [roleIds.Accountant] }).expect(403);
      await as(owner).patch('/organisation/scim', { enabled: true, defaultRoleIds: [roleIds.Administrator] }).expect(400);
      const res = (await as(owner).patch('/organisation/scim', { enabled: true, defaultRoleIds: [roleIds.Accountant] }).expect(200)).body;
      expect(res.token).toMatch(/^scim_/);
      token = res.token;
      expect((await as(owner).get('/organisation/scim').expect(200)).body.token).toBeUndefined();
    });

    it('creates, finds, updates and deactivates people', async () => {
      await scim('get', '/Users', '').expect(401);
      await scim('get', '/Users', 'scim_wrong').expect(401);
      const created = await scim('post', '/Users')
        .send({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Jane.Wambui@ent.test', externalId: 'aad-123', name: { givenName: 'Jane', familyName: 'Wambui' }, emails: [{ value: 'Jane.Wambui@ent.test', primary: true }], active: true })
        .expect(201);
      jane = created.body.id;
      expect(created.body).toMatchObject({ userName: 'jane.wambui@ent.test', externalId: 'aad-123', displayName: 'Jane Wambui', active: true });
      await scim('post', '/Users').send({ userName: 'jane.wambui@ent.test' }).expect(409);
      const { db } = await getServices();
      const user = (await db.users.findById(jane).lean())!;
      expect(user.roleIds.map(String)).toEqual([roleIds.Accountant]);
      // No password: provisioned people sign in through SSO.
      await api().post('/api/v1/auth/login').send({ email: 'jane.wambui@ent.test', password: '!scim' }).expect(401);

      const found = await scim('get', `/Users?filter=${encodeURIComponent('userName eq "jane.wambui@ent.test"')}`).expect(200);
      expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: jane }] });
      expect((await scim('get', `/Users?filter=${encodeURIComponent('externalId eq "aad-123"')}`).expect(200)).body.totalResults).toBe(1);

      // Entra ID style patch (capitalised op, string boolean) and Okta style replace.
      const tokenVersion = user.tokenVersion;
      const off = await scim('patch', `/Users/${jane}`).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }).expect(200);
      expect(off.body.active).toBe(false);
      expect((await db.users.findById(jane).lean())!.tokenVersion).toBe(tokenVersion + 1);
      const replaced = await scim('put', `/Users/${jane}`).send({ userName: 'jane.wambui@ent.test', name: { givenName: 'Jane', familyName: 'Wambui-Otieno' }, active: true }).expect(200);
      expect(replaced.body).toMatchObject({ displayName: 'Jane Wambui-Otieno', active: true });
      await scim('patch', `/Users/${jane}`).send({ Operations: [{ op: 'replace', value: { 'name.givenName': 'Janet' } }] }).expect(200);
      expect((await scim('get', `/Users/${jane}`).expect(200)).body.displayName).toBe('Janet Wambui-Otieno');

      await scim('delete', `/Users/${jane}`).expect(204);
      expect((await db.users.findById(jane).lean())!.isActive).toBe(false);
    });

    it('will not deactivate the last administrator', async () => {
      const owners = (await scim('get', `/Users?filter=${encodeURIComponent('userName eq "owner@ent.test"')}`).expect(200)).body.Resources;
      const res = await scim('patch', `/Users/${owners[0].id}`).send({ Operations: [{ op: 'replace', path: 'active', value: false }] }).expect(409);
      expect(res.body.message).toMatch(/last active administrator/);
    });

    it("will not change an administrator's email (a leaked token must not take over the account)", async () => {
      const owners = (await scim('get', `/Users?filter=${encodeURIComponent('userName eq "owner@ent.test"')}`).expect(200)).body.Resources;
      const res = await scim('patch', `/Users/${owners[0].id}`).send({ Operations: [{ op: 'replace', path: 'userName', value: 'attacker@evil.test' }] }).expect(409);
      expect(res.body.message).toMatch(/administrator; their email can only be changed in FarajaSoft/);
    });
  });

  describe('expense claims in other currencies', () => {
    it('converts lines at the day rate or the rate paid, and reimburses from a USD account', async () => {
      await as(owner).post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '130', effectiveDate: '2026-03-01' }).expect(201);
      const usdBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'USD Bank', glAccountId: acc['1130'] }).expect(201)).body.id;
      const categories = (await as(preparer).get('/expense-categories').expect(200)).body as { id: string; code: string }[];
      const cat = (c: string) => categories.find((x) => x.code === c)!.id;
      const missingRate = await as(preparer)
        .post('/expense-claims', { entityId: ke, branchId: hq, title: 'Trip', lines: [{ date: '2026-03-02', categoryId: cat('TRAVEL'), description: 'Taxi', currency: 'EUR', originalAmount: '20', receiptReference: 'T1' }] })
        .expect(400);
      expect(missingRate.body.message).toMatch(/no approved EUR\/KES rate/);
      const claim = await as(preparer)
        .post('/expense-claims', {
          entityId: ke,
          branchId: hq,
          title: 'Kampala trip',
          lines: [
            { date: '2026-03-02', categoryId: cat('TRAVEL'), description: 'Flight change fee', currency: 'USD', originalAmount: '50', receiptReference: 'KQ-1' },
            { date: '2026-03-03', categoryId: cat('TRAVEL'), description: 'Taxi (card)', currency: 'USD', originalAmount: '50', exchangeRate: '132', receiptReference: 'UB-7' },
            { date: '2026-03-03', categoryId: cat('TRAVEL'), description: 'Airport transfer', amount: '1000', receiptReference: 'MT-2' },
          ],
        })
        .expect(201);
      expect(claim.body.lines.map((l: { amount: string; currency: string | null; originalAmount: string | null; exchangeRate: string | null }) => [l.amount, l.currency, l.originalAmount, l.exchangeRate])).toEqual([
        ['6500', 'USD', '50', '130'],
        ['6600', 'USD', '50', '132'],
        ['1000', null, null, null],
      ]);
      expect(claim.body.total).toBe('14100');
      // A card rate 1.5% off the day's rate is normal; one 7.7% off needs the approver's reason.
      expect(claim.body.policyBreaches).toBe(0);
      const generous = await as(preparer)
        .post('/expense-claims', { entityId: ke, branchId: hq, title: 'Generous rate', lines: [{ date: '2026-03-03', categoryId: cat('TRAVEL'), description: 'Taxi', currency: 'USD', originalAmount: '10', exchangeRate: '140', receiptReference: 'X-1' }] })
        .expect(201);
      expect(generous.body.policyBreaches).toBe(1);
      expect(generous.body.lines[0].policyNotes).toEqual(["Rate 140 is 7.7% above the day's rate of 130"]);
      await as(preparer).post(`/expense-claims/${claim.body.id}/submit`).expect(201);
      await as(reviewer).post(`/expense-claims/${claim.body.id}/approve`, {}).expect(201);
      const paid = (await as(reviewer).post(`/expense-claims/${claim.body.id}/pay`, { date: '2026-03-05', bankAccountId: usdBank }).expect(201)).body;
      expect(paid.payment).toMatchObject({ currency: 'USD', amount: '108.46', exchangeRate: '130' });
      const { db } = await getServices();
      const line = (await db.ledger.findOne({ journalId: new Types.ObjectId(paid.payment.journalId), accountId: new Types.ObjectId(acc['1130']) }).lean())!;
      expect([line.creditTx.toString(), line.credit.toString(), line.currency]).toEqual(['108.46', '14100', 'USD']);
      const [claims] = await db.ledger.aggregate<{ net: { toString(): string } }>([{ $match: { accountId: new Types.ObjectId(acc['2170']) } }, { $group: { _id: null, net: { $sum: { $subtract: ['$debit', '$credit'] } } } }]);
      expect(claims.net.toString()).toBe('0');
    });
  });
});
