'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDateTime } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Notice, PageHeader, Select, TableWrap, Textarea } from './ui';
import { useDirectory } from './workflow';

interface SsoSettings {
  enabled: boolean;
  protocol: 'OIDC' | 'SAML';
  label: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  saml: { entryPoint: string; idpIssuer: string; hasCertificate: boolean; entityId: string; acs: string; metadata: string };
  allowedDomains: string[];
  allowPasswordLogin: boolean;
}

type SsoForm = Omit<SsoSettings, 'allowedDomains' | 'hasClientSecret' | 'saml'> & { domains: string; clientSecret: string; entryPoint: string; idpIssuer: string; idpCert: string };

/** Single sign-on for the organisation: OpenID Connect or SAML 2.0. */
export function SsoSettingsCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['sso-settings'], queryFn: () => api.get<SsoSettings>('/organisation/sso') });
  const [form, setForm] = useState<SsoForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const f: SsoForm | null = form ?? (data ? { ...data, domains: data.allowedDomains.join(', '), clientSecret: '', entryPoint: data.saml.entryPoint, idpIssuer: data.saml.idpIssuer, idpCert: '' } : null);
  const save = useMutation({
    mutationFn: () =>
      api.patch<SsoSettings>('/organisation/sso', {
        enabled: f!.enabled,
        protocol: f!.protocol,
        label: f!.label,
        issuer: f!.issuer,
        clientId: f!.clientId,
        ...(f!.clientSecret && { clientSecret: f!.clientSecret }),
        ...(f!.protocol === 'SAML' && { saml: { entryPoint: f!.entryPoint, idpIssuer: f!.idpIssuer, idpCert: f!.idpCert } }),
        allowedDomains: f!.domains.split(/[\s,;]+/).filter(Boolean),
        allowPasswordLogin: f!.allowPasswordLogin,
      }),
    onSuccess: () => (setError(null), setSaved(true), setForm(null), queryClient.invalidateQueries({ queryKey: ['sso-settings'] })),
    onError: (err) => (setSaved(false), setError(errorMessage(err))),
  });
  if (!f || !data) return <Card title="Single sign-on"><Loading /></Card>;
  const set = (p: Partial<SsoForm>) => (setSaved(false), setForm({ ...f, ...p }));
  const callback = typeof window !== 'undefined' ? `${window.location.origin}/api/v1/finance/auth/sso/callback` : '';
  const code = (v: string) => <code className="break-all rounded bg-gray-100 px-1">{v}</code>;
  return (
    <Card title={<span>Single sign-on {data.enabled ? <Badge tone="green">on</Badge> : <Badge tone="gray">off</Badge>}</span>}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button size="sm" variant={f.protocol === 'OIDC' ? 'primary' : 'secondary'} onClick={() => set({ protocol: 'OIDC' })}>OpenID Connect</Button>
          <Button size="sm" variant={f.protocol === 'SAML' ? 'primary' : 'secondary'} onClick={() => set({ protocol: 'SAML' })}>SAML 2.0</Button>
        </div>
        {f.protocol === 'OIDC' ? (
          <p className="text-xs text-muted">
            Let people sign in with your identity provider (Microsoft Entra ID, Google Workspace, Okta or any OpenID Connect provider). Register FarajaSoft as a web application there with this redirect URI: {code(callback)}. Only people who already have a user here can sign in; roles and permissions stay in FarajaSoft.
          </p>
        ) : (
          <p className="text-xs text-muted">
            For identity providers that speak SAML (ADFS, Entra ID, Okta, Google, JumpCloud). Create an application there with entity ID {code(data.saml.entityId)} and reply (ACS) URL {code(data.saml.acs)}, or import the metadata from {code(data.saml.metadata)}. Send the email address as the NameID (or an email attribute) and sign the assertions.
          </p>
        )}
        <ErrorBanner error={error} />
        {saved && <Notice tone="green">Saved.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          {f.protocol === 'OIDC' ? (
            <>
              <Field label="Issuer URL" hint="e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 or https://accounts.google.com">
                <Input value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} />
              </Field>
              <Field label="Button label"><Input value={f.label} placeholder="Microsoft" onChange={(e) => set({ label: e.target.value })} /></Field>
              <Field label="Client ID"><Input value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} /></Field>
              <Field label="Client secret" hint={data.hasClientSecret ? 'Stored (encrypted). Enter a new one to replace it.' : 'Stored encrypted; never shown again'}>
                <Input type="password" autoComplete="off" value={f.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Identity provider sign-in URL" hint="The SAML single sign-on (redirect binding) URL">
                <Input value={f.entryPoint} onChange={(e) => set({ entryPoint: e.target.value })} />
              </Field>
              <Field label="Button label"><Input value={f.label} placeholder="Company login" onChange={(e) => set({ label: e.target.value })} /></Field>
              <Field label="Identity provider entity ID" hint="Optional; responses from any other issuer are refused">
                <Input value={f.idpIssuer} onChange={(e) => set({ idpIssuer: e.target.value })} />
              </Field>
              <Field label="Signing certificate" hint={data.saml.hasCertificate ? 'Saved. Paste a new one to replace it (e.g. when the provider rotates it).' : 'The PEM certificate the provider signs assertions with'} className="sm:col-span-2">
                <Textarea rows={4} className="font-mono text-xs" value={f.idpCert} placeholder="-----BEGIN CERTIFICATE-----" onChange={(e) => set({ idpCert: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Email domains that use SSO" className="sm:col-span-2" hint="Separate with commas, e.g. faraja.co.ke, faraja.ug">
            <Input value={f.domains} onChange={(e) => set({ domains: e.target.value })} />
          </Field>
        </div>
        <Checkbox label="Enable single sign-on" checked={f.enabled} onChange={(v) => set({ enabled: v })} />
        <Checkbox label="Still allow password sign-in for these domains (administrators can always use their password)" checked={f.allowPasswordLogin} onChange={(v) => set({ allowPasswordLogin: v })} />
        <div className="flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save single sign-on</Button>
        </div>
      </div>
    </Card>
  );
}

interface ScimSettings {
  enabled: boolean;
  baseUrl: string;
  hasToken: boolean;
  defaultRoleIds: string[];
  lastUsedAt: string | null;
  token?: string;
}

/** SCIM 2.0: the identity provider creates, updates and deactivates users. */
export function ScimSettingsCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['scim-settings'], queryFn: () => api.get<ScimSettings>('/organisation/scim') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ id: string; name: string; permissions: string[] }[]>('/roles') });
  const [form, setForm] = useState<{ enabled: boolean; defaultRoleIds: string[] } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = form ?? (data ? { enabled: data.enabled, defaultRoleIds: data.defaultRoleIds } : null);
  const save = useMutation({
    mutationFn: (rotateToken: boolean) => api.patch<ScimSettings>('/organisation/scim', { ...f!, rotateToken }),
    onSuccess: (res) => (setError(null), setForm(null), setToken(res.token ?? null), queryClient.setQueryData(['scim-settings'], res)),
    onError: (err) => setError(errorMessage(err)),
  });
  if (!f || !data) return <Card title="User provisioning (SCIM)"><Loading /></Card>;
  const assignable = (roles.data ?? []).filter((r) => !r.permissions.includes('users.manage') && !r.permissions.includes('org.manage'));
  return (
    <Card title={<span>User provisioning (SCIM) {data.enabled ? <Badge tone="green">on</Badge> : <Badge tone="gray">off</Badge>}</span>}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          Your identity provider creates people here, keeps their name and email in step and deactivates leavers. Use the SCIM URL <code className="break-all rounded bg-gray-100 px-1">{data.baseUrl}</code> with the token below. New people get the roles chosen here and sign in through single sign-on; administrator roles are always granted by hand.
          {data.lastUsedAt && ` Last used ${formatDateTime(data.lastUsedAt)}.`}
        </p>
        <ErrorBanner error={error} />
        {token && (
          <Notice tone="amber">
            Token (shown once; paste it into the identity provider): <span className="select-all break-all font-mono text-xs">{token}</span>
          </Notice>
        )}
        <Field label="Roles for new people">
          <div className="flex flex-wrap gap-3">
            {assignable.map((r) => (
              <Checkbox key={r.id} label={r.name} checked={f.defaultRoleIds.includes(r.id)} onChange={(v) => setForm({ ...f, defaultRoleIds: v ? [...f.defaultRoleIds, r.id] : f.defaultRoleIds.filter((x) => x !== r.id) })} />
            ))}
          </div>
        </Field>
        <Checkbox label="Accept provisioning from the identity provider" checked={f.enabled} onChange={(v) => setForm({ ...f, enabled: v })} />
        <div className="flex justify-end gap-2">
          {data.hasToken && <Button variant="ghost" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>New token</Button>}
          <Button variant="primary" loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save provisioning</Button>
        </div>
      </div>
    </Card>
  );
}

