'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, Textarea } from '@/components/ui';
import { useMe } from '@/lib/session';
import { api } from '@/modules/portals/ui/api';

interface Setting { portal: string; enabled: boolean; title: string; welcome: string; accent: string; logoUrl: string; contactEmail: string; contactPhone: string; footer: string }

const NAMES: Record<string, { name: string; path: (code: string) => string | null; how: string }> = {
  jobs: { name: 'Jobs and applicant accounts', path: (c) => `/jobs/${c}`, how: 'Public: vacancies, applicant accounts with two-step codes, applications.' },
  customers: { name: 'Water customer portal', path: (c) => `/portal/${c}`, how: 'Customers sign in with their account number and a texted code.' },
  vendors: { name: 'Vendor portal', path: () => null, how: 'Each supplier gets a private link from their supplier page in Finance.' },
  tenants: { name: 'Tenant portal', path: () => null, how: 'Each tenant gets a private link from Estates.' },
  donors: { name: 'Donor portal', path: () => null, how: 'Each donor gets a private link from Projects → Grants and donors.' },
  library: { name: 'E-library', path: (c) => `/library/${c}`, how: 'Public: items marked for the public.' },
  msme: { name: 'MSME products portal', path: (c) => `/msme/${c}`, how: 'Public: approved businesses and their products; registration.' },
  tenders: { name: 'Tenders portal', path: (c) => `/tender-notices/${c}`, how: 'Public: open tenders with documents, addenda and answers; sealed online bids; award notices.' },
};

function PortalCard({ s }: { s: Setting }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [f, setF] = useState(s);
  const save = useMutation({ mutationFn: () => api.put(`/settings/${s.portal}`, { enabled: f.enabled, title: f.title, welcome: f.welcome, accent: f.accent, logoUrl: f.logoUrl, contactEmail: f.contactEmail, contactPhone: f.contactPhone, footer: f.footer }), onSuccess: () => qc.invalidateQueries({ queryKey: ['portals-settings'] }) });
  const meta = NAMES[s.portal];
  const code = me?.organisation?.code?.toLowerCase();
  const path = code ? meta.path(code) : null;
  const t = (k: keyof Setting) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title={<span style={{ color: f.accent }}>{meta.name}</span>} actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <p className="mb-2 text-xs text-muted">{meta.how}{path && <> Address: <a href={path} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{path}</a></>}</p>
      <label className="mb-2 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Open</label>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Title"><Input value={f.title} onChange={t('title')} placeholder={meta.name} /></Field>
        <Field label="Colour"><div className="flex gap-2"><input type="color" value={f.accent} onChange={t('accent')} className="h-9 w-12" /><Input value={f.accent} onChange={t('accent')} /></div></Field>
        <Field label="Logo (https address)" className="sm:col-span-2"><Input value={f.logoUrl} onChange={t('logoUrl')} /></Field>
        <Field label="Welcome text" className="sm:col-span-2"><Textarea rows={2} value={f.welcome} onChange={t('welcome')} /></Field>
        <Field label="Contact email"><Input value={f.contactEmail} onChange={t('contactEmail')} /></Field>
        <Field label="Contact phone"><Input value={f.contactPhone} onChange={t('contactPhone')} /></Field>
        <Field label="Footer" className="sm:col-span-2"><Input value={f.footer} onChange={t('footer')} /></Field>
      </div>
    </Card>
  );
}

export default function PortalSettingsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['portals-settings'], queryFn: () => api.get<Setting[]>('/settings') });
  return (
    <>
      <PageHeader title="Portal settings" subtitle="Each public portal has its own look, wording and contacts, and can be opened or closed on its own; each keeps its own sign-in and approval steps." />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <div className="grid gap-4 lg:grid-cols-2">{data?.map((s) => <PortalCard key={s.portal} s={s} />)}</div>}
    </>
  );
}
