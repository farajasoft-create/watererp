'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { addAll, formatAmount, formatCompact, formatDate, formatDateTime, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { MonthlyChart } from './monthly-chart';
import { downloadCsv, ReportTitle } from './report-filters';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap, Tabs, Textarea } from './ui';
import { useDirectory } from './workflow';
import { ForecastScenario } from './automation';

// ---------------------------------------------------------------------------------------------
// Developers: service accounts, API keys and webhooks
// ---------------------------------------------------------------------------------------------

interface ServiceAccount {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
  allBranches: boolean;
  branchIds: string[];
  isActive: boolean;
  keys: { id: string; name: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null }[];
}
interface Endpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  isActive: boolean;
  consecutiveFailures: number;
  disabledReason: string;
  createdAt: string;
}
interface Delivery {
  id: string;
  endpointId: string;
  eventType: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  nextAttemptAt: string;
  createdAt: string;
  event: { summary: string } | null;
}

export function DevelopersPage() {
  const [tab, setTab] = useState<'keys' | 'webhooks' | 'docs'>('keys');
  return (
    <>
      <PageHeader title="Developers" description="Connect other systems through the REST API and webhooks. API keys belong to service accounts, which are governed by roles, branch restrictions, approval limits and segregation of duties like any user." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'docs', label: 'API reference' }]} />
      {tab === 'keys' && <ApiKeys />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'docs' && <ApiReference />}
    </>
  );
}

