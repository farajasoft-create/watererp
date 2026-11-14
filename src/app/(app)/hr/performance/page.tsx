'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';
import { useCan, useMe } from '@/lib/session';
import { api } from '@/modules/hr/ui/api';
import { useEmployeeOptions } from '@/modules/hr/ui/hooks';

const PERSPECTIVES = ['FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH'] as const;
const RECS = ['NONE', 'REWARD', 'PROMOTION', 'TRAINING', 'IMPROVEMENT_PLAN'] as const;

interface Cycle { id: string; name: string; from: string; to: string; status: string }
interface Target { id: string; perspective: string; objective: string; measure: string; target: string; weight: number; selfRating: number | null; selfComment?: string; rating: number | null; comment?: string }
interface Appraisal { id: string; status: string; score: number | null; grade: string; recommendation: string; trainingNeeds: string[]; targets: Target[]; appraiserId: string; supervisorComment?: string; appeal?: { grounds?: string; decision?: string }; employee: { id: string; employeeNo: string; name: string; jobTitle?: string } | null }
interface Report { appraisals: number; completed: number; averageScore: number | null; grades: Record<string, number>; departments: { department: string; appraisals: number; averageScore: number | null }[] }
interface Training { id: string; title: string; kind: string; provider: string; startDate: string; endDate: string; cost: string; status: string; createdBy: string; participants: { employeeId: string; attended: boolean | null; rating: number | null; feedback?: string }[]; needs: string[] }
interface Budget { year: number; budget: string | null; committed: string; remaining: string; byDepartment: { department: string; cost: string }[]; trainings: number; averageEvaluation: number | null }

export default function PerformancePage() {
  const [tab, setTab] = useState<'appraisals' | 'training'>('appraisals');
  return (
    <>
      <PageHeader title="Appraisal & training" subtitle="Balanced-scorecard appraisals agreed with each employee and rated by them and their supervisor; training planned from the needs they show, within the year's budget." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'appraisals', label: 'Appraisals' }, { id: 'training', label: 'Training' }]} />
      {tab === 'appraisals' ? <Appraisals /> : <TrainingPlan />}
    </>
  );
}

