'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader } from '@/components/ui';
import { useCan } from '@/lib/session';
import { api } from '@/modules/bi/ui/api';
import { Dataset, Runner, Spec, SpecEditor } from '@/modules/bi/ui/builder';
import { ChartType } from '@/modules/bi/ui/charts';

interface Saved { id: string; name: string; description?: string; folder?: string; spec: Spec; chart: ChartType; mine: boolean }

function Builder({ datasets, existing }: { datasets: Dataset[]; existing?: Saved }) {
  const can = useCan();
  const router = useRouter();
  const [spec, setSpec] = useState<Spec>(existing?.spec ?? { dataset: '', filters: [] });
  const [chart, setChart] = useState<ChartType>(existing?.chart ?? 'table');
  const [ran, setRan] = useState<Spec | null>(existing?.spec ?? null);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState({ name: existing?.name ?? '', folder: existing?.folder ?? 'General', description: existing?.description ?? '', note: '' });
  const update = Boolean(existing?.mine);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: meta.name, folder: meta.folder || undefined, description: meta.description || undefined, note: meta.note || undefined, spec, chart };
      return update ? api.put<{ id: string }>(`/reports/${existing!.id}`, body) : api.post<{ id: string }>('/reports', body);
    },
    onSuccess: (r) => router.push(`/bi/reports/${r.id}`),
  });
  return (
    <>
      <PageHeader title={existing ? `Edit: ${existing.name}` : 'Report builder'} subtitle="Pick the data, filter it, group it, and show it as a table, chart or cross-tab" actions={can('bi.build') && <Button onClick={() => setSaving(true)} disabled={!spec.dataset}>{update ? 'Save changes' : 'Save as report'}</Button>} />
      {!datasets.length ? (
        <Card><p className="text-sm text-muted">You have no data to report on. Reports cover the modules you have a role in.</p></Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
          <Card title="Report">
            <SpecEditor spec={spec} setSpec={setSpec} datasets={datasets} />
            <div className="mt-4"><Button onClick={() => setRan(spec)} disabled={!spec.dataset}>Run</Button></div>
          </Card>
          {ran ? <Runner spec={ran} chart={chart} setChart={setChart} title={meta.name || 'Report'} /> : <Card><p className="text-sm text-muted">Choose the data and press Run.</p></Card>}
        </div>
      )}
      {saving && (
        <Modal open onClose={() => setSaving(false)} title={update ? 'Save changes' : 'Save report'} footer={<><Button variant="secondary" onClick={() => setSaving(false)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || meta.name.trim().length < 2}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></Field>
            <Field label="Folder"><Input value={meta.folder} onChange={(e) => setMeta({ ...meta, folder: e.target.value })} placeholder="Commercial" /></Field>
            <Field label="Description" className="sm:col-span-2"><Input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field>
            {update && <Field label="What changed" className="sm:col-span-2" hint="Kept with the earlier version, which you can roll back to"><Input value={meta.note} onChange={(e) => setMeta({ ...meta, note: e.target.value })} /></Field>}
          </div>
          <p className="text-xs text-muted">The report is saved with what is set on the left ({spec.dataset || 'no data chosen'}), shown as {chart}.</p>
        </Modal>
      )}
    </>
  );
}

function Explore() {
  const reportId = useSearchParams().get('report');
  const datasets = useQuery({ queryKey: ['bi-datasets'], queryFn: () => api.get<Dataset[]>('/datasets') });
  const existing = useQuery({ queryKey: ['bi-report', reportId], queryFn: () => api.get<Saved>(`/reports/${reportId}`), enabled: Boolean(reportId) });
  if (datasets.isLoading || (reportId && existing.isLoading)) return <Loading />;
  if (!datasets.data) return <ErrorBox error={datasets.error} />;
  return (
    <>
      <ErrorBox error={existing.error} />
      <Builder key={existing.data?.id ?? 'new'} datasets={datasets.data} existing={existing.data} />
    </>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Explore />
    </Suspense>
  );
}
