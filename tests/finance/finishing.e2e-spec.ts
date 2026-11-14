import { createServer, Server } from 'node:net';
import { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 20: invoice PDFs made on the server (app, portal and email attachment),
 * virus scanning of attachments with ClamAV (a stand-in clamd that flags the EICAR test file), and text
 * messages to approvers who opted in.
 */

const PASSWORD = 'Password1234';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const pdf = (text: string) => `%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n`;

describe('PDFs, virus scanning and approver texts (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let customer: string;
  let invoice: string;
  let clamd: Server;
  let clamdPort: number;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    upload: (url: string, data: string) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).raw(data),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  beforeAll(async () => {
    // clamd INSTREAM: chunks of <4-byte length><bytes>, ended by a zero length.
    clamd = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const start = buf.indexOf('zINSTREAM\0');
        if (start < 0) return;
        let pos = start + 'zINSTREAM\0'.length;
        const parts: Buffer[] = [];
        while (pos + 4 <= buf.length) {
          const len = buf.readUInt32BE(pos);
          if (len === 0) {
            const content = Buffer.concat(parts).toString('latin1');
            socket.end(content.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (pos + 4 + len > buf.length) return;
          parts.push(buf.subarray(pos + 4, pos + 4 + len));
          pos += 4 + len;
        }
      });
    });
    await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
    clamdPort = (clamd.address() as AddressInfo).port;

    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Finishing E2E', adminName: 'Owner', email: 'owner@fin.test', password: PASSWORD, entityCode: 'KE', entityName: 'Finishing Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@fin.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@fin.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@fin.test');
    reviewer = await login('rev@fin.test');
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Acacia Traders Ltd', currency: 'KES', email: 'accounts@acacia.test' }).expect(201)).body.id;
    const created = await as(preparer)
      .post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-01', lines: [{ description: 'Consulting, March', accountId: acc['4200'], quantity: '10', unitPrice: '15000' }] })
      .expect(201);
    invoice = created.body.id;
    await as(preparer).post(`/invoices/${invoice}/submit`).expect(201);
    await as(reviewer).post(`/invoices/${invoice}/approve`).expect(201);
  });

  afterAll(async () => {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
    delete process.env.ATTACHMENT_SCAN_REQUIRED;
    await new Promise((resolve) => clamd.close(resolve));
    await closeTestApp();
  });

  describe('invoice PDFs', () => {
    it('makes a PDF for the app and the customer portal', async () => {
      const res = await as(reviewer).get(`/invoices/${invoice}/pdf`).expect(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''Invoice%20INV-KE-\d+\.pdf/);
      expect(String(res.body).startsWith('%PDF-')).toBe(true);
      const link = await as(preparer).post(`/customers/${customer}/portal-links`, { entityId: ke }).expect(201);
      const token = /portal\/([^/?]+)/.exec(link.body.url)![1];
      const portal = await api().get(`/api/v1/portal/${token}/invoices/${invoice}/pdf`).expect(200);
      expect(portal.headers.get('content-disposition')).toMatch(/^attachment;/);
      await api().get(`/api/v1/portal/not-a-real-token-at-all-xxxxxx/invoices/${invoice}/pdf`).expect(404);
    });

    it('attaches the PDF when the invoice is emailed', async () => {
      await as(preparer).post(`/invoices/${invoice}/email`, {}).expect(201);
      const { db } = await getServices();
      const email = (await db.emails.findOne({ to: 'accounts@acacia.test' }).lean())!;
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toMatch(/^Invoice INV-KE-\d+\.pdf$/);
      expect(Buffer.from(email.attachments[0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
      const log = (await as(owner).get('/emails?limit=5').expect(200)).body;
      expect(JSON.stringify(log)).not.toContain(email.attachments[0].content.slice(0, 40));
    });
  });

  describe('virus scanning', () => {
    let bill: string;

    beforeAll(async () => {
      bill = (await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: (await as(preparer).post('/suppliers', { code: 'SUP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id, date: '2026-03-02', supplierInvoiceNumber: 'S-1', lines: [{ description: 'Supplies', accountId: acc['6600'], quantity: '1', unitPrice: '100' }] }).expect(201)).body.id;
    });

    it('scans uploads and refuses infected files', async () => {
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(clamdPort);
      const clean = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${bill}&name=S-1.pdf`, pdf('S-1')).expect(201);
      expect(clean.body.scanStatus).toBe('CLEAN');
      const infected = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${bill}&name=notes.txt`, EICAR).expect(400);
      expect(infected.body.message).toMatch(/notes\.txt contains malware \(Eicar-Signature\); it was not saved/);
      const { db } = await getServices();
      expect(await db.attachments.countDocuments({ name: 'notes.txt' })).toBe(0);
      expect(await db.auditEvents.countDocuments({ action: 'attachment.malware' })).toBe(1);
    });

    it('refuses uploads while the scanner is down, unless scanning is optional', async () => {
      process.env.CLAMAV_PORT = '1';
      const down = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${bill}&name=later.pdf`, pdf('later')).expect(503);
      expect(down.body.message).toMatch(/could not be reached/);
      process.env.ATTACHMENT_SCAN_REQUIRED = 'false';
      const kept = await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${bill}&name=later.pdf`, pdf('later')).expect(201);
      expect(kept.body.scanStatus).toBe('ERROR');
      // An infected file slipped in while the scanner was down.
      await as(preparer).upload(`/attachments?recordType=Invoice&recordId=${bill}&name=sneaky.txt`, EICAR).expect(201);
      // With scanning required again, unscanned files wait for the background scan.
      delete process.env.ATTACHMENT_SCAN_REQUIRED;
      process.env.CLAMAV_PORT = String(clamdPort);
      await as(reviewer).get(`/attachments/${kept.body.id}/content`).expect(423);
      const { attachments, db } = await getServices();
      expect(await attachments.scanBacklog()).toEqual({ scanned: 2, infected: 1, failed: 0 });
      expect((await db.attachments.findById(kept.body.id).lean())!.scanStatus).toBe('CLEAN');
      const sneaky = (await db.attachments.findOne({ name: 'sneaky.txt' }).lean())!;
      expect(sneaky).toMatchObject({ scanStatus: 'INFECTED', scanSignature: 'Eicar-Signature' });
      expect(sneaky.deletedAt).toBeTruthy();
      await as(reviewer).get(`/attachments/${kept.body.id}/content`).expect(200);
      await as(reviewer).get(`/attachments/${sneaky._id}/content`).expect(404);
    });
  });

  describe('approver texts', () => {
    const submitJournal = async (amount: string) => {
      const j = await as(preparer)
        .post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-10', description: `Accrual ${amount}`, lines: [{ accountId: acc['6200'], debit: amount }, { accountId: acc['2160'], credit: amount }] })
        .expect(201);
      await as(preparer).post(`/journals/${j.body.id}/submit`).expect(201);
    };
    const texts = async () => {
      const { db } = await getServices();
      return db.sms.find({ category: 'approval' }).lean();
    };

    it('texts approvers only when the organisation allows it and they opted in with a number', async () => {
      await submitJournal('1000');
      expect(await texts()).toHaveLength(0);
      await as(owner).patch('/organisation/sms', { enabled: true, paymentConfirmations: true, approvalAlerts: true }).expect(200);
      const me = (await as(reviewer).get('/auth/me').expect(200)).body;
      expect(me.smsApprovalAlerts).toBe(true);
      await submitJournal('1001');
      expect(await texts()).toHaveLength(0);
      await as(reviewer).patch('/auth/preferences', { phone: '0722 555 010', smsApprovals: true }).expect(200);
      await submitJournal('1002');
      const sent = await texts();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('+254722555010');
      expect(sent[0].message).toMatch(/^FarajaSoft: Journal .* awaits your approval\. http/);
      expect(sent[0].relatedId?.equals(new Types.ObjectId((await as(reviewer).get('/auth/me').expect(200)).body.id))).toBe(true);
    });
  });
});
