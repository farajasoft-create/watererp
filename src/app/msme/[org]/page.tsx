'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Tabs, Textarea } from '@/components/ui';
import { fmtMoney, label } from '@/lib/format';

interface Catalogue { organisation: string; branding: Branding; businesses: { id: string; businessName: string; sector: string; location?: string; phone: string; email?: string; agpo: string; description?: string; products: { id: string; name: string; description?: string; price?: string | null; unit?: string }[] }[] }
const SECTORS = ['AGRICULTURE', 'MANUFACTURING', 'CONSTRUCTION', 'TRADE', 'SERVICES', 'ICT', 'TRANSPORT', 'HOSPITALITY', 'OTHER'];

/** The MSME products portal: approved local businesses and what they sell, and registration. */
export default function MsmePortalPage() {
  const { org } = useParams<{ org: string }>();
  const [tab, setTab] = useState<'browse' | 'register'>('browse');
  const [q, setQ] = useState({ search: '', sector: '', agpo: '' });
  const { data, error } = useQuery({
    queryKey: ['msme', org, q],
    queryFn: async () => {
      const res = await fetch(`/api/v1/portals/public/${org}/msmes?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? 'The portal is not available');
      return body as Catalogue;
    },
  });
  const [f, setF] = useState({ businessName: '', ownerName: '', phone: '', email: '', sector: 'TRADE', location: '', kraPin: '', registrationNo: '', agpo: 'NONE', agpoCertificate: '', description: '' });
  const [products, setProducts] = useState([{ name: '', description: '', price: '', unit: '' }]);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const register = async () => {
    setFailure(null);
    const res = await fetch(`/api/v1/portals/public/${org}/msmes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || undefined])), businessName: f.businessName, ownerName: f.ownerName, phone: f.phone, sector: f.sector, agpo: f.agpo, products: products.filter((p) => p.name).map((p) => ({ name: p.name, description: p.description || undefined, price: p.price || null, unit: p.unit || undefined })) }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) setFailure(new Error(body?.errors?.[0]?.message ?? body?.message ?? 'Something went wrong'));
    else setSent(body.reference);
  };
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="MSME products portal" branding={data?.branding}>
      <ErrorBox error={error} />
      <Tabs tabs={[{ id: 'browse', label: 'Browse businesses' }, { id: 'register', label: 'Register your business' }]} value={tab} onChange={setTab} />
      {tab === 'browse' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Product, business or place" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="max-w-sm" />
            <Select value={q.sector} onChange={(e) => setQ({ ...q, sector: e.target.value })} className="max-w-48"><option value="">All sectors</option>{SECTORS.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
            <Select value={q.agpo} onChange={(e) => setQ({ ...q, agpo: e.target.value })} className="max-w-48"><option value="">Any ownership</option><option value="YOUTH">Youth (AGPO)</option><option value="WOMEN">Women (AGPO)</option><option value="PWD">Persons with disability (AGPO)</option></Select>
          </div>
          {!data?.businesses.length ? <Card><p className="text-sm text-muted">No businesses listed yet.</p></Card> : (
            <div className="grid gap-3 md:grid-cols-2">
              {data.businesses.map((b) => (
                <Card key={b.id} title={b.businessName}>
                  <p className="text-xs text-muted">{label(b.sector)}{b.location && ` · ${b.location}`} {b.agpo !== 'NONE' && <Badge tone="green">AGPO {b.agpo.toLowerCase()}</Badge>}</p>
                  {b.description && <p className="mt-1 text-sm">{b.description}</p>}
                  {b.products.length > 0 && <ul className="mt-2 space-y-0.5 text-sm">{b.products.map((p) => <li key={p.id}>{p.name}{p.price && <span className="text-muted"> · KES {fmtMoney(Number(p.price))}{p.unit && ` per ${p.unit}`}</span>}</li>)}</ul>}
                  <p className="mt-2 text-sm"><a href={`tel:${b.phone}`} style={{ color: 'var(--portal-accent)' }}>{b.phone}</a>{b.email && <> · <a href={`mailto:${b.email}`} style={{ color: 'var(--portal-accent)' }}>{b.email}</a></>}</p>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'register' && (
        <Card title="Register your business">
          {sent ? <Notice tone="green">Thank you. Your reference is {sent}; we will text you once the listing is approved, with a link to keep your products up to date.</Notice> : (
            <div className="space-y-3">
              <ErrorBox error={failure} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Business name"><Input value={f.businessName} onChange={t('businessName')} /></Field>
                <Field label="Owner"><Input value={f.ownerName} onChange={t('ownerName')} /></Field>
                <Field label="Phone"><Input value={f.phone} onChange={t('phone')} /></Field>
                <Field label="Email"><Input value={f.email} onChange={t('email')} /></Field>
                <Field label="Sector"><Select value={f.sector} onChange={t('sector')}>{SECTORS.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
                <Field label="Location"><Input value={f.location} onChange={t('location')} /></Field>
                <Field label="KRA PIN"><Input value={f.kraPin} onChange={t('kraPin')} /></Field>
                <Field label="Business registration number"><Input value={f.registrationNo} onChange={t('registrationNo')} /></Field>
                <Field label="AGPO group"><Select value={f.agpo} onChange={t('agpo')}><option value="NONE">None</option><option value="YOUTH">Youth</option><option value="WOMEN">Women</option><option value="PWD">Persons with disability</option></Select></Field>
                {f.agpo !== 'NONE' && <Field label="AGPO certificate number"><Input value={f.agpoCertificate} onChange={t('agpoCertificate')} /></Field>}
              </div>
              <Field label="What you do"><Textarea rows={3} value={f.description} onChange={t('description')} /></Field>
              <div className="space-y-2">
                <div className="text-sm font-medium">Products and services</div>
                {products.map((p, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr]">
                    <Input placeholder="Product" value={p.name} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <Input placeholder="Description" value={p.description} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <Input placeholder="Price" value={p.price} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                    <Input placeholder="Per (unit)" value={p.unit} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
                  </div>
                ))}
                <Button variant="secondary" onClick={() => setProducts([...products, { name: '', description: '', price: '', unit: '' }])}>Add a product</Button>
              </div>
              <Button onClick={register} disabled={f.businessName.length < 2 || f.ownerName.length < 2 || f.phone.length < 9}>Register</Button>
            </div>
          )}
        </Card>
      )}
    </PortalShell>
  );
}
