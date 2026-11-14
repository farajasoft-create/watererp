'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { Badge, Card, ErrorBox, Input, Select } from '@/components/ui';
import { label } from '@/lib/format';

interface Library { organisation: string; branding: Branding; items: { id: string; title: string; author?: string; category: string; year?: number; summary?: string; tags: string[]; url?: string; hasFile: boolean }[] }
const CATS = ['POLICY', 'REPORT', 'STRATEGIC_PLAN', 'TARIFF', 'TENDER', 'MANUAL', 'PUBLICATION', 'FORM', 'RESEARCH', 'OTHER'];

/** The public e-library: published documents anyone can search and open. */
export default function PublicLibraryPage() {
  const { org } = useParams<{ org: string }>();
  const [q, setQ] = useState({ search: '', category: '' });
  const { data, error, isLoading } = useQuery({
    queryKey: ['library', org, q],
    queryFn: async () => {
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
      const res = await fetch(`/api/v1/portals/public/${org}/library?${params}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? 'The library is not available');
      return body as Library;
    },
  });
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="E-library" branding={data?.branding}>
      <ErrorBox error={error} />
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search titles, authors, subjects" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="max-w-sm" />
        <Select value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })} className="max-w-48"><option value="">All kinds</option>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
      </div>
      {isLoading ? <p className="text-sm text-muted">Loading…</p> : !data?.items.length ? <Card><p className="text-sm text-muted">Nothing found.</p></Card> : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.items.map((i) => (
            <Card key={i.id}>
              <a href={`/api/v1/portals/public/${org}/library/${i.id}`} target="_blank" rel="noreferrer" className="font-medium hover:underline" style={{ color: 'var(--portal-accent)' }}>{i.title}</a>
              <div className="text-xs text-muted">{[i.author, i.year, label(i.category)].filter(Boolean).join(' · ')}</div>
              {i.summary && <p className="mt-1 text-sm">{i.summary}</p>}
              <div className="mt-1 flex flex-wrap gap-1">{i.tags.map((t) => <Badge key={t} tone="gray">{t}</Badge>)}</div>
            </Card>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
