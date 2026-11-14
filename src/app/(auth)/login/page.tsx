'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { landingPage } from '@/lib/navigation';
import { Me } from '@/lib/types';

type LoginResult = Me | { twoFactorRequired: true; ticket: string };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [org, setOrg] = useState('');
  const done = (me: Me) => {
    const next = params.get('next');
    if (me.mustEnrolTwoFactor) return router.replace('/account?enrol=1');
    router.replace(next && /^\/(?![\/\\])/.test(next) ? next : landingPage(me));
  };
  const login = useMutation({
    mutationFn: () => api.post<LoginResult>('/auth/login', { email, password }),
    onSuccess: (r) => ('twoFactorRequired' in r ? setTicket(r.ticket) : done(r)),
  });
  const second = useMutation({ mutationFn: () => api.post<Me>('/auth/login/2fa', { ticket, code }), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ticket) second.mutate();
    else login.mutate();
  };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <ErrorBox error={login.error || second.error} />
        {!ticket ? (
          <>
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
            <Field label="Code">
              <Input autoFocus inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" disabled={second.isPending}>
              Continue
            </Button>
            <button type="button" className="w-full text-sm text-brand-700" onClick={() => { setTicket(null); setCode(''); }}>
              Start again
            </button>
          </>
        )}
      </form>
      {!ticket && (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand-700">Sign in with your organisation account</summary>
          <div className="mt-2 flex gap-2">
            <Input placeholder="Organisation code" value={org} onChange={(e) => setOrg(e.target.value)} />
            <Button variant="secondary" disabled={!org} onClick={() => window.location.assign(`/api/v1/auth/sso/start?org=${encodeURIComponent(org)}&next=${encodeURIComponent(params.get('next') ?? '/')}`)}>
              Continue
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-white p-6 shadow-sm">
        <div className="mb-5">
          <div className="text-lg font-semibold">FarajaSoft</div>
          <p className="text-sm text-muted">One sign-in for every system</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
