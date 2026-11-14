'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { downloadCsv } from './report-filters';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Select, TableWrap, Tabs } from './ui';

const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'UNSERVICEABLE'] as const;
const SOURCES = [
  ['PURCHASED', 'Purchased'],
  ['DONATED', 'Donated / grant'],
  ['CONSTRUCTED', 'Constructed'],
  ['TRANSFERRED_IN', 'Transferred in'],
] as const;
const KINDS = [
  ['SERVICE', 'Service'],
  ['REPAIR', 'Repair'],
  ['INSPECTION', 'Inspection'],
  ['INSURANCE_CLAIM', 'Insurance claim'],
] as const;
const positive = /^\d*(\.\d*)?$/;
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : '');

export interface AssetCare {
  id: string;
  number: string;
  entityId: string;
  status: string;
  tagNumber: string;
  custodian: string;
  condition: string;
  acquisitionType: string;
  donor: string;
  supplierName: string;
  makeModel?: string;
  pvNumber?: string;
  deliveryDate?: string | null;
  warranty?: { provider: string; expiresOn: string | null; terms: string };
  insurance?: { insurer: string; policyNumber: string; sumInsured: string | null; premium: string | null; startsOn: string | null; expiresOn: string | null };
  maintenance: { id: string; date: string; kind: string; description: string; vendor: string; cost: string; invoiceId: string | null; invoiceNumber: string; nextDue: string | null }[];
  lastVerified?: { date: string | null; byName: string; location: string; condition: string };
}

/** Opens the label sheet for one or more assets (a PDF in a new tab). */
export function printLabels(entityId: string, opts: { ids?: string[]; location?: string; skip?: number } = {}) {
  const q = new URLSearchParams({ entityId });
  if (opts.ids?.length) q.set('ids', opts.ids.join(','));
  if (opts.location) q.set('location', opts.location);
  if (opts.skip) q.set('skip', String(opts.skip));
  window.open(`/api/v1/finance/assets/labels?${q}`, '_blank', 'noopener');
}

const expiryBadge = (d: string | null | undefined) => {
  if (!d) return null;
  const days = Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <Badge tone="red">lapsed</Badge>;
  if (days <= 60) return <Badge tone="amber">{days} days left</Badge>;
  return null;
};