function Appraisals() {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions();
  const cycles = useQuery({ queryKey: ['hr-cycles'], queryFn: () => api.get<Cycle[]>('/appraisal-cycles') });
  const [cycleId, setCycleId] = useState('');
  const cycle = cycles.data?.find((c) => c.id === cycleId) ?? cycles.data?.[0];
  const list = useQuery({ queryKey: ['hr-appraisals', cycle?.id], queryFn: () => api.get<Appraisal[]>(`/appraisal-cycles/${cycle!.id}/appraisals`), enabled: !!cycle });
  const report = useQuery({ queryKey: ['hr-appraisal-report', cycle?.id], queryFn: () => api.get<Report>(`/appraisal-cycles/${cycle!.id}/report`), enabled: !!cycle && can('hr.reports.view') });
  const [newCycle, setNewCycle] = useState<null | { name: string; from: string; to: string }>(null);
  const [targets, setTargets] = useState<null | { employeeId: string; rows: { perspective: string; objective: string; measure: string; target: string; weight: string }[] }>(null);
  const [reviewing, setReviewing] = useState<null | { a: Appraisal; ratings: Record<string, string>; comment: string; recommendation: string; needs: string }>(null);
  const refresh = () => ['hr-appraisals', 'hr-appraisal-report', 'hr-cycles'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const addCycle = useMutation({ mutationFn: () => api.post<Cycle>('/appraisal-cycles', newCycle), onSuccess: (c) => (setNewCycle(null), setCycleId(c.id), refresh()) });
  const saveTargets = useMutation({
    mutationFn: () => api.post('/appraisals/targets', { cycleId: cycle!.id, employeeId: targets!.employeeId, targets: targets!.rows.filter((r) => r.objective).map((r) => ({ ...r, weight: Number(r.weight || 0) })) }),
    onSuccess: () => (setTargets(null), refresh()),
  });
  const review = useMutation({
    mutationFn: () => {
      const r = reviewing!;
      const ratings = r.a.targets.map((t) => ({ targetId: t.id, rating: Number(r.ratings[t.id] || 0) }));
      return r.a.status === 'APPEALED'
        ? api.post(`/appraisals/${r.a.id}/appeal-decision`, { decision: r.comment || 'Appeal considered', ratings })
        : api.post(`/appraisals/${r.a.id}/review`, { ratings, comment: r.comment || undefined, recommendation: r.recommendation, trainingNeeds: r.needs.split(',').map((x) => x.trim()).filter(Boolean) });
    },
    onSuccess: () => (setReviewing(null), refresh()),
  });
  const blankRows = () => PERSPECTIVES.map((p) => ({ perspective: p, objective: '', measure: '', target: '', weight: '25' }));
  return (
    <div className="space-y-4">
      <Card
        title={
          <div className="flex items-center gap-2">
            <Select value={cycle?.id ?? ''} onChange={(e) => setCycleId(e.target.value)}>{cycles.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            {cycle && <Badge value={cycle.status} />}
          </div>
        }
        actions={
          <div className="flex gap-2">
            {can('hr.employee.manage') && <Button variant="secondary" onClick={() => setNewCycle({ name: `${new Date().getFullYear()} appraisal`, from: `${new Date().getFullYear()}-01-01`, to: `${new Date().getFullYear()}-12-31` })}>New cycle</Button>}
            {cycle?.status === 'OPEN' && <Button onClick={() => setTargets({ employeeId: '', rows: blankRows() })}>Set targets</Button>}
          </div>
        }
      >
        {report.data && (
          <div className="mb-3 grid gap-3 sm:grid-cols-4">
            <Stat label="Appraisals" value={report.data.appraisals} />
            <Stat label="Completed" value={report.data.completed} />
            <Stat label="Average score" value={report.data.averageScore === null ? '—' : `${report.data.averageScore}%`} />
            <Stat label="Grades" value={Object.entries(report.data.grades).map(([g, n]) => `${g} ${n}`).join(', ') || '—'} />
          </div>
        )}
        {!cycle ? (
          <Empty>Create an appraisal cycle to start.</Empty>
        ) : list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty>No appraisals in this cycle yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Employee</th><th>Status</th><th className="text-right">Score</th><th>Grade</th><th>Recommendation</th><th /></tr></thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className="py-2">{a.employee ? `${a.employee.employeeNo} · ${a.employee.name}` : '—'}</td>
                  <td><Badge value={a.status} /></td>
                  <td className="text-right">{a.score ?? '—'}</td>
                  <td>{a.grade}</td>
                  <td>{a.recommendation !== 'NONE' ? label(a.recommendation) : ''}{a.trainingNeeds.length > 0 && <div className="text-xs text-muted">{a.trainingNeeds.join(', ')}</div>}</td>
                  <td className="text-right">
                    {a.status === 'SELF_REVIEWED' && <Button variant="secondary" onClick={() => setReviewing({ a, ratings: {}, comment: '', recommendation: 'NONE', needs: '' })}>Review</Button>}
                    {a.status === 'APPEALED' && can('hr.career.approve') && a.appraiserId !== me?.id && <Button variant="secondary" onClick={() => setReviewing({ a, ratings: Object.fromEntries(a.targets.map((t) => [t.id, String(t.rating ?? '')])), comment: '', recommendation: a.recommendation, needs: '' })}>Decide appeal</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={!!newCycle} onClose={() => setNewCycle(null)} title="New appraisal cycle" footer={<><Button variant="secondary" onClick={() => setNewCycle(null)}>Cancel</Button><Button disabled={addCycle.isPending} onClick={() => addCycle.mutate()}>Create</Button></>}>
        {newCycle && (
          <div className="grid gap-3 sm:grid-cols-3">
            <ErrorBox error={addCycle.error} />
            <Field label="Name"><Input value={newCycle.name} onChange={(e) => setNewCycle({ ...newCycle, name: e.target.value })} /></Field>
            <Field label="From"><Input type="date" value={newCycle.from} onChange={(e) => setNewCycle({ ...newCycle, from: e.target.value })} /></Field>
            <Field label="To"><Input type="date" value={newCycle.to} onChange={(e) => setNewCycle({ ...newCycle, to: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      <Modal wide open={!!targets} onClose={() => setTargets(null)} title="Performance targets" footer={<><Button variant="secondary" onClick={() => setTargets(null)}>Cancel</Button><Button disabled={saveTargets.isPending || !targets?.employeeId} onClick={() => saveTargets.mutate()}>Save targets</Button></>}>
        {targets && (
          <div className="space-y-3">
            <ErrorBox error={saveTargets.error} />
            <Field label="Employee"><Select value={targets.employeeId} onChange={(e) => setTargets({ ...targets, employeeId: e.target.value })}><option value="">Select…</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.employeeNo} · {p.name}</option>)}</Select></Field>
            <p className="text-xs text-muted">At least one target in each perspective; weights add up to 100 (now {targets.rows.reduce((a, r) => a + Number(r.weight || 0), 0)}).</p>
            {targets.rows.map((r, i) => {
              const set = (p: Partial<typeof r>) => setTargets({ ...targets, rows: targets.rows.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_9rem_7rem_4rem]">
                  <Select value={r.perspective} onChange={(e) => set({ perspective: e.target.value })}>{PERSPECTIVES.map((p) => <option key={p} value={p}>{label(p)}</option>)}</Select>
                  <Input placeholder="Objective" value={r.objective} onChange={(e) => set({ objective: e.target.value })} />
                  <Input placeholder="Measure" value={r.measure} onChange={(e) => set({ measure: e.target.value })} />
                  <Input placeholder="Target" value={r.target} onChange={(e) => set({ target: e.target.value })} />
                  <Input placeholder="%" value={r.weight} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && set({ weight: e.target.value })} />
                </div>
              );
            })}
            <Button variant="secondary" onClick={() => setTargets({ ...targets, rows: [...targets.rows, { perspective: 'FINANCIAL', objective: '', measure: '', target: '', weight: '' }] })}>Add target</Button>
          </div>
        )}
      </Modal>

      <Modal wide open={!!reviewing} onClose={() => setReviewing(null)} title={reviewing ? `${reviewing.a.status === 'APPEALED' ? 'Appeal' : 'Review'}: ${reviewing.a.employee?.name ?? ''}` : ''} footer={<><Button variant="secondary" onClick={() => setReviewing(null)}>Cancel</Button><Button disabled={review.isPending} onClick={() => review.mutate()}>Save</Button></>}>
        {reviewing && (
          <div className="space-y-3 text-sm">
            <ErrorBox error={review.error} />
            {reviewing.a.appeal?.grounds && <p className="rounded bg-amber-50 p-2">Appeal: {reviewing.a.appeal.grounds}</p>}
            <table className="w-full">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Objective</th><th>Weight</th><th>Self</th><th>Rating (1-5)</th></tr></thead>
              <tbody>
                {reviewing.a.targets.map((t) => (
                  <tr key={t.id} className="border-t border-line">
                    <td className="py-2">{t.objective}<div className="text-xs text-muted">{label(t.perspective)}{t.measure && ` · ${t.measure}`}{t.target && ` · target ${t.target}`}</div>{t.selfComment && <div className="text-xs italic">“{t.selfComment}”</div>}</td>
                    <td>{t.weight}%</td>
                    <td>{t.selfRating ?? '—'}</td>
                    <td><Select value={reviewing.ratings[t.id] ?? ''} onChange={(e) => setReviewing({ ...reviewing, ratings: { ...reviewing.ratings, [t.id]: e.target.value } })}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reviewing.a.status !== 'APPEALED' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Recommendation"><Select value={reviewing.recommendation} onChange={(e) => setReviewing({ ...reviewing, recommendation: e.target.value })}>{RECS.map((r) => <option key={r} value={r}>{label(r)}</option>)}</Select></Field>
                <Field label="Training needs" hint="Separate with commas"><Input value={reviewing.needs} onChange={(e) => setReviewing({ ...reviewing, needs: e.target.value })} /></Field>
              </div>
            )}
            <Field label={reviewing.a.status === 'APPEALED' ? 'Appeal decision' : 'Overall comment'}><Textarea rows={2} value={reviewing.comment} onChange={(e) => setReviewing({ ...reviewing, comment: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function TrainingPlan() {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: people } = useEmployeeOptions();
  const [year, setYear] = useState(new Date().getFullYear());
  const list = useQuery({ queryKey: ['hr-trainings', year], queryFn: () => api.get<Training[]>('/trainings', { year: String(year) }) });
  const budget = useQuery({ queryKey: ['hr-training-budget', year], queryFn: () => api.get<Budget>('/training-budget', { year: String(year) }) });
  const needs = useQuery({ queryKey: ['hr-training-needs'], queryFn: () => api.get<{ employeeId: string; employee: string; need: string }[]>('/training-needs') });
  const [form, setForm] = useState<null | { id?: string; title: string; kind: string; provider: string; startDate: string; endDate: string; cost: string; participantIds: string[]; needs: string }>(null);
  const [budgetAmount, setBudgetAmount] = useState<string | null>(null);
  const refresh = () => ['hr-trainings', 'hr-training-budget', 'hr-training-needs'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const body = { title: f.title, kind: f.kind, provider: f.provider || undefined, startDate: f.startDate, endDate: f.endDate, cost: f.cost || '0', participantIds: f.participantIds, needs: f.needs.split(',').map((x) => x.trim()).filter(Boolean) };
      return f.id ? api.patch(`/trainings/${f.id}`, body) : api.post('/trainings', body);
    },
    onSuccess: () => (setForm(null), refresh()),
  });
  const act = useMutation({ mutationFn: (v: { id: string; action: string }) => api.post(`/trainings/${v.id}/${v.action}`, {}), onSuccess: refresh });
  const setBudget = useMutation({ mutationFn: () => api.put('/training-budget', { year, amount: budgetAmount }), onSuccess: () => (setBudgetAmount(null), refresh()) });
  const name = (id: string) => people?.find((p) => p.id === id)?.name ?? '';
  return (
    <div className="space-y-4">
      <ErrorBox error={act.error} />
      <Card title={<div className="flex items-center gap-2">Training budget <Input className="w-24" value={year} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setYear(Number(e.target.value))} /></div>} actions={can('hr.settings.manage') && <Button variant="secondary" onClick={() => setBudgetAmount(budget.data?.budget ?? '')}>Set budget</Button>}>
        {budget.data && (
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Budget" value={budget.data.budget ? fmtMoney(budget.data.budget) : 'Not set'} />
            <Stat label="Committed" value={fmtMoney(budget.data.committed)} />
            <Stat label="Remaining" value={fmtMoney(budget.data.remaining)} tone={Number(budget.data.remaining) < 0 ? 'bad' : undefined} />
            <Stat label="Average evaluation" value={budget.data.averageEvaluation ? `${budget.data.averageEvaluation} / 5` : '—'} />
          </div>
        )}
        {budgetAmount !== null && (
          <div className="mt-3 flex items-end gap-2">
            <Field label={`Budget for ${year}`}><Input value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} /></Field>
            <Button onClick={() => setBudget.mutate()}>Save</Button>
          </div>
        )}
      </Card>
      {!!needs.data?.length && (
        <Card title="Training needs from appraisals, not yet planned">
          <ul className="text-sm">{needs.data.map((n, i) => <li key={i}>{n.employee}: {n.need}</li>)}</ul>
        </Card>
      )}
      <Card title={`Training plan ${year}`} actions={can('hr.employee.manage') && <Button onClick={() => setForm({ title: '', kind: 'TRAINING', provider: '', startDate: '', endDate: '', cost: '', participantIds: [], needs: '' })}>Plan training</Button>}>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty>Nothing planned this year.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Training</th><th>Dates</th><th>Participants</th><th className="text-right">Cost</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="py-2">{t.title}<div className="text-xs text-muted">{label(t.kind)}{t.provider && ` · ${t.provider}`}</div></td>
                  <td>{fmtDate(t.startDate)} – {fmtDate(t.endDate)}</td>
                  <td className="text-xs">{t.participants.map((p) => `${name(p.employeeId)}${p.attended === false ? ' (absent)' : ''}${p.rating ? ` ★${p.rating}` : ''}`).join(', ')}</td>
                  <td className="text-right">{fmtMoney(t.cost)}</td>
                  <td><Badge value={t.status} /></td>
                  <td className="whitespace-nowrap text-right">
                    {t.status === 'PLANNED' && can('hr.employee.manage') && <Button variant="secondary" onClick={() => setForm({ id: t.id, title: t.title, kind: t.kind, provider: t.provider, startDate: t.startDate.slice(0, 10), endDate: t.endDate.slice(0, 10), cost: t.cost, participantIds: t.participants.map((p) => p.employeeId), needs: t.needs.join(', ') })}>Edit</Button>}
                    {t.status === 'PLANNED' && can('hr.career.approve') && t.createdBy !== me?.id && <Button onClick={() => act.mutate({ id: t.id, action: 'approve' })}>Approve</Button>}
                    {t.status === 'APPROVED' && can('hr.employee.manage') && <Button variant="secondary" onClick={() => act.mutate({ id: t.id, action: 'complete' })}>Mark done</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Modal wide open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit training' : 'Plan training'} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button disabled={save.isPending || !form?.title || !form?.startDate || !form?.endDate || !form?.participantIds.length} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorBox error={save.error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{['TRAINING', 'WORKSHOP', 'MENTORSHIP', 'COACHING'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <Field label="Provider"><Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></Field>
              <Field label="From"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="To"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
              <Field label="Cost"><Input inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
            </div>
            <Field label="Needs it meets" hint="Separate with commas; matching appraisal needs are then marked as planned"><Input value={form.needs} onChange={(e) => setForm({ ...form, needs: e.target.value })} /></Field>
            <p className="text-xs font-semibold uppercase text-muted">Participants</p>
            <div className="grid max-h-48 gap-1 overflow-auto text-sm sm:grid-cols-3">
              {people?.map((p) => (
                <label key={p.id} className="flex items-center gap-2"><input type="checkbox" checked={form.participantIds.includes(p.id)} onChange={(e) => setForm({ ...form, participantIds: e.target.checked ? [...form.participantIds, p.id] : form.participantIds.filter((x) => x !== p.id) })} />{p.name}</label>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
