'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { api } from '@/lib/api';
import { menuFor } from '@/lib/navigation';
import { useMe } from '@/lib/session';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const menu = menuFor(me);
  const current = menu.find((s) => pathname === s.module.home || pathname.startsWith(`/${s.module.key}/`));
  // Exact match for a module's home page, prefix match for everything under it.
  const active = (href: string) => (menu.some((s) => s.module.home === href) ? pathname === href : pathname.startsWith(href));
  const isAdmin = Boolean(me?.isAdmin);
  // Until two-step sign-in is set up (when required), My account is the only page.
  useEffect(() => {
    if (me?.mustEnrolTwoFactor && pathname !== '/account') router.replace('/account?enrol=1');
  }, [me?.mustEnrolTwoFactor, pathname, router]);

  const logout = async () => {
    await api.post('/auth/logout');
    router.replace('/login');
  };

  const linkClass = (on: boolean) => `block rounded-md px-3 py-1.5 text-sm ${on ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50'}`;

  return (
    <div className="min-h-screen lg:flex">
      <aside className={`no-print fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-white transition-transform lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="border-b border-line px-4 py-4">
          <Link href="/" className="font-semibold">
            FarajaSoft{current && <span className="text-brand-600"> {current.module.name}</span>}
          </Link>
          <div className="truncate text-xs text-muted">{me?.organisation?.name ?? '…'}</div>
        </div>
        <nav className="flex-1 space-y-3 overflow-y-auto p-2">
          <Link href="/" onClick={() => setOpen(false)} className={linkClass(pathname === '/')}>
            Home
          </Link>
          <div className="space-y-0.5">
            <Link href="/approvals" onClick={() => setOpen(false)} className={linkClass(pathname.startsWith('/approvals'))}>Approvals</Link>
            <Link href="/tasks" onClick={() => setOpen(false)} className={linkClass(pathname.startsWith('/tasks'))}>Tasks</Link>
            <Link href="/documents" onClick={() => setOpen(false)} className={linkClass(pathname.startsWith('/documents'))}>Documents</Link>
          </div>
          {menu.map((section) => {
            const expanded = section === current || menu.length === 1;
            return (
              <div key={section.module.key}>
                <Link href={section.module.home} onClick={() => setOpen(false)} className="block px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted hover:text-brand-700">
                  {section.module.name}
                </Link>
                {expanded && (
                  <div className="space-y-0.5">
                    {section.items.map((n) => (
                      <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={linkClass(active(n.href))}>
                        {n.label}
                      </Link>
                    ))}
                    {section.links.map((n) => (
                      <Link key={n.href} href={n.href} className="mt-2 block rounded-md border border-dashed border-brand-300 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
                        {n.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {isAdmin && (
            <div>
              <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">Platform</div>
              <Link href="/settings" onClick={() => setOpen(false)} className={linkClass(pathname.startsWith('/settings'))}>
                Settings & users
              </Link>
            </div>
          )}
        </nav>
        <div className="border-t border-line p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <Link href="/account" className="truncate font-medium hover:text-brand-700">{me?.name}</Link>
            <NotificationBell />
          </div>
          <div className="truncate text-muted">{me?.isAdmin ? 'Administrator' : me?.access.map((a) => a.roleLabel).join(', ')}</div>
          <button type="button" onClick={logout} className="mt-1 text-brand-700 hover:underline">
            Sign out
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="min-w-0 flex-1">
        <div className="no-print flex items-center gap-2 border-b border-line bg-white px-4 py-2 lg:hidden">
          <button type="button" onClick={() => setOpen(true)} className="rounded border border-line px-2 py-1 text-sm" aria-label="Menu">
            ☰
          </button>
          <span className="text-sm font-semibold">FarajaSoft{current && ` ${current.module.name}`}</span>
        </div>
        <main className="mx-auto max-w-7xl p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
