'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import type { Party } from '@/modules/finance/ui/lib/commercial';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { downloadCsv } from '../report-filters';
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap, Tabs, Textarea } from '../ui';
import { AccountOptions } from './shared';

export interface SupplierCategory { id: string; code: string; name: string; description: string; expenseAccountId: string | null; isActive: boolean }
interface ComplianceDoc { type: string; number: string; issuedOn: string | null; expiresOn: string | null; note: string }
export type SupplierParty = Party & {
  status?: string;
  statusReason?: string;
  statusUntil?: string | null;
  categoryIds?: string[];
  compliance?: ComplianceDoc[];
  createdBy?: string | null;
  onboarding?: { submittedAt: string | null; approvedAt: string | null; comment: string };
};
interface Averages { quality: number; delivery: number; price: number; service: number }
interface Performance {
  status: string;
  ratingCount: number;
  averages: Averages | null;
  overall: number | null;
  ordersDelivered: number;
  onTime: number;
  onTimePercent: number | null;
  spend12m: string;
  ratings: { id: string; date: string; purchaseOrderNumber: string; quality: number; delivery: number; price: number; service: number; comment: string; ratedByName: string }[];
}

const COMPLIANCE_TYPES = [
  ['TAX_COMPLIANCE', 'Tax compliance certificate'],
  ['REGISTRATION', 'Certificate of incorporation / CR12'],
  ['AGPO', 'AGPO certificate'],
  ['NCA', 'NCA registration'],
  ['PROFESSIONAL', 'Professional licence'],
  ['OTHER', 'Other'],
] as const;
const typeLabel = (t: string) => COMPLIANCE_TYPES.find(([k]) => k === t)?.[1] ?? t;
const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : '');
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'violet'> = { ACTIVE: 'green', PENDING: 'amber', REJECTED: 'red', SUSPENDED: 'amber', BLACKLISTED: 'red', INACTIVE: 'gray' };

