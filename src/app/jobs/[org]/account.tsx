'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';

const LEVELS = ['KCSE', 'CERTIFICATE', 'DIPLOMA', 'DEGREE', 'MASTERS', 'DOCTORATE'] as const;

export async function jobsCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/hr/jobs${path}`, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong'), { status: res.status });
  return data as T;
}

interface Qualification { level: string; title: string; institution?: string; year?: number | null }
interface Experience { employer: string; position: string; from?: string | null; to?: string | null; duties?: string }
interface Referee { name: string; position?: string; phone?: string; email?: string }
interface Professional { body: string; membershipNo?: string; year?: number | null }
export interface Me {
  name: string;
  email: string;
  phone: string;
  nationalId: string;
  profile: { gender?: string | null; dateOfBirth?: string | null; county?: string; disability?: boolean; highestLevel?: string | null; experienceYears?: number; qualifications: Qualification[]; experience: Experience[]; professional: Professional[]; referees: Referee[]; summary?: string };
  applications: { id: string; reference: string; vacancy: string; status: string; interviewAt?: string | null; interviewVenue?: string; reportBy?: string | null; createdAt: string }[];
}

/** The signed-in applicant, or null when nobody is signed in. */
export function useApplicant(org: string) {
  return useQuery({ queryKey: ['applicant-me', org], queryFn: () => jobsCall<Me>('GET', `/${org}/account/me`).catch((e) => (e.status === 401 ? null : Promise.reject(e))), retry: false });
}

type Step = { kind: 'signin' } | { kind: 'register' } | { kind: 'code'; applicantId: string; purpose: 'REGISTER' | 'LOGIN' | 'RESET'; sentTo?: { email: string; phone: string } } | { kind: 'forgot' };

/** Register, sign in (password, then a code sent by email and SMS), or reset a forgotten password. */
function SignIn({ org }: { org: string }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'signin' });
  const [f, setF] = useState({ name: '', email: '', phone: '', nationalId: '', password: '', code: '' });
  const [done, setDone] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      if (step.kind === 'signin') {
        const r = await jobsCall<{ applicantId: string; sentTo: { email: string; phone: string } }>('POST', `/${org}/account/login`, { email: f.email, password: f.password });
        setStep({ kind: 'code', applicantId: r.applicantId, purpose: 'LOGIN', sentTo: r.sentTo });
      } else if (step.kind === 'register') {
        const r = await jobsCall<{ applicantId: string; sentTo: { email: string; phone: string } }>('POST', `/${org}/account/register`, { name: f.name, email: f.email, phone: f.phone, nationalId: f.nationalId, password: f.password });
        setStep({ kind: 'code', applicantId: r.applicantId, purpose: 'REGISTER', sentTo: r.sentTo });
      } else if (step.kind === 'forgot') {
        const r = await jobsCall<{ applicantId: string }>('POST', `/${org}/account/forgot`, { email: f.email });
        setStep({ kind: 'code', applicantId: r.applicantId, purpose: 'RESET' });
      } else if (step.purpose === 'RESET') {
        await jobsCall('POST', `/${org}/account/reset`, { applicantId: step.applicantId, code: f.code, password: f.password });
        setDone('Password changed. Sign in with the new password.');
        setStep({ kind: 'signin' });
      } else {
        await jobsCall('POST', `/${org}/account/${step.purpose === 'REGISTER' ? 'verify' : 'login/verify'}`, { applicantId: step.applicantId, code: f.code });
        await qc.invalidateQueries({ queryKey: ['applicant-me', org] });
      }
      setF((x) => ({ ...x, code: '' }));
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title={step.kind === 'register' ? 'Create an applicant account' : step.kind === 'forgot' ? 'Forgotten password' : step.kind === 'code' ? 'Enter your code' : 'Applicant sign-in'}>
      <div className="space-y-3">
        <ErrorBox error={run.error} />
        {done && <Notice tone="green">{done}</Notice>}
        {step.kind === 'code' && <p className="text-sm text-muted">We sent a six-digit code {step.sentTo ? `to ${step.sentTo.email} and ${step.sentTo.phone}` : 'to your email and phone, if the account exists'}. It expires in 10 minutes.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {step.kind === 'register' && (
            <>
              <Field label="Full name"><Input value={f.name} onChange={set('name')} /></Field>
              <Field label="ID number"><Input value={f.nationalId} onChange={set('nationalId')} /></Field>
              <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
            </>
          )}
          {step.kind !== 'code' && <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>}
          {step.kind === 'code' && <Field label="Code"><Input inputMode="numeric" value={f.code} onChange={set('code')} maxLength={6} /></Field>}
          {(step.kind === 'signin' || step.kind === 'register' || (step.kind === 'code' && step.purpose === 'RESET')) && <Field label={step.kind === 'code' ? 'New password' : 'Password'} hint={step.kind === 'signin' ? undefined : 'At least 8 characters'}><Input type="password" value={f.password} onChange={set('password')} /></Field>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => { setDone(null); run.mutate(); }} disabled={run.isPending}>{step.kind === 'signin' ? 'Continue' : step.kind === 'register' ? 'Register' : step.kind === 'forgot' ? 'Send a code' : 'Confirm'}</Button>
          {step.kind !== 'register' && <Button variant="secondary" onClick={() => setStep({ kind: 'register' })}>Create an account</Button>}
          {step.kind !== 'signin' && <Button variant="secondary" onClick={() => setStep({ kind: 'signin' })}>Sign in instead</Button>}
          {step.kind === 'signin' && <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setStep({ kind: 'forgot' })}>Forgot your password?</button>}
        </div>
      </div>
    </Card>
  );
}

function ProfileEditor({ org, me, onClose }: { org: string; me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const p = me.profile;
  const [f, setF] = useState({ phone: me.phone, gender: p.gender ?? '', dateOfBirth: p.dateOfBirth?.slice(0, 10) ?? '', county: p.county ?? '', disability: Boolean(p.disability), highestLevel: p.highestLevel ?? '', experienceYears: String(p.experienceYears ?? 0), summary: p.summary ?? '' });
  const [quals, setQuals] = useState<Qualification[]>(p.qualifications ?? []);
  const [jobs, setJobs] = useState<Experience[]>((p.experience ?? []).map((x) => ({ ...x, from: x.from?.slice(0, 10) ?? '', to: x.to?.slice(0, 10) ?? '' })));
  const [refs, setRefs] = useState<Referee[]>(p.referees ?? []);
  const [bodies, setBodies] = useState<Professional[]>(p.professional ?? []);
  const save = useMutation({
    mutationFn: () =>
      jobsCall('PUT', `/${org}/account/profile`, {
        phone: f.phone,
        profile: {
          gender: f.gender || null,
          dateOfBirth: f.dateOfBirth || null,
          county: f.county,
          disability: f.disability,
          highestLevel: f.highestLevel || null,
          experienceYears: Number(f.experienceYears) || 0,
          summary: f.summary,
          qualifications: quals.filter((q) => q.title).map((q) => ({ ...q, year: q.year ? Number(q.year) : null })),
          experience: jobs.filter((j) => j.employer && j.position).map((j) => ({ ...j, from: j.from || null, to: j.to || null })),
          professional: bodies.filter((b) => b.body),
          referees: refs.filter((r) => r.name),
        },
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['applicant-me', org] }); onClose(); },
  });
  const row = <T,>(list: T[], setList: (l: T[]) => void, i: number, k: keyof T, v: string) => setList(list.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Card title="My profile" actions={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => save.mutate()} disabled={save.isPending}>Save profile</Button></>}>
      <div className="space-y-4 text-sm">
        <ErrorBox error={save.error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Gender"><Select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">Prefer not to say</option><option value="FEMALE">Female</option><option value="MALE">Male</option></Select></Field>
          <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} /></Field>
          <Field label="Home county"><Input value={f.county} onChange={(e) => setF({ ...f, county: e.target.value })} /></Field>
          <Field label="Highest qualification"><Select value={f.highestLevel} onChange={(e) => setF({ ...f, highestLevel: e.target.value })}><option value="">Choose</option>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</Select></Field>
          <Field label="Years of relevant experience"><Input inputMode="numeric" value={f.experienceYears} onChange={(e) => setF({ ...f, experienceYears: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.disability} onChange={(e) => setF({ ...f, disability: e.target.checked })} />I am a person with a disability</label>
        <Field label="About you"><Textarea rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        <div>
          <div className="mb-1 font-medium">Education</div>
          {quals.map((q, i) => (
            <div key={i} className="mb-1 grid gap-1 sm:grid-cols-[1fr_2fr_2fr_80px_auto]">
              <Select value={q.level} onChange={(e) => row(quals, setQuals, i, 'level', e.target.value)}>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</Select>
              <Input placeholder="Course" value={q.title} onChange={(e) => row(quals, setQuals, i, 'title', e.target.value)} />
              <Input placeholder="Institution" value={q.institution ?? ''} onChange={(e) => row(quals, setQuals, i, 'institution', e.target.value)} />
              <Input placeholder="Year" value={q.year ? String(q.year) : ''} onChange={(e) => row(quals, setQuals, i, 'year', e.target.value)} />
              <Button variant="secondary" onClick={() => setQuals(quals.filter((_, j) => j !== i))} aria-label="Remove">✕</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setQuals([...quals, { level: 'DIPLOMA', title: '' }])}>Add education</Button>
        </div>
        <div>
          <div className="mb-1 font-medium">Work experience</div>
          {jobs.map((j, i) => (
            <div key={i} className="mb-1 grid gap-1 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]">
              <Input placeholder="Employer" value={j.employer} onChange={(e) => row(jobs, setJobs, i, 'employer', e.target.value)} />
              <Input placeholder="Position" value={j.position} onChange={(e) => row(jobs, setJobs, i, 'position', e.target.value)} />
              <Input type="date" value={j.from ?? ''} onChange={(e) => row(jobs, setJobs, i, 'from', e.target.value)} aria-label="From" />
              <Input type="date" value={j.to ?? ''} onChange={(e) => row(jobs, setJobs, i, 'to', e.target.value)} aria-label="To" />
              <Button variant="secondary" onClick={() => setJobs(jobs.filter((_, k) => k !== i))} aria-label="Remove">✕</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setJobs([...jobs, { employer: '', position: '' }])}>Add a job</Button>
        </div>
        <div>
          <div className="mb-1 font-medium">Professional bodies</div>
          {bodies.map((b, i) => (
            <div key={i} className="mb-1 grid gap-1 sm:grid-cols-[2fr_1fr_auto]">
              <Input placeholder="Body (e.g. Engineers Board of Kenya)" value={b.body} onChange={(e) => row(bodies, setBodies, i, 'body', e.target.value)} />
              <Input placeholder="Membership number" value={b.membershipNo ?? ''} onChange={(e) => row(bodies, setBodies, i, 'membershipNo', e.target.value)} />
              <Button variant="secondary" onClick={() => setBodies(bodies.filter((_, k) => k !== i))} aria-label="Remove">✕</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setBodies([...bodies, { body: '' }])}>Add a professional body</Button>
        </div>
        <div>
          <div className="mb-1 font-medium">Referees</div>
          {refs.map((r, i) => (
            <div key={i} className="mb-1 grid gap-1 sm:grid-cols-[2fr_2fr_1fr_2fr_auto]">
              <Input placeholder="Name" value={r.name} onChange={(e) => row(refs, setRefs, i, 'name', e.target.value)} />
              <Input placeholder="Position" value={r.position ?? ''} onChange={(e) => row(refs, setRefs, i, 'position', e.target.value)} />
              <Input placeholder="Phone" value={r.phone ?? ''} onChange={(e) => row(refs, setRefs, i, 'phone', e.target.value)} />
              <Input placeholder="Email" value={r.email ?? ''} onChange={(e) => row(refs, setRefs, i, 'email', e.target.value)} />
              <Button variant="secondary" onClick={() => setRefs(refs.filter((_, k) => k !== i))} aria-label="Remove">✕</Button>
            </div>
          ))}
          {refs.length < 5 && <Button variant="secondary" onClick={() => setRefs([...refs, { name: '' }])}>Add a referee</Button>}
        </div>
      </div>
    </Card>
  );
}

/** The applicant's own area: profile, applications and their stage, sign out, close the account. */
export function ApplicantArea({ org }: { org: string }) {
  const qc = useQueryClient();
  const me = useApplicant(org);
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [password, setPassword] = useState('');
  const out = useMutation({ mutationFn: () => jobsCall('POST', `/${org}/account/logout`), onSuccess: () => qc.setQueryData(['applicant-me', org], null) });
  const deactivate = useMutation({ mutationFn: () => jobsCall('POST', `/${org}/account/deactivate`, { password }), onSuccess: () => qc.setQueryData(['applicant-me', org], null) });
  if (me.isLoading) return null;
  if (!me.data) return <SignIn org={org} />;
  const m = me.data;
  return (
    <>
      {editing ? <ProfileEditor org={org} me={m} onClose={() => setEditing(false)} /> : (
        <Card title={`Signed in as ${m.name}`} actions={<><Button variant="secondary" onClick={() => setEditing(true)}>Edit my profile</Button><Button variant="secondary" onClick={() => out.mutate()}>Sign out</Button></>}>
          <div className="space-y-3 text-sm">
            {!m.profile.highestLevel && <Notice tone="amber">Complete your profile (at least your highest qualification) before applying.</Notice>}
            <p className="text-muted">{m.email} · {m.phone} · ID {m.nationalId}{m.profile.highestLevel && ` · ${label(m.profile.highestLevel)}, ${m.profile.experienceYears ?? 0} years' experience`}</p>
            {m.applications.length > 0 && (
              <table className="w-full">
                <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-1">Tracking number</th><th>Vacancy</th><th>Applied</th><th>Stage</th></tr></thead>
                <tbody>
                  {m.applications.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-1 font-mono text-xs">{a.reference}</td>
                      <td>{a.vacancy}</td>
                      <td>{fmtDate(a.createdAt)}</td>
                      <td><Badge value={a.status} />{a.interviewAt && ['SHORTLISTED', 'INTERVIEWED'].includes(a.status) && <div className="text-xs text-muted">Interview {fmtDate(a.interviewAt)}{a.interviewVenue && ` at ${a.interviewVenue}`}</div>}{a.reportBy && a.status === 'OFFERED' && <div className="text-xs text-muted">Report by {fmtDate(a.reportBy)}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {closing ? (
              <div className="flex flex-wrap items-end gap-2">
                <ErrorBox error={deactivate.error} />
                <Field label="Your password, to close the account"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <Button variant="secondary" onClick={() => setClosing(false)}>Keep it</Button>
                <Button onClick={() => deactivate.mutate()} disabled={!password || deactivate.isPending}>Deactivate my account</Button>
              </div>
            ) : <button type="button" className="text-xs text-muted hover:underline" onClick={() => setClosing(true)}>Deactivate my account</button>}
          </div>
        </Card>
      )}
    </>
  );
}
