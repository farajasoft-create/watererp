import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WaterServices } from '../src/modules/water/server/container';
import { seedWater, startApp, TestApp } from './helpers';

/**
 * Customer service and debt management: complaints from every channel with deadlines and escalation,
 * USSD and SMS, the self-service portal, payment plans, collection cases and notices.
 */

let app: TestApp;
let s: WaterServices;
let w: Awaited<ReturnType<typeof seedWater>>;
let token: string;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

beforeAll(async () => {
  app = await startApp('water_service_e2e', {
    modules: ['water'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'agent', access: [{ module: 'water', role: 'CUSTOMER_SERVICE' }] },
      { who: 'credit', access: [{ module: 'water', role: 'CREDIT_CONTROL' }] },
      { who: 'manager', access: [{ module: 'water', role: 'MANAGER' }] },
    ],
  });
  s = app.platform.modules.water as WaterServices;
  // The SMS gateway is configured so texts are "sent" to the stand-in.
  await app.call('admin', 'PATCH', '/settings/sms', { provider: 'AFRICASTALKING', username: 'tachwasco', apiKey: 'at-key' });
  w = await seedWater(app, ['Kiprono Kirui', 'Chebet Jepkosgei']);
  token = (await app.call<{ token: string }>('admin', 'POST', '/water/settings/intake-token', {}, 200)).token;
});

afterAll(async () => app?.stop());

