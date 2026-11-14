'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDateTime } from '@/modules/finance/ui/lib/format';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, Input, Loading, Notice, PageHeader } from './ui';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <div className="space-y-3">
      <Notice tone="amber">Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They will not be shown again.</Notice>
      <div className="grid grid-cols-2 gap-2 rounded-md border border-line bg-gray-50 p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => navigator.clipboard?.writeText(text)}>Copy</Button>
        <Button
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([`FarajaSoft recovery codes\n\n${text}\n`], { type: 'text/plain' }));
            a.download = 'farajasoft-recovery-codes.txt';
            a.click();
          }}
        >
          Download
        </Button>
        <Button variant="primary" className="ml-auto" onClick={onDone}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}

/** Scan the QR code, confirm with a first code, then save the recovery codes. */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['mfa-setup'], queryFn: () => api.post<{ secret: string; otpauthUri: string; qrCode: string }>('/auth/mfa/setup'), staleTime: Infinity, gcTime: 0, retry: false });
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
    onError: (err) => setError(errorMessage(err)),
  });
  if (codes) return <RecoveryCodes codes={codes} onDone={() => (queryClient.invalidateQueries({ queryKey: ['me'] }), onDone())} />;
  if (setup.isLoading || !setup.data) return setup.error ? <ErrorBanner error={setup.error} /> : <Loading />;
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setError(null);
        enable.mutate();
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
        <li>Scan this code, or enter the key by hand.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
        <img src={setup.data.qrCode} alt="QR code for your authenticator app" width={180} height={180} className="rounded-md border border-line" />
        <div className="text-sm">
          <p className="text-muted">Key</p>
          <p className="font-mono text-base tracking-wider">{setup.data.secret}</p>
          <p className="mt-2 text-xs text-muted">Time-based · 6 digits · 30 seconds</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="flex items-end gap-2">
        <Field label="Code from the app">
          <Input autoFocus required inputMode="numeric" autoComplete="one-time-code" className="w-36 text-center font-mono text-lg tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </Field>
        <Button variant="primary" type="submit" loading={enable.isPending} disabled={code.length !== 6}>
          Turn on
        </Button>
      </div>
    </form>
  );
}

/** Shown instead of the app when the organisation requires two-step verification and the user has none. */
export function MfaEnrollmentGate({ organisationName, onSignOut }: { organisationName: string; onSignOut: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card title="Set up two-step verification">
        <p className="mb-4 text-sm text-muted">{organisationName} requires two-step verification for every user. It takes a minute, and protects the books if your password is ever stolen.</p>
        <MfaSetup onDone={() => window.location.reload()} />
      </Card>
      <p className="mt-3 text-center text-sm">
        <button className="text-muted hover:underline" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    </div>
  );
}

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  method: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const device = (ua: string | null) => {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser or API client';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
};

