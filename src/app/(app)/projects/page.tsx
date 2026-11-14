'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select, Stat, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/projects/ui/api';
import { Progress } from '@/modules/projects/ui/shared';

interface ProjectRow { id: string; code: string; name: string; kind: string; status: string; financeCode: string; startDate?: string; endDate?: string; position: { financeLinked: boolean; budget: string; spent: string; wip: string; spentPct: number | null; physicalPct: number | null; timeElapsedPct: number | null; kpiAttainmentPct: number | null } }
interface Dashboard { grants: { count: number; committed: string; received: string; spent: string; behind: string[] }; projects: { count: number; active: number; budget: string; spent: string; capex: string; wip: string; overBudget: string[] }; byDonor: { donor: string; committed: string; received: string; spent: string }[] }
interface GrantOption { id: string; code: string; title: string }

function NewProject({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: ['projects-grants'], queryFn: () => api.get<GrantOption[]>('/grants') });
  const people = useDirectory();
  const [f, setF] = useState({ code: '', name: '', description: '', kind: 'CAPEX', financeCode: '', grantIds: [] as string[], budget: '', startDate: '', endDate: '', location: '', managerId: '' });
  const save = useMutation({
    mutationFn: () => api.post('/projects', { ...f, description: f.description || undefined, location: f.location || undefined, startDate: f.startDate || null, endDate: f.endDate || null, managerId: f.managerId || null, budget: f.budget || '0' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects-list'] }); onClose(); },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title="New project" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || f.name.length < 3 || !f.financeCode}>Save</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code"><Input value={f.code} onChange={t('code')} /></Field>
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={t('name')} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={t('kind')}><option value="CAPEX">Capital works</option><option value="OPEX">Programme (operating)</option><option value="MIXED">Mixed</option></Select></Field>
        <Field label="Finance project code" hint="The PROJECT dimension postings are tagged with"><Input value={f.financeCode} onChange={(e) => setF({ ...f, financeCode: e.target.value.toUpperCase() })} /></Field>
        <Field label="Budget (KES)"><Input inputMode="decimal" value={f.budget} onChange={t('budget')} /></Field>
        <Field label="Starts"><Input type="date" value={f.startDate} onChange={t('startDate')} /></Field>
        <Field label="Ends"><Input type="date" value={f.endDate} onChange={t('endDate')} /></Field>
        <Field label="Project manager"><Select value={f.managerId} onChange={t('managerId')}><option value="">—</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Location" className="sm:col-span-3"><Input value={f.location} onChange={t('location')} /></Field>
        <Field label="Description" className="sm:col-span-3"><Textarea rows={2} value={f.description} onChange={t('description')} /></Field>
      </div>
      <Field label="Funded by">
        <div className="flex flex-wrap gap-3 text-sm">
          {grants.data?.map((g) => <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={f.grantIds.includes(g.id)} onChange={(e) => setF({ ...f, grantIds: e.target.checked ? [...f.grantIds, g.id] : f.grantIds.filter((x) => x !== g.id) })} /> {g.code} · {g.title}</label>)}
          {!grants.data?.length && <span className="text-muted">No grants yet (own funds).</span>}
        </div>
      </Field>
    </Modal>
  );
}

export default function ProjectsPage() {
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const dash = useQuery({ queryKey: ['projects-dashboard'], queryFn: () => api.get<Dashboard>('/dashboard') });
  const { data, error, isLoading } = useQuery({ queryKey: ['projects-list'], queryFn: () => api.get<ProjectRow[]>('/projects') });
  const d = dash.data;
  return (
    <>
      <PageHeader title="Projects" subtitle="Capital works and donor-funded programmes, with spending read live from the ledger" actions={can('projects.manage') && <Button onClick={() => setCreating(true)}>New project</Button>} />
      <ErrorBox error={error || dash.error} />
      {d && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Active projects" value={`${d.projects.active} of ${d.projects.count}`} />
          <Stat label="Project budgets" value={<Money value={d.projects.budget} />} />
          <Stat label="Spent" value={<Money value={d.projects.spent} />} hint={d.projects.overBudget.length ? `over budget: ${d.projects.overBudget.join(', ')}` : undefined} tone={d.projects.overBudget.length ? 'bad' : undefined} />
          <Stat label="Work in progress" value={<Money value={d.projects.wip} />} hint="capital spent, not yet capitalised" />
          <Stat label="Donor funds committed" value={<Money value={d.grants.committed} />} hint={`${d.grants.count} grants`} />
          <Stat label="Donor funds received / spent" value={<><Money value={d.grants.received} /> / <Money value={d.grants.spent} /></>} hint={d.grants.behind.length ? `behind: ${d.grants.behind.join(', ')}` : undefined} tone={d.grants.behind.length ? 'warn' : undefined} />
        </div>
      )}
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No projects yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Project</th><th>Kind</th><th>Status</th><th>Dates</th><th className="num">Budget</th><th className="num">Spent</th><th>Spent %</th><th>Physical</th><th>Time used</th><th>KPIs</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.code}</Link> {p.name}{!p.position.financeLinked && <div className="text-xs text-amber-800">No finance project {p.financeCode} yet</div>}</td>
                    <td>{label(p.kind)}</td>
                    <td><Badge value={p.status} /></td>
                    <td>{p.startDate ? `${fmtDate(p.startDate)} – ${fmtDate(p.endDate ?? null)}` : '—'}</td>
                    <td className="num"><Money value={p.position.budget} /></td>
                    <td className="num"><Money value={p.position.spent} /></td>
                    <td><Progress value={p.position.spentPct} /></td>
                    <td><Progress value={p.position.physicalPct} against={p.position.timeElapsedPct} /></td>
                    <td><Progress value={p.position.timeElapsedPct} /></td>
                    <td>{p.position.kpiAttainmentPct === null ? '—' : `${p.position.kpiAttainmentPct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </>
  );
}