describe('customer service', () => {
  let ticketId: string;

  it('logs a complaint with a deadline and texts the reference', async () => {
    const t = await app.call<{ id: string; number: string; slaDueAt: string; createdAt: string; priority: string; phone: string }>('agent', 'POST', '/water/tickets', { category: 'BURST', channel: 'PHONE', customerId: w.customers[0].id, subject: 'Burst pipe at the gate' });
    expect(t.number).toBe('TKT-000001');
    // Bursts are urgent: half of the 6-hour target.
    expect(new Date(t.slaDueAt).getTime() - new Date(t.createdAt).getTime()).toBe(3 * 3_600_000);
    expect(app.sms.at(-1)).toMatchObject({ to: '+254712345600' });
    expect(app.sms.at(-1)!.message).toContain('TKT-000001');
    ticketId = t.id;
  });

  it('assigns, resolves and closes with the customer rating', async () => {
    const agent = await s.db.users.findOne({ email: 'agent@test.co' }).lean();
    await app.call('manager', 'POST', `/water/tickets/${ticketId}/assign`, { assignedTo: agent!._id.toHexString() }, 200);
    await app.call('agent', 'POST', `/water/tickets/${ticketId}/start`, {}, 200);
    await app.call('agent', 'POST', `/water/tickets/${ticketId}/close`, { customerConfirmed: true }, 400);
    await app.call('agent', 'POST', `/water/tickets/${ticketId}/resolve`, { resolution: 'Pipe replaced, supply restored' }, 200);
    const closed = await app.call<{ status: string; satisfaction: number }>('agent', 'POST', `/water/tickets/${ticketId}/close`, { customerConfirmed: true, satisfaction: 4 }, 200);
    expect(closed).toMatchObject({ status: 'CLOSED', satisfaction: 4 });
    const stats = await app.call<{ total: number; resolved: number; slaCompliancePercent: number; csat: number }>('agent', 'GET', '/water/tickets/stats?from=2026-01-01&to=2030-01-01');
    expect(stats).toMatchObject({ total: 1, resolved: 1, slaCompliancePercent: 100, csat: 4 });
  });

  it('escalates overdue tickets', async () => {
    const t = await app.call<{ id: string }>('agent', 'POST', '/water/tickets', { category: 'NO_WATER', channel: 'WALK_IN', subject: 'No water since Monday', phone: '0722000111' });
    await s.db.tickets.collection.updateOne({ _id: new Types.ObjectId(t.id) }, { $set: { createdAt: new Date(Date.now() - 50 * 3_600_000), slaDueAt: new Date(Date.now() - 26 * 3_600_000) } });
    const r = await app.call<{ escalated: number }>('agent', 'POST', '/water/tickets/housekeeping', {}, 200);
    expect(r.escalated).toBe(1);
    expect((await s.db.tickets.findById(t.id).lean())?.escalationLevel).toBe(2);
  });

  it('takes reports from a call centre system once', async () => {
    const body = { externalRef: 'CC-9001', category: 'LEAK', subject: 'Leak near the market', phone: '0733000222' };
    const a = await app.call<{ number: string }>('cc', 'POST', `/water/intake/${token}/call-centre`, body);
    const b = await app.call<{ number: string }>('cc', 'POST', `/water/intake/${token}/call-centre`, body);
    expect(a.number).toBe(b.number);
    await app.call('cc', 'POST', `/water/intake/${'x'.repeat(30)}/call-centre`, body, 404);
  });

  it('answers USSD: balance, problem reports and notices', async () => {
    const ussd = async (text: string) => (await app.raw('at', 'POST', `/water/intake/${token}/ussd`, form({ sessionId: 'S1', serviceCode: '*384*7#', phoneNumber: '+254712345600', text }), 'application/x-www-form-urlencoded')).text();
    expect(await ussd('')).toMatch(/^CON Tachasis Water Co\n1\. My balance/);
    expect(await ussd('1')).toBe(`END Account ${w.customers[0].accountNo} is paid up.`);
    expect(await ussd('3')).toMatch(/^CON What is the problem\?/);
    expect(await ussd('3*2')).toMatch(/^CON Where\?/);
    const done = await ussd('3*2*Near Kapsoen school');
    expect(done).toMatch(/^END Received\. Your reference is TKT-\d{6}/);
    const t = await s.db.tickets.findOne({ channel: 'USSD' }).lean();
    expect(t).toMatchObject({ category: 'LEAK', location: 'Near Kapsoen school' });
    expect(t?.customerId?.toHexString()).toBe(w.customers[0].id);
  });

  it('replies to BAL by SMS and turns other texts into tickets', async () => {
    const before = app.sms.length;
    await app.raw('at', 'POST', `/water/intake/${token}/sms`, form({ from: '+254712345601', text: 'bal', id: 'AT1' }), 'application/x-www-form-urlencoded');
    expect(app.sms.length).toBe(before + 1);
    expect(app.sms.at(-1)!.message).toContain(w.customers[1].accountNo);
    await app.raw('at', 'POST', `/water/intake/${token}/sms`, form({ from: '+254712345601', text: 'My meter is leaking', id: 'AT2' }), 'application/x-www-form-urlencoded');
    expect(await s.db.tickets.countDocuments({ channel: 'SMS', customerId: w.customers[1].id })).toBe(1);
  });

  it('lets customers sign in to the portal with a texted code', async () => {
    const acc = w.customers[0].accountNo;
    await app.call('cust', 'POST', '/water/portal/TWC/code', { accountNo: acc, phone: '0799999999' }, 200);
    const sentBefore = app.sms.length;
    await app.call('cust', 'POST', '/water/portal/TWC/code', { accountNo: acc, phone: '0712345600' }, 200);
    expect(app.sms.length).toBe(sentBefore + 1);
    const code = /code is (\d{6})/.exec(app.sms.at(-1)!.message)![1];
    await app.call('cust', 'GET', '/water/portal/TWC/me', undefined, 401);
    await app.call('cust', 'POST', '/water/portal/TWC/session', { accountNo: acc, code: code === '000000' ? '111111' : '000000' }, 401);
    await app.call('cust', 'POST', '/water/portal/TWC/session', { accountNo: acc, code }, 200);
    const me = await app.call<{ customer: { accountNo: string }; tickets: unknown[] }>('cust', 'GET', '/water/portal/TWC/me');
    expect(me.customer.accountNo).toBe(acc);
    const t = await app.call<{ number: string; channel: string }>('cust', 'POST', '/water/portal/TWC/tickets', { category: 'BILLING', subject: 'Bill too high this month' });
    expect(t.channel).toBe('PORTAL');
    // Another account's portal session is not this one.
    await app.call('cust', 'GET', '/water/portal/OTHER/me', undefined, 404);
  });

  it('sends notices to the zone', async () => {
    const before = app.sms.length;
    const n = await app.call<{ sentCount: number }>('agent', 'POST', '/water/notices', { type: 'INTERRUPTION', title: 'Maintenance', message: 'Supply will be off on Saturday 8am-2pm for pipe repairs.', zoneIds: [w.zoneId] });
    expect(n.sentCount).toBe(2);
    expect(app.sms.length).toBe(before + 2);
    const info = await app.call<{ notices: { title: string }[] }>('anyone', 'GET', '/water/portal/TWC');
    expect(info.notices[0].title).toBe('Maintenance');
  });
});

