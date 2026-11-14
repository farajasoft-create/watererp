'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { ApplicantArea, jobsCall, useApplicant } from './account';

/** The public jobs page: open vacancies, applying online and checking an application's progress. */

const LEVELS = ['KCSE', 'CERTIFICATE', 'DIPLOMA', 'DEGREE', 'MASTERS', 'DOCTORATE'] as const;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/hr/jobs${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong');
  return data as T;
}

interface Opening { id: string; number: string; title: string; department: string; positions: number; employmentType: string; description: string; requirements: string; minimumLevel: string | null; minimumExperience: number; closingDate: string }

const blank = { name: '', email: '', phone: '', nationalId: '', gender: '', dateOfBirth: '', county: '', disability: false, highestLevel: 'DIPLOMA', qualification: '', institution: '', year: '', experienceYears: '0', coverLetter: '' };

export default function JobsPage() {
  const { org } = useParams<{ org: string }>();
  const { data, error, isLoading } = useQuery({ queryKey: ['jobs', org], queryFn: () => call<{ organisation: string; branding?: Branding; vacancies: Opening[] }>('GET', `/${org}`) });
  const [applying, setApplying] = useState<Opening | null>(null);
  const [f, setF] = useState(blank);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState({ reference: '', nationalId: '' });
  const [status, setStatus] = useState<{ vacancy: string; status: string; interviewAt: string | null } | null>(null);
  const [checkError, setCheckError] = useState<unknown>(null);
  const applicant = useApplicant(org);
  const qc = useQueryClient();
  const quickApply = async (v: Opening) => {
    setFailure(null);
    setSent(null);
    try {
      const res = await jobsCall<{ reference: string }>('POST', `/${org}/account/apply/${v.id}`, {});
      setSent(res.reference);
      await qc.invalidateQueries({ queryKey: ['applicant-me', org] });
    } catch (e) {
      setFailure(e);
    }
  };

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await call<{ reference: string }>('POST', `/${org}/${applying!.id}/apply`, {
        name: f.name,
        email: f.email,
        phone: f.phone,
        nationalId: f.nationalId,
        gender: f.gender || null,
        dateOfBirth: f.dateOfBirth || null,
        county: f.county || undefined,
        disability: f.disability,
        highestLevel: f.highestLevel,
        qualifications: f.qualification ? [{ level: f.highestLevel, title: f.qualification, institution: f.institution || undefined, year: f.year ? Number(f.year) : null }] : [],
        experienceYears: Number(f.experienceYears || 0),
        coverLetter: f.coverLetter || undefined,
      });
      setSent(res.reference);
      setApplying(null);
      setF(blank);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };
  const lookup = async () => {
    setCheckError(null);
    setStatus(null);
    try {
      setStatus(await call('GET', `/${org}/status?reference=${encodeURIComponent(check.reference)}&nationalId=${encodeURIComponent(check.nationalId)}`));
    } catch (e) {
      setCheckError(e);
    }
  };

  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="Careers" branding={data?.branding}>
      <header>
        <h1 className="text-2xl font-semibold">{data?.organisation ?? 'Careers'}</h1>
        <p className="text-sm text-muted">Current vacancies. Apply online before the closing date; keep your reference number to follow your application.</p>
      </header>
      <ErrorBox error={error} />
      <ApplicantArea org={org} />
      {sent && <Notice tone="green">Application received. Your tracking number is <strong>{sent}</strong>; it has also been sent to you by email and SMS.</Notice>}
      {!applying && <ErrorBox error={failure} />}
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !data?.vacancies.length ? (
        <Card><p className="text-sm text-muted">There are no open vacancies at the moment.</p></Card>
      ) : (
        data.vacancies.map((v) => (
          <Card key={v.id} title={`${v.title}`} actions={applicant.data ? <Button onClick={() => quickApply(v)}>Apply with my profile</Button> : <Button onClick={() => (setSent(null), setFailure(null), setApplying(v))}>Apply without an account</Button>}>
            <div className="space-y-2 text-sm">
              <p className="text-muted">{v.number} · {v.department} · {label(v.employmentType)} · {v.positions} post{v.positions === 1 ? '' : 's'} · closes {fmtDate(v.closingDate)}</p>
              {v.description && <p className="whitespace-pre-wrap">{v.description}</p>}
              {v.requirements && <p className="whitespace-pre-wrap"><strong>Requirements.</strong> {v.requirements}</p>}
              <p>{v.minimumLevel && <Badge>Minimum {label(v.minimumLevel)}</Badge>} {v.minimumExperience > 0 && <Badge>{v.minimumExperience}+ years&apos; experience</Badge>}</p>
            </div>
          </Card>
        ))
      )}

      {applying && (
        <Card title={`Apply: ${applying.title}`}>
          <div className="space-y-3">
            <ErrorBox error={failure} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="ID number"><Input value={f.nationalId} onChange={(e) => setF({ ...f, nationalId: e.target.value })} /></Field>
              <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
              <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Gender"><Select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="">Prefer not to say</option><option value="FEMALE">Female</option><option value="MALE">Male</option></Select></Field>
              <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} /></Field>
              <Field label="Home county"><Input value={f.county} onChange={(e) => setF({ ...f, county: e.target.value })} /></Field>
              <Field label="Years of relevant experience"><Input inputMode="numeric" value={f.experienceYears} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setF({ ...f, experienceYears: e.target.value })} /></Field>
              <Field label="Highest qualification"><Select value={f.highestLevel} onChange={(e) => setF({ ...f, highestLevel: e.target.value })}>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</Select></Field>
              <Field label="Course or subject"><Input value={f.qualification} onChange={(e) => setF({ ...f, qualification: e.target.value })} /></Field>
              <Field label="Institution"><Input value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></Field>
              <Field label="Year completed"><Input inputMode="numeric" value={f.year} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setF({ ...f, year: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.disability} onChange={(e) => setF({ ...f, disability: e.target.checked })} />I am a person with a disability</label>
            <Field label="Why you are suited to this post"><Textarea rows={4} value={f.coverLetter} onChange={(e) => setF({ ...f, coverLetter: e.target.value })} /></Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setApplying(null)}>Cancel</Button>
              <Button disabled={busy || !f.name || !f.email || !f.phone || !f.nationalId} onClick={submit}>Submit application</Button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Check an application">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Reference"><Input value={check.reference} onChange={(e) => setCheck({ ...check, reference: e.target.value })} /></Field>
          <Field label="ID number"><Input value={check.nationalId} onChange={(e) => setCheck({ ...check, nationalId: e.target.value })} /></Field>
          <Button variant="secondary" disabled={!check.reference || !check.nationalId} onClick={lookup}>Check</Button>
        </div>
        <ErrorBox error={checkError} />
        {status && (
          <p className="mt-2 text-sm">
            {status.vacancy}: <Badge value={status.status} />
            {status.interviewAt && ` · interview on ${fmtDate(status.interviewAt)}`}
          </p>
        )}
      </Card>
    </PortalShell>
  );
}
