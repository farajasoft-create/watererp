'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useEmployeeOptions } from '@/modules/hr/ui/hooks';

interface Who { id: string; employeeNo: string; name: string }
interface Change { id: string; kind: 'PERSONAL' | 'BANK'; changes: Record<string, unknown> | null; before: Record<string, unknown> | null; status: string; createdAt: string; employee: Who }
interface Case { id: string; number: string; kind: 'DISCIPLINARY' | 'GRIEVANCE'; category: string; against: string; description: string; status: string; outcome: string | null; outcomeNote: string; incidentDate: string | null; steps: { action: string; at: string; byName: string; note: string; dueDate?: string }[]; appeal?: { grounds?: string; decision?: string | null }; employee: Who }
interface Clearance { id: string; lastDay: string; reason: string; status: string; items: { section: string; cleared: boolean; owed: string; note: string; clearedByName: string; clearedAt: string | null }[]; exitInterview?: { conductedAt?: string; reasonForLeaving?: string; wouldRecommend?: boolean; comments?: string }; employee: Who & { jobTitle?: string } }

const OUTCOMES = { DISCIPLINARY: ['NO_ACTION', 'VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'SUSPENSION', 'SURCHARGE', 'DEMOTION', 'DISMISSAL'], GRIEVANCE: ['RESOLVED', 'NOT_UPHELD'] } as const;
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).replace(/[{}"[\]]/g, ' ').replace(/\s+/g, ' ').trim() : String(v));

export default function RelationsPage() {
  const can = useCan();
  const tabs = [
    ...(can('hr.employee.manage') ? [{ id: 'changes' as const, label: 'Record changes from staff' }] : []),
    ...(can('hr.cases.manage') ? [{ id: 'cases' as const, label: 'Discipline & grievances' }] : []),
    { id: 'clearance' as const, label: 'Exit clearance' },
  ];
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>(tabs[0].id);
  return (
    <>
      <PageHeader title="Staff relations & exits" subtitle="Changes staff ask to make to their own records, disciplinary cases and grievances with every step on file, and clearance of leavers." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'changes' && <Changes />}
      {tab === 'cases' && <Cases />}
      {tab === 'clearance' && <Clearances />}
    </>
  );
}

function Changes() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['hr-change-requests'], queryFn: () => api.get<Change[]>('/change-requests') });
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) => api.post(`/change-requests/${v.id}/decide`, { approve: v.approve, note: v.note }),
    onSuccess: () => (setRejecting(null), qc.invalidateQueries({ queryKey: ['hr-change-requests'] })),
  });
  return (
    <Card title="Awaiting approval">
      <ErrorBox error={decide.error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No changes waiting.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div>
                <p className="font-medium"><Link className="text-brand-700 hover:underline" href={`/hr/employees/${c.employee.id}`}>{c.employee.employeeNo} · {c.employee.name}</Link> <Badge>{c.kind === 'BANK' ? 'Bank details' : 'Personal details'}</Badge> <span className="text-xs text-muted">{fmtDateTime(c.createdAt)}</span></p>
                {c.changes ? (
                  <ul className="mt-1 text-xs">
                    {Object.entries(c.changes).map(([k, v]) => (
                      <li key={k}><span className="text-muted">{label(k)}:</span> {show(c.before?.[k])} → <strong>{show(v)}</strong></li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">Bank details are visible to payroll only.</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setRejecting({ id: c.id, note: '' })}>Reject</Button>
                <Button disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, approve: true })}>Approve and apply</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject the change" footer={<><Button variant="secondary" onClick={() => setRejecting(null)}>Back</Button><Button disabled={!rejecting?.note.trim()} onClick={() => decide.mutate({ id: rejecting!.id, approve: false, note: rejecting!.note })}>Reject</Button></>}>
        <Field label="Reason (the employee is told)"><Textarea rows={3} value={rejecting?.note ?? ''} onChange={(e) => setRejecting({ ...rejecting!, note: e.target.value })} /></Field>
      </Modal>
    </Card>
  );
}

function Cases() {
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions();
  const [kind, setKind] = useState<'DISCIPLINARY' | 'GRIEVANCE'>('DISCIPLINARY');
  const { data, isLoading } = useQuery({ queryKey: ['hr-cases', kind], queryFn: () => api.get<Case[]>('/cases', { kind }) });
  const [opening, setOpening] = useState<null | { employeeId: string; category: string; against: string; description: string; incidentDate: string }>(null);
  const [current, setCurrent] = useState<Case | null>(null);
  const [step, setStep] = useState({ action: 'NOTE', note: '', dueDate: '', outcome: '', appealDecision: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['hr-cases'] });
  const open = useMutation({ mutationFn: () => api.post('/cases', { kind, ...opening!, incidentDate: opening!.incidentDate || null, against: opening!.against || undefined }), onSuccess: () => (setOpening(null), refresh()) });
  const act = useMutation({
    mutationFn: () => api.post<Case>(`/cases/${current!.id}/steps`, { action: step.action, note: step.note || undefined, dueDate: step.dueDate || null, ...(step.outcome && { outcome: step.outcome }), ...(step.appealDecision && { appealDecision: step.appealDecision }) }),
    onSuccess: (c) => (setCurrent({ ...current!, ...c }), setStep({ action: 'NOTE', note: '', dueDate: '', outcome: '', appealDecision: '' }), refresh()),
  });
  const actions = (c: Case) =>
    ({
      OPEN: c.kind === 'DISCIPLINARY' ? ['SHOW_CAUSE', 'HEARING', 'NOTE'] : ['HEARING', 'NOTE'],
      SHOW_CAUSE: ['RESPONSE', 'HEARING', 'DECISION', 'NOTE'],
      HEARING: ['DECISION', 'NOTE'],
      DECIDED: ['APPEAL', 'CLOSE', 'NOTE'],
      APPEALED: ['APPEAL_DECISION', 'NOTE'],
      CLOSED: ['NOTE'],
    })[c.status] ?? ['NOTE'];
  return (
    <Card title={<Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="DISCIPLINARY">Disciplinary cases</option><option value="GRIEVANCE">Grievances</option></Select>} actions={<Button onClick={() => setOpening({ employeeId: '', category: '', against: '', description: '', incidentDate: '' })}>Open a {kind === 'DISCIPLINARY' ? 'case' : 'grievance'}</Button>}>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>None recorded.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Number</th><th>Employee</th><th>Category</th><th>Status</th><th>Outcome</th><th /></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="py-2 font-mono text-xs">{c.number}</td>
                <td>{c.employee.employeeNo} · {c.employee.name}</td>
                <td>{c.category}{c.against && <div className="text-xs text-muted">About: {c.against}</div>}</td>
                <td><Badge value={c.status} /></td>
                <td>{c.outcome ? label(c.outcome) : '—'}</td>
                <td className="text-right"><Button variant="secondary" onClick={() => setCurrent(c)}>Open</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={!!opening} onClose={() => setOpening(null)} title={kind === 'DISCIPLINARY' ? 'Open a disciplinary case' : 'Record a grievance'} footer={<><Button variant="secondary" onClick={() => setOpening(null)}>Cancel</Button><Button disabled={open.isPending || !opening?.employeeId || !opening?.category || !opening?.description} onClick={() => open.mutate()}>Open</Button></>}>
        {opening && (
          <div className="space-y-3">
            <ErrorBox error={open.error} />
            <Field label={kind === 'DISCIPLINARY' ? 'Employee' : 'Raised by'}><Select value={opening.employeeId} onChange={(e) => setOpening({ ...opening, employeeId: e.target.value })}><option value="">Select…</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}</Select></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category"><Input value={opening.category} onChange={(e) => setOpening({ ...opening, category: e.target.value })} placeholder={kind === 'DISCIPLINARY' ? 'Absenteeism, negligence…' : 'Workload, conduct of a supervisor…'} /></Field>
              <Field label="Date of the incident"><Input type="date" value={opening.incidentDate} onChange={(e) => setOpening({ ...opening, incidentDate: e.target.value })} /></Field>
            </div>
            {kind === 'GRIEVANCE' && <Field label="About whom or what"><Input value={opening.against} onChange={(e) => setOpening({ ...opening, against: e.target.value })} /></Field>}
            <Field label="Details"><Textarea rows={4} value={opening.description} onChange={(e) => setOpening({ ...opening, description: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
      <Modal wide open={!!current} onClose={() => setCurrent(null)} title={current ? `${current.number} · ${current.employee.name}` : ''}>
        {current && (
          <div className="space-y-3 text-sm">
            <ErrorBox error={act.error} />
            <p><Badge value={current.status} /> {current.category}{current.outcome && ` · outcome: ${label(current.outcome)}`}{current.appeal?.decision && ` · appeal ${label(current.appeal.decision)}`}</p>
            <p className="whitespace-pre-wrap text-muted">{current.description}</p>
            <ol className="space-y-1 border-l-2 border-line pl-3">
              {current.steps.map((s, i) => (
                <li key={i}><span className="font-medium">{label(s.action)}</span> · {fmtDateTime(s.at)} · {s.byName}{s.dueDate && ` · due ${fmtDate(s.dueDate)}`}{s.note && <div className="text-xs text-muted">{s.note}</div>}</li>
              ))}
            </ol>
            <div className="grid gap-2 rounded border border-line p-3 sm:grid-cols-2">
              <Field label="Next step"><Select value={step.action} onChange={(e) => setStep({ ...step, action: e.target.value })}>{actions(current).map((a) => <option key={a} value={a}>{label(a)}</option>)}</Select></Field>
              {['SHOW_CAUSE', 'HEARING'].includes(step.action) && <Field label={step.action === 'HEARING' ? 'Hearing date' : 'Reply due'}><Input type="date" value={step.dueDate} onChange={(e) => setStep({ ...step, dueDate: e.target.value })} /></Field>}
              {(step.action === 'DECISION' || (step.action === 'APPEAL_DECISION' && step.appealDecision === 'VARIED')) && (
                <Field label="Outcome"><Select value={step.outcome} onChange={(e) => setStep({ ...step, outcome: e.target.value })}><option value="">Choose…</option>{OUTCOMES[current.kind].map((o) => <option key={o} value={o}>{label(o)}</option>)}</Select></Field>
              )}
              {step.action === 'APPEAL_DECISION' && <Field label="Appeal decision"><Select value={step.appealDecision} onChange={(e) => setStep({ ...step, appealDecision: e.target.value })}><option value="">Choose…</option>{['UPHELD', 'VARIED', 'OVERTURNED'].map((o) => <option key={o} value={o}>{label(o)}</option>)}</Select></Field>}
              <Field label={step.action === 'APPEAL' ? 'Grounds of appeal' : 'Notes'} className="sm:col-span-2"><Textarea rows={2} value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} /></Field>
              <div className="sm:col-span-2"><Button disabled={act.isPending} onClick={() => act.mutate()}>Record</Button></div>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Clearances() {
  const can = useCan();
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions();
  const { data, isLoading } = useQuery({ queryKey: ['hr-clearances'], queryFn: () => api.get<Clearance[]>('/clearances') });
  const [starting, setStarting] = useState<null | { employeeId: string; lastDay: string; reason: string }>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [interview, setInterview] = useState({ reasonForLeaving: '', wouldRecommend: true, comments: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['hr-clearances'] });
  const start = useMutation({ mutationFn: () => api.post(`/employees/${starting!.employeeId}/clearance`, { lastDay: starting!.lastDay, reason: starting!.reason }), onSuccess: () => (setStarting(null), refresh()) });
  const clear = useMutation({ mutationFn: (v: { section: string; cleared: boolean; owed?: string; note?: string }) => api.post(`/clearances/${current}/sections`, v), onSuccess: refresh });
  const exit = useMutation({ mutationFn: () => api.post(`/clearances/${current}/exit-interview`, interview), onSuccess: refresh });
  const complete = useMutation({ mutationFn: () => api.post(`/clearances/${current}/complete`), onSuccess: refresh });
  const c = data?.find((x) => x.id === current);
  return (
    <Card title="Leavers" actions={can('hr.employee.manage') && <Button onClick={() => setStarting({ employeeId: '', lastDay: new Date().toISOString().slice(0, 10), reason: '' })}>Start clearance</Button>}>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No clearances.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Employee</th><th>Last day</th><th>Reason</th><th>Sections cleared</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id} className="border-t border-line">
                <td className="py-2">{x.employee.employeeNo} · {x.employee.name}</td>
                <td>{fmtDate(x.lastDay)}</td>
                <td>{x.reason}</td>
                <td>{x.items.filter((i) => i.cleared).length}/{x.items.length}</td>
                <td><Badge value={x.status} /></td>
                <td className="text-right"><Button variant="secondary" onClick={() => setCurrent(x.id)}>Open</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={!!starting} onClose={() => setStarting(null)} title="Start clearance" footer={<><Button variant="secondary" onClick={() => setStarting(null)}>Cancel</Button><Button disabled={start.isPending || !starting?.employeeId || !starting?.reason} onClick={() => start.mutate()}>Start</Button></>}>
        {starting && (
          <div className="space-y-3">
            <ErrorBox error={start.error} />
            <Field label="Employee"><Select value={starting.employeeId} onChange={(e) => setStarting({ ...starting, employeeId: e.target.value })}><option value="">Select…</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}</Select></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Last day"><Input type="date" value={starting.lastDay} onChange={(e) => setStarting({ ...starting, lastDay: e.target.value })} /></Field>
              <Field label="Reason"><Input value={starting.reason} onChange={(e) => setStarting({ ...starting, reason: e.target.value })} placeholder="Resignation, retirement…" /></Field>
            </div>
          </div>
        )}
      </Modal>
      <Modal wide open={!!c} onClose={() => setCurrent(null)} title={c ? `Clearance: ${c.employee.name}` : ''} footer={c && c.status === 'CLEARED' ? <Button onClick={() => window.print()}>Print clearance certificate</Button> : undefined}>
        {c && (
          <div className="space-y-3 text-sm">
            <ErrorBox error={clear.error ?? exit.error ?? complete.error} />
            {c.status === 'CLEARED' && (
              <div className="rounded border border-line p-3">
                <p className="text-base font-semibold">Clearance certificate</p>
                <p>This certifies that {c.employee.name} ({c.employee.employeeNo}{c.employee.jobTitle ? `, ${c.employee.jobTitle}` : ''}), whose last day was {fmtDate(c.lastDay)}, has been cleared by every section listed below.</p>
              </div>
            )}
            <table className="w-full">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Section</th><th>Status</th><th className="text-right">Owed</th><th>Note</th><th /></tr></thead>
              <tbody>
                {c.items.map((i) => (
                  <tr key={i.section} className="border-t border-line">
                    <td className="py-2">{i.section}</td>
                    <td>{i.cleared ? <span>Cleared by {i.clearedByName}, {fmtDate(i.clearedAt)}</span> : <Badge tone="amber">Not cleared</Badge>}</td>
                    <td className="text-right">{Number(i.owed) > 0 ? fmtMoney(i.owed) : '—'}</td>
                    <td className="text-xs">{i.note}</td>
                    <td className="text-right">{c.status === 'OPEN' && !i.cleared && <Button variant="secondary" disabled={clear.isPending} onClick={() => clear.mutate({ section: i.section, cleared: true })}>Clear</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {c.exitInterview?.conductedAt ? (
              <p>Exit interview {fmtDate(c.exitInterview.conductedAt)}: {c.exitInterview.reasonForLeaving}{c.exitInterview.comments ? ` — ${c.exitInterview.comments}` : ''}</p>
            ) : (
              can('hr.employee.manage') && c.status === 'OPEN' && (
                <div className="grid gap-2 rounded border border-line p-3 sm:grid-cols-2">
                  <Field label="Reason for leaving"><Input value={interview.reasonForLeaving} onChange={(e) => setInterview({ ...interview, reasonForLeaving: e.target.value })} /></Field>
                  <label className="flex items-center gap-2 pt-6"><input type="checkbox" checked={interview.wouldRecommend} onChange={(e) => setInterview({ ...interview, wouldRecommend: e.target.checked })} />Would recommend us as an employer</label>
                  <Field label="Comments" className="sm:col-span-2"><Textarea rows={2} value={interview.comments} onChange={(e) => setInterview({ ...interview, comments: e.target.value })} /></Field>
                  <div><Button disabled={!interview.reasonForLeaving || exit.isPending} onClick={() => exit.mutate()}>Record exit interview</Button></div>
                </div>
              )
            )}
            {c.status === 'OPEN' && can('hr.employee.manage') && <Button disabled={complete.isPending} onClick={() => complete.mutate()}>Complete clearance</Button>}
          </div>
        )}
      </Modal>
    </Card>
  );
}
