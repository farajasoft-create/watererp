'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { landingPage } from '@/lib/navigation';
import { Me } from '@/lib/types';

type LoginResult = Me | { twoFactorRequired: true; ticket: string };
type Step = { kind: 'password' } | { kind: 'code'; ticket: string };

const ORG_KEY = 'farajasoft.sso.org';

/** Only paths on this site: never `//other.host` or `/\other.host`. */
function safeNext(next: string | null): string | null {
  return next && /^\/(?![/\\])/.test(next) ? next : null;
}

/** Turns a failed request into a sentence a person can act on. */
function describe(err: unknown, step: Step['kind']): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many sign-in attempts from this device. Wait a minute, then try again.';
    if (err.status >= 500) return 'The server ran into a problem. Try again in a moment; if it keeps happening, tell your system administrator.';
    if (err.status === 400) return step === 'code' ? 'Enter the 6-digit code from your app, or one of your recovery codes.' : 'Enter a valid email address and your password.';
    if (err.message === 'Authentication required') return 'This sign-in can no longer continue. Enter your password again.';
    return err.message;
  }
  if (err instanceof TypeError) return 'Can’t reach the server. Check your internet connection, then try again.';
  return 'The server sent an answer we couldn’t read. Try again in a moment.';
}

function readStoredOrg(): string {
  try {
    return window.localStorage.getItem(ORG_KEY) ?? '';
  } catch {
    return '';
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const ids = { email: useId(), password: useId(), caps: useId(), code: useId(), codeHint: useId(), org: useId() };

  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));
  const [leaving, setLeaving] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(Boolean(params.get('org')));
  // The last organisation code used on this device, so SSO users type it once. The form renders only in the
  // browser (useSearchParams under Suspense), so storage is there to read.
  const [org, setOrg] = useState(() => params.get('org') ?? (typeof window === 'undefined' ? '' : readStoredOrg()));

  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const orgRef = useRef<HTMLInputElement>(null);

  const goOn = (me: Me) => router.replace(me.mustEnrolTwoFactor ? '/account?enrol=1' : (next ?? landingPage(me)));
  const done = (me: Me) => {
    setLeaving(true);
    goOn(me);
  };

  // Someone already signed in (an old tab, the back button) goes straight on.
  const session = useQuery({ queryKey: ['login', 'session'], queryFn: () => api.get<Me>('/auth/me'), retry: false, staleTime: Infinity });
  useEffect(() => {
    if (session.data) goOn(session.data);
    // goOn only navigates; re-running it for the same session would navigate twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data]);

  const login = useMutation({
    mutationFn: () => api.post<LoginResult>('/auth/login', { email: email.trim(), password }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if ('twoFactorRequired' in r) {
        setStep({ kind: 'code', ticket: r.ticket });
        setCode('');
        setRecovery(false);
      } else done(r);
    },
    onError: (err) => {
      setError(describe(err, 'password'));
      if (err instanceof ApiError && err.status === 401) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
    },
  });

  const second = useMutation({
    mutationFn: (value: string) => api.post<Me>('/auth/login/2fa', { ticket: step.kind === 'code' ? step.ticket : '', code: value }),
    onMutate: () => setError(null),
    onSuccess: done,
    onError: (err) => {
      // A wrong code can be retried; an expired or refused ticket needs the password again.
      if (err instanceof ApiError && err.status === 401 && err.message !== 'The code is wrong') {
        setStep({ kind: 'password' });
        setPassword('');
        setError(describe(err, 'code'));
        setTimeout(() => passwordRef.current?.focus());
        return;
      }
      setError(describe(err, 'code'));
      setCode('');
      codeRef.current?.focus();
    },
  });

  useEffect(() => {
    if (step.kind === 'code') codeRef.current?.focus();
  }, [step.kind, recovery]);

  const busy = login.isPending || second.isPending || leaving || Boolean(session.data);

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) login.mutate();
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && code) second.mutate(code);
  };
  const changeCode = (value: string) => {
    const clean = recovery ? value.replace(/\s+/g, '').slice(0, 12) : value.replace(/\D/g, '').slice(0, 6);
    setCode(clean);
    // Six digits is a whole code: send it without making them reach for the button.
    if (!recovery && clean.length === 6 && !busy) second.mutate(clean);
  };
  const startSso = (e: FormEvent) => {
    e.preventDefault();
    const code = org.trim();
    if (!code) return orgRef.current?.focus();
    try {
      window.localStorage.setItem(ORG_KEY, code);
    } catch {
      // Private windows can refuse storage; remembering the code is only a convenience.
    }
    setLeaving(true);
    window.location.assign(`/api/v1/auth/sso/start?org=${encodeURIComponent(code)}&next=${encodeURIComponent(next ?? '/')}`);
  };
  const checkCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));

  if (step.kind === 'code') {
    return (
      <div className="login-step">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Two-step verification</h1>
        <p className="mt-2 text-[0.9375rem] text-muted">
          Open your authenticator app and enter the code for <span className="font-medium break-all text-ink">{email.trim()}</span>.
        </p>
        <form onSubmit={submitCode} className="mt-7 space-y-5" noValidate aria-busy={busy}>
          {error && <Alert>{error}</Alert>}
          <div>
            <label htmlFor={ids.code} className="login-label">
              {recovery ? 'Recovery code' : '6-digit code'}
            </label>
            <input
              ref={codeRef}
              id={ids.code}
              className="login-input text-center text-lg tracking-[0.35em] tabular-nums"
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={recovery ? 12 : 6}
              pattern={recovery ? undefined : '[0-9]{6}'}
              required
              disabled={busy}
              value={code}
              aria-describedby={ids.codeHint}
              aria-invalid={Boolean(error) || undefined}
              onChange={(e) => changeCode(e.target.value)}
            />
            <p id={ids.codeHint} className="mt-2 text-sm text-muted">
              {recovery ? 'Each recovery code works once. You saved them when you turned on two-step verification.' : 'The code changes every 30 seconds. It is sent as soon as you type the sixth digit.'}
            </p>
          </div>
          <SubmitButton busy={busy} disabled={!code}>
            {leaving ? 'Signing you in…' : second.isPending ? 'Checking…' : 'Verify and sign in'}
          </SubmitButton>
        </form>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <button
            type="button"
            className="login-link"
            disabled={busy}
            onClick={() => {
              setRecovery((r) => !r);
              setCode('');
              setError(null);
            }}
          >
            {recovery ? 'Use the code from my app' : 'Use a recovery code'}
          </button>
          <button
            type="button"
            className="login-link"
            disabled={busy}
            onClick={() => {
              setStep({ kind: 'password' });
              setPassword('');
              setError(null);
            }}
          >
            Use a different account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-step">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">Sign in</h1>
      <p className="mt-2 text-[0.9375rem] text-muted">{next && !error ? 'Sign in to continue to the page you were opening.' : 'Use the email address and password your organisation gave you.'}</p>

      <form onSubmit={submitPassword} className="mt-7 space-y-5" aria-busy={busy}>
        {error && <Alert>{error}</Alert>}
        <div>
          <label htmlFor={ids.email} className="login-label">
            Work email
          </label>
          <input
            id={ids.email}
            className="login-input"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            maxLength={254}
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={ids.password} className="login-label">
            Password
          </label>
          <div className="relative">
            <input
              ref={passwordRef}
              id={ids.password}
              className="login-input pe-12"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              maxLength={200}
              disabled={busy}
              value={password}
              aria-describedby={capsLock ? ids.caps : undefined}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={checkCaps}
              onKeyUp={checkCaps}
              onBlur={() => setCapsLock(false)}
            />
            <button
              type="button"
              className="absolute inset-y-0 end-0 grid w-12 place-items-center rounded-e-lg text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              aria-controls={ids.password}
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          {capsLock && (
            <p id={ids.caps} className="mt-2 flex items-center gap-1.5 text-sm text-amber-800" role="status">
              <CapsIcon /> Caps Lock is on
            </p>
          )}
        </div>
        <SubmitButton busy={busy}>{leaving ? 'Signing you in…' : login.isPending ? 'Signing in…' : 'Sign in'}</SubmitButton>
      </form>

      <p className="mt-4 text-sm text-muted">Forgotten your password? Your system administrator can reset it for you.</p>

      <div className="my-8 flex items-center gap-3 text-xs font-medium text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      {!ssoOpen ? (
        <button
          type="button"
          className="login-secondary"
          disabled={busy}
          onClick={() => {
            setSsoOpen(true);
            setTimeout(() => orgRef.current?.focus());
          }}
        >
          <BuildingIcon />
          Sign in with your organisation account
        </button>
      ) : (
        <form onSubmit={startSso} className="space-y-3" aria-busy={leaving}>
          <div>
            <label htmlFor={ids.org} className="login-label">
              Organisation code
            </label>
            <div className="flex gap-2">
              <input
                ref={orgRef}
                id={ids.org}
                className="login-input min-w-0 flex-1 uppercase placeholder:normal-case"
                autoComplete="organization"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={20}
                placeholder="e.g. TACHWASCO"
                required
                disabled={busy}
                value={org}
                onChange={(e) => setOrg(e.target.value.replace(/\s+/g, ''))}
              />
              <button type="submit" className="login-secondary w-auto shrink-0 px-5" disabled={busy || !org.trim()}>
                {leaving ? 'Opening…' : 'Continue'}
              </button>
            </div>
          </div>
          <p className="text-sm text-muted">You’ll sign in on your organisation’s own page (Microsoft 365 or Google), then come back here.</p>
        </form>
      )}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800">
      <AlertIcon />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}

