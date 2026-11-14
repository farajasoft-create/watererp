'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Tabs } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/internalaudit/ui/api';

interface PlanRow { id: string; year: string; title: string; status: string; version: number; itemCount: number; hours: number; availableHours: number; cost: string; decidedAt?: string }
interface Calendar { year: number; months: { month: number; engagements: { id: string; number: string; title: string; status: string }[]; planned: { title: string }[] }[] }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function NewPlan({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const y = new Date().getFullYear() + 1;
  const [f, setF] = useState({ year: String(y), title: `Annual audit plan ${y}`, availableHours: '', fromUniverse: true });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/plans', { ...f, availableHours: Number(f.availableHours) || 0 }),
    onSuccess: (p) => router.push(`/internalaudit/plans/${p.id}`),
  });
  return (
    <Modal open onClose={onClose} title="New annual plan" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || f.title.length < 3}>Create</Button></>}>
      <ErrorBox error={create.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Year" hint="e.g. 2027 or 2026/27"><Input value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /></Field>
        <Field label="Audit team hours available"><Input inputMode="numeric" value={f.availableHours} onChange={(e) => setF({ ...f, availableHours: e.target.value })} /></Field>
        <Field label="Title" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.fromUniverse} onChange={(e) => setF({ ...f, fromUniverse: e.target.checked })} /> Start from the audit universe: every high or critical risk area, and every area due for audit</label>
    </Modal>
  );
}

export default function PlansPage() {
  const can = useCan();
  const [tab, setTab] = useState<'plans' | 'calendar'>('plans');
  const [creating, setCreating] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const plans = useQuery({ queryKey: ['ia-plans'], queryFn: () => api.get<PlanRow[]>('/plans') });
  const cal = useQuery({ queryKey: ['ia-calendar', year], queryFn: () => api.get<Calendar>('/calendar', { year }), enabled: tab === 'calendar' });
  return (
    <>
      <PageHeader title="Annual audit plan" subtitle="The risk-based plan, its approval, and the audit calendar" actions={can('internalaudit.plan.manage') && <Button onClick={() => setCreating(true)}>New plan</Button>} />
      <Tabs tabs={[{ id: 'plans', label: 'Plans' }, { id: 'calendar', label: 'Calendar' }]} value={tab} onChange={setTab} />
      <ErrorBox error={plans.error || cal.error} />
      {tab === 'plans' && (
        <Card padded={false}>
          {plans.isLoading ? <Loading /> : !plans.data?.length ? <Empty>No plans yet.</Empty> : (
            <table className="table-base">
              <thead><tr><th>Year</th><th>Plan</th><th>Status</th><th className="num">Audits</th><th className="num">Hours</th><th className="num">Cost (KES)</th><th>Decided</th></tr></thead>
              <tbody>
                {plans.data.map((p) => (
                  <tr key={p.id}>
                    <td>{p.year}{p.version > 1 && <span className="text-xs text-muted"> v{p.version}</span>}</td>
                    <td><Link href={`/internalaudit/plans/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.title}</Link></td>
                    <td><Badge value={p.status} /></td>
                    <td className="num">{p.itemCount}</td>
                    <td className="num">{p.hours}{p.availableHours ? ` / ${p.availableHours}` : ''}</td>
                    <td className="num"><Money value={p.cost} /></td>
                    <td>{p.decidedAt ? fmtDate(p.decidedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'calendar' && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Button variant="secondary" onClick={() => setYear(year - 1)}>←</Button>
            <span className="font-medium">{year}</span>
            <Button variant="secondary" onClick={() => setYear(year + 1)}>→</Button>
          </div>
          {cal.isLoading ? <Loading /> : cal.data && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {cal.data.months.map((m) => (
                <Card key={m.month} title={MONTHS[m.month - 1]}>
                  {!m.engagements.length && !m.planned.length ? <p className="text-sm text-muted">Nothing.</p> : (
                    <ul className="space-y-1 text-sm">
                      {m.engagements.map((e) => <li key={e.id}><Link href={`/internalaudit/engagements/${e.id}`} className="text-brand-700 hover:underline">{e.number}</Link> {e.title} <Badge value={e.status} /></li>)}
                      {m.planned.map((p, i) => <li key={i} className="text-muted">Planned: {p.title}</li>)}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {creating && <NewPlan onClose={() => setCreating(false)} />}
    </>
  );
}
