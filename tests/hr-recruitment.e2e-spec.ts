import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { startApp, TestApp } from './helpers';

/**
 * Recruitment end to end: applicant accounts with two-step codes at registration and sign-in, password
 * reset and deactivation (each confirmed by email and SMS), a saved profile used to apply, the tracking
 * number sent on every application, the long list with archived profiles, automatic and officer
 * shortlisting, interview invitations, panel scores, selection and an approved offer, appointment, and
 * the induction programme with alerts and attendance.
 */

let app: TestApp;
let hr: HrServices;
let org: Types.ObjectId;
const ids: Record<string, string> = {};
const CODE = 'TWC';

async function lastCode(email: string) {
  const m = await app.platform.core.db.emails.findOne({ to: email, subject: /your code is/ }).sort({ createdAt: -1, _id: -1 }).lean();
  return /code is (\d{6})/.exec(m?.subject ?? '')?.[1] ?? '';
}
const smsTo = async (phone: string, re: RegExp) => (await app.platform.core.db.sms.find({ to: phone }).lean()).filter((m) => re.test(m.message));

beforeAll(async () => {
  app = await startApp('hr_recruitment_e2e', {
    modules: ['hr'],
    users: [
      { who: 'hr', access: [{ module: 'hr', role: 'HR_MANAGER' }] },
      { who: 'hr2', access: [{ module: 'hr', role: 'HR_MANAGER' }] },
      { who: 'panel', access: [{ module: 'hr', role: 'HR_OFFICER' }] },
      { who: 'officer', access: [{ module: 'hr', role: 'LINE_MANAGER' }] },
      { who: 'clerk', access: [{ module: 'hr', role: 'LINE_MANAGER' }] },
    ],
  });
  hr = app.platform.modules.hr as HrServices;
  const db = app.platform.core.db;
  org = new Types.ObjectId(app.orgId);
  await hrModule.seed!({ db, core: app.platform.core, services: hr, organisationId: org, demo: false, demoPassword: 'password-123456' });
  ids.TEC = (await hr.db.departments.findOne({ organisationId: org, code: 'TEC' }).lean())!._id.toHexString();
  for (const who of ['panel', 'officer', 'hr2', 'clerk']) ids[who] = (await db.users.findOne({ email: `${who}@test.co` }).lean())!._id.toHexString();
});

afterAll(async () => {
  await app?.stop();
});

