import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../../src/modules/finance/core/common/auth';
import { currentStep, hotp } from '../../src/modules/finance/core/common/totp';
import { AttachmentsService } from '../../src/modules/finance/core/modules/documents/attachments.service';
import { MemoryStore } from '../../src/modules/finance/core/modules/documents/file-store';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 6: document attachments (types, access, versions, retention, duplicates,
 * search), two-step verification and recovery codes, session management, account lockout, the
 * organisation MFA policy, and the management reporting pack.
 */

const PASSWORD = 'Password1234';
const pdf = (text: string) => `%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n`;

describe('Governance (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let viewer: string;
  let ke: string;
  let hq: string;
  let supplier: string;
  const acc: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    delete: (url: string) => api().delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    upload: (url: string, data: string) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).raw(data),
  });
  const login = async (email: string, password = PASSWORD) => (await api().post('/api/v1/auth/login').send({ email, password }).expect(200)).body;
  async function draftBill(ref: string) {
    return (
      await as(preparer)
        .post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-04-10', supplierInvoiceNumber: ref, lines: [{ description: 'Stationery', accountId: acc['6600'], quantity: '1', unitPrice: '1200' }] })
        .expect(201)
    ).body.id as string;
  }

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Governance E2E', adminName: 'Owner', email: 'owner@gov.test', password: PASSWORD, entityCode: 'KE', entityName: 'Gov Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const r of (await as(owner).get('/roles').expect(200)).body) roleIds[r.name] = r.id;
    const journalsOnly = (await as(owner).post('/roles', { name: 'Journal viewer', permissions: ['journal.view'] }).expect(201)).body.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@gov.test', password: PASSWORD, roleIds: [roleIds['Accountant']] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@gov.test', password: PASSWORD, roleIds: [roleIds['Finance Reviewer']] }).expect(201);
    await as(owner).post('/users', { name: 'Viewer', email: 'view@gov.test', password: PASSWORD, roleIds: [journalsOnly] }).expect(201);
    preparer = (await login('prep@gov.test')).token;
    reviewer = (await login('rev@gov.test')).token;
    viewer = (await login('view@gov.test')).token;
    supplier = (await as(preparer).post('/suppliers', { code: 'PAPER', name: 'Paper Co', currency: 'KES' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('attachments', () => {
    let billId: string;
    let attachmentId: string;

    it('stores a supporting document on a bill and serves it back', async () => {
      billId = await draftBill('PC-100');
      const up = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=PC-100.pdf&category=INVOICE`, pdf('PC-100')).expect(201);
      attachmentId = up.body.id;
      expect(up.body).toMatchObject({ name: 'PC-100.pdf', mimeType: 'application/pdf', version: 1, category: 'INVOICE', duplicates: [] });
      expect(up.body.sha256).toMatch(/^[a-f0-9]{64}$/);
      const list = await as(reviewer).get(`/attachments?recordType=Invoice&recordId=${billId}`).expect(200);
      expect(list.body.items).toHaveLength(1);
      const file = await as(reviewer).get(`/attachments/${attachmentId}/content?inline=1`).expect(200);
      expect(file.headers.get('content-type')).toBe('application/pdf');
      expect(file.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''PC-100\.pdf/);
      expect(file.headers.get('x-content-type-options')).toBe('nosniff');
      expect(file.body).toContain('%PDF-1.4');
    });

    it('accepts only known file types whose content matches', async () => {
      const exe = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=setup.exe`, 'MZ...').expect(400);
      expect(exe.body.message).toMatch(/not accepted/);
      const fake = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=fake.pdf`, '<html>not a pdf</html>').expect(400);
      expect(fake.body.message).toMatch(/does not match/);
      await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=big.pdf`, pdf('x'.repeat(4 * 1024 * 1024))).expect(400);
    });

    it('follows the record’s permissions', async () => {
      await as(viewer).get(`/attachments?recordType=Invoice&recordId=${billId}`).expect(403);
      await as(viewer).get(`/attachments/${attachmentId}/content`).expect(403);
      await as(viewer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=x.pdf`, pdf('x')).expect(403);
    });

    it('keeps versions, and retains evidence once the bill is posted', async () => {
      const v2 = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=PC-100-corrected.pdf&replaces=${attachmentId}`, pdf('PC-100 corrected')).expect(201);
      expect(v2.body.version).toBe(2);
      const versions = await as(preparer).get(`/attachments/${v2.body.id}/versions`).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const list = await as(preparer).get(`/attachments?recordType=Invoice&recordId=${billId}`).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ version: 2, versions: 2 });

      await as(preparer).post(`/invoices/${billId}/submit`).expect(201);
      await as(reviewer).post(`/invoices/${billId}/approve`).expect(201);
      const locked = await as(preparer).delete(`/attachments/${v2.body.id}`).expect(400);
      expect(locked.body.message).toMatch(/retention policy/);
      // Evidence can still be added after posting.
      await as(reviewer).upload(`/attachments?recordType=Invoice&recordId=${billId}&name=approval-email.txt&category=APPROVAL_EVIDENCE`, 'Approved by phone with the supplier').expect(201);
    });

    it('lets drafts lose documents, and flags the same file on two bills', async () => {
      const other = await draftBill('PC-101');
      const up = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${other}&name=PC-100-copy.pdf`, pdf('PC-100')).expect(201);
      expect(up.body.duplicates[0]).toMatchObject({ recordId: billId });
      const ex = await as(owner).get(`/analytics/exceptions?entityId=${ke}&from=2026-01-01&to=2030-12-31`).expect(200);
      expect(ex.body.some((e: { kind: string }) => e.kind === 'duplicate_attachment')).toBe(true);
      await as(preparer).delete(`/attachments/${up.body.id}`).expect(200);
      expect((await as(preparer).get(`/attachments?recordType=Invoice&recordId=${other}`).expect(200)).body.items).toHaveLength(0);
    });

    it('searches documents the user can see and audits downloads', async () => {
      const found = await as(reviewer).get('/attachments/search?q=corrected').expect(200);
      expect(found.body).toHaveLength(1);
      expect(found.body[0].link).toBe(`/finance/purchases/bills/${billId}`);
      expect((await as(viewer).get('/attachments/search?q=corrected').expect(200)).body).toHaveLength(0);
      const audit = await as(owner).get('/audit-events?action=attachment.download').expect(200);
      expect(JSON.stringify(audit.body)).toContain('Opened PC-100.pdf');
    });
  });

  describe('direct uploads to object storage', () => {
    // The same service over an in-memory object store standing in for Cloudflare R2.
    const store = new MemoryStore();
    let service: AttachmentsService;
    const actor = async (token: string) => {
      const { db } = await getServices();
      return authenticate(db, new Request('http://localhost/', { headers: { authorization: `Bearer ${token}` } }), { ip: '127.0.0.1' });
    };
    const keyOf = (url: string) => url.replace('memory://', '');

    beforeAll(async () => {
      const s = await getServices();
      service = new AttachmentsService(s.db, s.audit, store);
    });

    it('uploads straight to storage, then verifies and fingerprints the file', async () => {
      const user = await actor(preparer);
      const billId = new Types.ObjectId(await draftBill('PC-200'));
      const file = Buffer.from(pdf('large scan'));
      const ticket = await service.createUpload(user, { recordType: 'Invoice', recordId: billId, name: 'scan.pdf', size: file.length, category: 'INVOICE' });
      expect(ticket.uploadUrl).toMatch(/^memory:\/\//);
      // Not visible until it has been checked.
      expect((await service.list(user, 'Invoice', billId)).items).toHaveLength(0);
      await store.put(keyOf(ticket.uploadUrl), file, 'application/pdf');
      const done = await service.completeUpload(user, ticket.id);
      expect(done).toMatchObject({ name: 'scan.pdf', size: file.length, mimeType: 'application/pdf' });
      expect(done.sha256).toMatch(/^[a-f0-9]{64}$/);
      const res = await service.download(user, done.id, true);
      expect(Buffer.from(await res.arrayBuffer()).equals(file)).toBe(true);
      await expect(service.completeUpload(user, ticket.id)).rejects.toThrow(/not found/);
    });

    it('rejects stored files that do not match what was declared', async () => {
      const user = await actor(preparer);
      const billId = new Types.ObjectId(await draftBill('PC-201'));
      const wrongSize = await service.createUpload(user, { recordType: 'Invoice', recordId: billId, name: 'a.pdf', size: 10 });
      await store.put(keyOf(wrongSize.uploadUrl), Buffer.from(pdf('longer than ten bytes')), 'application/pdf');
      await expect(service.completeUpload(user, wrongSize.id)).rejects.toThrow(/not the 10 declared/);
      expect(store.objects.has(keyOf(wrongSize.uploadUrl))).toBe(false);
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      const disguised = await service.createUpload(user, { recordType: 'Invoice', recordId: billId, name: 'b.pdf', size: html.length });
      await store.put(keyOf(disguised.uploadUrl), html, 'application/pdf');
      await expect(service.completeUpload(user, disguised.id)).rejects.toThrow(/does not match/);
      await expect(service.createUpload(user, { recordType: 'Invoice', recordId: billId, name: 'huge.pdf', size: 60 * 1024 * 1024 })).rejects.toThrow(/at most/);
      await expect(service.createUpload(user, { recordType: 'Invoice', recordId: billId, name: 'tool.exe', size: 100 })).rejects.toThrow(/not accepted/);
    });

    it('cleans up uploads that were never completed', async () => {
      const user = await actor(preparer);
      const ticket = await service.createUpload(user, { recordType: 'Invoice', recordId: new Types.ObjectId(await draftBill('PC-202')), name: 'never.pdf', size: 100 });
      await store.put(keyOf(ticket.uploadUrl), Buffer.alloc(100), 'application/pdf');
      const { db } = await getServices();
      await db.attachments.collection.updateOne({ _id: ticket.id }, { $set: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
      expect((await service.cleanupPending()).removed).toBe(1);
      expect(store.objects.has(keyOf(ticket.uploadUrl))).toBe(false);
    });
  });

  describe('two-step verification and sessions', () => {
    let secret: string;
    let recovery: string[];

    it('enrols with an authenticator app and returns recovery codes', async () => {
      const setup = await as(reviewer).post('/auth/mfa/setup').expect(200);
      expect(setup.body.qrCode).toMatch(/^data:image\/png;base64,/);
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      secret = setup.body.secret.replace(/\s/g, '');
      await as(reviewer).post('/auth/mfa/enable', { code: '000000' }).expect(400);
      const enabled = await as(reviewer).post('/auth/mfa/enable', { code: hotp(secret, currentStep()) }).expect(200);
      recovery = enabled.body.recoveryCodes;
      expect(recovery).toHaveLength(10);
      const { db } = await getServices();
      const stored = await db.users.findOne({ email: 'rev@gov.test' }).lean();
      expect(stored!.mfa!.secret).not.toContain(secret);
      expect(stored!.mfa!.recoveryCodes[0]).not.toBe(recovery[0]);
    });

    it('asks for a code after the password and refuses replays', async () => {
      const first = await login('rev@gov.test');
      expect(first).toMatchObject({ mfaRequired: true });
      expect(first.token).toBeUndefined();
      await api().post('/api/v1/auth/mfa/verify').send({ challenge: first.challenge, code: '123456' }).expect(401);
      // The enrolment code's step is used up; the next one works once.
      const code = hotp(secret, currentStep() + 1);
      const ok = await api().post('/api/v1/auth/mfa/verify').send({ challenge: first.challenge, code }).expect(200);
      expect(ok.body.token).toBeDefined();
      reviewer = ok.body.token;
      await api().post('/api/v1/auth/mfa/verify').send({ challenge: first.challenge, code }).expect(401);
      const challengeAsSession = await api().get('/api/v1/accounts').set('Authorization', `Bearer ${first.challenge}`);
      expect(challengeAsSession.status).toBe(401);
    });

    it('accepts each recovery code once', async () => {
      const attempt = await login('rev@gov.test');
      const res = await api().post('/api/v1/auth/mfa/verify').send({ challenge: attempt.challenge, recoveryCode: recovery[0] }).expect(200);
      expect(res.body.recoveryCodesLeft).toBe(9);
      const again = await login('rev@gov.test');
      await api().post('/api/v1/auth/mfa/verify').send({ challenge: again.challenge, recoveryCode: recovery[0] }).expect(401);
    });

    it('lists sessions and signs out another device', async () => {
      const sessions = await as(reviewer).get('/auth/sessions').expect(200);
      expect(sessions.body.length).toBeGreaterThanOrEqual(2);
      const current = sessions.body.find((x: { current: boolean }) => x.current);
      expect(current.method).toBe('mfa');
      const other = sessions.body.find((x: { current: boolean; method: string }) => !x.current && x.method === 'recovery_code');
      await as(reviewer).post(`/auth/sessions/${other.id}/revoke`).expect(200);
      expect((await as(reviewer).get('/auth/sessions').expect(200)).body.some((x: { id: string }) => x.id === other.id)).toBe(false);
    });

    it('rejects tokens of revoked sessions and signs out on logout', async () => {
      const fresh = (await login('prep@gov.test')).token;
      await as(fresh).get('/accounts').expect(200);
      await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${fresh}`).expect(200);
      await as(fresh).get('/accounts').expect(401);
      await as(preparer).get('/accounts').expect(200);
    });

    it('locks an account after repeated failures', async () => {
      // From a fresh address, so the per-address rate limit is not what stops the attempts.
      const attempt = (password: string) => api().post('/api/v1/auth/login').set('x-forwarded-for', '10.20.30.40').send({ email: 'view@gov.test', password });
      for (let i = 0; i < 5; i++) await attempt('wrong-password-1').expect(401);
      const locked = await attempt(PASSWORD).expect(429);
      expect(locked.body.message).toMatch(/Too many failed attempts/);
      const { db } = await getServices();
      await db.users.updateOne({ email: 'view@gov.test' }, { lockedUntil: null });
      await api().post('/api/v1/auth/login').set('x-forwarded-for', '10.20.30.41').send({ email: 'view@gov.test', password: PASSWORD }).expect(200);
    });

    it('enforces the organisation policy until the user enrols', async () => {
      // The administrator enrols first: once the policy is on, only enrolled users can change it back.
      const setup = await as(owner).post('/auth/mfa/setup').expect(200);
      const ownerSecret = setup.body.secret.replace(/\s/g, '');
      const enabled = await as(owner).post('/auth/mfa/enable', { code: hotp(ownerSecret, currentStep()) }).expect(200);
      await as(owner).get('/accounts').expect(401);
      owner = enabled.body.token;
      await as(owner).patch('/organisation', { settings: { requireMfa: true } }).expect(200);
      const blocked = await as(preparer).get('/accounts').expect(403);
      expect(blocked.body.errors[0].message).toBe('MFA_ENROLLMENT_REQUIRED');
      const me = await as(preparer).get('/auth/me').expect(200);
      expect(me.body.mfaEnrollmentRequired).toBe(true);
      await as(reviewer).get('/accounts').expect(200);
      // Disabling is refused while the policy is on.
      await as(reviewer).post('/auth/mfa/disable', { password: PASSWORD, code: hotp(secret, currentStep() + 1) }).expect(403);
      await as(owner).patch('/organisation', { settings: { requireMfa: false } }).expect(200);
      await as(preparer).get('/accounts').expect(200);
    });

    it('lets an administrator reset a lost authenticator', async () => {
      const users = await as(owner).get('/users').expect(200);
      const rev = users.body.find((u: { email: string }) => u.email === 'rev@gov.test');
      expect(rev.mfa.enabled).toBe(true);
      expect(rev.mfa.secret).toBeUndefined();
      await as(owner).post(`/users/${rev.id}/mfa/reset`).expect(200);
      await as(reviewer).get('/accounts').expect(401);
      const again = await login('rev@gov.test');
      expect(again.token).toBeDefined();
      reviewer = again.token;
    });
  });

  describe('management reporting pack', () => {
    it('assembles the month’s pack with commentary', async () => {
      const pack = await as(owner).get(`/reports/pack?entityId=${ke}&month=2026-04`).expect(200);
      expect(pack.body.commentary.length).toBeGreaterThan(0);
      expect(pack.body.commentary[0]).toMatch(/^Revenue for the month was KES/);
      expect(pack.body.profitAndLoss.totals.expenses).toBe('1200');
      expect(pack.body.balanceSheet.balanced).toBe(true);
      expect(pack.body.payables.totals.total).toBe('1200');
      expect(pack.body.cashFlow.reconciles).toBe(true);
      await as(viewer).get(`/reports/pack?entityId=${ke}&month=2026-04`).expect(403);
      await as(owner).get(`/reports/pack?entityId=${ke}&month=April`).expect(400);
    });
  });
});
