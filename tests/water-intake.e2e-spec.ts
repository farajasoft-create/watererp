import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guessCategory, netPromoterScore } from '../src/modules/water/server/service/tickets.service';
import { seedWater, startApp, TestApp } from './helpers';

/**
 * Customer service intake and routing: complaints by email (matched to the customer, category guessed
 * from the words), SMS complaints categorised the same way, routing rules that send each new ticket to
 * the right officer, and the net promoter score from customer feedback.
 */

let app: TestApp;
let w: Awaited<ReturnType<typeof seedWater>>;
let token = '';
const ids: Record<string, string> = {};
type Ticket = { id: string; number: string; category: string; channel: string; status: string; assignedTo: string | null; customerId: string | null };

beforeAll(async () => {
  app = await startApp('water_intake_e2e', {
    modules: ['water'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'plumber', access: [{ module: 'water', role: 'TECHNICAL' }] },
      { who: 'clerk', access: [{ module: 'water', role: 'CUSTOMER_SERVICE' }] },
    ],
  });
  w = await seedWater(app, ['Kiprono Kirui', 'Chebet Jepkosgei']);
  token = (await app.call<{ token: string }>('admin', 'POST', '/water/settings/intake-token', undefined, 200)).token;
  for (const who of ['plumber', 'clerk']) ids[who] = (await app.platform.core.db.users.findOne({ email: `${who}@test.co` }).lean())!._id.toHexString();
});

afterAll(async () => {
  await app?.stop();
});

describe('intake and routing', () => {
  it('guesses categories and scores NPS', () => {
    expect(guessCategory('There is a burst pipe flooding the road')).toBe('BURST');
    expect(guessCategory('Hakuna maji since Monday')).toBe('NO_WATER');
    expect(guessCategory('My bill is too high this month')).toBe('BILLING');
    expect(guessCategory('Hello')).toBe('OTHER');
    expect(netPromoterScore([10, 9, 8, 3])).toBe(25);
    expect(netPromoterScore([])).toBeNull();
  });

  it('routes new tickets by category and zone', async () => {
    await app.call('admin', 'PATCH', '/water/settings/service', { routing: [{ category: null, zoneId: null, assignTo: ids.plumber }] }, 400);
    await app.call('admin', 'PATCH', '/water/settings/service', { routing: [{ category: 'LEAK', zoneId: null, assignTo: ids.plumber }, { category: null, zoneId: w.zoneId, assignTo: ids.clerk }] }, 200);
    const leak = await app.call<Ticket>('admin', 'POST', '/water/tickets', { category: 'LEAK', channel: 'WALK_IN', subject: 'Leak by the gate', customerId: w.customers[0].id });
    expect(leak).toMatchObject({ status: 'ASSIGNED', assignedTo: ids.plumber });
    const bill = await app.call<Ticket>('admin', 'POST', '/water/tickets', { category: 'BILLING', channel: 'WALK_IN', subject: 'Query', customerId: w.customers[0].id });
    expect(bill).toMatchObject({ status: 'ASSIGNED', assignedTo: ids.clerk }); // zone rule
    const nowhere = await app.call<Ticket>('admin', 'POST', '/water/tickets', { category: 'BILLING', channel: 'PHONE', subject: 'Query from a non-customer' });
    expect(nowhere).toMatchObject({ status: 'OPEN', assignedTo: null });
    const notices = await app.platform.core.db.notifications.find({ title: /routed to you/ }).lean();
    expect(notices).toHaveLength(2);
  });

  it('takes complaints by email', async () => {
    const r = await app.call<{ ok: boolean; ticket: string }>('anon', 'POST', `/water/intake/${token}/email`, { from: 'Kiprono Kirui <kiprono@mail.test>', subject: `Leaking pipe, account ${w.customers[0].accountNo}`, text: 'Water is leaking at my gate since morning.', messageId: '<abc@mail.test>' }, 200);
    const t = await app.platform.core.db.connection.collection('water_tickets').findOne({ number: r.ticket });
    expect(t).toMatchObject({ channel: 'EMAIL', category: 'LEAK', status: 'ASSIGNED', email: 'kiprono@mail.test' });
    expect(String(t!.customerId)).toBe(w.customers[0].id);
    // The provider retrying the same message does not open a second ticket.
    const again = await app.call<{ ticket: string }>('anon', 'POST', `/water/intake/${token}/email`, { from: 'kiprono@mail.test', subject: 'Leaking pipe', text: 'x', messageId: '<abc@mail.test>' }, 200);
    expect(again.ticket).toBe(r.ticket);
    // Mailgun-style form fields.
    const form = new URLSearchParams({ sender: 'someone@mail.test', subject: 'Dirty brown water', 'body-plain': 'The water smells.' }).toString();
    const res = await app.raw('anon', 'POST', `/water/intake/${token}/email`, form, 'application/x-www-form-urlencoded');
    const body = (await res.json()) as { ticket: string };
    expect((await app.platform.core.db.connection.collection('water_tickets').findOne({ number: body.ticket }))?.category).toBe('WATER_QUALITY');
    await app.call('anon', 'POST', '/water/intake/not-a-real-token-at-all/email', { from: 'x@y.z', subject: 'x' }, 404);
  });

  it('categorises SMS complaints', async () => {
    const r = await app.call<{ ticket: string }>('anon', 'POST', `/water/intake/${token}/sms`, { from: '+254700000099', text: 'My bill is too high this month', id: 'sms-1' }, 200);
    expect((await app.platform.core.db.connection.collection('water_tickets').findOne({ number: r.ticket }))?.category).toBe('BILLING');
  });

  it('collects the net promoter score', async () => {
    const tickets = await app.platform.core.db.connection.collection('water_tickets').find({ channel: 'WALK_IN' }).toArray();
    for (const [i, t] of tickets.entries()) {
      await app.call('admin', 'POST', `/water/tickets/${t._id}/resolve`, { resolution: 'Fixed' }, 200);
      await app.call('admin', 'POST', `/water/tickets/${t._id}/close`, { customerConfirmed: true, satisfaction: 5, recommend: i === 0 ? 10 : 4 }, 200);
    }
    const day = new Date().toISOString().slice(0, 10);
    const stats = await app.call<{ nps: number; npsResponses: number }>('admin', 'GET', `/water/tickets/stats?from=${day}&to=${day}`);
    expect(stats).toMatchObject({ nps: 0, npsResponses: 2 });
  });
});
