import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { ModelClient } from '../../src/modules/finance/core/modules/automation/ai.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 7: recurring journals, collections, bank-reconciliation and account
 * suggestions, cash-forecast scenarios, and AI assistance (with a scripted model in place of the API).
 */

const PASSWORD = 'Password1234';

/** A stand-in model that returns scripted responses and records what it was asked. */
class ScriptedModel implements ModelClient {
  calls: MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly script: Record<string, unknown>[]) {}
  messages = {
    create: async (params: MessageCreateParamsNonStreaming) => {
      this.calls.push(params);
      const next = this.script.shift();
      if (!next) throw new Error('No more scripted responses');
      return { id: 'msg', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 120, output_tokens: 40 }, content: [], ...next } as unknown as Message;
    },
  };
}

describe('Automation and AI (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let customer: string;
  let supplier: string;
  const acc: Record<string, string> = {};
  const roleIds: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    raw: (url: string, data: string, type: string) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).raw(data, type),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  async function postDoc(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`).expect(201)).body;
  }

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Automation E2E', adminName: 'Owner', email: 'owner@auto.test', password: PASSWORD, entityCode: 'KE', entityName: 'Auto Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const r of (await as(owner).get('/roles').expect(200)).body) roleIds[r.name] = r.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@auto.test', password: PASSWORD, roleIds: [roleIds['Accountant']] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@auto.test', password: PASSWORD, roleIds: [roleIds['Finance Reviewer']] }).expect(201);
    preparer = await login('prep@auto.test');
    reviewer = await login('rev@auto.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Main bank', glAccountId: acc['1120'], reconcileFrom: '2026-01-01' }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'ACME', name: 'Acme Traders', currency: 'KES', paymentTermsDays: 30 }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'STAT', name: 'Stationery World', taxId: 'P051234567X', currency: 'KES' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('recurring journals', () => {
    let id: string;
    const rent = (overrides: object = {}) => ({
      entityId: ke,
      branchId: hq,
      name: 'Office rent',
      description: 'Rent for {period}',
      reference: 'RENT-{year}-{month}',
      lines: [
        { accountId: acc['6200'], debit: '150000', description: 'Rent {monthName}' },
        { accountId: acc['1120'], credit: '150000' },
      ],
      frequency: 'MONTHLY',
      dayOfMonth: 31,
      startDate: '2026-07-01',
      action: 'SUBMIT',
      ...overrides,
    });

    it('validates templates like journals', async () => {
      await as(preparer).post('/recurring-journals', rent({ lines: [{ accountId: acc['6200'], debit: '100' }, { accountId: acc['1120'], credit: '90' }] })).expect(400);
      const control = await as(preparer).post('/recurring-journals', rent({ lines: [{ accountId: acc['1200'], debit: '100' }, { accountId: acc['4100'], credit: '100' }] })).expect(400);
      expect(control.body.message).toMatch(/control account/);
      await as(preparer).post('/recurring-journals', rent({ dayOfMonth: 30 })).expect(400);
    });

    it('schedules month-end occurrences', async () => {
      const created = await as(preparer).post('/recurring-journals', rent()).expect(201);
      id = created.body.id;
      const detail = await as(preparer).get(`/recurring-journals/${id}`).expect(200);
      expect(detail.body.schedule.slice(0, 4).map((d: string) => d.slice(0, 10))).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']);
    });

    it('creates due occurrences in the owner’s name and submits them', async () => {
      const s = await getServices();
      const result = await s.recurring.processDue(new Date('2026-09-15T00:00:00Z'));
      expect(result).toEqual({ created: 2, failed: 0 });
      const list = await as(reviewer).get(`/journals?entityId=${ke}&search=Rent for`).expect(200);
      const descriptions = list.body.items.map((j: { description: string; status: string }) => `${j.description}|${j.status}`).sort();
      expect(descriptions).toEqual(['Rent for August 2026|SUBMITTED', 'Rent for July 2026|SUBMITTED']);
      const template = await as(preparer).get(`/recurring-journals/${id}`).expect(200);
      expect(template.body.nextRunDate.slice(0, 10)).toBe('2026-09-30');
      expect(template.body.runs.map((r: { journalNumber: string }) => r.journalNumber).every(Boolean)).toBe(true);
      // Prepared by the owner, so the owner cannot approve them.
      const jid = list.body.items[0].id;
      await as(preparer).post(`/journals/${jid}/approve`).expect(403);
      await as(reviewer).post(`/journals/${jid}/approve`).expect(201);
    });

    it('records failures, tells the owner and retries until skipped', async () => {
      const s = await getServices();
      await s.db.users.updateOne({ email: 'prep@auto.test' }, { isActive: false });
      const failed = await s.recurring.processDue(new Date('2026-10-05T00:00:00Z'));
      expect(failed.failed).toBe(1);
      await s.db.users.updateOne({ email: 'prep@auto.test' }, { isActive: true });
      const template = await as(preparer).get(`/recurring-journals/${id}`).expect(200);
      expect(template.body.lastError).toMatch(/owner of this template is inactive/);
      expect(template.body.nextRunDate.slice(0, 10)).toBe('2026-09-30');
      const notes = await as(preparer).get('/notifications').expect(200);
      expect(notes.body.items[0].title).toMatch(/could not be created/);
      await as(preparer).post(`/recurring-journals/${id}/skip`).expect(200);
      const after = await as(preparer).get(`/recurring-journals/${id}`).expect(200);
      expect(after.body.nextRunDate.slice(0, 10)).toBe('2026-10-31');
      const run = await as(preparer).post(`/recurring-journals/${id}/run`).expect(200);
      expect(run.body.number).toMatch(/^JV-/);
    });
  });

  describe('collections', () => {
    it('ranks overdue customers and tracks promises', async () => {
      for (const [date, amount] of [
        ['2026-05-01', '80000'],
        ['2026-08-20', '20000'],
      ] as const) {
        await postDoc({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date, lines: [{ description: 'Goods', accountId: acc['4100'], quantity: '1', unitPrice: amount }] });
      }
      const list = await as(preparer).get(`/collections?entityId=${ke}&asOf=2026-09-30`).expect(200);
      const row = list.body.rows[0];
      expect(row).toMatchObject({ name: 'Acme Traders', overdue: '100000', overdueInvoices: 2, priority: 'high' });
      expect(row.oldestDaysOverdue).toBe(122);
      expect(row.action).toMatch(/Final notice/);

      await as(preparer).post(`/collections/${customer}/activities`, { entityId: ke, type: 'PROMISE', promiseDate: '2026-09-25', promiseAmount: '50000', note: 'Promised half by the 25th' }).expect(201);
      const broken = await as(preparer).get(`/collections?entityId=${ke}&asOf=2026-09-30`).expect(200);
      expect(broken.body.rows[0].promise.broken).toBe(true);
      expect(broken.body.rows[0].action).toMatch(/has not paid/);
      expect(broken.body.totals.brokenPromises).toBe(1);
    });

    it('writes a reminder whose tone follows the age of the debt', async () => {
      const letter = await as(preparer).get(`/collections/${customer}/letter?entityId=${ke}&asOf=2026-09-30`).expect(200);
      expect(letter.body.stage).toBe('final');
      expect(letter.body.items).toHaveLength(2);
      expect(letter.body.total).toBe('100000');
      const firm = await as(preparer).get(`/collections/${customer}/letter?entityId=${ke}&asOf=2026-07-15`).expect(200);
      expect(firm.body.stage).toBe('firm');
      const friendly = await as(preparer).get(`/collections/${customer}/letter?entityId=${ke}&asOf=2026-06-10`).expect(200);
      expect(friendly.body.stage).toBe('friendly');
      expect(friendly.body.items).toHaveLength(1);
    });
  });

  describe('suggestions', () => {
    it('suggests bank matches with evidence, including a deposit of several receipts', async () => {
      const receipt = async (amount: string, reference: string, date: string) =>
        (await as(preparer).post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date, bankAccountId: bank, amount, reference }).expect(201)).body;
      const r1 = await receipt('12000', 'CHQ-5531', '2026-09-10');
      for (const r of [r1, await receipt('3000', 'CASH-1', '2026-09-12'), await receipt('4500', 'CASH-2', '2026-09-12')]) await as(preparer).post(`/payments/${r.id}/approve`).expect(201);
      // A bank charge handled earlier teaches the account for the next one.
      await as(owner)
        .post(`/bank-accounts/${bank}/statements`, {
          lines: [
            { date: '2026-08-31', description: 'Monthly ledger fee', amount: '-850' },
            { date: '2026-09-11', description: 'Cheque deposit Acme Traders CHQ-5531', amount: '12000' },
            { date: '2026-09-13', description: 'Cash deposit', amount: '7500' },
            { date: '2026-09-30', description: 'Monthly ledger fee', amount: '-850' },
          ],
        })
        .expect(201);
      const ws = await as(reviewer).get(`/bank-accounts/${bank}/reconciliation?asOf=2026-09-30`).expect(200);
      const firstFee = ws.body.statementLines.find((l: { date: string }) => l.date.startsWith('2026-08-31'));
      await as(reviewer).post(`/bank-accounts/${bank}/adjustments`, { statementLineId: firstFee.id, accountId: acc['6800'] }).expect(201);

      const sug = await as(reviewer).get(`/bank-accounts/${bank}/suggestions`).expect(200);
      const one = sug.body.matches.find((m: { kind: string }) => m.kind === 'one-to-one');
      expect(one.reasons.join(' ')).toMatch(/reference .*CHQ-5531|RCT/);
      expect(one.confidence).toBeGreaterThanOrEqual(80);
      const many = sug.body.matches.find((m: { kind: string }) => m.kind === 'one-to-many');
      expect(many.ledgerEntryIds).toHaveLength(2);
      expect(sug.body.adjustments[0].account.code).toBe('6800');
      // Accepting a suggestion is an ordinary match.
      await as(reviewer).post(`/bank-accounts/${bank}/matches`, { statementLineIds: many.statementLineIds, ledgerEntryIds: many.ledgerEntryIds }).expect(201);
    });

    it('suggests accounts from earlier bills', async () => {
      for (const ref of ['SW-1', 'SW-2']) {
        await postDoc({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-09-02', supplierInvoiceNumber: ref, lines: [{ description: 'Printer paper A4 reams', accountId: acc['6600'], quantity: '10', unitPrice: '650' }] });
      }
      const s = await as(preparer).get(`/suggestions/accounts?side=purchase&partyId=${supplier}&description=A4 paper`).expect(200);
      expect(s.body[0]).toMatchObject({ code: '6600' });
      expect(s.body[0].reason).toMatch(/2 earlier lines from this supplier/);
      const other = await as(preparer).get('/suggestions/accounts?side=purchase&description=printer paper reams').expect(200);
      expect(other.body[0].code).toBe('6600');
    });
  });

  describe('cash forecast scenarios', () => {
    it('shows the effect of what-if assumptions next to the base case', async () => {
      const inThreeWeeks = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
      const res = await as(owner)
        .post('/analytics/cash-forecast/scenario', { entityId: ke, delayDays: 30, paymentsPercent: 20, items: [{ date: inThreeWeeks, amount: '-1000000', description: 'Tax payment' }] })
        .expect(200);
      const base = res.body.base.weeks.at(-1).closing;
      const scenario = res.body.scenario.weeks.at(-1).closing;
      expect(Number(scenario)).toBeLessThanOrEqual(Number(base) - 1_000_000);
    });
  });

  describe('AI assistance', () => {
    it('stays off until configured and enabled by the organisation', async () => {
      const s = await getServices();
      s.ai.useClient(null);
      expect((await as(preparer).get('/ai/status').expect(200)).body).toMatchObject({ configured: false, enabled: false, allowed: true });
      await as(preparer).post('/ai/ask', { entityId: ke, question: 'What was revenue?' }).expect(503);
      s.ai.useClient(new ScriptedModel([]));
      const off = await as(preparer).post('/ai/ask', { entityId: ke, question: 'What was revenue?' }).expect(403);
      expect(off.body.message).toMatch(/turned off/);
      await as(owner).patch('/organisation', { settings: { aiEnabled: true } }).expect(200);
    });

    it('reads a supplier invoice into a draft proposal for review', async () => {
      const s = await getServices();
      const model = new ScriptedModel([
        {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'record_invoice',
              input: {
                supplierName: 'STATIONERY WORLD LTD',
                supplierTaxId: 'P051234567X',
                invoiceNumber: 'SW-3',
                invoiceDate: '2026-09-20',
                dueDate: '2026-10-20',
                currency: 'KES',
                lines: [
                  { description: 'A4 paper reams', quantity: '20', unitPrice: '650', taxRatePercent: '16', amount: '13000' },
                  { description: 'Toner cartridge', quantity: '2', unitPrice: '4500', taxRatePercent: '16', amount: '9500' },
                ],
                subtotal: '22000',
                taxTotal: '3520',
                total: '25520',
                pricesIncludeTax: false,
                notes: null,
              },
            },
          ],
        },
      ]);
      s.ai.useClient(model);
      const res = await as(preparer).raw(`/ai/invoice-capture?entityId=${ke}`, '%PDF-1.4\n% scanned invoice\n%%EOF\n', 'application/pdf').expect(200);
      expect(res.body.supplier).toMatchObject({ code: 'STAT', match: 'tax_id' });
      expect(res.body.read).toMatchObject({ invoiceNumber: 'SW-3', invoiceDate: '2026-09-20', total: '25520' });
      expect(res.body.lines[0]).toMatchObject({ quantity: '20', unitPrice: '650', taxCode: 'VAT16' });
      expect(res.body.lines[0].account).toMatch(/^6600/);
      expect(res.body.warnings.join(' ')).toMatch(/Line 2: 2 × 4500 does not equal 9500/);
      const sent = model.calls[0];
      expect(sent.tool_choice).toEqual({ type: 'tool', name: 'record_invoice' });
      expect((sent.messages[0].content as { type: string }[])[0].type).toBe('document');
    });

    it('answers questions only from reports the asker may run', async () => {
      const s = await getServices();
      const model = new ScriptedModel([
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'profit_and_loss', input: { from: '2026-01-01', to: '2026-12-31' } }, { type: 'tool_use', id: 'b', name: 'balance_sheet', input: { asOf: 'yesterday' } }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Revenue for 2026 so far is KES 100,000.' }] },
      ]);
      s.ai.useClient(model);
      const res = await as(preparer).post('/ai/ask', { entityId: ke, question: 'What is our revenue this year?' }).expect(200);
      expect(res.body.answer).toBe('Revenue for 2026 so far is KES 100,000.');
      expect(res.body.tools).toEqual([
        { tool: 'profit_and_loss', input: { from: '2026-01-01', to: '2026-12-31' }, ok: true },
        { tool: 'balance_sheet', input: { asOf: 'yesterday' }, ok: false },
      ]);
      const results = model.calls[1].messages.at(-1)!.content as { type: string; content: string; is_error?: boolean }[];
      expect(JSON.parse(results[0].content).totals.revenue).toBe('100000');
      expect(results[1].is_error).toBe(true);
      expect(String(model.calls[0].system)).toMatch(/never state a number you did not get from a tool/);
      const usage = await as(owner).get('/ai/usage').expect(200);
      expect(usage.body.find((u: { feature: string }) => u.feature === 'ask').requests).toBe(2);
    });

    it('requires the ai.use permission', async () => {
      const viewer = (await as(owner).post('/roles', { name: 'Reports only', permissions: ['reports.view'] }).expect(201)).body.id;
      await as(owner).post('/users', { name: 'Viewer', email: 'view@auto.test', password: PASSWORD, roleIds: [viewer] }).expect(201);
      const token = await login('view@auto.test');
      await as(token).post('/ai/ask', { entityId: ke, question: 'What is our revenue?' }).expect(403);
    });
  });
});
