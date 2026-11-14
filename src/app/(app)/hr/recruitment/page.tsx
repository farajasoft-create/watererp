'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { departmentName, useDepartments } from '@/modules/hr/ui/hooks';

const LEVELS = ['KCSE', 'CERTIFICATE', 'DIPLOMA', 'DEGREE', 'MASTERS', 'DOCTORATE'] as const;

interface Vacancy {
  id: string;
  number: string;
  title: string;
  departmentId: string;
  jobGroupId: string | null;
  positions: number;
  employmentType: string;
  description: string;
  requirements: string;
  minimumLevel: string | null;
  minimumExperience: number;
  closingDate: string;
  internalOnly: boolean;
  status: string;
  establishmentNote: string;
  rejectionReason: string;
  createdBy: string;
  panel: string[];
  shortlistOfficers?: string[];
  applications?: number;
  shortlisted?: number;
  appointed?: number;
}
interface Application { id: string; reference: string; name: string; email: string; phone: string; gender: string | null; county: string; disability: boolean; highestLevel: string; experienceYears: number; status: string; shortlistNote: string; interviewAt: string | null; averageScore: number | null; scores: { userId: string; name: string; score: number; comment: string }[]; employeeId: string | null }
interface Detail extends Omit<Vacancy, 'applications'> { vacantPosts: number | null; applications: Application[] }
interface RecruitmentRow { id: string; number: string; title: string; status: string; positions: number; applications: number; shortlisted: number; interviewed: number; appointed: number; female: number; male: number; withDisability: number }

const blank = (deptId: string) => ({ title: '', departmentId: deptId, jobGroupId: '', positions: '1', employmentType: 'PERMANENT', description: '', requirements: '', minimumLevel: 'DIPLOMA', minimumExperience: '0', closingDate: '', internalOnly: false, establishmentNote: '', panel: [] as string[], shortlistOfficers: [] as string[] });

