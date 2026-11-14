'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

function TwoFactor() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState({ password: '', code: '' });
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup'), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const disable = useMutation({ mutationFn: () => api.post('/auth/2fa/disable', off), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  return (
    <Card title="Two-step sign-in">
      <div className="space-y-3">
        <ErrorBox error={start.error || enable.error || disable.error} />
        {me?.mustEnrolTwoFactor && <Notice tone="amber">Your organisation requires two-step sign-in. Set it up to continue.</Notice>}
        {codes && (
          <Notice tone="green">
            <p className="font-medium">Two-step sign-in is on. Keep these recovery codes somewhere safe; each works once if you lose your phone:</p>
            <pre className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
          </Notice>
        )}
        {me?.twoFactorEnabled && !codes ? (
          <>
            <p className="text-sm">On. You are asked for a code from your authenticator app after your password.</p>
            {!me.mustEnrolTwoFactor && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Password"><Input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></Field>
                <Field label="Code from the app"><Input inputMode="numeric" value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} /></Field>
                <Button variant="secondary" onClick={() => disable.mutate()} disabled={!off.password || off.code.length !== 6}>Turn off</Button>
              </div>
            )}
          </>
        ) : !setup ? (
          !codes && (
            <>
              <p className="text-sm">Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) to your password.</p>
              <Button onClick={() => start.mutate()} disabled={start.isPending}>Set up</Button>
            </>
          )
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>In the app, add an account and choose to enter a setup key (or, on this phone, <a className="text-brand-700 underline" href={setup.otpauthUrl}>open it in the app</a>).</li>
              <li>Account: your email. Key: <code className="select-all rounded bg-slate-100 px-1 font-mono">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code> (time based).</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div className="flex items-end gap-2">
              <Field label="Code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <Button onClick={() => enable.mutate()} disabled={code.length !== 6 || enable.isPending}>Turn on</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function Password() {
  const [f, setF] = useState({ current: '', next: '' });
  const save = useMutation({ mutationFn: () => api.post('/auth/password', f), onSuccess: () => setF({ current: '', next: '' }) });
  return (
    <Card title="Password">
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Password changed; other devices are signed out.</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password (10 characters or more)"><Input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Button onClick={() => save.mutate()} disabled={!f.current || f.next.length < 10 || save.isPending}>Change</Button>
      </div>
    </Card>
  );
}

export default function AccountPage() {
  const { data: me } = useMe();
  return (
    <>
      <PageHeader title="My account" subtitle={me ? `${me.name} · ${me.email}` : undefined} />
      <div className="space-y-4">
        <TwoFactor />
        <Password />
      </div>
    </>
  );
}
