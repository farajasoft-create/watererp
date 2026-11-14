import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { rankBids } from '../src/modules/tenders/server/tenders.service';
import { startApp, TestApp } from './helpers';

/**
 * PPADA tendering: thresholds and justification, committees, publishing with the notice period, the
 * public notice with addenda and answered questions, sealed online bids that can be changed until
 * closing, opening by three members, preliminary and technical evaluation, ranking, professional
 * opinion, award with simultaneous notification and reasons, the standstill, a request for review,
 * and the contracts register.
 */

let app: TestApp;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const MEMBERS = ['o1', 'o2', 'o3', 'e1', 'e2', 'e3'];

beforeAll(async () => {
  app = await startApp('tenders_e2e', {
    modules: ['tenders'],
    users: [
      { who: 'officer', access: [{ module: 'tenders', role: 'OFFICER' }] },
      { who: 'head', access: [{ module: 'tenders', role: 'HEAD' }] },
      { who: 'ao', access: [{ module: 'tenders', role: 'ACCOUNTING_OFFICER' }] },
      ...MEMBERS.map((who) => ({ who, access: [{ module: 'tenders', role: 'MEMBER' }] })),
    ],
  });
  for (const who of MEMBERS) ids[who] = (await app.platform.core.db.users.findOne({ email: `${who}@test.co` }).lean())!._id.toHexString();
});

afterAll(async () => {
  await app?.stop();
});

const tenderBody = {
  title: 'Supply and delivery of water treatment chemicals',
  method: 'OPEN_NATIONAL',
  category: 'GOODS',
  estimate: '12000000',
  planReference: 'APP-2026-014',
  bidSecurity: '200000',
  bidValidityDays: 120,
  closingAt: at(20),
  openingAt: at(20),
  mandatory: ['Certificate of incorporation', 'Valid tax compliance certificate'],
  criteria: [{ name: 'Experience', weight: 40 }, { name: 'Technical specification', weight: 60 }],
  passMark: 70,
};
const bid = (name: string, kraPin: string, phone: string, amount: string) => ({ name, kraPin, phone, email: `${name.split(' ')[0].toLowerCase()}@bidder.co`, amount, validityDays: 120, bidSecurityReference: `BS-${kraPin}`, mandatory: tenderBody.mandatory.map((requirement) => ({ requirement, provided: true, reference: 'attached' })), technicalProposal: 'Per specification' });

