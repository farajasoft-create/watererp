'use client';

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect } from 'react';
import { errorMessage } from '@/lib/api';
import { fmtMoney, label } from '@/lib/format';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
    secondary: 'bg-white text-ink border border-line hover:bg-slate-50 disabled:text-muted',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost: 'text-brand-700 hover:bg-brand-50',
  };
  return <button type="button" {...props} className={cx('inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed', styles[variant], className)} />;
}

const inputClass = 'w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, 'pr-7', props.className)}>
      {children}
    </select>
  );
}

export function Field({ label: text, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted">{text}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-line bg-white', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-200',
  gray: 'bg-slate-50 text-slate-600 ring-slate-200',
};

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  ACTIVE: 'green', APPROVED: 'green', POSTED: 'green', ISSUED: 'green', SENT: 'green', INSTALLED: 'green', RECONNECTED: 'green', OPEN: 'blue', GOOD: 'green',
  APPLIED: 'blue', DRAFT: 'blue', PENDING: 'amber', LISTED: 'amber', NOTICE_SENT: 'amber', APPROVING: 'amber', UNMATCHED: 'amber', IN_STORE: 'blue', ACCEPTABLE: 'amber', BILLED: 'gray', CLOSED: 'gray',
  DISCONNECTED: 'red', REJECTED: 'red', FAILED: 'red', REVERSED: 'red', FAULTY: 'red', CANCELLED: 'gray', SKIPPED: 'gray', NOT_SENT: 'gray', REMOVED: 'gray', UNACCEPTABLE: 'red',
  PAID: 'green', SUSPENDED: 'amber', TERMINATED: 'gray',
  ASSIGNED: 'blue', IN_PROGRESS: 'amber', RESOLVED: 'green', REOPENED: 'red', COMPLETED: 'green', DEFAULTED: 'red', SPLIT: 'gray', DONE: 'green', ON_HOLD: 'amber',
  PASS: 'green', FAIL: 'red', OVERDUE: 'red', SUBMITTED: 'amber', RECEIVED: 'green', ISSUED_OUT: 'gray', VOID: 'gray', CLOSED_OUT: 'gray', PUBLISHED: 'green', ARCHIVED: 'gray',
  HIGH: 'red', LOW: 'amber', ZERO: 'amber', NEGATIVE: 'red', ROLLOVER: 'amber', NO_ACCESS: 'amber', METER_FAULTY: 'red', METER_TAMPERED: 'red', NONE: 'gray', ESTIMATED: 'amber', ACTUAL: 'gray',
};

export function Badge({ value, tone, children }: { value?: string | null; tone?: keyof typeof TONES; children?: ReactNode }) {
  const t = tone ?? (value ? STATUS_TONE[value] : undefined) ?? 'gray';
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap', TONES[t])}>{children ?? label(value)}</span>;
}

export function Money({ value, className }: { value: string | number | null | undefined; className?: string }) {
  const n = Number(value ?? 0);
  return <span className={cx('tabular-nums', n < 0 && 'text-emerald-700', className)}>{fmtMoney(value)}</span>;
}

export function Stat({ label: text, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <div className="text-xs font-medium text-muted">{text}</div>
      <div className={cx('mt-1 text-xl font-semibold tabular-nums', tone === 'good' && 'text-emerald-700', tone === 'warn' && 'text-amber-700', tone === 'bad' && 'text-red-700')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage(error)}</div>;
}

export function Notice({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'amber' | 'green' }) {
  const t = { blue: 'border-brand-200 bg-brand-50 text-brand-800', amber: 'border-amber-200 bg-amber-50 text-amber-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-800' }[tone];
  return <div className={cx('rounded-md border px-3 py-2 text-sm', t)}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Loading() {
  return <div className="px-4 py-10 text-center text-sm text-muted">Loading…</div>;
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="space-y-3 p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between px-4 py-2 text-xs text-muted">
      <span>
        {total === 0 ? 'No records' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()}`}
      </span>
      <div className="flex gap-1">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