describe('recruitment', () => {
  it('advertises a vacancy with shortlisting officers and a panel', async () => {
    const v = await app.call<{ id: string }>('hr', 'POST', '/hr/vacancies', { title: 'Water Technician', departmentId: ids.TEC, positions: 1, minimumLevel: 'DIPLOMA', minimumExperience: 2, closingDate: '2030-12-31', panel: [ids.panel], shortlistOfficers: [ids.officer] });
    ids.v = v.id;
    await app.call('hr', 'POST', `/hr/vacancies/${v.id}/submit`, {}, 200);
    await app.call('hr2', 'POST', `/hr/vacancies/${v.id}/approve`, {}, 200);
    await app.call('hr', 'POST', `/hr/vacancies/${v.id}/publish`, {}, 200);
  });

  it('registers an applicant only after a code from email and SMS', async () => {
    const r = await app.call<{ applicantId: string; sentTo: { phone: string } }>('anon', 'POST', `/hr/jobs/${CODE}/account/register`, { name: 'Faith Jepchirchir', email: 'faith@mail.test', phone: '0711222333', nationalId: '30111222', password: 'secret-pass-1' }, 200);
    ids.applicant = r.applicantId;
    expect(r.sentTo.phone).toBe('***333');
    expect(await smsTo('+254711222333', /your code is \d{6}/)).toHaveLength(1);
    await app.call('anon', 'GET', `/hr/jobs/${CODE}/account/me`, undefined, 401);
    await app.call('anon', 'POST', `/hr/jobs/${CODE}/account/verify`, { applicantId: r.applicantId, code: '000000' }, 400);
    await app.call('anon', 'POST', `/hr/jobs/${CODE}/account/verify`, { applicantId: r.applicantId, code: await lastCode('faith@mail.test') }, 200);
    const me = await app.call<{ name: string }>('anon', 'GET', `/hr/jobs/${CODE}/account/me`);
    expect(me.name).toBe('Faith Jepchirchir');
    expect(await smsTo('+254711222333', /applicant account is ready/)).toHaveLength(1);
    await app.call('anon', 'POST', `/hr/jobs/${CODE}/account/register`, { name: 'Faith J', email: 'faith@mail.test', phone: '0711222333', nationalId: '30111222', password: 'another-pass' }, 409);
    // A staff session does not open the applicant account, nor the other way round.
    await app.call('hr', 'GET', `/hr/jobs/${CODE}/account/me`, undefined, 401);
    await app.call('anon', 'GET', '/hr/vacancies', undefined, 401);
  });

  it('asks for a code at every sign-in and stops guessing', async () => {
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login`, { email: 'faith@mail.test', password: 'wrong-password' }, 401);
    const l = await app.call<{ applicantId: string }>('applicant', 'POST', `/hr/jobs/${CODE}/account/login`, { email: 'faith@mail.test', password: 'secret-pass-1' }, 200);
    await app.call('applicant', 'GET', `/hr/jobs/${CODE}/account/me`, undefined, 401);
    for (let i = 0; i < 5; i++) await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login/verify`, { applicantId: l.applicantId, code: '999999' }, 400);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login/verify`, { applicantId: l.applicantId, code: await lastCode('faith@mail.test') }, 403);
    const again = await app.call<{ applicantId: string }>('applicant', 'POST', `/hr/jobs/${CODE}/account/login`, { email: 'faith@mail.test', password: 'secret-pass-1' }, 200);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login/verify`, { applicantId: again.applicantId, code: await lastCode('faith@mail.test') }, 200);
    await app.call('applicant', 'GET', `/hr/jobs/${CODE}/account/me`, undefined, 200);
  });

  it('keeps a profile and applies with it, sending the tracking number', async () => {
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/apply/${ids.v}`, {}, 400); // no qualification yet
    await app.call('applicant', 'PUT', `/hr/jobs/${CODE}/account/profile`, { profile: { gender: 'FEMALE', county: 'Nandi', highestLevel: 'DIPLOMA', experienceYears: 4, qualifications: [{ level: 'DIPLOMA', title: 'Water Technology', institution: 'KEWI', year: 2019 }], experience: [{ employer: 'Eldoret Water', position: 'Plumber', from: '2020-01-01', to: '2024-01-01' }], referees: [{ name: 'Eng. Kiprop', phone: '0700111222' }] } });
    const applied = await app.call<{ reference: string }>('applicant', 'POST', `/hr/jobs/${CODE}/account/apply/${ids.v}`, { coverLetter: 'I am keen.' }, 201);
    ids.ref = applied.reference;
    expect(await smsTo('+254711222333', new RegExp(`Tracking number: ${applied.reference}`))).toHaveLength(1);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/apply/${ids.v}`, {}, 409);
    const me = await app.call<{ applications: { reference: string; status: string }[] }>('applicant', 'GET', `/hr/jobs/${CODE}/account/me`);
    expect(me.applications).toEqual([expect.objectContaining({ reference: applied.reference, status: 'RECEIVED' })]);

    const walkIn = await app.call<{ reference: string }>('anon2', 'POST', `/hr/jobs/${CODE}/${ids.v}/apply`, { name: 'Brian Kiptoo', email: 'brian@mail.test', phone: '0722333444', nationalId: '29888777', highestLevel: 'CERTIFICATE', experienceYears: 1 }, 201);
    expect(await smsTo('+254722333444', new RegExp(walkIn.reference))).toHaveLength(1);
  });

  it('resets a forgotten password and ends old sessions', async () => {
    const f = await app.call<{ applicantId: string }>('other', 'POST', `/hr/jobs/${CODE}/account/forgot`, { email: 'faith@mail.test' }, 200);
    const nobody = await app.call<{ message: string }>('other', 'POST', `/hr/jobs/${CODE}/account/forgot`, { email: 'nobody@mail.test' }, 200);
    expect(nobody.message).toContain('If the email has an account');
    await app.call('other', 'POST', `/hr/jobs/${CODE}/account/reset`, { applicantId: f.applicantId, code: await lastCode('faith@mail.test'), password: 'brand-new-pass' }, 200);
    expect(await smsTo('+254711222333', /password was changed/)).toHaveLength(1);
    await app.call('applicant', 'GET', `/hr/jobs/${CODE}/account/me`, undefined, 401);
    const l = await app.call<{ applicantId: string }>('applicant', 'POST', `/hr/jobs/${CODE}/account/login`, { email: 'faith@mail.test', password: 'brand-new-pass' }, 200);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login/verify`, { applicantId: l.applicantId, code: await lastCode('faith@mail.test') }, 200);
  });

  it('long-lists, shortlists automatically and by the officers, and invites', async () => {
    await app.call('hr', 'POST', `/hr/vacancies/${ids.v}/close`, {}, 200);
    expect(await app.call('hr', 'POST', `/hr/vacancies/${ids.v}/shortlist`, {}, 200)).toEqual({ shortlisted: 1, notShortlisted: 1 });
    const list = await app.call<{ id: string; reference: string; status: string; archivedProfile: { county: string } | null }[]>('hr', 'GET', `/hr/vacancies/${ids.v}/longlist`);
    expect(list.map((a) => a.status).sort()).toEqual(['NOT_SHORTLISTED', 'SHORTLISTED']);
    expect(list.find((a) => a.reference === ids.ref)?.archivedProfile?.county).toBe('Nandi');
    const brian = list.find((a) => a.reference !== ids.ref)!;
    ids.faithApp = list.find((a) => a.reference === ids.ref)!.id;
    const csv = await (await app.raw('hr', 'GET', `/hr/vacancies/${ids.v}/longlist?format=csv`)).text();
    expect(csv).toContain(ids.ref);

    await app.call('clerk', 'POST', `/hr/applications/${brian.id}/shortlist`, { shortlist: true, note: 'not mine to decide' }, 403);
    await app.call('officer', 'POST', `/hr/applications/${brian.id}/shortlist`, { shortlist: true, note: 'Strong field experience outweighs the certificate' }, 200);

    expect(await app.call('hr', 'POST', `/hr/vacancies/${ids.v}/invite`, { interviewAt: '2030-12-31T07:00:00Z', venue: 'Board room, Kapsabet' }, 200)).toEqual({ invited: 2 });
    expect(await smsTo('+254722333444', /Board room, Kapsabet/)).toHaveLength(1);
    expect(await app.call('hr', 'POST', `/hr/vacancies/${ids.v}/invite`, { interviewAt: '2030-12-31T07:00:00Z', venue: 'Board room' }, 200)).toEqual({ invited: 0 });
  });

  it('scores, selects, approves the offer and appoints', async () => {
    await app.call('panel', 'POST', `/hr/applications/${ids.faithApp}/score`, { score: 82 }, 200);
    await app.call('hr', 'POST', `/hr/applications/${ids.faithApp}/select`, undefined, 200);
    await app.call('hr', 'POST', `/hr/applications/${ids.faithApp}/offer`, { reportBy: '2031-01-15' }, 403);
    expect((await app.call<{ status: string }>('hr2', 'POST', `/hr/applications/${ids.faithApp}/offer`, { reportBy: '2031-01-15' }, 200)).status).toBe('OFFERED');
    expect(await smsTo('+254711222333', /offer of appointment/)).toHaveLength(1);
    const appointed = await app.call<{ employeeId: string }>('hr2', 'POST', `/hr/applications/${ids.faithApp}/appoint`, { hireDate: new Date().toISOString().slice(0, 10) }, 201);
    ids.employee = appointed.employeeId;
  });

  it('closes an applicant account on request', async () => {
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/deactivate`, { password: 'wrong' }, 401);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/deactivate`, { password: 'brand-new-pass' }, 200);
    expect(await smsTo('+254711222333', /deactivated/)).toHaveLength(1);
    await app.call('applicant', 'POST', `/hr/jobs/${CODE}/account/login`, { email: 'faith@mail.test', password: 'brand-new-pass' }, 401);
  });

  it('runs an induction programme with alerts and attendance', async () => {
    const starters = await app.call<{ id: string }[]>('hr', 'GET', '/hr/inductions/new-starters');
    expect(starters.map((s) => s.id)).toContain(ids.employee);
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const i = await app.call<{ id: string }>('hr', 'POST', '/hr/inductions', { title: 'January induction', startDate: start, endDate: end, venue: 'Training room', participants: [ids.employee], sessions: [{ date: start, time: '09:00', topic: 'Welcome and HR policies' }] }, 201);
    expect(await smsTo('+254711222333', /January induction/)).toHaveLength(1);

    await hr.db.users.updateOne({ _id: new Types.ObjectId(ids.officer) }, { access: [{ module: 'hr', role: 'LINE_MANAGER', scope: [new Types.ObjectId(ids.TEC)] }] });
    const s = await app.call<{ sessions: { topic: string; department: string }[] }>('officer', 'POST', `/hr/inductions/${i.id}/sessions`, { date: end, time: '10:00', topic: 'How the technical department works', departmentId: ids.TEC }, 200);
    expect(s.sessions.map((x) => x.department)).toContain('Technical');
    await app.call('clerk', 'POST', `/hr/inductions/${i.id}/sessions`, { topic: 'No department' }, 403);

    expect(await hr.induction.remindDue(org, new Date(Date.now() + 86_400_000))).toEqual({ reminded: 1 });
    expect(await smsTo('+254711222333', /Reminder/)).toHaveLength(1);

    await app.call('hr', 'PUT', `/hr/inductions/${i.id}/attendance`, { rows: [{ employeeId: ids.employee, attended: true }] }, 200);
    const e = await hr.db.employees.findById(ids.employee).lean();
    expect(e!.onboarding!.find((t) => /Induction/.test(t.task))?.done).toBe(true);
  });
});
