import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WaterServices } from '../src/modules/water/server/container';
import { ACCOUNTS, connectLedger, seedWater, startApp, TestApp } from './helpers';

/**
 * Water features added for the TACHWASCO tender: supplementary bills, split and cheque receipts, meter
 * tests and calibration, bulk upload of readings and the reconnection fee in the ledger.
 */

let app: TestApp;
let s: WaterServices;
let w: Awaited<ReturnType<typeof seedWater>>;

beforeAll(async () => {
  app = await startApp('water_extras_e2e', {
    modules: ['water'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'billing', access: [{ module: 'water', role: 'BILLING' }] },
      { who: 'manager', access: [{ module: 'water', role: 'MANAGER' }] },
      { who: 'cashier', access: [{ module: 'water', role: 'CASHIER' }] },
    ],
  });
  s = app.platform.modules.water as WaterServices;
  w = await seedWater(app, ['Kiprono Kirui', 'Chebet Jepkosgei', 'Kibet Langat']);
  await connectLedger(app, ACCOUNTS);
});

afterAll(async () => app?.stop());

describe('water extras', () => {
  it('uploads readings in bulk, once', async () => {
    await app.call('billing', 'POST', '/water/cycles', { period: '2026-10' });
    const rows = [
      { serialNo: 'm-001', value: '112', readAt: '2026-10-28' },
      { serialNo: 'M-002', value: '108', readAt: '2026-10-28' },
      { serialNo: 'M-404', value: '1', readAt: '2026-10-28' },
    ];
    const first = await app.call<{ imported: number; failed: number }>('billing', 'POST', '/water/readings/import', { rows }, 200);
    expect(first).toMatchObject({ imported: 2, failed: 1 });
    const again = await app.call<{ imported: number; results: { duplicate?: boolean }[] }>('billing', 'POST', '/water/readings/import', { rows }, 200);
    expect(again.imported).toBe(0);
    expect(again.results.filter((r) => r.duplicate)).toHaveLength(2);
    expect(await s.db.readings.countDocuments({ period: '2026-10' })).toBe(2);
  });

  it('raises a supplementary bill that does not block the regular run', async () => {
    const c = w.customers[0];
    // Back-billing 10 m³ on the domestic tariff (consumption bands only) plus a bowser delivery.
    const run = await app.call<{ id: string; kind: string; totalAmount: string }>('billing', 'POST', '/water/bill-runs/supplementary', {
      customerId: c.id,
      period: '2026-10',
      reason: 'Under-read meter in September',
      billDate: '2026-10-20',
      units: '10',
      charges: [{ description: 'Bowser delivery 5 m³', amount: '1500' }],
    });
    expect(run.kind).toBe('SUPPLEMENTARY');
    // 6 m³ in the flat band (600) + 4 × 120 = 1080, plus 1500.
    expect(run.totalAmount).toBe('2580');
    await app.call('billing', 'POST', `/water/bill-runs/${run.id}/approve`, undefined, 403);
    await app.call('manager', 'POST', `/water/bill-runs/${run.id}/approve`, undefined, 200);
    const bill = await s.db.bills.findOne({ billRunId: run.id }).lean();
    expect(bill?.billNo).toMatch(/^202610-\d{6}S$/);
    const journal = app.journals.find((j) => j.url.endsWith('/journals') && String(j.body?.reference).startsWith('WATER-SUPP-'));
    const lines = journal!.body!.lines as { accountId: string; credit?: string }[];
    expect(lines.find((l) => l.accountId === ACCOUNTS.other)?.credit).toBe('1500.00');

    // The regular run still bills the account for October.
    const regular = await app.call<{ run: { billCount: number } }>('billing', 'POST', '/water/bill-runs', { period: '2026-10', billDate: '2026-10-31' });
    expect(regular.run.billCount).toBe(2);
  });

  it('records cheques and splits one receipt between accounts', async () => {
    await app.call('cashier', 'POST', '/water/payments', { customerId: w.customers[2].id, amount: '300', channel: 'CHEQUE', reference: 'SLIP-1', paidAt: '2026-11-01' }, 400);
    const cheque = await app.call<{ chequeNo: string }>('cashier', 'POST', '/water/payments', { customerId: w.customers[2].id, amount: '300', channel: 'CHEQUE', reference: 'SLIP-1', chequeNo: '000123', drawerBank: 'KCB', paidAt: '2026-11-01' });
    expect(cheque.chequeNo).toBe('000123');
    const chequeJournal = app.journals.filter((j) => j.url.endsWith('/journals')).pop()!;
    expect((chequeJournal.body!.lines as { accountId: string; debit?: string }[])[0]).toMatchObject({ accountId: ACCOUNTS.bank, debit: '300.00' });

    const parts = await app.call<{ reference: string; accountNo: string }[]>('cashier', 'POST', '/water/payments/split', {
      channel: 'BANK',
      reference: 'EQ-778',
      paidAt: '2026-11-02',
      payerName: 'Landlord',
      parts: [
        { customerId: w.customers[0].id, amount: '1000' },
        { customerId: w.customers[1].id, amount: '500' },
      ],
    });
    expect(parts.map((p) => p.reference)).toEqual(['EQ-778/1', 'EQ-778/2']);

    // An unmatched M-Pesa payment split by a cashier: the parts must add up to it.
    await app.call('admin', 'PATCH', '/water/settings/mpesa', { shortcode: '600100' });
    const token = (await app.call<{ mpesa: { callbackToken: string } }>('admin', 'GET', '/water/settings')).mpesa.callbackToken;
    await app.call('mpesa', 'POST', `/water/mpesa/c2b/${token}/confirmation`, { TransactionType: 'Pay Bill', TransID: 'TKSPLIT01', TransTime: '20261103103000', TransAmount: '900.00', BusinessShortCode: '600100', BillRefNumber: 'two houses', MSISDN: '254712345678', FirstName: 'JANE' }, 200);
    const unmatched = await s.db.payments.findOne({ reference: 'TKSPLIT01' }).lean();
    await app.call('cashier', 'POST', `/water/payments/${unmatched!._id}/split`, { parts: [{ customerId: w.customers[1].id, amount: '400' }, { customerId: w.customers[2].id, amount: '400' }] }, 400);
    await app.call('cashier', 'POST', `/water/payments/${unmatched!._id}/split`, { parts: [{ customerId: w.customers[1].id, amount: '400' }, { customerId: w.customers[2].id, amount: '500' }] }, 200);
    expect((await s.db.payments.findById(unmatched!._id).lean())?.status).toBe('SPLIT');
    expect(await s.db.payments.countDocuments({ splitFrom: unmatched!._id, status: 'POSTED' })).toBe(2);
  });

  it('tests meters and lists calibration due', async () => {
    const m = w.customers[2];
    await app.call('billing', 'POST', `/water/meters/${m.meterId}/tests`, { at: '2026-11-01', result: 'PASS', errorPercent: '1.2', certificateNo: 'KEBS-1', nextCalibration: '2026-11-20' });
    const due = await app.call<{ serialNo: string; lastTest: { result: string } }[]>('billing', 'GET', '/water/meters/calibration-due');
    expect(due.map((d) => d.serialNo)).toEqual([m.serialNo]);
    expect(due[0].lastTest.result).toBe('PASS');
    const failed = await app.call<{ status: string }>('billing', 'POST', `/water/meters/${m.meterId}/tests`, { at: '2026-11-02', result: 'FAIL', errorPercent: '6' });
    expect(failed.status).toBe('FAULTY');
  });

  it('sends the reconnection fee to the ledger', async () => {
    await app.call('admin', 'PATCH', '/water/settings/billing', { billing: { dueDays: 14, penaltyPercent: '0', reconnectionFee: '1000', disconnectionMinArrears: '0', disconnectionGraceDays: 0, highFactor: 2, lowFactor: 0.3 } });
    const c = w.customers[0];
    const [d] = await s.db.disconnections.create([{ organisationId: app.orgId, customerId: c.id, accountNo: c.accountNo, status: 'LISTED', arrears: '100' }]);
    await app.call('billing', 'POST', `/water/disconnections/${d._id}/disconnect`, {}, 200);
    await app.call('billing', 'POST', `/water/disconnections/${d._id}/reconnect`, {}, 200);
    const stored = await s.db.disconnections.findById(d._id).lean();
    expect(stored?.reconnectionFee?.toString()).toBe('1000');
    expect(stored?.feeAccounting?.status).toBe('SENT');
    const journal = app.journals.find((j) => String(j.body?.reference).startsWith('WATER-RECON-'));
    expect((journal!.body!.lines as { accountId: string; credit?: string }[])[1]).toMatchObject({ accountId: ACCOUNTS.reconnection, credit: '1000.00' });
  });
});