export function SecurityPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<null | 'setup' | 'disable' | 'codes'>(null);
  const [form, setForm] = useState({ password: '', code: '' });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions') });
  const refresh = () => (queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['sessions'] }));
  const act = useMutation({
    mutationFn: async (action: 'disable' | 'codes' | 'password' | 'revoke-all' | { revoke: string }) => {
      if (action === 'disable') return api.post('/auth/mfa/disable', form);
      if (action === 'codes') return api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { code: form.code });
      if (action === 'password') {
        if (pw.newPassword !== pw.confirm) throw new Error('The new passwords do not match');
        return api.post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      }
      if (action === 'revoke-all') return api.post('/auth/logout-all');
      return api.post(`/auth/sessions/${action.revoke}/revoke`);
    },
    onSuccess: (r, action) => {
      setError(null);
      if (action === 'codes') setCodes((r as { recoveryCodes: string[] }).recoveryCodes);
      if (action === 'disable') setNotice('Two-step verification is off.');
      if (action === 'password') {
        setNotice('Password changed. Your other sessions were signed out.');
        setPw({ currentPassword: '', newPassword: '', confirm: '' });
      }
      if (action === 'revoke-all') window.location.href = '/login';
      setMode(action === 'codes' ? 'codes' : null);
      setForm({ password: '', code: '' });
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <>
      <PageHeader title="Account security" description={`${me.name} · ${me.email}`} />
      {notice && <div className="mb-3"><Notice tone="green">{notice}</Notice></div>}
      <ErrorBanner error={error} className="mb-3" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span>Two-step verification {me.mfaEnabled ? <Badge tone="green">on</Badge> : <Badge tone="gray">off</Badge>}</span>}>
          {mode === 'setup' ? (
            <MfaSetup onDone={() => (setMode(null), setNotice('Two-step verification is on.'), refresh())} />
          ) : mode === 'codes' && codes ? (
            <RecoveryCodes codes={codes} onDone={() => (setMode(null), setCodes(null))} />
          ) : !me.mfaEnabled ? (
            <div className="space-y-3 text-sm">
              <p className="text-muted">Ask for a code from your phone after your password, so a stolen password alone cannot open the books.</p>
              <Button variant="primary" onClick={() => (setError(null), setMode('setup'))}>Set up two-step verification</Button>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <p>Signing in asks for a code from your authenticator app. {me.recoveryCodesLeft} recovery code{me.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
              {me.recoveryCodesLeft < 3 && <Notice tone="amber">You are running out of recovery codes. Generate new ones.</Notice>}
              {mode === 'disable' || mode === 'codes' ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act.mutate(mode);
                  }}
                >
                  {mode === 'disable' && <Field label="Password"><Input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>}
                  <Field label="Code from the app"><Input required inputMode="numeric" className="w-32 font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
                  <Button type="submit" variant={mode === 'disable' ? 'danger' : 'primary'} loading={act.isPending}>{mode === 'disable' ? 'Turn off' : 'Generate new codes'}</Button>
                  <Button type="button" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
                </form>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={() => (setError(null), setMode('codes'))}>New recovery codes</Button>
                  {!me.organisation.settings.requireMfa && <Button variant="danger" onClick={() => (setError(null), setMode('disable'))}>Turn off</Button>}
                </div>
              )}
              {me.organisation.settings.requireMfa && <p className="text-xs text-muted">Your organisation requires two-step verification.</p>}
            </div>
          )}
        </Card>

        <Card title="Password">
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate('password');
            }}
          >
            <Field label="Current password" className="sm:col-span-2"><Input type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
            <Field label="New password" hint="At least 10 characters, with a letter and a digit"><Input type="password" autoComplete="new-password" required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
            <Field label="Repeat new password"><Input type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Button type="submit" loading={act.isPending && act.variables === 'password'}>Change password</Button></div>
          </form>
        </Card>
      </div>

      <Card title="Mobile number" className="mt-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const phone = String(new FormData(e.currentTarget).get('phone') ?? '');
            api.patch('/auth/preferences', { phone }).then(refresh, (err) => setError(errorMessage(err)));
          }}
        >
          <Field label="Safaricom number">
            <Input name="phone" inputMode="tel" defaultValue={me.phone ?? ''} placeholder="0712 345 678" className="w-48" />
          </Field>
          <Button type="submit">Save</Button>
          <p className="pb-2 text-xs text-muted">Approved expense claims can be reimbursed to this number by M-Pesa.</p>
        </form>
      </Card>

      <Card title="Email notifications" className="mt-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Approvals, escalations and outcomes of what I submit">
            <select
              className="h-9 rounded-md border border-line bg-white px-3 text-sm"
              value={me.emailPreferences?.approvals ?? 'immediate'}
              onChange={(e) => api.patch('/auth/preferences', { approvals: e.target.value }).then(refresh, (err) => setError(errorMessage(err)))}
            >
              <option value="immediate">Email me straight away</option>
              <option value="digest">One daily summary</option>
              <option value="off">Don&apos;t email me (in-app only)</option>
            </select>
          </Field>
          <p className="pb-2 text-xs text-muted">Notifications always appear under the bell in the app as well.</p>
        </div>
        {me.smsApprovalAlerts && (
          <div className="mt-3">
            <Checkbox
              label={me.phone ? `Also text me at ${me.phone} when something is waiting for my approval` : 'Text me when something is waiting for my approval (add your mobile number above first)'}
              checked={!!me.smsPreferences?.approvals}
              disabled={!me.phone}
              onChange={(v) => api.patch('/auth/preferences', { smsApprovals: v }).then(refresh, (err) => setError(errorMessage(err)))}
            />
          </div>
        )}
      </Card>

      <Card
        title="Where you are signed in"
        className="mt-5"
        padded={false}
        actions={<Button size="sm" variant="danger" onClick={() => act.mutate('revoke-all')}>Sign out everywhere</Button>}
      >
        {sessions.isLoading ? (
          <Loading />
        ) : (
          <table className="table-base">
            <thead><tr><th>Device</th><th>Address</th><th>Signed in</th><th>Last active</th><th>Method</th><th /></tr></thead>
            <tbody>
              {sessions.data?.map((s) => (
                <tr key={s.id}>
                  <td>{device(s.userAgent)} {s.current && <Badge tone="blue">this device</Badge>}</td>
                  <td className="font-mono text-xs">{s.ip ?? '—'}</td>
                  <td className="text-xs">{formatDateTime(s.createdAt)}</td>
                  <td className="text-xs">{formatDateTime(s.lastSeenAt)}</td>
                  <td className="text-xs">{s.method === 'mfa' ? 'Password + code' : s.method === 'recovery_code' ? 'Recovery code' : 'Password'}</td>
                  <td className="text-right">{!s.current && <Button size="sm" variant="ghost" onClick={() => act.mutate({ revoke: s.id })}>Sign out</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
