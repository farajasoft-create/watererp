'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface Settings {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  kraPin?: string;
  currency: string;
  ledger: { enabled: boolean; baseUrl?: string; apiKey: string | null; entityId?: string; branchId?: string; mode: 'DRAFT' | 'SUBMIT' | 'POST'; provider: string };
  sms: { provider: 'NONE' | 'AFRICASTALKING'; username?: string; apiKey: string | null; senderId?: string };
  mail?: { enabled?: boolean; host?: string; port?: number; secure?: boolean; username?: string; password?: string | null; from?: string };
  security?: { requireTwoFactor: string; sso?: { enabled?: boolean; issuer?: string; clientId?: string; clientSecret?: string | null; domains?: string[] } };
}

interface ModuleRow {
  key: string;
  name: string;
  description: string;
  dependsOn: string[];
  enabled: boolean;
}

interface ModuleRoles {
  module: string;
  name: string;
  scope: { label: string; endpoint: string } | null;
  permissions?: string[];
  roles: { key: string; label: string; description?: string; permissions?: string[]; custom?: boolean }[];
}

type Tab = 'organisation' | 'modules' | 'users' | 'ledger' | 'sms' | 'email' | 'security' | 'approvals' | 'audit' | 'developers' | 'privacy';

function Organisation({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: s.name, address: s.address ?? '', phone: s.phone ?? '', email: s.email ?? '', kraPin: s.kraPin ?? '', currency: s.currency ?? 'KES' });
  const save = useMutation({ mutationFn: () => api.patch('/settings/general', f), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  return (
    <Card title="Organisation" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="KRA PIN"><Input value={f.kraPin} onChange={(e) => setF({ ...f, kraPin: e.target.value })} /></Field>
        <Field label="Address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Currency"><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
      </div>
    </Card>
  );
}

function Modules() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['modules'], queryFn: () => api.get<ModuleRow[]>('/modules') });
  const save = useMutation({
    mutationFn: (modules: string[]) => api.put<ModuleRow[]>('/settings/modules', { modules }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['modules'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (isLoading || !data) return <Loading />;
  const on = data.filter((m) => m.enabled).map((m) => m.key);
  const toggle = (key: string, enabled: boolean) => save.mutate(enabled ? [...on, key] : on.filter((k) => k !== key));
  return (
    <Card title="Modules" padded={false}>
      <div className="px-4 pt-3 text-sm text-muted">Every module shares this organisation, its users, the SMS gateway and the ledger. Switching one off hides it and refuses its API; its data stays.</div>
      <ErrorBox error={error || save.error} />
      <table className="table-base mt-2">
        <thead><tr><th>Module</th><th>What it covers</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.key}>
              <td className="font-medium">{m.name}{m.dependsOn.length > 0 && <div className="text-xs text-muted">Needs {m.dependsOn.join(', ')}</div>}</td>
              <td className="max-w-md text-sm">{m.description}</td>
              <td>{m.enabled ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</td>
              <td className="text-right">
                <Button variant={m.enabled ? 'ghost' : 'secondary'} disabled={save.isPending} onClick={() => toggle(m.key, !m.enabled)}>
                  {m.enabled ? 'Switch off' : 'Switch on'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  isAdmin?: boolean;
  access: { module: string; role: string; scope?: string[] }[];
  active: boolean;
  lastLoginAt?: string;
  twoFactor?: { enabled?: boolean };
}

type Access = Record<string, { role: string; scope: string[] }>;

/** Lets an administrator limit a role to some records of a module (zones, branches…). */
function ScopePicker({ endpoint, label, value, onChange }: { endpoint: string; label: string; value: string[]; onChange: (v: string[]) => void }) {
  const { data } = useQuery({ queryKey: ['scope', endpoint], queryFn: () => api.get<{ id: string; label?: string; code?: string; name?: string }[]>(endpoint) });
  return (
    <Field label={label} hint="None selected = all">
      <div className="flex flex-wrap gap-3 rounded border border-line p-2">
        {data?.map((x) => (
          <label key={x.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={value.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((v) => v !== x.id))} />
            {x.label ?? x.code ?? x.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

function UserForm({ user, modules, onClose }: { user?: User; modules: ModuleRoles[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', isAdmin: user?.isAdmin ?? false, active: user?.active ?? true, password: '' });
  const [access, setAccess] = useState<Access>(Object.fromEntries((user?.access ?? []).map((a) => [a.module, { role: a.role, scope: a.scope ?? [] }])));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, password: f.password || undefined, access: Object.entries(access).filter(([, a]) => a.role).map(([module, a]) => ({ module, role: a.role, scope: a.scope })) };
      return user ? api.patch(`/users/${user.id}`, body) : api.post('/users', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.name}` : 'New user'} footer={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label={user ? 'New password (optional)' : 'Password'} hint="At least 10 characters"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.isAdmin} onChange={(e) => setF({ ...f, isAdmin: e.target.checked })} /> Administrator (everything, in every module)</label>
      </div>
      {!f.isAdmin && (
        <div className="mt-4 space-y-3">
          <div className="text-xs font-medium text-muted">Role in each module</div>
          {modules.map((m) => {
            const a = access[m.module] ?? { role: '', scope: [] };
            const set = (patch: Partial<typeof a>) => setAccess({ ...access, [m.module]: { ...a, ...patch } });
            return (
              <div key={m.module} className="rounded border border-line p-3">
                <Field label={m.name}>
                  <Select value={a.role} onChange={(e) => set({ role: e.target.value })}>
                    <option value="">No access</option>
                    {m.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </Select>
                </Field>
                {a.role && m.roles.find((r) => r.key === a.role)?.description && <p className="mt-1 text-xs text-muted">{m.roles.find((r) => r.key === a.role)?.description}</p>}
                {a.role && m.scope && <div className="mt-2"><ScopePicker endpoint={m.scope.endpoint} label={m.scope.label} value={a.scope} onChange={(scope) => set({ scope })} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function Users() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<ModuleRoles[]>('/roles') });
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const describe = (u: User) => {
    if (u.isAdmin) return 'Administrator';
    const parts = u.access.map((a) => {
      const m = roles.data?.find((x) => x.module === a.module);
      return `${m?.name ?? a.module}: ${m?.roles.find((r) => r.key === a.role)?.label ?? a.role}`;
    });
    return parts.join(' · ') || 'No access';
  };
  return (
    <Card padded={false} title="Users" actions={<Button onClick={() => setEdit('new')}>New user</Button>}>
      <ErrorBox error={users.error} />
      <table className="table-base">
        <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td className="font-medium">{u.name}</td>
              <td>{u.email}</td>
              <td className="text-sm">{describe(u)}</td>
              <td>{u.active ? <Badge value="ACTIVE" /> : <Badge tone="gray">Inactive</Badge>}</td>
              <td>{fmtDateTime(u.lastLoginAt)}</td>
              <td className="whitespace-nowrap text-right">
                {u.twoFactor?.enabled && <Button variant="ghost" onClick={async () => { await api.post(`/users/${u.id}/reset-2fa`); users.refetch(); }}>Reset two-step</Button>}
                <Button variant="ghost" onClick={() => setEdit(u)}>Edit</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && roles.data && <UserForm user={edit === 'new' ? undefined : edit} modules={roles.data} onClose={() => setEdit(null)} />}
    </Card>
  );
}

/** Data subject requests: everything held about a person, to answer an access request or check before erasure. */
function Privacy() {
  const [q, setQ] = useState({ email: '', phone: '', idNumber: '', kraPin: '', reason: '' });
  const search = useMutation({ mutationFn: () => api.post<{ searchedAt: string; collections: string[]; results: { collection: string; label: string; id: string; summary: string; matchedOn: string[]; record: unknown }[] }>('/privacy/subject-search', Object.fromEntries(Object.entries(q).filter(([, v]) => v))) });
  const download = () => {
    const blob = new Blob([JSON.stringify(search.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `subject-access-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const t = (k: keyof typeof q) => (e: { target: { value: string } }) => setQ({ ...q, [k]: e.target.value });
  return (
    <Card title="Data subject requests">
      <p className="mb-3 text-sm text-muted">Under the Data Protection Act, 2019 a person may ask what the organisation holds about them. Search every module by any of their identifiers; the search and its reason are kept in the audit trail.</p>
      <ErrorBox error={search.error} />
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Email"><Input value={q.email} onChange={t('email')} /></Field>
        <Field label="Phone"><Input value={q.phone} onChange={t('phone')} /></Field>
        <Field label="ID number"><Input value={q.idNumber} onChange={t('idNumber')} /></Field>
        <Field label="KRA PIN"><Input value={q.kraPin} onChange={t('kraPin')} /></Field>
        <Field label="Reason (request reference)" className="sm:col-span-3"><Input value={q.reason} onChange={t('reason')} /></Field>
        <Button className="self-end" onClick={() => search.mutate()} disabled={search.isPending || q.reason.length < 5}>Search</Button>
      </div>
      {search.data && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-sm"><span>{search.data.results.length} record(s) found in {search.data.collections.length} places searched.</span>{search.data.results.length > 0 && <Button variant="secondary" onClick={download}>Download (JSON)</Button>}</div>
          <table className="table-base"><thead><tr><th>Where</th><th>Record</th><th>Matched on</th></tr></thead>
            <tbody>{search.data.results.map((r) => <tr key={`${r.collection}${r.id}`}><td>{r.label}</td><td>{r.summary}</td><td className="text-xs">{r.matchedOn.join(', ')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** API keys for other systems and the API description. */
function Developers() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [who, setWho] = useState('');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('365');
  const [issued, setIssued] = useState<string | null>(null);
  const keys = useQuery({ queryKey: ['api-keys', who], queryFn: () => api.get<{ id: string; label: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }[]>(`/users/${who}/api-keys`), enabled: !!who });
  const create = useMutation({ mutationFn: () => api.post<{ key: string }>(`/users/${who}/api-keys`, { label, days: days ? Number(days) : null }), onSuccess: (r) => { setIssued(r.key); setLabel(''); keys.refetch(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/users/${who}/api-keys/${id}`), onSuccess: () => keys.refetch() });
  return (
    <div className="space-y-4">
      <Card title="API">
        <p className="text-sm">Every module&apos;s REST API is described in OpenAPI 3.1 at <a className="text-brand-700 hover:underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">/api/v1/openapi.json</a> (Finance in more detail at <a className="text-brand-700 hover:underline" href="/api/v1/finance/openapi.json" target="_blank" rel="noreferrer">/api/v1/finance/openapi.json</a>). Load either into Postman, Swagger UI or a code generator.</p>
        <p className="mt-2 text-sm text-muted">Other systems call it with <code>Authorization: Bearer gk_…</code>. A key acts as the user it belongs to: create a service user with only the roles the other system needs, then issue the key below. Every call is in the audit trail.</p>
      </Card>
      <Card title="API keys">
        <ErrorBox error={create.error || revoke.error || keys.error} />
        <div className="mb-3 w-72"><Select value={who} onChange={(e) => { setWho(e.target.value); setIssued(null); }}><option value="">Choose a user</option>{users.data?.filter((u) => !u.isAdmin && u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></div>
        {issued && <Notice tone="green">Copy this key now; it is not shown again: <Input readOnly value={issued} onFocus={(e) => e.target.select()} /></Notice>}
        {who && (
          <>
            <table className="table-base"><thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Expires</th><th>Last used</th><th /></tr></thead>
              <tbody>{keys.data?.map((k) => <tr key={k.id}><td>{k.label}</td><td className="font-mono text-xs">{k.prefix}…</td><td>{fmtDateTime(k.createdAt)}</td><td>{k.expiresAt ? fmtDateTime(k.expiresAt) : 'Never'}</td><td>{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '—'}</td><td className="text-right"><Button variant="ghost" onClick={() => revoke.mutate(k.id)}>Revoke</Button></td></tr>)}</tbody>
            </table>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. SCADA gateway" /></Field>
              <Field label="Valid for (days, blank = no expiry)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
              <Button onClick={() => create.mutate()} disabled={label.length < 2 || create.isPending}>Issue key</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** The organisation's own roles: any mix of a module's permissions, changed here without a release. */
function CustomRoles() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<ModuleRoles[]>('/roles') });
  const [f, setF] = useState<{ module: string; key: string; label: string; description: string; permissions: string[] } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['roles'] });
  const save = useMutation({ mutationFn: () => api.put('/roles/custom', { ...f!, description: f!.description || undefined }), onSuccess: () => { setF(null); refresh(); } });
  const remove = useMutation({ mutationFn: (x: { module: string; key: string }) => api.delete(`/roles/custom/${x.module}/${x.key}`), onSuccess: refresh });
  const custom = roles.data?.flatMap((m) => m.roles.filter((r) => r.custom).map((r) => ({ ...r, module: m.module, moduleName: m.name }))) ?? [];
  const mod = roles.data?.find((m) => m.module === f?.module);
  return (
    <Card title="Custom roles" actions={<Button onClick={() => setF({ module: roles.data?.[0]?.module ?? '', key: '', label: '', description: '', permissions: [] })}>New role</Button>}>
      <ErrorBox error={roles.error || remove.error} />
      <p className="mb-2 text-sm text-muted">Build a role from any of a module&apos;s permissions. Changes reach the people holding the role straight away.</p>
      {!custom.length ? <p className="text-sm text-muted">None yet; the standard roles of each module are always available.</p> : (
        <table className="table-base">
          <thead><tr><th>Module</th><th>Role</th><th>Permissions</th><th /></tr></thead>
          <tbody>
            {custom.map((r) => (
              <tr key={`${r.module}${r.key}`}>
                <td>{r.moduleName}</td>
                <td>{r.label}<div className="text-xs text-muted">{r.key}</div></td>
                <td className="text-xs">{r.permissions?.join(', ')}</td>
                <td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => setF({ module: r.module, key: r.key, label: r.label, description: r.description ?? '', permissions: [...(r.permissions ?? [])] })}>Edit</Button>
                  <Button variant="ghost" onClick={() => remove.mutate({ module: r.module, key: r.key })}>Delete</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f && (
        <Modal open title="Custom role" onClose={() => setF(null)} footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !f.key || !f.label || !f.permissions.length}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Module"><Select value={f.module} onChange={(e) => setF({ ...f, module: e.target.value, permissions: [] })}>{roles.data?.map((m) => <option key={m.module} value={m.module}>{m.name}</option>)}</Select></Field>
            <Field label="Key"><Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toUpperCase() })} placeholder="e.g. DESK_READER" /></Field>
            <Field label="Name" className="sm:col-span-2"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </div>
          <div className="mt-3 grid gap-1 sm:grid-cols-2">
            {mod?.permissions?.map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.permissions.includes(p)} onChange={(e) => setF({ ...f, permissions: e.target.checked ? [...f.permissions, p] : f.permissions.filter((x) => x !== p) })} /> {p}</label>
            ))}
          </div>
        </Modal>
      )}
    </Card>
  );
}

interface Lookup {
  entities: { id: string; code: string; name: string }[];
  branches: { id: string; code: string; name: string }[];
  accounts: { id: string; code: string; name: string; type: string }[];
}

function Ledger({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const l = s.ledger;
  const [f, setF] = useState({ enabled: l.enabled, baseUrl: l.baseUrl ?? '', apiKey: '', entityId: l.entityId ?? '', branchId: l.branchId ?? '', mode: l.mode ?? 'SUBMIT' });
  const lookup = useMutation({ mutationFn: () => api.post<Lookup>('/settings/ledger/lookup', { baseUrl: f.baseUrl || undefined, apiKey: f.apiKey || undefined, entityId: f.entityId || undefined }) });
  const save = useMutation({
    mutationFn: () => api.patch('/settings/ledger', { ...f, apiKey: f.apiKey || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['ledger-accounts'] });
    },
  });
  const { mutate: runLookup } = lookup;
  useEffect(() => {
    if (l.baseUrl && l.apiKey) runLookup();
  }, [l.baseUrl, l.apiKey, runLookup]);

  return (
    <Card title="General ledger" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <p className="mb-3 text-sm text-muted">
        One ledger for every module: water billing and collections today, payroll, procurement and the rest as they are added. Each module maps its own accounts in its settings. Journals go to <b>{l.provider}</b>. In Accounting go to <b>Setup → Developers</b>, create a service account with journal permissions, and paste its API key here.
      </p>
      <ErrorBox error={save.error || lookup.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Field label="Accounting address"><Input placeholder="https://books.example.com" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></Field>
        <Field label="API key" hint={l.apiKey ? `Stored: ${l.apiKey}. Leave empty to keep it.` : undefined}><Input type="password" placeholder="fsk_…" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></Field>
      </div>
      <Button variant="secondary" className="mt-3" onClick={() => lookup.mutate()} disabled={lookup.isPending}>{lookup.isPending ? 'Connecting…' : 'Test connection'}</Button>
      {lookup.data && <span className="ml-2 text-sm text-emerald-700">Connected: {lookup.data.accounts.length} postable accounts.</span>}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Legal entity">
          <Select value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })}>
            <option value="">{f.entityId ? 'Saved (test connection to view)' : 'Select…'}</option>
            {lookup.data?.entities.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
          </Select>
        </Field>
        <Field label="Branch">
          <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
            <option value="">{f.branchId ? 'Saved (test connection to view)' : 'Select…'}</option>
            {lookup.data?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </Select>
        </Field>
        <Field label="Journals arrive as" hint="Submit keeps Accounting's approval in charge">
          <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as typeof f.mode })}>
            <option value="DRAFT">Drafts</option>
            <option value="SUBMIT">Submitted for approval</option>
            <option value="POST">Posted (approval switched off)</option>
          </Select>
        </Field>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Send module transactions to the ledger
      </label>
    </Card>
  );
}

function Sms({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ provider: s.sms?.provider ?? 'NONE', username: s.sms?.username ?? '', apiKey: '', senderId: s.sms?.senderId ?? '' });
  const save = useMutation({ mutationFn: () => api.patch('/settings/sms', { ...f, apiKey: f.apiKey || undefined }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const outbox = useQuery({ queryKey: ['sms'], queryFn: () => api.get<{ id: string; to: string; message: string; purpose?: string; status: string; error?: string; createdAt: string }[]>('/sms') });
  return (
    <div className="space-y-4">
      <Card title="SMS gateway" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
        <p className="mb-3 text-sm text-muted">Shared by every module (bills, disconnection notices, payslips…).</p>
        <ErrorBox error={save.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as typeof f.provider })}>
              <option value="NONE">None</option>
              <option value="AFRICASTALKING">Africa&apos;s Talking</option>
            </Select>
          </Field>
          <Field label="Username" hint="“sandbox” for testing"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="API key" hint={s.sms?.apiKey ? `Stored: ${s.sms.apiKey}` : undefined}><Input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></Field>
          <Field label="Sender ID"><Input value={f.senderId} onChange={(e) => setF({ ...f, senderId: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Recent messages" padded={false}>
        <table className="table-base">
          <thead><tr><th>Queued</th><th>To</th><th>Message</th><th>From</th><th>Status</th></tr></thead>
          <tbody>
            {outbox.data?.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap">{fmtDateTime(m.createdAt)}</td>
                <td>{m.to}</td>
                <td className="max-w-lg text-xs">{m.message}</td>
                <td className="text-xs">{m.purpose}</td>
                <td><Badge value={m.status} />{m.error && <div className="text-xs text-muted">{m.error}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Email({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const m = s.mail ?? {};
  const [f, setF] = useState({ enabled: m.enabled ?? false, host: m.host ?? '', port: String(m.port ?? 587), secure: m.secure ?? false, username: m.username ?? '', password: '', from: m.from ?? '' });
  const [to, setTo] = useState('');
  const save = useMutation({ mutationFn: () => api.patch('/settings/email', { ...f, port: Number(f.port), password: f.password || undefined, host: f.host || undefined, username: f.username || undefined, from: f.from || undefined }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const test = useMutation({ mutationFn: () => api.post<{ sent: number; failed: number; skipped: number }>('/settings/email/test', { to }), onSuccess: () => qc.invalidateQueries({ queryKey: ['emails'] }) });
  const outbox = useQuery({ queryKey: ['emails'], queryFn: () => api.get<{ id: string; to: string; subject: string; purpose?: string; status: string; error?: string; createdAt: string }[]>('/emails') });
  return (
    <div className="space-y-4">
      <Card title="Outgoing email (SMTP)" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
        <p className="mb-3 text-sm text-muted">The organisation&apos;s own mail server, for bills, receipts, notifications, RFQs and purchase orders. Office 365: smtp.office365.com, port 587. Gmail / Google Workspace: smtp.gmail.com, port 587 with an app password.</p>
        <ErrorBox error={save.error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Send email</label>
          <Field label="Server"><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>
          <Field label="Port"><Input inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} /> SSL from the start (port 465)</label>
          <Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="Password" hint={m.password ? 'Stored; leave empty to keep it' : undefined}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Send as" className="sm:col-span-2"><Input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="billing@tachwasco.co.ke" /></Field>
        </div>
        <div className="mt-3 flex items-end gap-2">
          <Field label="Send a test to"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button variant="secondary" onClick={() => test.mutate()} disabled={!to || test.isPending}>Send test</Button>
        </div>
        <ErrorBox error={test.error} />
        {test.data && <Notice tone={test.data.sent ? 'green' : 'amber'}>{test.data.sent ? 'Sent.' : test.data.skipped ? 'Not sent: switch email on and save first.' : 'The server refused it; see the error below.'}</Notice>}
      </Card>
      <Card title="Recent emails" padded={false}>
        <table className="table-base">
          <thead><tr><th>Queued</th><th>To</th><th>Subject</th><th>From</th><th>Status</th></tr></thead>
          <tbody>{outbox.data?.map((x) => <tr key={x.id}><td className="whitespace-nowrap">{fmtDateTime(x.createdAt)}</td><td>{x.to}</td><td className="text-sm">{x.subject}</td><td className="text-xs">{x.purpose}</td><td><Badge value={x.status} />{x.error && <div className="text-xs text-muted">{x.error}</div>}</td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}

function Security({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const sec = s.security ?? { requireTwoFactor: 'NONE', sso: {} };
  const [f, setF] = useState({ requireTwoFactor: sec.requireTwoFactor ?? 'NONE', enabled: sec.sso?.enabled ?? false, issuer: sec.sso?.issuer ?? '', clientId: sec.sso?.clientId ?? '', clientSecret: '', domains: (sec.sso?.domains ?? []).join(', ') });
  const save = useMutation({
    mutationFn: () => api.patch('/settings/security', { requireTwoFactor: f.requireTwoFactor, sso: { enabled: f.enabled, issuer: f.issuer || undefined, clientId: f.clientId || undefined, clientSecret: f.clientSecret || undefined, domains: f.domains.split(',').map((d) => d.trim()).filter(Boolean) } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <Card title="Sign-in security" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="space-y-4">
        <Field label="Two-step sign-in (authenticator app code after the password)" hint="Set it up for yourself first under My account. Users who have not set it up are taken there at their next sign-in.">
          <Select value={f.requireTwoFactor} onChange={(e) => setF({ ...f, requireTwoFactor: e.target.value })} className="max-w-sm">
            <option value="NONE">Optional for everyone</option>
            <option value="ADMINS">Required of administrators</option>
            <option value="ALL">Required of everyone</option>
          </Select>
        </Field>
        <div className="rounded-md border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Single sign-on with the organisation&apos;s accounts (OpenID Connect)</label>
          <p className="mt-1 text-sm text-muted">Microsoft Entra ID (Office 365): issuer https://login.microsoftonline.com/&lt;tenant id&gt;/v2.0. Google Workspace: https://accounts.google.com. Register this redirect address with the provider: <code>{origin}/api/v1/auth/sso/callback</code>. People sign in with the email address their user has here.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Issuer"><Input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></Field>
            <Field label="Client (application) id"><Input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></Field>
            <Field label="Client secret" hint={sec.sso?.clientSecret ? `Stored: ${sec.sso.clientSecret}` : undefined}><Input type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></Field>
            <Field label="Allowed email domains" hint="Comma separated; empty allows any"><Input value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="tachwasco.co.ke" /></Field>
          </div>
        </div>
      </div>
    </Card>
  );
}

interface Rule {
  id: string;
  module: string;
  docType: string;
  name?: string;
  steps: { name: string; roles: string[]; userIds: string[]; minAmount: number; parallel?: boolean }[];
  active: boolean;
}

/** Document types modules send for approval; a chain set here replaces the module's default. */
const DOC_TYPES: Record<string, { value: string; label: string }[]> = {
  finance: [{ value: 'payment-voucher', label: 'Payment voucher' }, { value: 'journal', label: 'Journal' }, { value: 'imprest', label: 'Imprest request' }, { value: 'petty-cash', label: 'Petty cash' }, { value: 'budget', label: 'Budget' }, { value: 'budget-reallocation', label: 'Budget reallocation' }],
  procurement: [{ value: 'requisition', label: 'Purchase requisition' }, { value: 'lpo', label: 'Local purchase order' }, { value: 'store-requisition', label: 'Store requisition' }],
  hr: [{ value: 'leave', label: 'Leave request' }, { value: 'recruitment', label: 'Vacancy' }, { value: 'transfer', label: 'Transfer / promotion' }],
  fleet: [{ value: 'transport-request', label: 'Transport request' }],
  water: [{ value: 'refund', label: 'Customer refund' }],
};

function Approvals() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<ModuleRoles[]>('/roles') });
  const rules = useQuery({ queryKey: ['approval-rules'], queryFn: () => api.get<Rule[]>('/approvals/rules') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [edit, setEdit] = useState<{ module: string; docType: string; name: string; steps: { name: string; roles: string[]; userIds: string[]; minAmount: string; parallel?: boolean }[]; active: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => api.put('/approvals/rules', { ...edit!, steps: edit!.steps.map((x) => ({ ...x, minAmount: Number(x.minAmount || 0) })) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-rules'] });
      setEdit(null);
    },
  });
  const moduleRoles = roles.data?.find((m) => m.module === edit?.module)?.roles ?? [];
  return (
    <Card padded={false} title="Approval chains" actions={<Button onClick={() => setEdit({ module: roles.data?.[0]?.module ?? 'water', docType: '', name: '', steps: [{ name: 'Approval', roles: [], userIds: [], minAmount: '0' }], active: true })}>New chain</Button>}>
      <p className="px-4 pt-3 text-sm text-muted">Who approves each kind of document, in order. A step with an amount applies only to documents of that amount or more. Nobody approves their own document, and every decision is signed and kept.</p>
      <ErrorBox error={rules.error} />
      <table className="table-base">
        <thead><tr><th>Module</th><th>Document</th><th>Steps</th><th /></tr></thead>
        <tbody>
          {rules.data?.map((r) => (
            <tr key={r.id}>
              <td>{roles.data?.find((m) => m.module === r.module)?.name ?? r.module}</td>
              <td>{DOC_TYPES[r.module]?.find((d) => d.value === r.docType)?.label ?? r.docType}{!r.active && <Badge tone="gray">Off</Badge>}</td>
              <td className="text-sm">{r.steps.map((x) => `${x.name}${x.minAmount ? ` (from ${x.minAmount.toLocaleString()})` : ''}`).join(' → ')}</td>
              <td className="text-right"><Button variant="ghost" onClick={() => setEdit({ module: r.module, docType: r.docType, name: r.name ?? '', steps: r.steps.map((x) => ({ ...x, minAmount: String(x.minAmount ?? 0) })), active: r.active })}>Edit</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal open wide onClose={() => setEdit(null)} title="Approval chain" footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !edit.docType}>Save</Button>}>
          <ErrorBox error={save.error} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Module"><Select value={edit.module} onChange={(e) => setEdit({ ...edit, module: e.target.value, docType: '', steps: edit.steps.map((x) => ({ ...x, roles: [] })) })}>{roles.data?.map((m) => <option key={m.module} value={m.module}>{m.name}</option>)}</Select></Field>
            <Field label="Document">
              <Select value={edit.docType} onChange={(e) => setEdit({ ...edit, docType: e.target.value })}>
                <option value="">Choose…</option>
                {(DOC_TYPES[edit.module] ?? []).map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> In use</label>
          </div>
          {edit.steps.map((st, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line p-3">
              <div className="flex gap-2">
                <Field label={`Step ${i + 1}`} className="flex-1"><Input value={st.name} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
                <Field label="From amount (KES)"><Input inputMode="decimal" value={st.minAmount} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, minAmount: e.target.value } : x)) })} /></Field>
                <label className="flex items-center gap-1.5 self-end text-sm" title="Every named person signs, in any order; leave unticked for any one of them"><input type="checkbox" checked={Boolean(st.parallel)} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, parallel: e.target.checked } : x)) })} /> All named people sign (parallel)</label>
                <Button variant="ghost" className="self-end" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-xs text-muted">Roles:</span>
                {moduleRoles.map((r) => <label key={r.key} className="flex items-center gap-1"><input type="checkbox" checked={st.roles.includes(r.key)} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, roles: e.target.checked ? [...x.roles, r.key] : x.roles.filter((k) => k !== r.key) } : x)) })} />{r.label}</label>)}
              </div>
              <Field label="Or named people">
                <Select multiple value={st.userIds} className="h-24" onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, userIds: [...e.target.selectedOptions].map((o) => o.value) } : x)) })}>
                  {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { name: '', roles: [], userIds: [], minAmount: '0' }] })}>Add step</Button>
        </Modal>
      )}
    </Card>
  );
}

/** Who opened which record or downloaded which file, in every module. */
function AccessLog() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [q, setQ] = useState({ userId: '', kind: '', search: '' });
  const { data, error } = useQuery({ queryKey: ['access-log', q], queryFn: () => api.get<{ id: string; at: string; user: string; module: string; kind: string; path: string; ip?: string }[]>('/access-log', Object.fromEntries(Object.entries(q).filter(([, v]) => v))) });
  return (
    <Card padded={false} title="Access log: views and downloads" actions={<><Select value={q.userId} onChange={(e) => setQ({ ...q, userId: e.target.value })} className="w-48"><option value="">Everyone</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select><Select value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value })} className="w-36"><option value="">Views and downloads</option><option value="VIEW">Views</option><option value="DOWNLOAD">Downloads</option></Select><Input placeholder="Path contains" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} className="w-48" /></>}>
      <ErrorBox error={error} />
      <table className="table-base">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Module</th><th>Record or file</th><th>From</th></tr></thead>
        <tbody>{data?.map((r) => <tr key={r.id}><td className="whitespace-nowrap">{fmtDateTime(r.at)}</td><td>{r.user}</td><td>{r.kind === 'VIEW' ? 'Viewed' : 'Downloaded'}</td><td>{r.module}</td><td className="max-w-md truncate font-mono text-xs" title={r.path}>{r.path}</td><td className="text-xs">{r.ip ?? ''}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

function Audit() {
  const [q, setQ] = useState({ entity: '', page: 1 });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const { data, error } = useQuery({ queryKey: ['audit', q], queryFn: () => api.get<{ id: string; createdAt: string; userId?: string; action: string; entity?: string; entityId?: string; ip?: string; data?: unknown }[]>('/audit', { entity: q.entity, page: q.page, pageSize: 100 }) });
  const name = (id?: string) => users.data?.find((u) => u.id === id)?.name ?? (id ? '—' : 'System');
  return (
    <Card padded={false} title="Audit trail" actions={<><Input placeholder="Record type (payment, user, document…)" value={q.entity} onChange={(e) => setQ({ entity: e.target.value, page: 1 })} className="w-72" /><Button variant="secondary" disabled={q.page <= 1} onClick={() => setQ({ ...q, page: q.page - 1 })}>Newer</Button><Button variant="secondary" disabled={(data?.length ?? 0) < 100} onClick={() => setQ({ ...q, page: q.page + 1 })}>Older</Button></>}>
      <ErrorBox error={error} />
      <table className="table-base">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>From</th><th>Details</th></tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
              <td>{name(r.userId)}</td>
              <td className="font-mono text-xs">{r.action}</td>
              <td className="text-xs">{r.entity}{r.entityId ? ` ${r.entityId.slice(-6)}` : ''}</td>
              <td className="text-xs">{r.ip ?? ''}</td>
              <td className="max-w-md truncate font-mono text-xs" title={r.data ? JSON.stringify(r.data) : ''}>{r.data ? JSON.stringify(r.data) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('organisation');
  const { data, error, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  return (
    <>
      <PageHeader title="Settings" subtitle="Shared by every module" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'organisation', label: 'Organisation' },
          { id: 'modules', label: 'Modules' },
          { id: 'users', label: 'Users & roles' },
          { id: 'ledger', label: 'Ledger' },
          { id: 'sms', label: 'SMS' },
          { id: 'email', label: 'Email' },
          { id: 'security', label: 'Sign-in security' },
          { id: 'approvals', label: 'Approval chains' },
          { id: 'audit', label: 'Audit trail' },
          { id: 'developers', label: 'Developers' },
          { id: 'privacy', label: 'Data protection' },
        ]}
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <>
          {tab === 'organisation' && <Organisation s={data} />}
          {tab === 'modules' && <Modules />}
          {tab === 'users' && <div className="space-y-4"><Users /><CustomRoles /></div>}
          {tab === 'ledger' && <Ledger s={data} />}
          {tab === 'sms' && <Sms s={data} />}
          {tab === 'email' && <Email s={data} />}
          {tab === 'security' && <Security s={data} />}
          {tab === 'approvals' && <Approvals />}
          {tab === 'audit' && <div className="space-y-4"><Audit /><AccessLog /></div>}
          {tab === 'developers' && <Developers />}
          {tab === 'privacy' && <Privacy />}
        </>
      )}
    </>
  );
}