export default function RecruitmentPage() {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'vacancies' | 'report'>('vacancies');
  const { data: departments } = useDepartments();
  const groups = useQuery({ queryKey: ['hr-job-groups'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/job-groups') });
  const people = useQuery({ queryKey: ['hr-people'], queryFn: () => api.get<{ id: string; name: string }[]>('/people'), enabled: can('hr.employee.manage') });
  const list = useQuery({ queryKey: ['hr-vacancies'], queryFn: () => api.get<Vacancy[]>('/vacancies') });
  const [form, setForm] = useState<null | (ReturnType<typeof blank> & { id?: string })>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => ['hr-vacancies', 'hr-vacancy'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const body = { ...f, id: undefined, jobGroupId: f.jobGroupId || null, positions: Number(f.positions || 1), minimumLevel: f.minimumLevel || null, minimumExperience: Number(f.minimumExperience || 0) };
      return f.id ? api.patch(`/vacancies/${f.id}`, body) : api.post('/vacancies', body);
    },
    onSuccess: () => (setForm(null), refresh()),
  });
  const orgCode = me?.organisation?.code;
  return (
    <>
      <PageHeader
        title="Recruitment"
        subtitle={<>Vacancies are approved against the establishment, then published on the {orgCode ? <Link className="text-brand-700 hover:underline" href={`/jobs/${orgCode.toLowerCase()}`} target="_blank">public jobs page</Link> : 'public jobs page'}. Shortlist, interview and appoint; the appointee&apos;s record opens with an onboarding checklist.</>}
        actions={can('hr.employee.manage') && <Button onClick={() => setForm(blank(departments?.[0]?.id ?? ''))}>New vacancy</Button>}
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'vacancies', label: 'Vacancies' }, { id: 'report', label: 'Recruitment report' }]} />
      {tab === 'vacancies' && (
        <Card>
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.length ? (
            <Empty>No vacancies yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Number</th><th>Title</th><th>Department</th><th>Posts</th><th>Closes</th><th>Status</th><th className="text-right">Applied</th><th className="text-right">Shortlisted</th><th /></tr></thead>
              <tbody>
                {list.data.map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="py-2 font-mono text-xs">{v.number}</td>
                    <td>{v.title}{v.internalOnly && <Badge tone="gray">Internal</Badge>}</td>
                    <td>{departmentName(departments, v.departmentId)}</td>
                    <td>{v.appointed ?? 0}/{v.positions}</td>
                    <td>{fmtDate(v.closingDate)}</td>
                    <td><Badge value={v.status} /></td>
                    <td className="text-right">{v.applications ?? 0}</td>
                    <td className="text-right">{v.shortlisted ?? 0}</td>
                    <td className="text-right"><Button variant="secondary" onClick={() => setOpen(v.id)}>Open</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'report' && <Report />}
      {open && <VacancyDetail id={open} meId={me?.id ?? ''} onClose={() => setOpen(null)} onEdit={(v) => (setOpen(null), setForm({ ...blank(v.departmentId), id: v.id, title: v.title, departmentId: v.departmentId, employmentType: v.employmentType, description: v.description, requirements: v.requirements, internalOnly: v.internalOnly, establishmentNote: v.establishmentNote, panel: v.panel, shortlistOfficers: v.shortlistOfficers ?? [], jobGroupId: v.jobGroupId ?? '', positions: String(v.positions), minimumLevel: v.minimumLevel ?? '', minimumExperience: String(v.minimumExperience), closingDate: v.closingDate.slice(0, 10) }))} />}
      <Modal wide open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit vacancy' : 'New vacancy'} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button disabled={save.isPending || !form?.title || !form?.closingDate} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorBox error={save.error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Department"><Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>{departments?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
              <Field label="Job group"><Select value={form.jobGroupId} onChange={(e) => setForm({ ...form, jobGroupId: e.target.value })}><option value="">—</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}</option>)}</Select></Field>
              <Field label="Positions"><Input inputMode="numeric" value={form.positions} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setForm({ ...form, positions: e.target.value })} /></Field>
              <Field label="Terms"><Select value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>{['PERMANENT', 'CONTRACT', 'CASUAL', 'INTERN'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
              <Field label="Applications close"><Input type="date" value={form.closingDate} onChange={(e) => setForm({ ...form, closingDate: e.target.value })} /></Field>
              <Field label="Minimum qualification"><Select value={form.minimumLevel} onChange={(e) => setForm({ ...form, minimumLevel: e.target.value })}><option value="">None</option>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</Select></Field>
              <Field label="Minimum experience (years)"><Input inputMode="numeric" value={form.minimumExperience} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setForm({ ...form, minimumExperience: e.target.value })} /></Field>
              <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={form.internalOnly} onChange={(e) => setForm({ ...form, internalOnly: e.target.checked })} />Internal advert only</label>
            </div>
            <Field label="Duties"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="Requirements"><Textarea rows={3} value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} /></Field>
            <Field label="Establishment note" hint="Only if advertising more posts than are vacant"><Input value={form.establishmentNote} onChange={(e) => setForm({ ...form, establishmentNote: e.target.value })} /></Field>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-muted">Interview panel</p>
              <div className="grid max-h-40 gap-1 overflow-auto text-sm sm:grid-cols-3">
                {people.data?.map((u) => (
                  <label key={u.id} className="flex items-center gap-2"><input type="checkbox" checked={form.panel.includes(u.id)} onChange={(e) => setForm({ ...form, panel: e.target.checked ? [...form.panel, u.id] : form.panel.filter((x) => x !== u.id) })} />{u.name}</label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-muted">Shortlisting officers (can shortlist or drop applicants by hand)</p>
              <div className="grid max-h-40 gap-1 overflow-auto text-sm sm:grid-cols-3">
                {people.data?.map((u) => (
                  <label key={u.id} className="flex items-center gap-2"><input type="checkbox" checked={form.shortlistOfficers.includes(u.id)} onChange={(e) => setForm({ ...form, shortlistOfficers: e.target.checked ? [...form.shortlistOfficers, u.id] : form.shortlistOfficers.filter((x) => x !== u.id) })} />{u.name}</label>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function VacancyDetail({ id, meId, onClose, onEdit }: { id: string; meId: string; onClose: () => void; onEdit: (v: Omit<Vacancy, 'applications'>) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const { data: v } = useQuery({ queryKey: ['hr-vacancy', id], queryFn: () => api.get<Detail>(`/vacancies/${id}`) });
  const [reason, setReason] = useState('');
  const [interviewAt, setInterviewAt] = useState('');
  const [scoring, setScoring] = useState<{ id: string; score: string; comment: string } | null>(null);
  const [appointing, setAppointing] = useState<{ id: string; hireDate: string } | null>(null);
  const refresh = () => ['hr-vacancies', 'hr-vacancy'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({ mutationFn: (a: string) => api.post(`/vacancies/${id}/${a}`, a === 'reject' ? { reason } : {}), onSuccess: refresh });
  const shortlist = useMutation({ mutationFn: () => api.post<{ shortlisted: number; notShortlisted: number }>(`/vacancies/${id}/shortlist`, { interviewAt: interviewAt || null }), onSuccess: refresh });
  const score = useMutation({ mutationFn: () => api.post(`/applications/${scoring!.id}/score`, { score: Number(scoring!.score), comment: scoring!.comment || undefined }), onSuccess: () => (setScoring(null), refresh()) });
  const appoint = useMutation({ mutationFn: () => api.post<{ employeeId: string }>(`/applications/${appointing!.id}/appoint`, { hireDate: appointing!.hireDate }), onSuccess: () => (setAppointing(null), refresh()) });
  const [invite, setInvite] = useState({ at: '', venue: '' });
  const [deciding, setDeciding] = useState<{ id: string; shortlist: boolean; note: string } | null>(null);
  const [offering, setOffering] = useState<{ id: string; reportBy: string } | null>(null);
  const sendInvites = useMutation({ mutationFn: () => api.post<{ invited: number }>(`/vacancies/${id}/invite`, { interviewAt: new Date(invite.at).toISOString(), venue: invite.venue }), onSuccess: refresh });
  const decide = useMutation({ mutationFn: () => api.post(`/applications/${deciding!.id}/shortlist`, { shortlist: deciding!.shortlist, note: deciding!.note }), onSuccess: () => (setDeciding(null), refresh()) });
  const select = useMutation({ mutationFn: (appId: string) => api.post(`/applications/${appId}/select`), onSuccess: refresh });
  const offer = useMutation({ mutationFn: () => api.post(`/applications/${offering!.id}/offer`, { reportBy: offering!.reportBy }), onSuccess: () => (setOffering(null), refresh()) });
  if (!v) return <Modal open onClose={onClose} title="Vacancy"><Loading /></Modal>;
  const onPanel = v.panel.includes(meId);
  const officer = (v.shortlistOfficers ?? []).includes(meId) || can('hr.career.approve');
  const mine = v.createdBy === meId;
  return (
    <Modal wide open onClose={onClose} title={`${v.number} · ${v.title}`}>
      <div className="space-y-3 text-sm">
        <ErrorBox error={act.error ?? shortlist.error ?? score.error ?? appoint.error ?? sendInvites.error ?? decide.error ?? select.error ?? offer.error} />
        {sendInvites.data && <Notice tone="green">{sendInvites.data.invited} candidate{sendInvites.data.invited === 1 ? '' : 's'} invited by email and SMS.</Notice>}
        <p><Badge value={v.status} /> {v.positions} post{v.positions === 1 ? '' : 's'} · closes {fmtDate(v.closingDate)} · minimum {v.minimumLevel ? label(v.minimumLevel) : 'none'}, {v.minimumExperience} years{v.vacantPosts !== null && ` · ${v.vacantPosts} authorised post${v.vacantPosts === 1 ? '' : 's'} vacant`}</p>
        {v.status === 'REJECTED' && <Notice tone="amber">Returned: {v.rejectionReason}</Notice>}
        {appoint.data && <Notice tone="green">Appointed. <Link className="underline" href={`/hr/employees/${appoint.data.employeeId}`}>Open the new employee&apos;s record</Link> to work through onboarding.</Notice>}
        {shortlist.data && <Notice tone="green">{shortlist.data.shortlisted} shortlisted, {shortlist.data.notShortlisted} did not meet the requirements.</Notice>}
        <div className="flex flex-wrap gap-2">
          {['DRAFT', 'REJECTED', 'PUBLISHED'].includes(v.status) && can('hr.employee.manage') && <Button variant="secondary" onClick={() => onEdit(v)}>Edit</Button>}
          {['DRAFT', 'REJECTED'].includes(v.status) && can('hr.employee.manage') && <Button onClick={() => act.mutate('submit')}>Submit for approval</Button>}
          {v.status === 'SUBMITTED' && can('hr.career.approve') && !mine && (
            <>
              <Input className="w-56" placeholder="Reason, to return it" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button variant="secondary" disabled={!reason.trim()} onClick={() => act.mutate('reject')}>Return</Button>
              <Button onClick={() => act.mutate('approve')}>Approve</Button>
            </>
          )}
          {v.status === 'APPROVED' && can('hr.employee.manage') && <Button onClick={() => act.mutate('publish')}>Publish</Button>}
          {v.status === 'PUBLISHED' && can('hr.employee.manage') && <Button variant="secondary" onClick={() => act.mutate('close')}>Close applications</Button>}
          {v.status === 'CLOSED' && can('hr.employee.manage') && (
            <>
              <Input type="date" className="w-44" value={interviewAt} onChange={(e) => setInterviewAt(e.target.value)} aria-label="Interview date" />
              <Button onClick={() => shortlist.mutate()}>Shortlist against requirements</Button>
            </>
          )}
          {v.applications.length > 0 && <a className="self-center text-brand-700 hover:underline" href={`/api/v1/hr/vacancies/${id}/longlist?format=csv`}>Long list (CSV)</a>}
        </div>
        {v.status === 'CLOSED' && can('hr.employee.manage') && v.applications.some((a) => a.status === 'SHORTLISTED') && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
            <Field label="Interview date and time"><Input type="datetime-local" value={invite.at} onChange={(e) => setInvite({ ...invite, at: e.target.value })} /></Field>
            <Field label="Venue" className="flex-1"><Input value={invite.venue} onChange={(e) => setInvite({ ...invite, venue: e.target.value })} placeholder="Board room, head office" /></Field>
            <Button disabled={!invite.at || invite.venue.length < 2 || sendInvites.isPending} onClick={() => sendInvites.mutate()}>Invite shortlisted candidates</Button>
          </div>
        )}
        {!v.applications.length ? (
          <Empty>No applications yet.</Empty>
        ) : (
          <table className="w-full">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Ref</th><th>Candidate</th><th>Qualification</th><th>Exp.</th><th>Status</th><th className="text-right">Score</th><th /></tr></thead>
            <tbody>
              {v.applications.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className="py-2 font-mono text-xs">{a.reference}</td>
                  <td>{a.name}<div className="text-xs text-muted">{a.email} · {a.phone}{a.county && ` · ${a.county}`}{a.disability && ' · PWD'}</div></td>
                  <td>{label(a.highestLevel)}</td>
                  <td>{a.experienceYears}</td>
                  <td><Badge value={a.status} />{a.shortlistNote && <div className="text-xs text-muted">{a.shortlistNote}</div>}</td>
                  <td className="text-right">{a.averageScore ?? '—'}{a.scores.length > 0 && <div className="text-xs text-muted">{a.scores.length} panellist{a.scores.length === 1 ? '' : 's'}</div>}</td>
                  <td className="whitespace-nowrap text-right">
                    {onPanel && ['SHORTLISTED', 'INTERVIEWED'].includes(a.status) && <Button variant="secondary" onClick={() => setScoring({ id: a.id, score: String(a.scores.find((s) => s.userId === meId)?.score ?? ''), comment: '' })}>Score</Button>}
                    {officer && ['RECEIVED', 'SHORTLISTED', 'NOT_SHORTLISTED'].includes(a.status) && v.status === 'CLOSED' && <Button variant="secondary" onClick={() => setDeciding({ id: a.id, shortlist: a.status !== 'SHORTLISTED', note: '' })}>{a.status === 'SHORTLISTED' ? 'Drop' : 'Shortlist'}</Button>}
                    {a.status === 'INTERVIEWED' && can('hr.employee.manage') && <Button variant="secondary" onClick={() => select.mutate(a.id)}>Select</Button>}
                    {a.status === 'SELECTED' && can('hr.career.approve') && <Button onClick={() => setOffering({ id: a.id, reportBy: '' })}>Approve and send offer</Button>}
                    {['INTERVIEWED', 'SELECTED', 'OFFERED'].includes(a.status) && can('hr.career.approve') && <Button onClick={() => setAppointing({ id: a.id, hireDate: new Date().toISOString().slice(0, 10) })}>Appoint</Button>}
                    {a.employeeId && <Link className="text-brand-700 hover:underline" href={`/hr/employees/${a.employeeId}`}>Employee</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {scoring && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
            <Field label="Your interview score (out of 100)"><Input className="w-24" value={scoring.score} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setScoring({ ...scoring, score: e.target.value })} /></Field>
            <Field label="Comment" className="flex-1"><Input value={scoring.comment} onChange={(e) => setScoring({ ...scoring, comment: e.target.value })} /></Field>
            <Button variant="secondary" onClick={() => setScoring(null)}>Cancel</Button>
            <Button disabled={!scoring.score} onClick={() => score.mutate()}>Save score</Button>
          </div>
        )}
        {deciding && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
            <Field label={deciding.shortlist ? 'Why shortlist this applicant' : 'Why drop this applicant'} className="flex-1"><Input value={deciding.note} onChange={(e) => setDeciding({ ...deciding, note: e.target.value })} /></Field>
            <Button variant="secondary" onClick={() => setDeciding(null)}>Cancel</Button>
            <Button disabled={deciding.note.trim().length < 3 || decide.isPending} onClick={() => decide.mutate()}>Save decision</Button>
          </div>
        )}
        {offering && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
            <Field label="Report to HR by"><Input type="date" value={offering.reportBy} onChange={(e) => setOffering({ ...offering, reportBy: e.target.value })} /></Field>
            <Button variant="secondary" onClick={() => setOffering(null)}>Cancel</Button>
            <Button disabled={!offering.reportBy || offer.isPending} onClick={() => offer.mutate()}>Send the offer by email and SMS</Button>
          </div>
        )}
        {appointing && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
            <Field label="Reports on"><Input type="date" value={appointing.hireDate} onChange={(e) => setAppointing({ ...appointing, hireDate: e.target.value })} /></Field>
            <Button variant="secondary" onClick={() => setAppointing(null)}>Cancel</Button>
            <Button disabled={appoint.isPending} onClick={() => appoint.mutate()}>Appoint and open the record</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Report() {
  const year = new Date().getFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: `${year}-12-31` });
  const { data, isLoading } = useQuery({ queryKey: ['hr-recruitment-report', range], queryFn: () => api.get<RecruitmentRow[]>('/reports/recruitment', range) });
  const csv = () => {
    const rows = [['Number', 'Title', 'Status', 'Posts', 'Applications', 'Shortlisted', 'Interviewed', 'Appointed', 'Female', 'Male', 'With disability'], ...(data ?? []).map((r) => [r.number, r.title, r.status, r.positions, r.applications, r.shortlisted, r.interviewed, r.appointed, r.female, r.male, r.withDisability])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `recruitment-${range.from}-${range.to}.csv`;
    a.click();
  };
  return (
    <Card title="Recruitment report" actions={<div className="flex items-end gap-2"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /><Button variant="secondary" onClick={csv}>Export CSV</Button><Button variant="secondary" onClick={() => window.print()}>Print</Button></div>}>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No vacancies in this period.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Vacancy</th><th>Status</th><th className="text-right">Posts</th><th className="text-right">Applied</th><th className="text-right">Shortlisted</th><th className="text-right">Interviewed</th><th className="text-right">Appointed</th><th className="text-right">Female</th><th className="text-right">PWD</th></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-2">{r.number} · {r.title}</td>
                <td><Badge value={r.status} /></td>
                <td className="text-right">{r.positions}</td>
                <td className="text-right">{r.applications}</td>
                <td className="text-right">{r.shortlisted}</td>
                <td className="text-right">{r.interviewed}</td>
                <td className="text-right">{r.appointed}</td>
                <td className="text-right">{r.female}</td>
                <td className="text-right">{r.withDisability}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