/** Tag, custody, condition, source, warranty, insurance and the maintenance log of one asset. */
export function AssetCareCards({ asset, currency }: { asset: AssetCare; currency?: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const precision = usePrecision();
  const fp = precision(currency);
  const manage = can('assets.manage') && asset.status !== 'DISPOSED';
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = asset.warranty;
  const ins = asset.insurance;
  const blank = () => ({
    tagNumber: asset.tagNumber || asset.number,
    custodian: asset.custodian,
    condition: asset.condition,
    acquisitionType: asset.acquisitionType,
    donor: asset.donor,
    supplierName: asset.supplierName,
    makeModel: asset.makeModel ?? '',
    pvNumber: asset.pvNumber ?? '',
    deliveryDate: day(asset.deliveryDate),
    wProvider: w?.provider ?? '',
    wExpires: day(w?.expiresOn),
    wTerms: w?.terms ?? '',
    insurer: ins?.insurer ?? '',
    policyNumber: ins?.policyNumber ?? '',
    sumInsured: ins?.sumInsured ?? '',
    premium: ins?.premium ?? '',
    iStarts: day(ins?.startsOn),
    iExpires: day(ins?.expiresOn),
  });
  const [f, setF] = useState(blank);
  const [m, setM] = useState({ date: today(), kind: 'SERVICE', description: '', vendor: '', cost: '', invoiceId: '', nextDue: '' });
  const bills = useQuery({
    queryKey: ['asset-bills', asset.entityId],
    queryFn: () => api.get<{ items: { id: string; number: string; partyName: string; date: string; subtotal: string }[] }>('/invoices', { kind: 'PURCHASE_BILL', entityId: asset.entityId, status: 'POSTED', pageSize: 100 }),
    enabled: adding,
  });
  const done = () => (setError(null), qc.invalidateQueries({ queryKey: ['asset', asset.id] }));
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/assets/${asset.id}`, {
        tagNumber: f.tagNumber,
        details: {
          custodian: f.custodian,
          condition: f.condition,
          acquisitionType: f.acquisitionType,
          donor: f.acquisitionType === 'DONATED' ? f.donor : '',
          supplierName: f.supplierName,
          makeModel: f.makeModel,
          pvNumber: f.pvNumber,
          deliveryDate: f.deliveryDate || null,
          warranty: { provider: f.wProvider, expiresOn: f.wExpires || null, terms: f.wTerms },
          insurance: { insurer: f.insurer, policyNumber: f.policyNumber, sumInsured: f.sumInsured || null, premium: f.premium || null, startsOn: f.iStarts || null, expiresOn: f.iExpires || null },
        },
      }),
    onSuccess: () => (setEditing(false), done()),
    onError: (e) => setError(errorMessage(e)),
  });
  const addEntry = useMutation({
    mutationFn: () => api.post(`/assets/${asset.id}/maintenance`, { date: m.date, kind: m.kind, description: m.description, vendor: m.vendor || undefined, cost: m.cost || '0', invoiceId: m.invoiceId || null, nextDue: m.nextDue || null }),
    onSuccess: () => (setAdding(false), setM({ date: today(), kind: 'SERVICE', description: '', vendor: '', cost: '', invoiceId: '', nextDue: '' }), done()),
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({ mutationFn: (entryId: string) => api.delete(`/assets/${asset.id}/maintenance/${entryId}`), onSuccess: done, onError: (e) => setError(errorMessage(e)) });
  const totalCost = asset.maintenance.reduce((t, x) => t + Number(x.cost), 0);

  const facts: [string, React.ReactNode][] = [
    ['Tag', <span key="t" className="font-mono">{asset.tagNumber || asset.number}</span>],
    ['Custodian', asset.custodian || '—'],
    ['Condition', title(asset.condition)],
    ['Source', `${SOURCES.find(([k]) => k === asset.acquisitionType)?.[1] ?? asset.acquisitionType}${asset.donor ? ` · ${asset.donor}` : ''}${asset.supplierName ? ` · ${asset.supplierName}` : ''}`],
    ['Make and model', asset.makeModel || '—'],
    ['PV / LPO number', asset.pvNumber || '—'],
    ['Delivered', asset.deliveryDate ? formatDate(asset.deliveryDate) : '—'],
    ['Last verified', asset.lastVerified?.date ? `${formatDate(asset.lastVerified.date)} by ${asset.lastVerified.byName}${asset.lastVerified.location ? ` at ${asset.lastVerified.location}` : ''}` : 'Never'],
  ];
  return (
    <>
      <ErrorBanner error={error} className="mt-4" />
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card
          title="Tag and custody"
          actions={
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => printLabels(asset.entityId, { ids: [asset.id] })}>Label</Button>
              {manage && <Button size="sm" variant="ghost" onClick={() => (setF(blank()), setError(null), setEditing(true))}>Edit</Button>}
            </div>
          }
        >
          <dl className="space-y-1 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>
            ))}
          </dl>
        </Card>
        <Card title="Warranty">
          {w?.provider || w?.expiresOn ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Provider</dt><dd>{w.provider || '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Expires</dt><dd>{formatDate(w.expiresOn) || '—'} {expiryBadge(w.expiresOn)}</dd></div>
              {w.terms && <p className="text-xs text-muted">{w.terms}</p>}
            </dl>
          ) : (
            <p className="text-sm text-muted">No warranty recorded.</p>
          )}
        </Card>
        <Card title="Insurance">
          {ins?.policyNumber ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Insurer</dt><dd>{ins.insurer || '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Policy</dt><dd className="font-mono text-xs">{ins.policyNumber}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Sum insured</dt><dd className="tabular-nums">{ins.sumInsured ? formatAmount(ins.sumInsured, fp) : '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Premium</dt><dd className="tabular-nums">{ins.premium ? formatAmount(ins.premium, fp) : '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Cover</dt><dd>{formatDate(ins.startsOn)} – {formatDate(ins.expiresOn)} {expiryBadge(ins.expiresOn)}</dd></div>
            </dl>
          ) : (
            <Notice tone="amber">Not insured. Record the policy so lapses are flagged.</Notice>
          )}
        </Card>
      </div>
      <Card title={`Maintenance${asset.maintenance.length ? ` · ${formatAmount(String(totalCost), fp)} to date` : ''}`} className="mt-4" padded={false} actions={manage && <Button size="sm" onClick={() => (setError(null), setAdding(true))}>Record maintenance</Button>}>
        {!asset.maintenance.length ? (
          <p className="p-4 text-sm text-muted">No servicing or repairs recorded.</p>
        ) : (
          <table className="table-base">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Work done</th><th>By</th><th>Bill</th><th>Next due</th><th className="num">Cost</th><th /></tr>
            </thead>
            <tbody>
              {[...asset.maintenance].reverse().map((x) => (
                <tr key={x.id}>
                  <td>{formatDate(x.date)}</td>
                  <td>{title(x.kind)}</td>
                  <td>{x.description}</td>
                  <td className="text-muted">{x.vendor}</td>
                  <td className="font-mono text-xs">{x.invoiceId ? <Link className="text-brand-700 hover:underline" href={`/finance/bills/${x.invoiceId}`}>{x.invoiceNumber}</Link> : '—'}</td>
                  <td>{formatDate(x.nextDue) || '—'}</td>
                  <td className="num">{formatAmount(x.cost, fp)}</td>
                  <td className="text-right">{manage && <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === x.id} onClick={() => remove.mutate(x.id)}>Remove</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal wide open={editing} onClose={() => setEditing(false)} title={`Details of ${asset.number}`} footer={<><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tag number" hint="Printed on the QR label"><Input value={f.tagNumber} onChange={(e) => setF({ ...f, tagNumber: e.target.value.toUpperCase() })} /></Field>
            <Field label="Custodian"><Input value={f.custodian} onChange={(e) => setF({ ...f, custodian: e.target.value })} /></Field>
            <Field label="Condition">
              <Select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c} value={c}>{title(c)}</option>)}</Select>
            </Field>
            <Field label="Source">
              <Select value={f.acquisitionType} onChange={(e) => setF({ ...f, acquisitionType: e.target.value })}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
            {f.acquisitionType === 'DONATED' && <Field label="Donor"><Input value={f.donor} onChange={(e) => setF({ ...f, donor: e.target.value })} /></Field>}
            <Field label="Supplier / manufacturer"><Input value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} /></Field>
            <Field label="Make and model"><Input value={f.makeModel} onChange={(e) => setF({ ...f, makeModel: e.target.value })} /></Field>
            <Field label="PV / LPO number"><Input value={f.pvNumber} onChange={(e) => setF({ ...f, pvNumber: e.target.value })} /></Field>
            <Field label="Date delivered"><Input type="date" value={f.deliveryDate} onChange={(e) => setF({ ...f, deliveryDate: e.target.value })} /></Field>
          </div>
          <p className="pt-2 text-xs font-semibold uppercase text-muted">Warranty</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Provider"><Input value={f.wProvider} onChange={(e) => setF({ ...f, wProvider: e.target.value })} /></Field>
            <Field label="Expires on"><Input type="date" value={f.wExpires} onChange={(e) => setF({ ...f, wExpires: e.target.value })} /></Field>
            <Field label="Terms"><Input value={f.wTerms} onChange={(e) => setF({ ...f, wTerms: e.target.value })} /></Field>
          </div>
          <p className="pt-2 text-xs font-semibold uppercase text-muted">Insurance</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Insurer"><Input value={f.insurer} onChange={(e) => setF({ ...f, insurer: e.target.value })} /></Field>
            <Field label="Policy number"><Input value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value })} /></Field>
            <Field label="Sum insured"><Input inputMode="decimal" value={f.sumInsured} onChange={(e) => positive.test(e.target.value) && setF({ ...f, sumInsured: e.target.value })} /></Field>
            <Field label="Premium"><Input inputMode="decimal" value={f.premium} onChange={(e) => positive.test(e.target.value) && setF({ ...f, premium: e.target.value })} /></Field>
            <Field label="Cover starts"><Input type="date" value={f.iStarts} onChange={(e) => setF({ ...f, iStarts: e.target.value })} /></Field>
            <Field label="Cover ends"><Input type="date" value={f.iExpires} onChange={(e) => setF({ ...f, iExpires: e.target.value })} /></Field>
          </div>
        </div>
      </Modal>

      <Modal wide open={adding} onClose={() => setAdding(false)} title={`Maintenance on ${asset.number}`} footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={addEntry.isPending} onClick={() => addEntry.mutate()}>Record</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date"><Input type="date" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
            <Field label="Next service due"><Input type="date" value={m.nextDue} onChange={(e) => setM({ ...m, nextDue: e.target.value })} /></Field>
            <Field label="Work done" className="sm:col-span-3"><Input value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></Field>
            <Field label="Supplier bill" hint="Links the cost to what was posted" className="sm:col-span-2">
              <Select value={m.invoiceId} onChange={(e) => {
                const b = bills.data?.items.find((x) => x.id === e.target.value);
                setM({ ...m, invoiceId: e.target.value, ...(b && { vendor: b.partyName, cost: m.cost || b.subtotal }) });
              }}>
                <option value="">None (done in-house or not billed yet)</option>
                {bills.data?.items.map((b) => <option key={b.id} value={b.id}>{b.number} · {b.partyName} · {formatDate(b.date)} · {formatAmount(b.subtotal, fp)}</option>)}
              </Select>
            </Field>
            <Field label="Cost"><Input inputMode="decimal" value={m.cost} onChange={(e) => positive.test(e.target.value) && setM({ ...m, cost: e.target.value })} /></Field>
            <Field label="Done by" className="sm:col-span-3"><Input value={m.vendor} onChange={(e) => setM({ ...m, vendor: e.target.value })} /></Field>
          </div>
        </div>
      </Modal>
    </>
  );
}

interface CareRow { id: string; number: string; tagNumber: string; name: string; location: string; custodian: string }
interface CareReport {
  warranty: (CareRow & { provider: string; expiresOn: string; days: number })[];
  insurance: (CareRow & { insurer: string; policyNumber: string; sumInsured: string | null; expiresOn: string; days: number })[];
  uninsured: (CareRow & { cost: string })[];
  serviceDue: (CareRow & { lastService: string; nextDue: string; days: number })[];
  unverified: (CareRow & { lastVerified: string | null })[];
  maintenanceCostThisYear: string;
}

const dueText = (days: number) => (days < 0 ? <span className="text-red-700">{-days} days ago</span> : <span>in {days} days</span>);

/** Cover about to lapse, services due, verification by scanning tags, and label printing. */
export function AssetCarePage() {
  const { entity } = useSession();
  const precision = usePrecision();
  const fp = precision(entity?.functionalCurrency);
  const [days, setDays] = useState('60');
  const [tab, setTab] = useState<'insurance' | 'warranty' | 'service' | 'uninsured' | 'unverified'>('insurance');
  const [scan, setScan] = useState({ tag: '', location: '', condition: '' });
  const [labelOpts, setLabelOpts] = useState({ location: '', skip: '' });
  const [verified, setVerified] = useState<null | { asset: { id: string; number: string; name: string; location: string }; moved: boolean; previousLocation: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['asset-care', entity?.id, days], queryFn: () => api.get<CareReport>('/assets/care', { entityId: entity!.id, days: days || '0' }), enabled: !!entity });
  const verify = useMutation({
    mutationFn: () => api.post<NonNullable<typeof verified>>('/assets/verify', { tag: scan.tag, location: scan.location || undefined, condition: scan.condition || undefined }),
    onSuccess: (r) => (setVerified(r), setError(null), setScan({ ...scan, tag: '' }), qc.invalidateQueries({ queryKey: ['asset-care'] })),
    onError: (e) => (setVerified(null), setError(errorMessage(e))),
  });
  const r = report.data;
  const link = (x: CareRow) => <Link className="font-mono text-xs text-brand-700 hover:underline" href={`/finance/assets/${x.id}`}>{x.tagNumber}</Link>;
  const exportTab = () => {
    if (!r) return;
    const rows: (string | number)[][] = [];
    if (tab === 'insurance') rows.push(['Tag', 'Asset', 'Insurer', 'Policy', 'Sum insured', 'Expires'], ...r.insurance.map((x) => [x.tagNumber, x.name, x.insurer, x.policyNumber, x.sumInsured ?? '', x.expiresOn.slice(0, 10)]));
    if (tab === 'warranty') rows.push(['Tag', 'Asset', 'Provider', 'Expires'], ...r.warranty.map((x) => [x.tagNumber, x.name, x.provider, x.expiresOn.slice(0, 10)]));
    if (tab === 'service') rows.push(['Tag', 'Asset', 'Last service', 'Next due'], ...r.serviceDue.map((x) => [x.tagNumber, x.name, x.lastService.slice(0, 10), x.nextDue.slice(0, 10)]));
    if (tab === 'uninsured') rows.push(['Tag', 'Asset', 'Location', 'Cost'], ...r.uninsured.map((x) => [x.tagNumber, x.name, x.location, x.cost]));
    if (tab === 'unverified') rows.push(['Tag', 'Asset', 'Location', 'Custodian', 'Last verified'], ...r.unverified.map((x) => [x.tagNumber, x.name, x.location, x.custodian, x.lastVerified?.slice(0, 10) ?? 'never']));
    const [header, ...body] = rows;
    downloadCsv(`asset-${tab}.csv`, header.map(String), body);
  };
  return (
    <>
      <PageHeader title="Asset care" description="Insurance and warranties about to lapse, services due, and physical verification by scanning asset tags." actions={<LinkButton href="/finance/assets">Register</LinkButton>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Verify an asset">
          <p className="mb-3 text-sm text-muted">Scan the QR label with a handheld scanner (or type the tag) to confirm the asset is where the register says.</p>
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => (e.preventDefault(), scan.tag && verify.mutate())}>
            <Field label="Tag"><Input autoFocus value={scan.tag} onChange={(e) => setScan({ ...scan, tag: e.target.value.toUpperCase() })} /></Field>
            <Field label="Found at" hint="Blank keeps the register's location"><Input value={scan.location} onChange={(e) => setScan({ ...scan, location: e.target.value })} /></Field>
            <Field label="Condition">
              <Select value={scan.condition} onChange={(e) => setScan({ ...scan, condition: e.target.value })}>
                <option value="">Unchanged</option>
                {CONDITIONS.map((c) => <option key={c} value={c}>{title(c)}</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-3"><Button type="submit" variant="primary" loading={verify.isPending}>Verify</Button></div>
          </form>
          <ErrorBanner error={error} className="mt-3" />
          {verified && (
            <div className="mt-3">
              <Notice tone={verified.moved ? 'amber' : 'green'}>
                <Link className="font-medium hover:underline" href={`/finance/assets/${verified.asset.id}`}>{verified.asset.number} {verified.asset.name}</Link> verified
                {verified.moved ? ` at ${verified.asset.location}; the register said ${verified.previousLocation || 'no location'} and has been updated.` : '.'}
              </Notice>
            </div>
          )}
        </Card>
        <Card title="Print labels">
          <p className="mb-3 text-sm text-muted">A4 sheets of 21 labels (63.5 × 38.1 mm) with a QR code of each tag. Leave location blank for every active asset.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Location starts with" className="sm:col-span-2"><Input value={labelOpts.location} onChange={(e) => setLabelOpts({ ...labelOpts, location: e.target.value })} /></Field>
            <Field label="Skip used labels"><Input inputMode="numeric" value={labelOpts.skip} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setLabelOpts({ ...labelOpts, skip: e.target.value })} /></Field>
          </div>
          <Button className="mt-3" onClick={() => entity && printLabels(entity.id, { location: labelOpts.location || undefined, skip: Number(labelOpts.skip) || undefined })}>Print labels</Button>
        </Card>
      </div>

      <div className="mb-3 mt-6 flex flex-wrap items-end gap-3">
        <Field label="Look ahead (days)"><Input className="w-24" inputMode="numeric" value={days} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDays(e.target.value)} /></Field>
        {r && <p className="pb-2 text-sm text-muted">Maintenance spend this year: <span className="tabular-nums text-ink">{formatAmount(r.maintenanceCostThisYear, fp)}</span></p>}
        <div className="ml-auto"><Button onClick={exportTab} disabled={!r}>Export CSV</Button></div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'insurance', label: `Insurance lapsing (${r?.insurance.length ?? 0})` },
          { id: 'warranty', label: `Warranty ending (${r?.warranty.length ?? 0})` },
          { id: 'service', label: `Service due (${r?.serviceDue.length ?? 0})` },
          { id: 'uninsured', label: `Uninsured (${r?.uninsured.length ?? 0})` },
          { id: 'unverified', label: `Not verified in a year (${r?.unverified.length ?? 0})` },
        ]}
      />
      <TableWrap>
        {!r ? (
          <Loading />
        ) : tab === 'insurance' ? (
          !r.insurance.length ? <Empty title="No cover lapses in this window" /> : (
            <table className="table-base">
              <thead><tr><th>Tag</th><th>Asset</th><th>Insurer</th><th>Policy</th><th className="num">Sum insured</th><th>Expires</th><th /></tr></thead>
              <tbody>{r.insurance.map((x) => <tr key={x.id}><td>{link(x)}</td><td>{x.name}</td><td>{x.insurer}</td><td className="font-mono text-xs">{x.policyNumber}</td><td className="num">{x.sumInsured ? formatAmount(x.sumInsured, fp) : '—'}</td><td>{formatDate(x.expiresOn)}</td><td>{dueText(x.days)}</td></tr>)}</tbody>
            </table>
          )
        ) : tab === 'warranty' ? (
          !r.warranty.length ? <Empty title="No warranties end in this window" /> : (
            <table className="table-base">
              <thead><tr><th>Tag</th><th>Asset</th><th>Provider</th><th>Expires</th><th /></tr></thead>
              <tbody>{r.warranty.map((x) => <tr key={x.id}><td>{link(x)}</td><td>{x.name}</td><td>{x.provider}</td><td>{formatDate(x.expiresOn)}</td><td>{dueText(x.days)}</td></tr>)}</tbody>
            </table>
          )
        ) : tab === 'service' ? (
          !r.serviceDue.length ? <Empty title="No services due" /> : (
            <table className="table-base">
              <thead><tr><th>Tag</th><th>Asset</th><th>Location</th><th>Last service</th><th>Next due</th><th /></tr></thead>
              <tbody>{r.serviceDue.map((x) => <tr key={x.id}><td>{link(x)}</td><td>{x.name}</td><td>{x.location}</td><td>{formatDate(x.lastService)}</td><td>{formatDate(x.nextDue)}</td><td>{dueText(x.days)}</td></tr>)}</tbody>
            </table>
          )
        ) : tab === 'uninsured' ? (
          !r.uninsured.length ? <Empty title="Every asset has a policy recorded" /> : (
            <table className="table-base">
              <thead><tr><th>Tag</th><th>Asset</th><th>Location</th><th>Custodian</th><th className="num">Cost</th></tr></thead>
              <tbody>{r.uninsured.map((x) => <tr key={x.id}><td>{link(x)}</td><td>{x.name}</td><td>{x.location}</td><td>{x.custodian}</td><td className="num">{formatAmount(x.cost, fp)}</td></tr>)}</tbody>
            </table>
          )
        ) : !r.unverified.length ? (
          <Empty title="Everything was verified in the last year" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Tag</th><th>Asset</th><th>Location</th><th>Custodian</th><th>Last verified</th></tr></thead>
            <tbody>{r.unverified.map((x) => <tr key={x.id}><td>{link(x)}</td><td>{x.name}</td><td>{x.location}</td><td>{x.custodian}</td><td>{formatDate(x.lastVerified) || 'Never'}</td></tr>)}</tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}
