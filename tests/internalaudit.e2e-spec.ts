import bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalauditModule } from '../src/modules/internalaudit/module';
import type { InternalauditServices } from '../src/modules/internalaudit/server/container';
import { drawSample, sampleSize } from '../src/modules/internalaudit/server/engagements.service';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';

/**
 * Internal audit end to end: universe and risk register with heat map, a risk-based annual plan
 * approved by the committee, an engagement from the plan with a programme's working papers, preparer
 * and reviewer sign-off, sampling and restricted evidence, findings answered by management, the report
 * reviewed, approved and issued (PDF and Word), actions implemented with evidence and verified,
 * reminders and escalation, the dashboard and the access log.
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
let ia: InternalauditServices;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string; type: string }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const type = res.headers.get('content-type') ?? '';
  const text = type.includes('pdf') ? '' : await res.text();
  return { status: res.status, data: (text && type.includes('json') ? JSON.parse(text) : null) as T, text, type };
}
const ok = async <T = Record<string, unknown>>(p: Promise<{ status: number; data: T }>, status = 200) => {
  const r = await p;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};
async function upload(who: string, name: string, query = '') {
  const res = await handle(new Request(`http://platform.test/api/v1/documents?name=${name}${query}`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: cookies[who] }, body: `evidence ${name}` }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('internalaudit_e2e')).asPromise();
  const modules = [internalauditModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['internalaudit'] }]);
  ia = platform.modules.internalaudit as InternalauditServices;
  await internalauditModule.seed!({ db, core: platform.core, services: ia, organisationId: org._id, demo: false, demoPassword: PASSWORD });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const role = (r: string) => [{ module: 'internalaudit', role: r }];
  const users = await db.users.create([
    { organisationId: org._id, email: 'head@test.co', name: 'Head of Audit', access: role('HEAD'), passwordHash: hash },
    { organisationId: org._id, email: 'manager@test.co', name: 'Audit Manager', access: role('MANAGER'), passwordHash: hash },
    { organisationId: org._id, email: 'auditor@test.co', name: 'Auditor One', access: role('AUDITOR'), passwordHash: hash },
    { organisationId: org._id, email: 'auditor2@test.co', name: 'Auditor Two', access: role('AUDITOR'), passwordHash: hash },
    { organisationId: org._id, email: 'committee@test.co', name: 'Committee Chair', access: role('COMMITTEE'), passwordHash: hash },
    { organisationId: org._id, email: 'owner@test.co', name: 'Commercial Manager', access: [], passwordHash: hash },
    { organisationId: org._id, email: 'outsider@test.co', name: 'Someone Else', access: [], passwordHash: hash },
  ]);
  for (const u of users) ids[u.email.split('@')[0]] = u._id.toHexString();
  for (const who of Object.keys(ids)) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('sampling', () => {
  it('sizes and draws samples that can be drawn again', () => {
    expect(sampleSize(95, 5)).toBe(59);
    const a = drawSample({ population: 1000, size: 59, method: 'RANDOM', seed: 42 });
    expect(a).toHaveLength(59);
    expect(new Set(a).size).toBe(59);
    expect(drawSample({ population: 1000, size: 59, method: 'RANDOM', seed: 42 })).toEqual(a);
    const s = drawSample({ population: 100, size: 10, method: 'SYSTEMATIC', seed: 7 });
    expect(s[1] - s[0]).toBe(10);
    // The big item is always picked in a monetary-unit sample.
    expect(drawSample({ population: 5, size: 2, method: 'MONETARY', seed: 3, values: [10, 10, 1000, 10, 10] })).toContain(3);
  });
});

describe('internal audit', () => {
  it('scores the universe and risk register and draws the heat map', async () => {
    expect((await call('auditor', 'POST', '/internalaudit/universe', { code: 'X', name: 'Nope', impact: 1, likelihood: 1 })).status).toBe(403);
    ids.billing = (await ok<{ id: string }>(call('manager', 'POST', '/internalaudit/universe', { code: 'billing', name: 'Billing and revenue', kind: 'PROCESS', impact: 4, likelihood: 4 }), 201)).id;
    ids.fleet = (await ok<{ id: string }>(call('manager', 'POST', '/internalaudit/universe', { code: 'FLEET', name: 'Fleet', impact: 2, likelihood: 2, lastAuditedAt: new Date().toISOString().slice(0, 10) }), 201)).id;
    expect((await call('manager', 'POST', '/internalaudit/risks', { code: 'R1', title: 'Revenue leakage', universeId: ids.billing, impact: 3, likelihood: 3, residualImpact: 4, residualLikelihood: 4 })).status).toBe(400);
    await ok(call('manager', 'POST', '/internalaudit/risks', { code: 'R1', title: 'Revenue leakage through unbilled consumption', category: 'FINANCIAL', universeId: ids.billing, impact: 5, likelihood: 4, controls: 'Monthly exception report', residualImpact: 4, residualLikelihood: 3 }), 201);
    const universe = await ok<{ code: string; score: number; rating: string; overdue: boolean }[]>(call('auditor', 'GET', '/internalaudit/universe'));
    expect(universe[0]).toMatchObject({ code: 'BILLING', score: 12, rating: 'HIGH', overdue: true });
    expect(universe.find((u) => u.code === 'FLEET')).toMatchObject({ rating: 'LOW', overdue: false });
    const heat = await ok<{ inherent: { impact: number; likelihood: number; count: number }[][]; residualByRating: Record<string, number> }>(call('committee', 'GET', '/internalaudit/risks/heat-map'));
    expect(heat.inherent.flat().find((c) => c.impact === 5 && c.likelihood === 4)?.count).toBe(1);
    expect(heat.residualByRating.HIGH).toBe(1);
    expect((await call('outsider', 'GET', '/internalaudit/universe')).status).toBe(403);
  });

  it('builds the annual plan from the universe and has it approved by the committee', async () => {
    const plan = await ok<{ id: string; items: { id: string; title: string; universeId: string; rating: string }[] }>(call('manager', 'POST', '/internalaudit/plans', { year: '2027', title: 'Annual audit plan 2027', availableHours: 1000, fromUniverse: true }), 201);
    ids.plan = plan.id;
    expect(plan.items.map((i) => i.universeId)).toEqual([ids.billing]); // fleet is low risk and not due
    const saved = await ok<{ items: { id: string }[]; hours: number }>(call('manager', 'PUT', `/internalaudit/plans/${plan.id}/items`, { items: [{ id: plan.items[0].id, universeId: ids.billing, title: 'Audit of billing and revenue', kind: 'ASSURANCE', quarter: 1, start: '2027-02-01', end: '2027-03-31', hours: 160, leadId: ids.auditor }] }));
    ids.planItem = saved.items[0].id;
    expect(saved.hours).toBe(160);
    await ok(call('manager', 'POST', `/internalaudit/plans/${plan.id}/submit`));
    expect((await call('manager', 'POST', `/internalaudit/plans/${plan.id}/decide`, { approve: true })).status).toBe(403);
    expect((await ok<{ status: string }>(call('committee', 'POST', `/internalaudit/plans/${plan.id}/decide`, { approve: true, note: 'Approved at the March meeting' }))).status).toBe('APPROVED');
  });

  it('opens an engagement from the plan with the programme as working papers', async () => {
    const programmes = await ok<{ id: string; name: string }[]>(call('manager', 'GET', '/internalaudit/programmes'));
    const rc = programmes.find((p) => p.name.startsWith('Revenue'))!;
    expect((await call('auditor', 'POST', '/internalaudit/engagements', { title: 'x', leadId: ids.auditor })).status).toBe(403);
    expect((await call('manager', 'POST', '/internalaudit/engagements', { title: 'Billing audit', leadId: ids.owner })).status).toBe(400);
    const e = await ok<{ id: string; number: string }>(call('manager', 'POST', '/internalaudit/engagements', { title: 'Audit of billing and revenue', kind: 'ASSURANCE', universeId: ids.billing, planId: ids.plan, planItemId: ids.planItem, start: '2027-02-01', end: '2027-03-31', leadId: ids.auditor, team: [ids.auditor2], budgetHours: 160, programmeId: rc.id, scope: 'January to December 2026' }), 201);
    ids.e = e.id;
    expect(e.number).toBe('IA-2027-001');
    const detail = await ok<{ workpapers: { id: string; ref: string }[] }>(call('auditor', 'GET', `/internalaudit/engagements/${e.id}`));
    expect(detail.workpapers.map((w) => w.ref)).toEqual(['RC-01', 'RC-02', 'RC-03', 'RC-04']);
    ids.wp = detail.workpapers[0].id;
    expect((await call('manager', 'POST', '/internalaudit/engagements', { title: 'Twice', planId: ids.plan, planItemId: ids.planItem, leadId: ids.auditor })).status).toBe(400);

    const inv = await ok<{ id: string }>(call('manager', 'POST', '/internalaudit/engagements', { title: 'Investigation: cash shortage at Kapsabet', kind: 'INVESTIGATION', start: '2027-02-10', leadId: ids.auditor2 }), 201);
    expect((await call('auditor', 'GET', `/internalaudit/engagements/${inv.id}`)).status).toBe(404);
    expect((await ok<{ id: string }[]>(call('auditor', 'GET', '/internalaudit/engagements'))).map((x) => x.id)).not.toContain(inv.id);
    expect((await call('auditor2', 'GET', `/internalaudit/engagements/${inv.id}`)).status).toBe(200);
    ids.inv = inv.id;
  });

  it('keeps working papers with versions, sign-off, samples and restricted evidence', async () => {
    await ok(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/status`, { status: 'FIELDWORK' }));
    expect((await call('auditor', 'POST', `/internalaudit/workpapers/${ids.wp}/sign`, { action: 'PREPARE' })).status).toBe(400);
    await ok(call('auditor', 'PATCH', `/internalaudit/workpapers/${ids.wp}`, { content: 'Tested 59 readings', conclusion: 'Draft' }));
    const v2 = await ok<{ version: number; versions: unknown[] }>(call('auditor', 'PATCH', `/internalaudit/workpapers/${ids.wp}`, { content: 'Tested 59 readings against bills; 4 estimated more than two months', conclusion: 'Control partly effective' }));
    expect(v2.version).toBe(3);
    expect(v2.versions).toHaveLength(2);

    const sample = await ok<{ size: number; items: number[]; seed: number }>(call('auditor', 'POST', `/internalaudit/workpapers/${ids.wp}/sample`, { population: 1000, confidence: 95, tolerableRate: 5, method: 'RANDOM', seed: 42 }));
    expect(sample.size).toBe(59);
    expect(sample.items).toEqual(drawSample({ population: 1000, size: 59, method: 'RANDOM', seed: 42 }));

    const doc = await upload('auditor', 'readings.txt', '&module=internalaudit');
    const withDoc = await ok<{ documents: { id: string }[] }>(call('auditor', 'POST', `/internalaudit/workpapers/${ids.wp}/evidence`, { documentIds: [doc] }));
    expect(withDoc.documents.map((d) => d.id)).toEqual([doc]);
    const stored = await platform.core.db.documents.findById(doc).lean();
    expect(stored).toMatchObject({ access: 'RESTRICTED', entity: 'iaWorkpaper' });
    expect(stored!.sharedWith.map(String)).toEqual(expect.arrayContaining([ids.auditor, ids.auditor2, ids.manager, ids.head]));
    expect((await call('outsider', 'GET', `/documents/${doc}/download`)).status).toBe(404);
    expect((await call('committee', 'GET', `/internalaudit/workpapers/${ids.wp}`)).status).toBe(403);

    await ok(call('auditor', 'POST', `/internalaudit/workpapers/${ids.wp}/sign`, { action: 'PREPARE' }));
    expect((await call('auditor', 'POST', `/internalaudit/workpapers/${ids.wp}/sign`, { action: 'REVIEW' })).status).toBe(403);
    expect((await call('auditor2', 'POST', `/internalaudit/workpapers/${ids.wp}/sign`, { action: 'REVIEW' })).status).toBe(403);
    expect((await ok<{ status: string }>(call('manager', 'POST', `/internalaudit/workpapers/${ids.wp}/sign`, { action: 'REVIEW', note: 'Good' }))).status).toBe('REVIEWED');
    expect((await call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/status`, { status: 'REPORTING' })).status).toBe(400);
    await ia.db.workpapers.updateMany({ engagementId: new Types.ObjectId(ids.e) }, { status: 'REVIEWED' });
  });

  it('records time and costs against the budget', async () => {
    await ok(call('manager', 'PUT', '/internalaudit/settings', { hourlyRate: '2000', remindDays: 14, escalateDays: 30 }));
    await ok(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/time`, { date: '2027-02-10', hours: 6, activity: 'FIELDWORK' }), 201);
    expect((await call('committee', 'POST', `/internalaudit/engagements/${ids.e}/time`, { date: '2027-02-10', hours: 2, activity: 'FIELDWORK' })).status).toBe(403);
    expect((await call('auditor2', 'POST', `/internalaudit/engagements/${ids.e}/costs`, { date: '2027-02-10', description: 'Travel', amount: '5000' })).status).toBe(403);
    await ok(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/costs`, { date: '2027-02-10', description: 'Travel to Kapsabet', amount: '5000' }), 201);
    await ok(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/tasks`, { title: 'Test debt follow-up', assigneeId: ids.auditor2, due: '2027-02-20' }), 201);
    const e = await ok<{ totals: { hours: number; cost: string; hoursUsedPct: number } }>(call('auditor', 'GET', `/internalaudit/engagements/${ids.e}`));
    expect(e.totals).toMatchObject({ hours: 6, hoursUsedPct: 3.8 });
    expect(Number(e.totals.cost)).toBe(17000);
  });

  it('takes management responses on findings', async () => {
    await ok(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/status`, { status: 'REPORTING' }));
    const f = await ok<{ id: string }>(call('auditor', 'POST', `/internalaudit/engagements/${ids.e}/findings`, { ref: 'f-01', title: 'Accounts estimated for long periods', condition: '4 of 59 accounts estimated over 2 months', criteria: 'Billing policy: estimates for at most 2 months', cause: 'Meters inaccessible', effect: 'Revenue misstated', rating: 'HIGH', recommendation: 'Replace or relocate inaccessible meters', ownerId: ids.owner, workpaperId: ids.wp }), 201);
    ids.f = f.id;
    const asked = await platform.core.db.notifications.find({ userId: new Types.ObjectId(ids.owner) }).lean();
    expect(asked.some((n) => n.title.includes('F-01'))).toBe(true);
    expect((await call('outsider', 'GET', `/internalaudit/findings/${f.id}`)).status).toBe(404);
    expect((await call('owner', 'GET', `/internalaudit/findings/${f.id}`)).status).toBe(200);
    expect((await call('owner', 'POST', `/internalaudit/findings/${f.id}/respond`, { accepted: true, response: 'Agreed' })).status).toBe(400);
    await ok(call('owner', 'POST', `/internalaudit/findings/${f.id}/respond`, { accepted: true, response: 'Agreed', action: 'Relocate 40 meters to the boundary', dueDate: '2027-06-30' }));
  });

  it('takes the report through review, approval and issue', async () => {
    await ok(call('auditor', 'PUT', `/internalaudit/engagements/${ids.e}/report`, { summary: 'Billing controls are partly effective; estimates run too long.', conclusion: 'Improve meter access.', opinion: 'NEEDS_IMPROVEMENT' }));
    expect((await call('auditor2', 'POST', `/internalaudit/engagements/${ids.e}/report/review`, {})).status).toBe(403);
    await ok(call('manager', 'POST', `/internalaudit/engagements/${ids.e}/report/review`, {}));
    expect((await call('manager', 'POST', `/internalaudit/engagements/${ids.e}/report/approve`, {})).status).toBe(403);
    await ok(call('head', 'POST', `/internalaudit/engagements/${ids.e}/report/approve`, {}));
    const draftPdf = await call('auditor', 'GET', `/internalaudit/engagements/${ids.e}/report.pdf`);
    expect(draftPdf.type).toContain('application/pdf');
    expect((await call('outsider', 'GET', `/internalaudit/engagements/${ids.e}/report.pdf`)).status).toBe(403);
    const issued = await ok<{ status: string; report: { status: string } }>(call('head', 'POST', `/internalaudit/engagements/${ids.e}/report/issue`, {}));
    expect(issued).toMatchObject({ status: 'ISSUED', report: { status: 'ISSUED' } });
    expect((await ia.db.findings.findById(ids.f).lean())!.status).toBe('AGREED');
    expect((await ia.db.universe.findById(ids.billing).lean())!.lastAuditedAt).toBeTruthy();
    const word = await call('committee', 'GET', `/internalaudit/engagements/${ids.e}/report.doc`);
    expect(word.type).toContain('application/msword');
    expect(word.text).toContain('Accounts estimated for long periods');
    const deck = await call('committee', 'GET', `/internalaudit/engagements/${ids.e}/report.pptx`);
    expect(deck.status).toBe(200);
    expect(deck.type).toContain('presentationml.presentation');
  });

  it('tracks the action to verification', async () => {
    const mine = await ok<{ ref: string; status: string }[]>(call('owner', 'GET', '/internalaudit/actions/mine'));
    expect(mine).toEqual([expect.objectContaining({ ref: 'F-01', status: 'AGREED' })]);
    expect((await call('owner', 'POST', `/internalaudit/findings/${ids.f}/progress`, { note: 'Done', implemented: true })).status).toBe(400);
    await ok(call('owner', 'POST', `/internalaudit/findings/${ids.f}/progress`, { note: '20 meters moved' }));
    const doc = await upload('owner', 'relocation-report.txt');
    expect((await ok<{ status: string }>(call('owner', 'POST', `/internalaudit/findings/${ids.f}/progress`, { note: 'All 40 meters relocated', implemented: true, documentIds: [doc] }))).status).toBe('IMPLEMENTED');
    expect((await platform.core.db.documents.findById(doc).lean())!.access).toBe('RESTRICTED');
    expect((await call('owner', 'POST', `/internalaudit/findings/${ids.f}/verify`, { verified: true, note: 'x' })).status).toBe(403);
    expect((await ok<{ status: string }>(call('auditor2', 'POST', `/internalaudit/findings/${ids.f}/verify`, { verified: true, note: 'Checked 10 relocated meters on site' }))).status).toBe('VERIFIED');
    const reg = await ok<{ ref: string; status: string }[]>(call('committee', 'GET', '/internalaudit/recommendations'));
    expect(reg).toEqual([expect.objectContaining({ ref: 'F-01', status: 'VERIFIED' })]);
    expect((await call('committee', 'GET', '/internalaudit/recommendations?format=csv')).text).toContain('F-01');
  });

  it('reminds owners and escalates long-overdue actions', async () => {
    const [late] = await ia.db.findings.create([{ organisationId: (await ia.db.engagements.findById(ids.e).lean())!.organisationId, engagementId: new Types.ObjectId(ids.e), ref: 'F-02', title: 'Old action', rating: 'MEDIUM', ownerId: new Types.ObjectId(ids.owner), ownerName: 'Commercial Manager', status: 'AGREED', dueDate: new Date(Date.now() - 40 * 86_400_000) }]);
    const r = await ok<{ reminded: number; escalated: number }>(call('manager', 'POST', '/internalaudit/housekeeping'));
    expect(r).toEqual({ reminded: 1, escalated: 1 });
    expect((await ok<{ reminded: number; escalated: number }>(call('manager', 'POST', '/internalaudit/housekeeping')))).toEqual({ reminded: 0, escalated: 0 });
    const toHead = await platform.core.db.notifications.find({ userId: new Types.ObjectId(ids.head), title: /F-02 escalated/ }).lean();
    expect(toHead).toHaveLength(1);
    const aged = await ok<{ ref: string; band: string; daysOverdue: number }[]>(call('manager', 'GET', '/internalaudit/recommendations?overdue=true'));
    expect(aged).toEqual([expect.objectContaining({ ref: 'F-02', band: '31–90 days' })]);
    await ia.db.findings.deleteOne({ _id: late._id });
  });

  it('shows the dashboard, calendar and access log', async () => {
    const d = await ok<{ plan: { audits: number; completed: number }; productivity: { name: string; hours: number; findings: number }[]; recommendations: { implementationPct: number }; budget: { number: string; hours: number }[] }>(call('committee', 'GET', '/internalaudit/dashboard?year=2027'));
    expect(d.plan).toMatchObject({ audits: 1, completed: 1 });
    expect(d.productivity.find((p) => p.name === 'Auditor One')).toMatchObject({ hours: 6, findings: 1 });
    expect(d.recommendations.implementationPct).toBe(100);
    expect(d.budget.find((b) => b.number === 'IA-2027-001')?.hours).toBe(6);
    const cal = await ok<{ months: { month: number; engagements: { number: string }[] }[] }>(call('auditor', 'GET', '/internalaudit/calendar?year=2027'));
    expect(cal.months[1].engagements.map((e) => e.number)).toContain('IA-2027-001');
    expect((await call('auditor', 'GET', `/internalaudit/engagements/${ids.e}/access-log`)).status).toBe(403);
    const log = await ok<{ who: string; action: string; kind: string; what: string }[]>(call('manager', 'GET', `/internalaudit/engagements/${ids.e}/access-log`));
    expect(log.some((l) => l.who === 'Auditor One' && l.action === 'workpaper.update' && l.what === 'RC-01')).toBe(true);
    expect(log.some((l) => l.who === 'Committee Chair' && l.kind === 'VIEW')).toBe(true);
  });

  it('pulls the transactions to test from another module and samples the actual records', async () => {
    const cat = await ok<{ key: string }[]>(call('auditor2', 'GET', '/internalaudit/data/catalogue'));
    expect(cat.map((d) => d.key)).toContain('internalaudit.findings');
    const wp = await ok<{ id: string }>(call('auditor2', 'POST', `/internalaudit/engagements/${ids.inv}/workpapers`, { ref: 'WP-9', title: 'Follow-up of open findings' }), 201);
    expect((await call('auditor2', 'POST', `/internalaudit/workpapers/${wp.id}/sample`, { method: 'RANDOM', size: 1 })).status).toBe(400); // nothing pulled yet
    const pop = await ok<{ count: number; label: string; rows: { ref: string }[] }>(call('auditor2', 'POST', `/internalaudit/workpapers/${wp.id}/population`, { dataset: 'internalaudit.findings', filters: [{ field: 'status', op: 'ne', value: 'CLOSED' }], columns: ['ref', 'title', 'rating', 'status'] }));
    expect(pop.count).toBeGreaterThan(0);
    expect(pop.label).toBe('Audit findings and actions');
    const s = await ok<{ population: number; selected: { item: number; ref: string }[] }>(call('auditor2', 'POST', `/internalaudit/workpapers/${wp.id}/sample`, { method: 'RANDOM', size: 1, seed: 7 }));
    expect(s.population).toBe(pop.count);
    expect(s.selected[0].ref).toBeTruthy();
    expect((await call('auditor2', 'POST', `/internalaudit/workpapers/${wp.id}/sample`, { method: 'MONETARY', size: 1 })).status).toBe(400); // no value field pulled
    expect((await call('committee', 'POST', `/internalaudit/workpapers/${wp.id}/population`, { dataset: 'internalaudit.findings' })).status).toBe(403);
    expect(await ia.db.audit.countDocuments({ action: 'internalaudit.workpaper.population' })).toBe(1);
  });
});