function SubmitButton({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="login-primary" disabled={busy || disabled}>
      {busy && <Spinner />}
      <span>{children}</span>
    </button>
  );
}

/* Icons: one 1.75 stroke on a 20px grid, drawn here so the page needs no icon library. */
const iconProps = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function EyeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M1.75 10S4.75 4.25 10 4.25 18.25 10 18.25 10 15.25 15.75 10 15.75 1.75 10 1.75 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8.2 4.45A8.6 8.6 0 0 1 10 4.25c5.25 0 8.25 5.75 8.25 5.75a14.8 14.8 0 0 1-2.1 2.85M5.6 5.6C3.1 7.15 1.75 10 1.75 10S4.75 15.75 10 15.75a8.1 8.1 0 0 0 4.4-1.35" />
      <path d="M8.25 8.25a2.5 2.5 0 0 0 3.5 3.5M2.5 2.5l15 15" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg {...iconProps} className="mt-px shrink-0" width={18} height={18}>
      <circle cx="10" cy="10" r="7.75" />
      <path d="M10 6.25v4.25M10 13.6v.15" />
    </svg>
  );
}
function CapsIcon() {
  return (
    <svg {...iconProps} width={16} height={16}>
      <path d="M10 3 3.5 10H7v4h6v-4h3.5L10 3ZM7 17h6" />
    </svg>
  );
}
function BuildingIcon() {
  return (
    <svg {...iconProps} width={18} height={18}>
      <path d="M3.25 17.25V4.5a1.25 1.25 0 0 1 1.25-1.25h6.25a1.25 1.25 0 0 1 1.25 1.25v12.75M12 8h3.5a1.25 1.25 0 0 1 1.25 1.25v8M1.75 17.25h16.5M6.5 6.5h1.75M6.5 9.75h1.75M6.5 13h1.75" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#007bb6" />
      <path d="M32 12c-7 10-14 18-14 26a14 14 0 0 0 28 0c0-8-7-16-14-26z" fill="#fff" />
      <path d="M26 40a6 6 0 0 0 6 6" stroke="#007bb6" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Water lines: gentle swells that drift apart toward the bottom, drawn once when the page opens. */
const CONTOURS = Array.from({ length: 17 }, (_, i) => {
  const y = 70 + i * 46;
  const a = 14 + 12 * Math.sin(i * 0.7) + i * 1.4;
  const shift = 40 * Math.cos(i * 0.45);
  return `M-40 ${y} C ${110 + shift} ${y - a}, ${230 + shift} ${y + a}, ${340 + shift} ${y} S ${560 + shift} ${y - a * 0.8}, 680 ${y + a * 0.3}`;
});

function Waterlines() {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 640 860" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {CONTOURS.map((d, i) => (
        <path key={i} d={d} pathLength={1} className="login-contour" style={{ animationDelay: `${i * 70}ms`, opacity: 0.16 + (i / CONTOURS.length) * 0.3 }} />
      ))}
    </svg>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-brand-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <Waterlines />
        <div className="relative flex items-center gap-3">
          <Mark className="h-9 w-9" />
          <span className="text-lg font-semibold tracking-tight">FarajaSoft</span>
        </div>
        <div className="relative max-w-md">
          <p className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance xl:text-5xl">One sign-in for every system</p>
          <p className="mt-5 max-w-sm text-base leading-relaxed text-brand-100">Water billing, finance, HR, procurement and the rest of the organisation’s work, in one place.</p>
        </div>
        <p className="relative text-sm text-brand-200">© {new Date().getFullYear()} FarajaSoft</p>
      </aside>

      <main className="flex flex-col px-4 py-8 sm:px-8 lg:px-12">
        <div className="flex items-center gap-2.5 lg:hidden">
          <Mark className="h-8 w-8" />
          <span className="font-semibold tracking-tight">FarajaSoft</span>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[24rem]">
            <Suspense>
              <LoginForm />
            </Suspense>
          </div>
        </div>
        <p className="text-center text-xs text-muted lg:hidden">One sign-in for every system</p>
      </main>
    </div>
  );
}