function SecretOnce({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title={label} footer={<Button variant="primary" onClick={onClose}>I have stored it</Button>}>
      <div className="space-y-3">
        <Notice tone="amber">Copy this now. It is shown only once and cannot be retrieved later.</Notice>
        <div className="flex gap-2">
          <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ApiKeys() {
  const queryClient = useQueryClient();
  const { entity } = useSession();
  const { data: directory } = useDirectory();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data = [], isLoading } = useQuery({ queryKey: ['service-accounts'], queryFn: () => api.get<ServiceAccount[]>('/service-accounts') });
  const [account, setAccount] = useState<null | { id?: string; name: string; roleIds: string[]; allBranches: boolean; branchIds: string[]; isActive: boolean }>(null);
  const [keyFor, setKeyFor] = useState<null | { id: string; name: string; keyName: string; expiresInDays: string }>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['service-accounts'] });
  const saveAccount = useMutation({
    mutationFn: () => (account!.id ? api.patch(`/service-accounts/${account!.id}`, { ...account, id: undefined }) : api.post('/service-accounts', { ...account, isActive: undefined })),
    onSuccess: () => (setAccount(null), setError(null), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const issue = useMutation({
    mutationFn: () => api.post<{ key: string }>(`/service-accounts/${keyFor!.id}/keys`, { name: keyFor!.keyName, expiresInDays: keyFor!.expiresInDays ? Number(keyFor!.expiresInDays) : null }),
    onSuccess: (r) => (setKeyFor(null), setError(null), setSecret(r.key), refresh()),
    onError: (err) => setError(errorMessage(err)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/api-keys/${id}/revoke`), onSuccess: refresh, onError: (err) => setError(errorMessage(err)) });
  const roleNames = (ids: string[]) => ids.map((id) => directory?.roles.find((r) => r.id === id)?.name ?? '?').join(', ');
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => (setError(null), setAccount({ name: '', roleIds: [], allBranches: true, branchIds: [], isActive: true }))}>New service account</Button>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      {isLoading ? (
        <Loading />
      ) : !data.length ? (
        <TableWrap><Empty title="No service accounts">Create one for each connected system (ERP, e-commerce, payroll) so its access can be limited and revoked on its own.</Empty></TableWrap>
      ) : (
        <div className="space-y-4">
          {data.map((a) => (
            <Card
              key={a.id}
              title={<span>{a.name} {!a.isActive && <Badge tone="gray">inactive</Badge>}<span className="ml-2 text-xs font-normal text-muted">{roleNames(a.roleIds)}{a.allBranches ? '' : ` · ${a.branchIds.length} branch(es)`}</span></span>}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => (setError(null), setAccount({ id: a.id, name: a.name, roleIds: a.roleIds, allBranches: a.allBranches, branchIds: a.branchIds, isActive: a.isActive }))}>Edit</Button>
                  <Button size="sm" onClick={() => (setError(null), setKeyFor({ id: a.id, name: a.name, keyName: '', expiresInDays: '365' }))} disabled={!a.isActive}>New key</Button>
                </>
              }
              padded={false}
            >
              {!a.keys.length ? (
                <p className="p-4 text-sm text-muted">No keys yet.</p>
              ) : (
                <table className="table-base">
                  <thead><tr><th>Key</th><th>Name</th><th>Created</th><th>Expires</th><th>Last used</th><th /></tr></thead>
                  <tbody>
                    {a.keys.map((k) => (
                      <tr key={k.id} className={k.revokedAt ? 'opacity-50' : ''}>
                        <td className="font-mono text-xs">{k.prefix}…</td>
                        <td>{k.name}</td>
                        <td className="text-xs">{formatDate(k.createdAt)}</td>
                        <td className="text-xs">{k.expiresAt ? formatDate(k.expiresAt) : 'never'}</td>
                        <td className="text-xs">{k.lastUsedAt ? `${formatDateTime(k.lastUsedAt)}${k.lastUsedIp ? ` · ${k.lastUsedIp}` : ''}` : 'never'}</td>
                        <td className="text-right">{k.revokedAt ? <Badge tone="gray">revoked</Badge> : <Button size="sm" variant="danger" onClick={() => revoke.mutate(k.id)}>Revoke</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!account} onClose={() => setAccount(null)} title={account?.id ? 'Edit service account' : 'New service account'} footer={<><Button onClick={() => setAccount(null)}>Cancel</Button><Button variant="primary" loading={saveAccount.isPending} onClick={() => saveAccount.mutate()}>Save</Button></>}>
        {account && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <Field label="Name"><Input value={account.name} placeholder="e.g. Shopify connector" onChange={(e) => setAccount({ ...account, name: e.target.value })} /></Field>
            <Field label="Roles" hint="Roles that manage users, integrations or the organisation cannot be given to service accounts">
              <div className="grid grid-cols-2 gap-1 pt-1">
                {directory?.roles.map((r) => (
                  <Checkbox key={r.id} label={r.name} checked={account.roleIds.includes(r.id)} onChange={(v) => setAccount({ ...account, roleIds: v ? [...account.roleIds, r.id] : account.roleIds.filter((x) => x !== r.id) })} />
                ))}
              </div>
            </Field>
            <Checkbox label="All branches" checked={account.allBranches} onChange={(v) => setAccount({ ...account, allBranches: v })} />
            {!account.allBranches && (
              <div className="flex flex-wrap gap-3">
                {branches.map((b) => (
                  <Checkbox key={b.id} label={b.code} checked={account.branchIds.includes(b.id)} onChange={(v) => setAccount({ ...account, branchIds: v ? [...account.branchIds, b.id] : account.branchIds.filter((x) => x !== b.id) })} />
                ))}
              </div>
            )}
            {account.id && <Checkbox label="Active (inactive accounts' keys stop working)" checked={account.isActive} onChange={(v) => setAccount({ ...account, isActive: v })} />}
          </div>
        )}
      </Modal>
      <Modal open={!!keyFor} onClose={() => setKeyFor(null)} title={`New API key for ${keyFor?.name ?? ''}`} footer={<><Button onClick={() => setKeyFor(null)}>Cancel</Button><Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate()}>Create key</Button></>}>
        {keyFor && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ErrorBanner error={error} className="sm:col-span-2" />
            <Field label="Key name"><Input value={keyFor.keyName} placeholder="e.g. Production" onChange={(e) => setKeyFor({ ...keyFor, keyName: e.target.value })} /></Field>
            <Field label="Expires after (days)" hint="Blank for no expiry"><Input inputMode="numeric" value={keyFor.expiresInDays} onChange={(e) => /^\d*$/.test(e.target.value) && setKeyFor({ ...keyFor, expiresInDays: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
      {secret && <SecretOnce label="Your new API key" value={secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function Webhooks() {
  const queryClient = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<Endpoint[]>('/webhooks') });
  const catalogue = useQuery({ queryKey: ['webhook-events'], queryFn: () => api.get<{ type: string; description: string }[]>('/webhooks/events') });
  const [selected, setSelected] = useState<string | null>(null);
  const deliveries = useQuery({ queryKey: ['webhook-deliveries', selected], queryFn: () => api.get<Delivery[]>('/webhooks/deliveries', { endpointId: selected ?? undefined, limit: 50 }), refetchInterval: 15_000 });
  const [form, setForm] = useState<null | { id?: string; url: string; description: string; events: string[]; all: boolean }>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => (queryClient.invalidateQueries({ queryKey: ['webhooks'] }), queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] }));
  const save = useMutation({
    mutationFn: () => {
      const body = { url: form!.url, description: form!.description, events: form!.all ? ['*'] : form!.events };
      return form!.id ? api.patch<Endpoint>(`/webhooks/${form!.id}`, body) : api.post<Endpoint & { secret: string }>('/webhooks', body);
    },
    onSuccess: (r) => {
      if ('secret' in r && r.secret) setSecret(r.secret as string);
      setForm(null);
      setError(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: ({ path, method = 'post', body }: { path: string; method?: 'post' | 'patch' | 'delete'; body?: object }) =>
      method === 'delete' ? api.delete(path) : method === 'patch' ? api.patch(path, body ?? {}) : api.post<{ secret?: string; status?: string; error?: string }>(path, body),
    onSuccess: (r) => {
      const res = r as { secret?: string; status?: string; error?: string } | null;
      if (res?.secret) setSecret(res.secret);
      if (res?.status && res.status !== 'SUCCEEDED') setError(`Delivery ${res.status.toLowerCase()}${res.error ? `: ${res.error}` : ''}`);
      else setError(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Events are recorded in the same transaction as the change, then delivered with an HMAC signature and retried with back-off for about a day.</p>
        <Button variant="primary" onClick={() => (setError(null), setForm({ url: 'https://', description: '', events: [], all: false }))}>Add endpoint</Button>
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No webhook endpoints" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className={cx(selected === e.id && 'bg-brand-50/60')}>
                  <td>
                    <button className="text-left font-mono text-xs text-brand-700 hover:underline" onClick={() => setSelected(selected === e.id ? null : e.id)}>{e.url}</button>
                    {e.description && <p className="text-xs text-muted">{e.description}</p>}
                  </td>
                  <td className="text-xs">{e.events.join(', ')}</td>
                  <td>
                    <Badge tone={e.isActive ? 'green' : 'gray'}>{e.isActive ? 'active' : 'disabled'}</Badge>
                    {e.consecutiveFailures > 0 && <p className="text-[11px] text-red-700">{e.consecutiveFailures} failing in a row</p>}
                    {e.disabledReason && <p className="text-[11px] text-muted">{e.disabledReason}</p>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `/webhooks/${e.id}/test` })}>Send test</Button>
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `/webhooks/${e.id}`, method: 'patch', body: { isActive: !e.isActive } })}>{e.isActive ? 'Disable' : 'Enable'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `/webhooks/${e.id}/rotate-secret` })}>Rotate secret</Button>
                    <Button size="sm" variant="ghost" onClick={() => (setError(null), setForm({ id: e.id, url: e.url, description: e.description, events: e.events.filter((x) => x !== '*'), all: e.events.includes('*') }))}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => act.mutate({ path: `/webhooks/${e.id}`, method: 'delete' })}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <Card title={`Recent deliveries${selected ? ' (selected endpoint)' : ''}`} padded={false} className="mt-5">
        {!deliveries.data?.length ? (
          <p className="p-4 text-sm text-muted">No deliveries yet.</p>
        ) : (
          <table className="table-base">
            <thead><tr><th>When</th><th>Event</th><th>Summary</th><th>Status</th><th className="num">Attempts</th><th>Last response</th><th /></tr></thead>
            <tbody>
              {deliveries.data.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(d.createdAt)}</td>
                  <td className="font-mono text-xs">{d.eventType}</td>
                  <td className="text-xs text-muted">{d.event?.summary}</td>
                  <td>
                    <Badge tone={d.status === 'SUCCEEDED' ? 'green' : d.status === 'FAILED' ? 'red' : 'amber'}>{d.status.toLowerCase()}</Badge>
                    {d.status === 'PENDING' && d.attempts > 0 && <p className="text-[11px] text-muted">retry {formatDateTime(d.nextAttemptAt)}</p>}
                  </td>
                  <td className="num">{d.attempts}</td>
                  <td className="text-xs">{d.lastStatusCode ?? ''} {d.lastError}</td>
                  <td className="text-right">{d.status !== 'SUCCEEDED' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `/webhooks/deliveries/${d.id}/redeliver` })}>Redeliver</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Modal wide open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit endpoint' : 'Add webhook endpoint'} footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="URL" hint="Must be a public https endpoint"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
              <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            </div>
            <Checkbox label="Send every event" checked={form.all} onChange={(v) => setForm({ ...form, all: v })} />
            {!form.all && (
              <div className="grid max-h-72 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
                {catalogue.data?.map((ev) => (
                  <label key={ev.type} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={form.events.includes(ev.type)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev.type] : form.events.filter((x) => x !== ev.type) })} />
                    <span>
                      <span className="font-mono text-xs">{ev.type}</span>
                      <span className="block text-xs text-muted">{ev.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
      {secret && <SecretOnce label="Webhook signing secret" value={secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function ApiReference() {
  const { data, isLoading } = useQuery({ queryKey: ['openapi'], queryFn: () => api.get<{ paths: Record<string, Record<string, { tags: string[]; 'x-permissions'?: string[] }>> }>('/openapi.json') });
  const [filter, setFilter] = useState('');
  if (isLoading || !data) return <Loading />;
  const ops = Object.entries(data.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), tag: op.tags[0], permissions: op['x-permissions'] ?? [] })));
  const shown = ops.filter((o) => !filter || `${o.path} ${o.tag}`.toLowerCase().includes(filter.toLowerCase()));
  const tags = [...new Set(shown.map((o) => o.tag))].sort();
  return (
    <div className="space-y-4">
      <Card title="Getting started">
        <div className="space-y-2 text-sm">
          <p>Base URL: <code className="rounded bg-gray-100 px-1 text-xs">{typeof window !== 'undefined' ? window.location.origin : ''}/api/v1</code> · machine-readable description: <a className="text-brand-700 hover:underline" href="/api/v1/finance/openapi.json" target="_blank" rel="noreferrer">openapi.json</a> (OpenAPI 3.1).</p>
          <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">{`curl -H "Authorization: Bearer fsk_…" \\
     -H "Idempotency-Key: $(uuidgen)" \\
     -H "Content-Type: application/json" \\
     -d '{"entityId":"…","branchId":"…","journalDate":"2026-10-01","description":"From ERP","lines":[…]}' \\
     ${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/finance/journals`}</pre>
          <p className="text-muted">Amounts are decimal strings. Writes accept an Idempotency-Key, so retries never double-post. Webhook signatures: <code className="text-xs">HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;raw body&gt;&quot;)</code> compared with <code className="text-xs">v1</code> in <code className="text-xs">X-FarajaSoft-Signature</code>.</p>
        </div>
      </Card>
      <Input placeholder="Filter endpoints…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
      {tags.map((tag) => (
        <Card key={tag} title={tag} padded={false}>
          <table className="table-base">
            <tbody>
              {shown.filter((o) => o.tag === tag).map((o) => (
                <tr key={`${o.method} ${o.path}`}>
                  <td className="w-20"><Badge tone={o.method === 'GET' ? 'blue' : o.method === 'DELETE' ? 'red' : o.method === 'PATCH' ? 'amber' : 'green'}>{o.method}</Badge></td>
                  <td className="font-mono text-xs">{o.path}</td>
                  <td className="text-right text-xs text-muted">{o.permissions.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Data import & export
// ---------------------------------------------------------------------------------------------

const KINDS = [
  { id: 'customers', label: 'Customers', permission: 'ar.manage' },
  { id: 'suppliers', label: 'Suppliers', permission: 'ap.manage' },
  { id: 'items', label: 'Items', permission: 'inventory.manage' },
  { id: 'accounts', label: 'Chart of accounts', permission: 'coa.manage' },
];

interface ImportResult {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  errors: number;
  results: { row: number; code: string; action: 'create' | 'update' | 'error'; message?: string }[];
}

export function DataPage() {
  const { can, entity } = useSession();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('customers');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ledger, setLedger] = useState({ from: startOfYear(), to: today() });
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResult>(`/import/${kind}`, { csv, dryRun }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      if (!r.dryRun) queryClient.invalidateQueries();
    },
    onError: (err) => (setError(errorMessage(err)), setResult(null)),
  });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsv(await file.text());
    setResult(null);
  };
  return (
    <>
      <PageHeader title="Import & export" description="Bring master data in from spreadsheets and take data out for BI tools. Imports go through the same validation, permissions and audit trail as entering records by hand." />
      <div className="grid gap-5 lg:grid-cols-3">
        {can('data.import') && (
          <Card title="Import from CSV" className="lg:col-span-2">
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Data">
                  <Select value={kind} onChange={(e) => (setKind(e.target.value), setResult(null))}>
                    {KINDS.map((k) => (<option key={k.id} value={k.id}>{k.label}</option>))}
                  </Select>
                </Field>
                <a className="mb-2 text-sm text-brand-700 hover:underline" href={`/api/v1/finance/import/${kind}/template`}>Download template</a>
                <label className="mb-1 ml-auto inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-white px-3.5 text-sm font-medium shadow-sm hover:bg-gray-50">
                  Choose file…
                  <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                </label>
              </div>
              <Textarea rows={8} className="font-mono text-xs" placeholder="code,name,currency,…" value={csv} onChange={(e) => (setCsv(e.target.value), setResult(null))} />
              <p className="text-xs text-muted">Rows are matched on code: existing records are updated with the non-empty cells, new codes are created. Accounts and tax codes are given by code. Each row succeeds or fails on its own.</p>
              <ErrorBanner error={error} />
              <div className="flex gap-2">
                <Button disabled={!csv.trim()} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>Check file</Button>
                <Button variant="primary" disabled={!result?.dryRun || result.created + result.updated === 0} loading={run.isPending && run.variables === false} onClick={() => run.mutate(false)}>
                  Import {result?.dryRun ? `${result.created + result.updated} row(s)` : ''}
                </Button>
              </div>
              {result && (
                <div>
                  <Notice tone={result.errors ? 'amber' : 'green'}>
                    {result.dryRun ? 'Check: ' : 'Imported: '}
                    {result.created} to create, {result.updated} to update, {result.errors} with errors{result.dryRun && result.errors ? ' (rows with errors will be skipped)' : ''}.
                  </Notice>
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    <table className="table-base">
                      <thead><tr><th className="num">Row</th><th>Code</th><th>Result</th><th>Message</th></tr></thead>
                      <tbody>
                        {result.results.map((r) => (
                          <tr key={r.row}>
                            <td className="num">{r.row}</td>
                            <td className="font-mono text-xs">{r.code}</td>
                            <td><Badge tone={r.action === 'error' ? 'red' : r.action === 'create' ? 'green' : 'blue'}>{r.action}</Badge></td>
                            <td className="text-xs text-red-700">{r.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}
        {can('data.export') && (
          <Card title="Export">
            <div className="space-y-3 text-sm">
              {KINDS.map((k) => (
                <div key={k.id} className="flex items-center justify-between">
                  <span>{k.label}</span>
                  <span className="space-x-3 text-xs">
                    <a className="text-brand-700 hover:underline" href={`/api/v1/finance/export/${k.id}`}>CSV</a>
                    <a className="text-brand-700 hover:underline" href={`/api/v1/finance/export/${k.id}?format=json`} target="_blank" rel="noreferrer">JSON</a>
                  </span>
                </div>
              ))}
              {can('journal.view') && (
                <div className="border-t border-line pt-3">
                  <p className="font-medium">Ledger detail ({entity?.code})</p>
                  <p className="mb-2 text-xs text-muted">Every posted line with account, branch, dimensions, party and currency amounts — for BI tools and auditors.</p>
                  <div className="flex gap-2">
                    <Input type="date" value={ledger.from} onChange={(e) => setLedger({ ...ledger, from: e.target.value })} aria-label="From" />
                    <Input type="date" value={ledger.to} onChange={(e) => setLedger({ ...ledger, to: e.target.value })} aria-label="To" />
                  </div>
                  <a className="mt-2 inline-block text-xs text-brand-700 hover:underline" href={`/api/v1/finance/export/ledger?entityId=${entity?.id}&from=${ledger.from}&to=${ledger.to}`}>Download CSV</a>
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Executive dashboard
// ---------------------------------------------------------------------------------------------

interface ExceptionItem {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  date: string | null;
  amount: string | null;
  link: string | null;
}
interface Executive {
  currency: string;
  asOf: string;
  fiscalYearStart: string;
  warehouse: { lastRefreshedAt: string | null; facts: number };
  kpis: {
    revenue: { ytd: string; lastYear: string; changePercent: string | null; mtd: string };
    grossMargin: { ytd: string; percent: string | null; lastYearPercent: string | null };
    opex: { ytd: string; lastYear: string; changePercent: string | null };
    ebitda: { ytd: string; percent: string | null; lastYear: string };
    netProfit: { ytd: string; lastYear: string; mtd: string };
    cash: { balance: string; forecastLow: string; forecastLowWeek: string };
    receivables: { balance: string; dso: number | null };
    payables: { balance: string; dpo: number | null };
    inventory: { balance: string };
    workingCapital: { amount: string; currentRatio: string | null };
  };
  trend: { month: string; revenue: string; grossProfit: string; opex: string; netProfit: string; cash: string }[];
  branches: { branchId: string; code: string; name: string; revenue: string; grossProfit: string; grossMarginPercent: string | null; netProfit: string }[];
  budget: { name: string; revenue: string; revenueActual: string; costs: string; costsActual: string; utilisationPercent: string | null; overBudget: { code: string; name: string; budget: string; actual: string }[] } | null;
  fx: { currency: string; net: string; atRate: string; sensitivity10: string }[];
  exceptions: { total: number; high: number; top: ExceptionItem[] };
}

function Tile({ label, value, currency, sub, tone }: { label: string; value: string; currency?: string; sub?: React.ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4 shadow-xs">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cx('mt-1 text-xl font-semibold tracking-tight tabular-nums', tone === 'bad' && 'text-red-700')}>
        {value}
        {currency && <span className="ml-1 text-xs font-normal text-muted">{currency}</span>}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

const change = (pct: string | null, invert = false) => {
  if (pct === null) return null;
  const up = !pct.startsWith('-');
  const good = invert ? !up : up;
  return <span className={good ? 'text-emerald-700' : 'text-red-700'}>{up ? '▲' : '▼'} {pct.replace('-', '')}% vs last year</span>;
};

const SEVERITY_TONE = { high: 'red', medium: 'amber', low: 'gray' } as const;

export function ExecutiveDashboard() {
  const { entity } = useSession();
  const [asOf, setAsOf] = useState(today());
  const { data, isLoading, error } = useQuery({ queryKey: ['executive', entity?.id, asOf], queryFn: () => api.get<Executive>('/analytics/executive', { entityId: entity!.id, asOf }) });
  const cur = data?.currency ?? '';
  const k = data?.kpis;
  const n = (v: string) => formatAmount(v, 0, { parens: true });
  return (
    <>
      <PageHeader
        title="Executive dashboard"
        description={data ? `${entity?.name} · year to date from ${formatDate(data.fiscalYearStart)} · as at ${formatDate(data.asOf)}` : undefined}
        actions={<Field label="As at"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>}
      />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data || !k ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Tile label="Revenue (YTD)" value={n(k.revenue.ytd)} currency={cur} sub={change(k.revenue.changePercent) ?? `This month ${formatCompact(k.revenue.mtd)}`} />
            <Tile label="Gross margin" value={k.grossMargin.percent ? `${k.grossMargin.percent}%` : '—'} sub={`${formatCompact(k.grossMargin.ytd)} ${cur}${k.grossMargin.lastYearPercent ? ` · last year ${k.grossMargin.lastYearPercent}%` : ''}`} />
            <Tile label="Operating expenses (YTD)" value={n(k.opex.ytd)} currency={cur} sub={change(k.opex.changePercent, true)} />
            <Tile label="EBITDA (YTD)" value={n(k.ebitda.ytd)} currency={cur} tone={k.ebitda.ytd.startsWith('-') ? 'bad' : undefined} sub={k.ebitda.percent ? `${k.ebitda.percent}% of revenue` : undefined} />
            <Tile label="Net profit (YTD)" value={n(k.netProfit.ytd)} currency={cur} tone={k.netProfit.ytd.startsWith('-') ? 'bad' : undefined} sub={`Last year ${formatCompact(k.netProfit.lastYear)}`} />
            <Tile label="Cash & bank" value={n(k.cash.balance)} currency={cur} sub={<Link className="text-brand-700 hover:underline" href="/finance/analytics/forecast">13-week low {formatCompact(k.cash.forecastLow)} ({formatDate(k.cash.forecastLowWeek)})</Link>} tone={k.cash.forecastLow.startsWith('-') ? 'bad' : undefined} />
            <Tile label="Receivables" value={n(k.receivables.balance)} currency={cur} sub={k.receivables.dso !== null ? `${k.receivables.dso} days sales outstanding` : undefined} />
            <Tile label="Payables" value={n(k.payables.balance)} currency={cur} sub={k.payables.dpo !== null ? `${k.payables.dpo} days payables outstanding` : undefined} />
            <Tile label="Inventory" value={n(k.inventory.balance)} currency={cur} />
            <Tile label="Working capital" value={n(k.workingCapital.amount)} currency={cur} sub={k.workingCapital.currentRatio ? `Current ratio ${k.workingCapital.currentRatio}` : undefined} />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Revenue and costs, last 12 months" className="lg:col-span-2">
              <MonthlyChart currency={cur} data={data.trend.map((t) => ({ month: t.month, revenue: t.revenue, costs: addAll([t.revenue, `-${t.netProfit}`.replace('--', '')]), netProfit: t.netProfit }))} />
            </Card>
            <Card title={`Key exceptions (${data.exceptions.total})`} actions={<Link className="text-xs text-brand-700 hover:underline" href="/finance/analytics/exceptions">All</Link>}>
              {!data.exceptions.top.length ? (
                <p className="text-sm text-muted">Nothing unusual in the last three months.</p>
              ) : (
                <ul className="space-y-2">
                  {data.exceptions.top.map((e, i) => (
                    <li key={i} className="text-sm">
                      <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>{' '}
                      {e.link ? <Link className="hover:underline" href={e.link}>{e.title}</Link> : e.title}
                      <p className="truncate text-xs text-muted">{e.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Branch performance (YTD)" padded={false} className="lg:col-span-2">
              <table className="table-base">
                <thead><tr><th>Branch</th><th className="num">Revenue</th><th className="num">Gross profit</th><th className="num">Margin</th><th className="num">Net profit</th></tr></thead>
                <tbody>
                  {data.branches.map((b) => (
                    <tr key={b.branchId}>
                      <td><span className="font-mono text-xs">{b.code}</span> {b.name}</td>
                      <td className="num">{n(b.revenue)}</td>
                      <td className="num">{n(b.grossProfit)}</td>
                      <td className="num text-xs">{b.grossMarginPercent ? `${b.grossMarginPercent}%` : ''}</td>
                      <td className={cx('num', b.netProfit.startsWith('-') && 'text-red-700')}>{n(b.netProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="space-y-5">
              <Card title="Budget utilisation (YTD)">
                {!data.budget ? (
                  <p className="text-sm text-muted">No approved budget.</p>
                ) : (
                  <div className="space-y-3 text-sm">
                    <div>
                      <div className="flex justify-between"><span>Costs</span><span className="tabular-nums">{data.budget.utilisationPercent ?? '—'}%</span></div>
                      <div className="mt-1 h-2 rounded-full bg-gray-100">
                        <div className={cx('h-2 rounded-full', Number(data.budget.utilisationPercent) > 100 ? 'bg-red-600' : 'bg-brand-600')} style={{ width: `${Math.min(100, Number(data.budget.utilisationPercent ?? 0))}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-muted">{formatCompact(data.budget.costsActual)} of {formatCompact(data.budget.costs)} {cur}</p>
                    </div>
                    <p className="text-xs text-muted">Revenue {formatCompact(data.budget.revenueActual)} against {formatCompact(data.budget.revenue)} budgeted</p>
                    {data.budget.overBudget.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-red-700">Over budget</p>
                        {data.budget.overBudget.map((o) => (<p key={o.code} className="text-xs">{o.code} {o.name}: {formatCompact(o.actual)} / {formatCompact(o.budget)}</p>))}
                      </div>
                    )}
                    <Link className="text-xs text-brand-700 hover:underline" href="/finance/reports/budget-vs-actual">Budget vs actual</Link>
                  </div>
                )}
              </Card>
              <Card title="FX exposure">
                {!data.fx.length ? (
                  <p className="text-sm text-muted">No foreign-currency balances.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {data.fx.map((f) => (
                        <tr key={f.currency}>
                          <td className="py-0.5 font-medium">{f.currency}</td>
                          <td className="py-0.5 text-right tabular-nums">{formatCompact(f.atRate)} {cur}</td>
                          <td className="py-0.5 text-right text-xs text-muted">±10%: {formatCompact(f.sensitivity10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Cash forecast
// ---------------------------------------------------------------------------------------------

interface ForecastWeek {
  week: number;
  weekStart: string;
  opening: string;
  customers: string;
  otherReceipts: string;
  suppliers: string;
  purchaseOrders: string;
  otherPayments: string;
  inflow: string;
  outflow: string;
  net: string;
  closing: string;
}
interface Forecast {
  currency: string;
  openingCash: string;
  weeks: ForecastWeek[];
  lowest: { weekStart: string; balance: string };
  shortfallWeeks: number[];
  assumptions: { weeklyOtherReceipts: string; weeklyOtherPayments: string; customers: { name: string; amount: string; daysLate: number }[] };
}

/** Single-series line of projected closing cash, with a zero baseline and a hover tooltip. */
function CashLine({ weeks, opening, currency, minimum }: { weeks: ForecastWeek[]; opening: string; currency: string; minimum: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const pad = { top: 12, right: 12, bottom: 26, left: 56 };
  const values = [Number(opening), ...weeks.map((w) => Number(w.closing))];
  const lo = Math.min(0, minimum, ...values);
  const hi = Math.max(1, minimum, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad.left + (i / (values.length - 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - lo) / span) * (H - pad.top - pad.bottom);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * span);
  const color = '#2a78d6';
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Projected closing cash by week" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="#eeeef4" />
            <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="#5e6075">{formatCompact(String(Math.round(t)))}</text>
          </g>
        ))}
        {lo < 0 && <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} stroke="#5e6075" strokeWidth="1" />}
        {minimum > 0 && <line x1={pad.left} x2={W - pad.right} y1={y(minimum)} y2={y(minimum)} stroke="#b45309" strokeDasharray="4 3" />}
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {values.map((v, i) => (
          <g key={i}>
            <rect x={x(i) - 18} y={pad.top} width="36" height={H - pad.top - pad.bottom} fill="transparent" onMouseEnter={() => setHover(i)} />
            <circle cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={v < minimum ? '#dc2626' : color} stroke="#fff" strokeWidth="2" />
            {(i === 0 || i % 2 === 1) && (
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#5e6075">{i === 0 ? 'Now' : `W${i}`}</text>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-line bg-white px-2 py-1 text-xs shadow" style={{ left: `${(x(hover) / W) * 100}%`, transform: 'translateX(-50%)' }}>
          <p className="font-medium">{hover === 0 ? 'Today' : `Week ${hover} · ${formatDate(weeks[hover - 1].weekStart)}`}</p>
          <p className="tabular-nums">{formatAmount(String(values[hover]), 0, { parens: true })} {currency}</p>
        </div>
      )}
    </div>
  );
}

export function CashForecastPage() {
  const { entity } = useSession();
  const [minimum, setMinimum] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['cash-forecast', entity?.id, minimum], queryFn: () => api.get<Forecast>('/analytics/cash-forecast', { entityId: entity!.id, minimumCash: minimum || undefined }) });
  const n = (v: string) => formatAmount(v, 0, { parens: true, blankZero: true });
  return (
    <>
      <PageHeader
        title="13-week cash forecast"
        description="Customer receipts at each customer's actual payment behaviour, supplier bills at their due dates, approved purchase orders on supplier terms, and the run rate of other cash movements over the last 13 weeks."
        actions={<Field label="Minimum cash buffer"><Input inputMode="decimal" className="w-36" value={minimum} onChange={(e) => /^\d*$/.test(e.target.value) && setMinimum(e.target.value)} /></Field>}
      />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {data.shortfallWeeks.length > 0 && <Notice tone="amber">Cash is projected to fall below {minimum ? formatAmount(minimum, 0) : 'zero'} in week(s) {data.shortfallWeeks.join(', ')}. Lowest: {formatAmount(data.lowest.balance, 0, { parens: true })} {data.currency} in the week of {formatDate(data.lowest.weekStart)}.</Notice>}
          <Card title={`Projected closing cash (${data.currency})`}>
            <CashLine weeks={data.weeks} opening={data.openingCash} currency={data.currency} minimum={Number(minimum || 0)} />
          </Card>
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="num">Opening</th>
                  <th className="num">Customers</th>
                  <th className="num">Other receipts</th>
                  <th className="num">Supplier bills</th>
                  <th className="num">Purchase orders</th>
                  <th className="num">Other payments</th>
                  <th className="num">Net</th>
                  <th className="num">Closing</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((w) => (
                  <tr key={w.week} className={cx(data.shortfallWeeks.includes(w.week) && 'bg-red-50')}>
                    <td className="whitespace-nowrap">W{w.week} <span className="text-xs text-muted">{formatDate(w.weekStart)}</span></td>
                    <td className="num">{n(w.opening)}</td>
                    <td className="num text-emerald-700">{n(w.customers)}</td>
                    <td className="num text-emerald-700">{n(w.otherReceipts)}</td>
                    <td className="num text-red-700">{n(w.suppliers)}</td>
                    <td className="num text-red-700">{n(w.purchaseOrders)}</td>
                    <td className="num text-red-700">{n(w.otherPayments)}</td>
                    <td className="num">{formatAmount(w.net, 0, { parens: true })}</td>
                    <td className={cx('num font-medium', w.closing.startsWith('-') && 'text-red-700')}>{formatAmount(w.closing, 0, { parens: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <ForecastScenario minimumCash={minimum} />
          <Card title="Assumptions">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p>Other receipts {formatAmount(data.assumptions.weeklyOtherReceipts, 0)} and other payments {formatAmount(data.assumptions.weeklyOtherPayments, 0)} {data.currency} a week — the average of journals through cash and bank over the last 13 weeks (cash sales, payroll, rent).</p>
                <p className="mt-2 text-xs text-muted">Overdue items are expected in week 1. Supplier bills are assumed paid on their due date.</p>
              </div>
              <div>
                <p className="mb-1 font-medium">Largest expected customer receipts</p>
                {data.assumptions.customers.map((c) => (
                  <p key={c.name} className="flex justify-between text-xs"><span>{c.name} <span className="text-muted">({c.daysLate ? `pays ~${c.daysLate} days late` : 'pays on time'})</span></span><span className="tabular-nums">{formatAmount(c.amount, 0)}</span></p>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  unusual_amount: 'Unusual amount',
  weekend: 'Weekend posting',
  backdated: 'Back-dated',
  duplicate_bill: 'Possible duplicate',
  bank_change_payment: 'Bank details changed',
  overdue_approval: 'Overdue approval',
  control_override: 'Control override',
  expense_policy: 'Expense policy',
  duplicate_attachment: 'Duplicate document',
};

export function ExceptionsPage() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [q, setQ] = useState({ from: startOfYear(), to: today(), severity: '' });
  const { data, isLoading, error } = useQuery({ queryKey: ['exceptions', entity?.id, q.from, q.to], queryFn: () => api.get<ExceptionItem[]>('/analytics/exceptions', { entityId: entity!.id, from: q.from, to: q.to }) });
  const rows = (data ?? []).filter((e) => !q.severity || e.severity === q.severity);
  const fp = precision(entity?.functionalCurrency);
  return (
    <>
      <PageHeader title="Key exceptions" description="Transactions that deserve a second look: unusual manual postings, weekend and back-dated journals, possible duplicate bills, payments soon after a supplier's bank details changed, overridden controls, overdue approvals and expense-policy exceptions." />
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="From"><Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
        <Field label="Severity">
          <Select value={q.severity} onChange={(e) => setQ({ ...q, severity: e.target.value })}>
            <option value="">All</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </Field>
        {data && <Button onClick={() => downloadCsv(`exceptions-${q.from}-${q.to}.csv`, ['Severity', 'Type', 'Title', 'Detail', 'Date', 'Amount'], rows.map((e) => [e.severity, KIND_LABEL[e.kind] ?? e.kind, e.title, e.detail, e.date?.slice(0, 10), e.amount]))}>Export CSV</Button>}
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <Empty title="No exceptions in this period" />
        ) : (
          <table className="table-base">
            <thead><tr><th>Severity</th><th>Type</th><th>Exception</th><th>Date</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td><Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge></td>
                  <td className="whitespace-nowrap text-xs">{KIND_LABEL[e.kind] ?? e.kind}</td>
                  <td>
                    {e.link ? <Link className="font-medium text-brand-700 hover:underline" href={e.link}>{e.title}</Link> : <span className="font-medium">{e.title}</span>}
                    <p className="text-xs text-muted">{e.detail}</p>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(e.date)}</td>
                  <td className="num">{e.amount ? formatAmount(e.amount, fp) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Cash flow statement
// ---------------------------------------------------------------------------------------------

interface CashFlow {
  currency: string;
  operating: { items: { key: string; label: string; amount: string }[]; total: string };
  investing: { items: { key: string; label: string; amount: string }[]; total: string };
  financing: { items: { key: string; label: string; amount: string }[]; total: string };
  netChange: string;
  openingCash: string;
  closingCash: string;
  reconciles: boolean;
  cashAccounts: { code: string; name: string; change: string }[];
}

export function CashFlowReport() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [q, setQ] = useState({ from: startOfYear(), to: today() });
  const { data, isLoading, error } = useQuery({ queryKey: ['cash-flow', entity?.id, q], queryFn: () => api.get<CashFlow>('/reports/cash-flow', { entityId: entity!.id, ...q }) });
  const fp = precision(data?.currency);
  const section = (title: string, s: CashFlow['operating'], totalLabel: string) => [
    <tr key={`${title}-h`} className="bg-gray-50"><td colSpan={2} className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</td></tr>,
    ...s.items.map((i) => (
      <tr key={i.key}>
        <td className="pl-6">{i.label}</td>
        <td className="num">{formatAmount(i.amount, fp, { parens: true })}</td>
      </tr>
    )),
    <tr key={`${title}-t`} className="font-semibold">
      <td>{totalLabel}</td>
      <td className="num border-t border-line">{formatAmount(s.total, fp, { parens: true })}</td>
    </tr>,
  ];
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Field label="From"><Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <ReportTitle title="Statement of cash flows" subtitle={`Indirect method · ${formatDate(q.from)} – ${formatDate(q.to)} · ${data?.currency ?? ''}`} />
      <ErrorBanner error={error} className="mb-3" />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <>
          {!data.reconciles && <div className="mb-3"><Notice tone="amber">The statement does not reconcile to the movement in cash; check for unclassified accounts.</Notice></div>}
          <TableWrap>
            <table className="table-base">
              <tbody>
                {section('Operating activities', data.operating, 'Net cash from operating activities')}
                {section('Investing activities', data.investing, 'Net cash from investing activities')}
                {section('Financing activities', data.financing, 'Net cash from financing activities')}
              </tbody>
              <tfoot>
                <tr><td>Net increase / (decrease) in cash</td><td className="num">{formatAmount(data.netChange, fp, { parens: true })}</td></tr>
                <tr><td>Cash and cash equivalents at the start</td><td className="num">{formatAmount(data.openingCash, fp, { parens: true })}</td></tr>
                <tr><td>Cash and cash equivalents at the end</td><td className="num">{formatAmount(data.closingCash, fp, { parens: true })}</td></tr>
              </tfoot>
            </table>
          </TableWrap>
          <p className="mt-2 text-xs text-muted">Cash and cash equivalents: {data.cashAccounts.map((a) => `${a.code} ${a.name}`).join(', ')}.</p>
        </>
      )}
    </>
  );
}