export function SupplierStatusBadge({ status }: { status?: string }) {
  if (!status || status === 'ACTIVE') return null;
  return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{status === 'PENDING' ? 'Awaiting approval' : status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}

const stars = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)} / 5`);

/** Onboarding, status, categories, compliance documents and performance for one supplier. */
export function SupplierProfile({ party }: { party: SupplierParty }) {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const precision = usePrecision();
  const manage = can('ap.manage');
  const approver = can('procurement.approve');
  const status = party.status ?? 'ACTIVE';
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'reject' | 'SUSPENDED' | 'BLACKLISTED' | 'ACTIVE' | 'rate' | 'compliance'>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [docs, setDocs] = useState<ComplianceDoc[]>([]);
  const [rating, setRating] = useState({ purchaseOrderId: '', date: today(), quality: 4, delivery: 4, price: 4, service: 4, comment: '' });
  const categories = useQuery({ queryKey: ['supplier-categories'], queryFn: () => api.get<SupplierCategory[]>('/supplier-categories') });
  const perf = useQuery({ queryKey: ['supplier-performance', party.id], queryFn: () => api.get<Performance>(`/suppliers/${party.id}/performance`) });
  const orders = useQuery({
    queryKey: ['supplier-orders', party.id],
    queryFn: () => api.get<{ items: { id: string; number: string; date: string; status: string }[] }>('/purchase-orders', { supplierId: party.id, pageSize: 50 }),
    enabled: dialog === 'rate',
  });
  const refresh = () => {
    setError(null);
    setDialog(null);
    setReason('');
    qc.invalidateQueries({ queryKey: ['party', party.id] });
    qc.invalidateQueries({ queryKey: ['supplier-performance', party.id] });
    qc.invalidateQueries({ queryKey: ['parties'] });
  };
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: object }) => api.post(`/suppliers/${party.id}/${path}`, body ?? {}), onSuccess: refresh, onError: (e) => setError(errorMessage(e)) });
  const setCategories = useMutation({ mutationFn: (categoryIds: string[]) => api.patch(`/suppliers/${party.id}`, { categoryIds }), onSuccess: refresh, onError: (e) => setError(errorMessage(e)) });
  const mine = party.createdBy === me.id;
  const p = perf.data;
  const dp = precision(party.currency);
  const fp = precision(me.organisation.reportingCurrency);
  const tcc = party.compliance?.find((c) => c.type === 'TAX_COMPLIANCE');
  const now = today();
  const lapsed = (d: string | null) => !!d && d.slice(0, 10) < now;

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />
      {status === 'PENDING' && (
        <Notice tone="amber">
          Awaiting onboarding approval. It cannot be sent RFQs or orders, billed or paid until a procurement approver approves it.
          {approver && !mine && (
            <span className="ml-2 inline-flex gap-2">
              <Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: 'approve' })}>Approve</Button>
              <Button size="sm" onClick={() => setDialog('reject')}>Reject</Button>
            </span>
          )}
          {approver && mine && <span className="ml-1">You registered it, so another approver must approve it.</span>}
        </Notice>
      )}
      {status === 'REJECTED' && (
        <Notice tone="amber">
          Not approved: {party.statusReason}. {manage && <Button size="sm" className="ml-2" loading={act.isPending} onClick={() => act.mutate({ path: 'resubmit' })}>Resubmit for approval</Button>}
        </Notice>
      )}
      {(status === 'SUSPENDED' || status === 'BLACKLISTED') && (
        <Notice tone="amber">
          {status === 'SUSPENDED' ? 'Suspended' : 'Blacklisted'}: {party.statusReason}
          {party.statusUntil && ` (until ${formatDate(party.statusUntil)})`}. No new RFQs or orders; bills and payments for work already done still go through.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Status"
          actions={
            approver && (status === 'ACTIVE' ? (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setDialog('SUSPENDED')}>Suspend</Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog('BLACKLISTED')}>Blacklist</Button>
              </div>
            ) : status === 'SUSPENDED' || status === 'BLACKLISTED' ? (
              <Button size="sm" variant="ghost" onClick={() => setDialog('ACTIVE')}>Reinstate</Button>
            ) : null)
          }
        >
          <p className="text-sm">{status === 'ACTIVE' ? <Badge tone="green">Active</Badge> : <SupplierStatusBadge status={status} />}</p>
          {party.onboarding?.approvedAt && <p className="mt-2 text-xs text-muted">Approved {formatDate(party.onboarding.approvedAt)}{party.onboarding.comment ? `: ${party.onboarding.comment}` : ''}</p>}
          <p className="mt-2 text-xs text-muted">Tax compliance: {tcc ? `${tcc.number}${tcc.expiresOn ? `, ${lapsed(tcc.expiresOn) ? 'expired' : 'valid to'} ${formatDate(tcc.expiresOn)}` : ''}` : 'not on file'}</p>
        </Card>
        <Card title="Categories">
          {!categories.data ? (
            <Loading />
          ) : !categories.data.length ? (
            <p className="text-sm text-muted">No supplier categories set up. <Link className="text-brand-700 hover:underline" href="/finance/purchases/supplier-management?tab=categories">Add some</Link>.</p>
          ) : (
            <div className="space-y-1">
              {categories.data.filter((c) => c.isActive || party.categoryIds?.includes(c.id)).map((c) => (
                <Checkbox
                  key={c.id}
                  disabled={!manage || setCategories.isPending}
                  label={`${c.code} · ${c.name}`}
                  checked={!!party.categoryIds?.includes(c.id)}
                  onChange={(v) => setCategories.mutate(v ? [...(party.categoryIds ?? []), c.id] : (party.categoryIds ?? []).filter((x) => x !== c.id))}
                />
              ))}
            </div>
          )}
        </Card>
        <Card title="Performance" actions={(can('procurement.manage') || approver) && status !== 'PENDING' && <Button size="sm" variant="ghost" onClick={() => (setError(null), setDialog('rate'))}>Rate</Button>}>
          {!p ? (
            <Loading />
          ) : (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Overall</dt><dd className="font-medium">{stars(p.overall)} <span className="text-xs text-muted">({p.ratingCount} rating{p.ratingCount === 1 ? '' : 's'})</span></dd></div>
              {p.averages && (['quality', 'delivery', 'price', 'service'] as const).map((k) => (
                <div key={k} className="flex justify-between"><dt className="capitalize text-muted">{k}</dt><dd>{stars(p.averages![k])}</dd></div>
              ))}
              <div className="flex justify-between"><dt className="text-muted">On-time delivery</dt><dd>{p.onTimePercent == null ? '—' : `${p.onTimePercent}% of ${p.ordersDelivered} orders`}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Spend, last 12 months</dt><dd className="tabular-nums">{formatAmount(p.spend12m, fp)}</dd></div>
            </dl>
          )}
        </Card>
      </div>

      <Card title="Compliance documents" padded={false} actions={manage && <Button size="sm" onClick={() => (setDocs(party.compliance?.map((d) => ({ ...d })) ?? []), setError(null), setDialog('compliance'))}>Edit</Button>}>
        {!party.compliance?.length ? (
          <p className="p-4 text-sm text-muted">None recorded. A current tax compliance certificate is needed for onboarding approval.</p>
        ) : (
          <table className="table-base">
            <thead><tr><th>Document</th><th>Number</th><th>Issued</th><th>Expires</th><th>Note</th></tr></thead>
            <tbody>
              {party.compliance.map((d, i) => (
                <tr key={i}>
                  <td>{typeLabel(d.type)}</td>
                  <td className="font-mono text-xs">{d.number}</td>
                  <td>{formatDate(d.issuedOn) || '—'}</td>
                  <td>{formatDate(d.expiresOn) || '—'} {lapsed(d.expiresOn) && <Badge tone="red">expired</Badge>}</td>
                  <td className="text-muted">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {!!p?.ratings.length && (
        <Card title="Ratings" padded={false}>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Order</th><th className="num">Quality</th><th className="num">Delivery</th><th className="num">Price</th><th className="num">Service</th><th>Comment</th><th>By</th></tr></thead>
            <tbody>
              {p.ratings.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.date)}</td>
                  <td className="font-mono text-xs">{r.purchaseOrderNumber || '—'}</td>
                  <td className="num">{r.quality}</td>
                  <td className="num">{r.delivery}</td>
                  <td className="num">{r.price}</td>
                  <td className="num">{r.service}</td>
                  <td>{r.comment}</td>
                  <td className="text-muted">{r.ratedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal
        open={dialog === 'reject' || dialog === 'SUSPENDED' || dialog === 'BLACKLISTED' || dialog === 'ACTIVE'}
        onClose={() => setDialog(null)}
        title={dialog === 'reject' ? `Reject ${party.name}` : dialog === 'SUSPENDED' ? `Suspend ${party.name}` : dialog === 'BLACKLISTED' ? `Blacklist ${party.name}` : `Reinstate ${party.name}`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant={dialog === 'ACTIVE' ? 'primary' : 'danger'}
              loading={act.isPending}
              onClick={() => act.mutate(dialog === 'reject' ? { path: 'reject', body: { reason } } : { path: 'status', body: { status: dialog, reason: reason || undefined, until: dialog === 'SUSPENDED' && until ? until : null } })}
            >
              {dialog === 'reject' ? 'Reject' : dialog === 'ACTIVE' ? 'Reinstate' : 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <Field label={dialog === 'ACTIVE' ? 'Note (optional)' : 'Reason'}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {dialog === 'SUSPENDED' && <Field label="Suspended until" hint="Blank suspends until reinstated"><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>}
        </div>
      </Modal>

      <Modal
        wide
        open={dialog === 'compliance'}
        onClose={() => setDialog(null)}
        title="Compliance documents"
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: 'compliance', body: { documents: docs.map((d) => ({ ...d, issuedOn: d.issuedOn || null, expiresOn: d.expiresOn || null })) } })}>Save</Button></>}
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          {docs.map((d, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_8.5rem_8.5rem_auto]">
              <Select value={d.type} onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                {COMPLIANCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <Input placeholder="Number" value={d.number} onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))} />
              <Input type="date" title="Issued" value={day(d.issuedOn)} onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, issuedOn: e.target.value } : x)))} />
              <Input type="date" title="Expires" value={day(d.expiresOn)} onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, expiresOn: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" onClick={() => setDocs(docs.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setDocs([...docs, { type: 'TAX_COMPLIANCE', number: '', issuedOn: null, expiresOn: null, note: '' }])}>+ Add document</Button>
          <p className="text-xs text-muted">Attach scans of the certificates under Attachments below.</p>
        </div>
      </Modal>

      <Modal
        open={dialog === 'rate'}
        onClose={() => setDialog(null)}
        title={`Rate ${party.name}`}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: 'ratings', body: { ...rating, purchaseOrderId: rating.purchaseOrderId || null, comment: rating.comment || undefined } })}>Save rating</Button></>}
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Purchase order">
              <Select value={rating.purchaseOrderId} onChange={(e) => setRating({ ...rating, purchaseOrderId: e.target.value })}>
                <option value="">General (no order)</option>
                {orders.data?.items.map((o) => <option key={o.id} value={o.id}>{o.number} · {formatDate(o.date)}</option>)}
              </Select>
            </Field>
            <Field label="Date"><Input type="date" value={rating.date} onChange={(e) => setRating({ ...rating, date: e.target.value })} /></Field>
            {(['quality', 'delivery', 'price', 'service'] as const).map((k) => (
              <Field key={k} label={`${k.charAt(0).toUpperCase()}${k.slice(1)} (1–5)`}>
                <Select value={String(rating[k])} onChange={(e) => setRating({ ...rating, [k]: Number(e.target.value) })}>
                  {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} · {['', 'Poor', 'Below expectations', 'Acceptable', 'Good', 'Excellent'][n]}</option>)}
                </Select>
              </Field>
            ))}
            <Field label="Comment" className="sm:col-span-2"><Textarea rows={2} value={rating.comment} onChange={(e) => setRating({ ...rating, comment: e.target.value })} /></Field>
          </div>
          <p className="text-xs text-muted">Currency of spend figures: {party.currency === me.organisation.reportingCurrency ? party.currency : `${me.organisation.reportingCurrency} (functional)`}. Outstanding to this supplier: {formatAmount(party.outstanding, dp)} {party.currency}.</p>
        </div>
      </Modal>
    </div>
  );
}

interface Scorecard { id: string; code: string; name: string; status: string; statusReason: string; categories: string[]; ratingCount: number; overall: number | null; averages: Averages | null; onTimePercent: number | null; ordersDelivered: number; spend12m: string }
interface ExpiringDoc { supplierId: string; code: string; name: string; email: string; type: string; number: string; expiresOn: string; days: number }

/** Scorecards, onboarding queue, compliance expiry and supplier categories. */
export function SupplierManagementPage({ initialTab }: { initialTab?: string }) {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const precision = usePrecision();
  const fp = precision(me.organisation.reportingCurrency);
  const { data: accounts = [] } = useAccounts();
  const [tab, setTab] = useState<'scorecards' | 'pending' | 'compliance' | 'categories'>((['scorecards', 'pending', 'compliance', 'categories'].includes(initialTab ?? '') ? initialTab : 'scorecards') as 'scorecards');
  const [days, setDays] = useState('30');
  const [editing, setEditing] = useState<null | Partial<SupplierCategory>>(null);
  const [error, setError] = useState<string | null>(null);
  const scorecards = useQuery({ queryKey: ['supplier-scorecards'], queryFn: () => api.get<Scorecard[]>('/supplier-scorecards') });
  const expiring = useQuery({ queryKey: ['supplier-compliance', days], queryFn: () => api.get<ExpiringDoc[]>('/supplier-compliance', { days: days || '0' }), enabled: tab === 'compliance' });
  const categories = useQuery({ queryKey: ['supplier-categories'], queryFn: () => api.get<SupplierCategory[]>('/supplier-categories') });
  const save = useMutation({
    mutationFn: () => {
      const body = { code: editing!.code, name: editing!.name, description: editing!.description ?? '', expenseAccountId: editing!.expenseAccountId || null, isActive: editing!.isActive ?? true };
      return editing!.id ? api.patch(`/supplier-categories/${editing!.id}`, body) : api.post('/supplier-categories', body);
    },
    onSuccess: () => (setEditing(null), setError(null), qc.invalidateQueries({ queryKey: ['supplier-categories'] })),
    onError: (e) => setError(errorMessage(e)),
  });
  const rows = scorecards.data ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING' || r.status === 'REJECTED');
  const link = (id: string, text: string) => <Link className="text-brand-700 hover:underline" href={`/finance/purchases/suppliers/${id}`}>{text}</Link>;

  return (
    <>
      <PageHeader title="Supplier management" description="Performance scorecards, onboarding approvals, compliance documents that are expiring, and supplier categories." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scorecards', label: 'Scorecards' },
          { id: 'pending', label: `Onboarding (${pending.length})` },
          { id: 'compliance', label: 'Compliance expiring' },
          { id: 'categories', label: 'Categories' },
        ]}
      />
      {tab === 'scorecards' && (
        <>
          <div className="mb-3 flex justify-end">
            <Button
              disabled={!rows.length}
              onClick={() => downloadCsv('supplier-scorecards.csv', ['Code', 'Supplier', 'Status', 'Categories', 'Ratings', 'Overall', 'Quality', 'Delivery', 'Price', 'Service', 'On time %', 'Orders delivered', 'Spend 12m'], rows.map((r) => [r.code, r.name, r.status, r.categories.join(' '), r.ratingCount, r.overall ?? '', r.averages?.quality ?? '', r.averages?.delivery ?? '', r.averages?.price ?? '', r.averages?.service ?? '', r.onTimePercent ?? '', r.ordersDelivered, r.spend12m]))}
            >
              Export CSV
            </Button>
          </div>
          <TableWrap>
            {scorecards.isLoading ? <Loading /> : !rows.length ? <Empty title="No suppliers yet" /> : (
              <table className="table-base">
                <thead><tr><th>Code</th><th>Supplier</th><th>Categories</th><th>Status</th><th className="num">Ratings</th><th className="num">Overall</th><th className="num">On time</th><th className="num">Spend, 12 months</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono text-xs">{r.code}</td>
                      <td>{link(r.id, r.name)}</td>
                      <td className="text-xs text-muted">{r.categories.join(', ')}</td>
                      <td>{r.status === 'ACTIVE' ? <Badge tone="green">Active</Badge> : r.status === 'INACTIVE' ? <Badge>Inactive</Badge> : <SupplierStatusBadge status={r.status} />}</td>
                      <td className="num">{r.ratingCount || '—'}</td>
                      <td className="num">{stars(r.overall)}</td>
                      <td className="num">{r.onTimePercent == null ? '—' : `${r.onTimePercent}%`}</td>
                      <td className="num">{formatAmount(r.spend12m, fp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
        </>
      )}
      {tab === 'pending' && (
        <TableWrap>
          {!pending.length ? <Empty title="No suppliers waiting for approval" /> : (
            <table className="table-base">
              <thead><tr><th>Code</th><th>Supplier</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>{pending.map((r) => <tr key={r.id}><td className="font-mono text-xs">{r.code}</td><td>{link(r.id, r.name)}</td><td><SupplierStatusBadge status={r.status} /></td><td className="text-muted">{r.statusReason}</td></tr>)}</tbody>
            </table>
          )}
        </TableWrap>
      )}
      {tab === 'compliance' && (
        <>
          <div className="mb-3 flex items-end gap-3">
            <Field label="Expiring within (days)"><Input className="w-24" inputMode="numeric" value={days} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDays(e.target.value)} /></Field>
          </div>
          <TableWrap>
            {!expiring.data ? <Loading /> : !expiring.data.length ? <Empty title="Nothing expires in this window" /> : (
              <table className="table-base">
                <thead><tr><th>Supplier</th><th>Document</th><th>Number</th><th>Expires</th><th /></tr></thead>
                <tbody>
                  {expiring.data.map((d, i) => (
                    <tr key={i}>
                      <td>{link(d.supplierId, d.name)}</td>
                      <td>{typeLabel(d.type)}</td>
                      <td className="font-mono text-xs">{d.number}</td>
                      <td>{formatDate(d.expiresOn)}</td>
                      <td>{d.days < 0 ? <Badge tone="red">expired {-d.days} days ago</Badge> : <Badge tone="amber">in {d.days} days</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
        </>
      )}
      {tab === 'categories' && (
        <>
          {can('ap.manage') && <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => (setError(null), setEditing({ isActive: true }))}>New category</Button></div>}
          <TableWrap>
            {!categories.data ? <Loading /> : !categories.data.length ? <Empty title="No supplier categories" /> : (
              <table className="table-base">
                <thead><tr><th>Code</th><th>Name</th><th>Default account</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {categories.data.map((c) => {
                    const a = accounts.find((x) => x.id === c.expenseAccountId);
                    return (
                      <tr key={c.id}>
                        <td className="font-mono text-xs">{c.code}</td>
                        <td>{c.name}{c.description && <span className="block text-xs text-muted">{c.description}</span>}</td>
                        <td>{a ? `${a.code} · ${a.name}` : '—'}</td>
                        <td>{c.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                        <td className="text-right">{can('ap.manage') && <Button size="sm" variant="ghost" onClick={() => (setError(null), setEditing(c))}>Edit</Button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </TableWrap>
        </>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Category ${editing.code}` : 'New supplier category'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}
      >
        {editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBanner error={error} className="sm:col-span-2" />
            <Field label="Code"><Input value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name"><Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Description" className="sm:col-span-2"><Input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <Field label="Default ledger account" hint="Suppliers in this category bill to it unless they have their own" className="sm:col-span-2">
              <Select value={editing.expenseAccountId ?? ''} onChange={(e) => setEditing({ ...editing, expenseAccountId: e.target.value || null })}>
                <AccountOptions accounts={accounts} classes={['EXPENSE', 'ASSET']} placeholder="None" />
              </Select>
            </Field>
            <Checkbox label="Active" checked={editing.isActive ?? true} onChange={(v) => setEditing({ ...editing, isActive: v })} />
          </div>
        )}
      </Modal>
    </>
  );
}