describe('debt management', () => {
  it('agrees a payment plan that keeps the account off the disconnection list', async () => {
    const c = w.customers[1];
    await s.db.transaction((session) => s.statement.post({ organisationId: new Types.ObjectId(app.orgId), customerId: new Types.ObjectId(c.id), date: new Date('2026-08-01'), type: 'OPENING', reference: 'OPEN', description: 'Arrears', debit: '10000' }, session));
    await s.db.customers.updateOne({ _id: c.id }, { oldestUnpaidDueDate: new Date('2026-08-15') });
    const plan = await app.call<{ id: string; instalments: { amount: string }[] }>('credit', 'POST', '/water/payment-plans', { customerId: c.id, deposit: '1000', instalments: 3, startDate: '2026-11-01' });
    expect(plan.instalments.map((i) => i.amount)).toEqual(['3000', '3000', '3000']);
    await app.call('credit', 'POST', `/water/payment-plans/${plan.id}/review`, { approve: true }, 403);
    await app.call('manager', 'POST', `/water/payment-plans/${plan.id}/review`, { approve: true }, 200);
    const listed = await app.call<{ listed: number }>('manager', 'POST', '/water/disconnections/generate', {}, 200);
    expect(listed.listed).toBe(0);

    await app.call('admin', 'POST', '/water/payments', { customerId: c.id, amount: '4000', channel: 'CASH', reference: 'RB-1', paidAt: '2026-11-03' });
    const stored = await s.db.paymentPlans.findById(plan.id).lean();
    expect(stored?.paidToDate?.toString()).toBe('4000');
    expect(stored?.instalments.map((i) => i.paid?.toString())).toEqual(['3000', '0', '0']);
  });

  it('moves a collection case through its stages and writes off with approval', async () => {
    const c = w.customers[0];
    await s.db.transaction((session) => s.statement.post({ organisationId: new Types.ObjectId(app.orgId), customerId: new Types.ObjectId(c.id), date: new Date('2026-06-01'), type: 'OPENING', reference: 'OPEN', description: 'Old debt', debit: '2500' }, session));
    await s.db.customers.updateOne({ _id: c.id }, { oldestUnpaidDueDate: new Date('2026-06-15') });
    const run = await app.call<{ opened: number }>('credit', 'POST', '/water/debt/collection-run', {}, 200);
    expect(run.opened).toBe(1);
    const [kase] = await app.call<{ id: string; stage: string; number: string }[]>('credit', 'GET', '/water/debt-cases?open=true');
    expect(kase.stage).toBe('REMINDER');
    expect(app.sms.at(-1)!.message).toContain('Reminder');
    await app.call('credit', 'POST', `/water/debt-cases/${kase.id}/stage`, { stage: 'LEGAL', legal: { advocate: 'Kip & Co Advocates', court: 'Kapsabet Law Courts', caseNo: 'SCC 12/2026' } }, 200);
    const off = await app.call<{ stage: string; writeOffAdjustmentId: string }>('credit', 'POST', `/water/debt-cases/${kase.id}/write-off`, { reason: 'Customer deceased, no estate' }, 200);
    expect(off.stage).toBe('WRITTEN_OFF');
    const adj = await s.db.adjustments.findById(off.writeOffAdjustmentId).lean();
    expect(adj?.amount?.toString()).toBe('-2500');
    expect(adj?.status).toBe('PENDING');
    const summary = await app.call<{ plans: { id: string; n: number }[] }>('credit', 'GET', '/water/debt/summary');
    expect(summary.plans.find((p) => p.id === 'ACTIVE')?.n).toBe(1);
  });
});