describe('tenders', () => {
  it('ranks on technical pass mark then lowest evaluated price', () => {
    const [a, b, c] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const m = new Types.ObjectId();
    const scores = [
      { memberId: m, bidId: a, criterion: 'X', score: 90 },
      { memberId: m, bidId: b, criterion: 'X', score: 60 },
      { memberId: m, bidId: c, criterion: 'X', score: 80 },
    ];
    const r = rankBids([{ _id: a, amount: '100', responsive: true }, { _id: b, amount: '50', responsive: true }, { _id: c, amount: '90', responsive: true }], scores, { criteria: [{ name: 'X', weight: 100 }], passMark: 70, financialWeight: 100 });
    expect(r.map((x) => [x.passed, x.rank])).toEqual([[true, 2], [false, null], [true, 1]]);
    const q = rankBids([{ _id: a, amount: '100', responsive: true }, { _id: c, amount: '90', responsive: true }], scores, { criteria: [{ name: 'X', weight: 100 }], passMark: 70, financialWeight: 20 });
    expect(q.find((x) => x.rank === 1)?.bidId).toEqual(a); // quality and cost: 90*0.8+90*0.2 beats 80*0.8+100*0.2
  });

  it('checks method thresholds and justification, then publishes with committees', async () => {
    await app.call('officer', 'POST', '/tenders/tenders', { ...tenderBody, method: 'RFQ' }, 400); // above the RFQ ceiling
    await app.call('officer', 'POST', '/tenders/tenders', { ...tenderBody, method: 'DIRECT', estimate: '100000' }, 400); // no justification
    await app.call('officer', 'POST', '/tenders/tenders', { ...tenderBody, criteria: [{ name: 'Experience', weight: 50 }] }, 400);
    const t = await app.call<{ id: string; number: string; status: string }>('officer', 'POST', '/tenders/tenders', tenderBody, 201);
    ids.tender = t.id;
    expect(t.number).toBe(`TWC/T/001/${new Date().getUTCFullYear()}`);
    await app.call('officer', 'POST', `/tenders/tenders/${t.id}/publish`, undefined, 400); // committees first
    const committees = { opening: [{ userId: ids.o1, role: 'CHAIR' }, { userId: ids.o2, role: 'SECRETARY' }, { userId: ids.o3, role: 'MEMBER' }], evaluation: [{ userId: ids.e1, role: 'CHAIR' }, { userId: ids.e2, role: 'SECRETARY' }, { userId: ids.e3, role: 'MEMBER' }] };
    await app.call('officer', 'PUT', `/tenders/tenders/${t.id}/committees`, committees, 403);
    await app.call('ao', 'PUT', `/tenders/tenders/${t.id}/committees`, { ...committees, evaluation: committees.evaluation.slice(0, 2) }, 400);
    await app.call('ao', 'PUT', `/tenders/tenders/${t.id}/committees`, committees, 200);
    expect((await app.call<{ status: string }>('officer', 'POST', `/tenders/tenders/${t.id}/publish`, undefined, 200)).status).toBe('PUBLISHED');
  });

  it('takes questions, addenda and sealed bids on the public portal', async () => {
    const list = await app.call<{ open: { number: string }[] }>('anyone', 'GET', '/tenders/public/twc');
    expect(list.open).toHaveLength(1);
    await app.call('anyone', 'POST', `/tenders/public/twc/${ids.tender}/questions`, { question: 'Is aluminium sulphate in granules acceptable?', askedBy: 'Alpha' }, 200);
    const staff = await app.call<{ clarifications: { id: string }[] }>('officer', 'GET', `/tenders/tenders/${ids.tender}`);
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/clarifications/${staff.clarifications[0].id}`, { answer: 'Yes, granules or kibbles.' }, 200);

    const a = await app.call<{ number: number; path: string }>('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Alpha Chemicals Ltd', 'P051111111A', '0711000001', '9500000'), 201);
    tokens.alpha = a.path.split('/').pop()!;
    tokens.beta = (await app.call<{ path: string }>('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Beta Supplies Ltd', 'P052222222B', '0711000002', '8800000'), 201)).path.split('/').pop()!;
    tokens.gamma = (await app.call<{ path: string }>('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Gamma Traders', 'P053333333C', '0711000003', '7000000'), 201)).path.split('/').pop()!;
    tokens.delta = (await app.call<{ path: string }>('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, { ...bid('Delta Agencies', 'P054444444D', '0711000004', '6000000'), mandatory: [{ requirement: 'Certificate of incorporation', provided: true }, { requirement: 'Valid tax compliance certificate', provided: false }] }, 201)).path.split('/').pop()!;
    await app.call('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Alpha Again', 'P051111111A', '0711000009', '1'), 409);
    await app.call('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, { ...bid('No Security', 'P055555555E', '0711000005', '1'), bidSecurityReference: undefined }, 400);

    // Alpha lowers its price before closing; a withdrawn bid drops out.
    await app.call('anyone', 'PUT', `/tenders/bid/${tokens.alpha}`, bid('Alpha Chemicals Ltd', 'P051111111A', '0711000001', '9000000'), 200);
    const w = await app.call<{ number: string; path: string }>('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Omega Ltd', 'P056666666F', '0711000006', '5000000'), 201);
    await app.call('anyone', 'POST', `/tenders/bid/${w.path.split('/').pop()}/withdraw`, undefined, 200);

    // Addendum extends closing; bidders are told.
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/addenda`, { text: 'Delivery point changed to Kapsoya works.', closingAt: at(21) }, 200);
    const notice = await app.call<{ addenda: unknown[]; clarifications: { answer: string }[] }>('anyone', 'GET', `/tenders/public/twc/${ids.tender}`);
    expect(notice.addenda).toHaveLength(1);
    expect(notice.clarifications[0].answer).toBe('Yes, granules or kibbles.');

    // Sealed: staff see a count, not the bids.
    const sealed = await app.call<{ sealed: boolean; bidsReceived: number; bids: unknown[] }>('officer', 'GET', `/tenders/tenders/${ids.tender}`);
    expect(sealed).toMatchObject({ sealed: true, bidsReceived: 4, bids: [] });
    await app.call('officer', 'GET', `/tenders/tenders/${ids.tender}/opening-register`, undefined, 400);
  });

  it('opens with three members and evaluates', async () => {
    await app.call('o1', 'POST', `/tenders/tenders/${ids.tender}/open`, { attendees: [ids.o2, ids.o3] }, 400); // not closed yet
    const c = app.platform.core.db.connection.collection('tenders_tenders');
    await c.updateOne({ _id: new Types.ObjectId(ids.tender) }, { $set: { closingAt: new Date(Date.now() - 60_000), openingAt: new Date(Date.now() - 30_000) } });
    await app.call('anyone', 'POST', `/tenders/public/twc/${ids.tender}/bids`, bid('Late Ltd', 'P057777777G', '0711000007', '1000'), 400);
    await app.call('anyone', 'PUT', `/tenders/bid/${tokens.alpha}`, bid('Alpha Chemicals Ltd', 'P051111111A', '0711000001', '1'), 400);
    await app.call('e1', 'POST', `/tenders/tenders/${ids.tender}/open`, { attendees: [ids.o2, ids.o3] }, 403);
    await app.call('o1', 'POST', `/tenders/tenders/${ids.tender}/open`, { attendees: [ids.o2] }, 400);
    const reg = await app.call<{ bids: { id: string; bidder: string; amount: string }[] }>('o1', 'POST', `/tenders/tenders/${ids.tender}/open`, { attendees: [ids.o2, ids.o3], bidderRepresentatives: 'Alpha, Beta' }, 200);
    expect(reg.bids.map((b) => [b.bidder, b.amount])).toEqual([['Alpha Chemicals Ltd', '9000000'], ['Beta Supplies Ltd', '8800000'], ['Gamma Traders', '7000000'], ['Delta Agencies', '6000000']]);
    for (const b of reg.bids) ids[b.bidder.split(' ')[0].toLowerCase()] = b.id;

    await app.call('o1', 'POST', `/tenders/tenders/${ids.tender}/preliminary`, { results: [{ bidId: ids.alpha, responsive: true }] }, 403);
    await app.call('e2', 'POST', `/tenders/tenders/${ids.tender}/preliminary`, { results: [{ bidId: ids.delta, responsive: false }] }, 400);
    await app.call('e2', 'POST', `/tenders/tenders/${ids.tender}/preliminary`, { results: [{ bidId: ids.alpha, responsive: true }, { bidId: ids.beta, responsive: true }, { bidId: ids.gamma, responsive: true }, { bidId: ids.delta, responsive: false, reason: 'No valid tax compliance certificate' }] }, 200);
    await app.call('e1', 'POST', `/tenders/tenders/${ids.tender}/scores`, { bidId: ids.delta, scores: [{ criterion: 'Experience', score: 90 }, { criterion: 'Technical specification', score: 90 }] }, 400);
    // Gamma is cheapest among the responsive bids but fails the technical pass mark; Beta wins on price.
    const marks: Record<string, [number, number]> = { alpha: [90, 85], beta: [80, 75], gamma: [50, 60] };
    for (const e of ['e1', 'e2', 'e3']) for (const [b, [x, y]] of Object.entries(marks)) await app.call(e, 'POST', `/tenders/tenders/${ids.tender}/scores`, { bidId: ids[b], scores: [{ criterion: 'Experience', score: x }, { criterion: 'Technical specification', score: y }] }, 200);
    await app.call('e2', 'POST', `/tenders/tenders/${ids.tender}/complete`, { report: 'The committee recommends the lowest evaluated bidder.' }, 403);
    const t = await app.call<{ status: string; evaluation: { recommendedBidId: string; ranking: { bidId: string; rank: number | null; passed: boolean; technical: number | null }[] } }>('e1', 'POST', `/tenders/tenders/${ids.tender}/complete`, { report: 'The committee recommends the lowest evaluated bidder.' }, 200);
    expect(t.status).toBe('EVALUATED');
    expect(t.evaluation.recommendedBidId).toBe(ids.beta);
    expect(t.evaluation.ranking.find((r) => r.bidId === ids.gamma)).toMatchObject({ passed: false, technical: 56 });
  });

  it('awards after the professional opinion, tells every bidder, and holds the contract through standstill and review', async () => {
    await app.call('ao', 'POST', `/tenders/tenders/${ids.tender}/award`, {}, 400); // opinion first
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/opinion`, { text: 'I concur with the evaluation committee.', concurs: true }, 403);
    await app.call('head', 'POST', `/tenders/tenders/${ids.tender}/opinion`, { text: 'I concur with the evaluation committee.', concurs: true }, 200);
    await app.call('ao', 'POST', `/tenders/tenders/${ids.tender}/award`, { bidId: ids.alpha }, 400); // departs from the recommendation without reasons
    await app.call('ao', 'POST', `/tenders/tenders/${ids.tender}/award`, { bidId: ids.gamma, reason: 'Cheapest' }, 400); // failed evaluation
    const t = await app.call<{ status: string; award: { amount: string; standstillEnds: string } }>('ao', 'POST', `/tenders/tenders/${ids.tender}/award`, {}, 200);
    expect(t).toMatchObject({ status: 'AWARDED', award: { amount: '8800000' } });

    const beta = await app.call<{ outcome: string }>('anyone', 'GET', `/tenders/bid/${tokens.beta}`);
    expect(beta.outcome).toBe('SUCCESSFUL');
    const delta = await app.call<{ outcome: string; outcomeReason: string }>('anyone', 'GET', `/tenders/bid/${tokens.delta}`);
    expect(delta.outcomeReason).toContain('No valid tax compliance certificate');
    const gamma = await app.call<{ outcomeReason: string }>('anyone', 'GET', `/tenders/bid/${tokens.gamma}`);
    expect(gamma.outcomeReason).toContain('below the pass mark of 70');
    const alpha = await app.call<{ outcomeReason: string }>('anyone', 'GET', `/tenders/bid/${tokens.alpha}`);
    expect(alpha.outcomeReason).toContain('ranked 2');
    expect(await app.platform.core.db.sms.countDocuments({ purpose: 'tenders:bid', message: /Review Board|was successful/ })).toBe(4);

    const award = (await app.call<{ awards: { awardedTo: string }[] }>('anyone', 'GET', '/tenders/public/twc')).awards;
    expect(award[0].awardedTo).toBe('Beta Supplies Ltd');

    const contract = { number: 'TWC/C/2026/001', signedAt: new Date().toISOString().slice(0, 10), value: '8800000', startDate: '2026-12-01', endDate: '2027-11-30', performanceSecurity: '880000' };
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/contract`, contract, 400); // standstill
    const c = app.platform.core.db.connection.collection('tenders_tenders');
    await c.updateOne({ _id: new Types.ObjectId(ids.tender) }, { $set: { 'award.standstillEnds': new Date(Date.now() - 1000) } });
    const withAppeal = await app.call<{ appeals: { id: string }[] }>('officer', 'POST', `/tenders/tenders/${ids.tender}/appeals`, { applicant: 'Alpha Chemicals Ltd', filedAt: new Date().toISOString().slice(0, 10), grounds: 'Our technical score was understated' }, 200);
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/contract`, contract, 400); // review pending
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/appeals/${withAppeal.appeals[0].id}`, { status: 'DISMISSED', decision: 'PPARB dismissed the request' }, 200);
    await app.call('officer', 'POST', `/tenders/tenders/${ids.tender}/contract`, { ...contract, value: '9000000' }, 400); // above award
    expect((await app.call<{ status: string }>('officer', 'POST', `/tenders/tenders/${ids.tender}/contract`, contract, 200)).status).toBe('CONTRACTED');

    const reg = await app.call<{ contractor: string; value: string; state: string }[]>('officer', 'GET', '/tenders/contracts');
    expect(reg[0]).toMatchObject({ contractor: 'Beta Supplies Ltd', value: '8800000' });
    const csv = await (await app.raw('officer', 'GET', '/tenders/tenders/register.csv')).text();
    expect(csv).toContain('Beta Supplies Ltd');
    const ppip = await (await app.raw('officer', 'GET', '/tenders/tenders/ppip.csv')).text();
    expect(ppip.split('\n')[1]).toContain('Beta Supplies Ltd');
  });
});