/** Email delivery status, a test email and the link to the email log. */
export function EmailSettingsCard() {
  const { data } = useQuery({ queryKey: ['emails', 'status'], queryFn: () => api.get<{ driver: string; items: unknown[] }>('/emails', { limit: 1 }) });
  const [result, setResult] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<{ status: string; lastError: string; provider: string }>('/emails/test'),
    onSuccess: (r) => setResult(r.status === 'SENT' ? (r.provider === 'capture' ? 'Captured in the email log (no provider configured).' : 'Sent. Check your inbox.') : `Not sent yet: ${r.lastError || r.status}`),
    onError: (err) => setResult(errorMessage(err)),
  });
  return (
    <Card title="Email">
      <div className="space-y-2 text-sm">
        {data?.driver === 'capture' ? (
          <Notice tone="amber">No email provider is configured (RESEND_API_KEY), so emails are kept in the email log instead of being sent.</Notice>
        ) : (
          <p className="text-muted">Emails are sent through Resend.</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>Send me a test email</Button>
          <Link href="/finance/setup/emails" className="text-xs text-brand-700 hover:underline">Email log</Link>
          {result && <span className="text-xs text-muted">{result}</span>}
        </div>
      </div>
    </Card>
  );
}

/** Who receives the monthly management pack for the current entity. */
export function PackSubscriptionCard() {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const { data: directory } = useDirectory();
  const subs = useQuery({ queryKey: ['report-subscriptions'], queryFn: () => api.get<{ entityId: string; userIds: string[]; dayOfMonth: number; isActive: boolean; lastSentFor: string | null }[]>('/report-subscriptions') });
  const current = subs.data?.find((s) => s.entityId === entity?.id);
  const [form, setForm] = useState<{ userIds: string[]; dayOfMonth: number; isActive: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = form ?? { userIds: current?.userIds ?? [], dayOfMonth: current?.dayOfMonth ?? 5, isActive: current?.isActive ?? true };
  const save = useMutation({
    mutationFn: () => api.patch('/report-subscriptions', { entityId: entity!.id, ...f }),
    onSuccess: () => (setError(null), setForm(null), queryClient.invalidateQueries({ queryKey: ['report-subscriptions'] })),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Card title={`Monthly management pack — ${entity?.code ?? ''}`}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">The previous month&apos;s pack is emailed on the chosen day. Each person&apos;s copy contains only what their role can see.{current?.lastSentFor && ` Last sent for ${current.lastSentFor}.`}</p>
        <ErrorBanner error={error} />
        <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2">
          {directory?.users.map((u) => (
            <Checkbox key={u.id} label={u.name} checked={f.userIds.includes(u.id)} onChange={(v) => setForm({ ...f, userIds: v ? [...f.userIds, u.id] : f.userIds.filter((x) => x !== u.id) })} />
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Send on day">
            <Select value={f.dayOfMonth} onChange={(e) => setForm({ ...f, dayOfMonth: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (<option key={d} value={d}>{d}</option>))}
            </Select>
          </Field>
          <Checkbox label="Active" checked={f.isActive} onChange={(v) => setForm({ ...f, isActive: v })} />
          <Button className="ml-auto" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </div>
    </Card>
  );
}

export function EmailLogPage() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['emails', status], queryFn: () => api.get<{ driver: string; items: { id: string; to: string[]; subject: string; category: string; status: string; attempts: number; lastError: string; createdAt: string; sentAt: string | null; text: string | null }[] }>('/emails', { status: status || undefined, limit: 100 }) });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Email log" description="Emails the system sent or tried to send for your organisation in the last six months. Password-reset links are hidden once a real email provider is configured." />
      {data?.driver === 'capture' && <div className="mb-3"><Notice tone="amber">No email provider is configured: these emails were captured, not delivered. Set RESEND_API_KEY and EMAIL_FROM to send them.</Notice></div>}
      <Select className="mb-3 w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="">All</option>
        <option value="PENDING">Pending</option>
        <option value="SENT">Sent</option>
        <option value="FAILED">Failed</option>
      </Select>
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No emails yet" />
        ) : (
          <table className="table-base">
            <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="cursor-pointer align-top" onClick={() => setOpen(open === m.id ? null : m.id)}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(m.createdAt)}</td>
                  <td className="text-xs">{m.to.join(', ')}</td>
                  <td>
                    {m.subject}
                    {open === m.id && <pre className="mt-2 whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-muted">{m.text ?? '(content hidden)'}</pre>}
                  </td>
                  <td className="text-xs">{m.category}</td>
                  <td>
                    <Badge tone={m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : 'amber'}>{m.status.toLowerCase()}</Badge>
                    {m.lastError && <p className="text-[11px] text-red-700">{m.lastError}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}
