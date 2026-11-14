'use client';

import Link from 'next/link';
import { Card, Loading, Notice, PageHeader } from '@/components/ui';
import { menuFor } from '@/lib/navigation';
import { useMe } from '@/lib/session';

export default function HomePage() {
  const { data: me, isLoading } = useMe();
  if (isLoading || !me) return <Loading />;
  const menu = menuFor(me);

  return (
    <>
      <PageHeader title={me.organisation?.name ?? 'FarajaSoft'} subtitle={`Signed in as ${me.name}`} />
      {!menu.length && (
        <Notice tone="amber">
          {me.isAdmin ? (
            <>
              No modules are switched on yet. Choose the systems this organisation uses under <Link href="/settings" className="underline">Settings → Modules</Link>.
            </>
          ) : (
            'You have no access to any module yet. Ask an administrator to give you a role.'
          )}
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {menu.map(({ module, items, links }) => {
          const role = me.access.find((a) => a.module === module.key)?.roleLabel ?? (me.isAdmin ? 'Administrator' : '');
          const start = items[0]?.href ?? links[0]?.href ?? module.home;
          return (
            <Card key={module.key}>
              <Link href={start} className="text-base font-semibold text-brand-800 hover:underline">
                {module.name}
              </Link>
              <p className="mt-1 text-sm text-muted">{module.description}</p>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {[...items.slice(0, 5), ...links].map((n) => (
                  <Link key={n.href} href={n.href} className="text-brand-700 hover:underline">
                    {n.label}
                  </Link>
                ))}
              </div>
              {role && <div className="mt-3 text-xs text-muted">Your role: {role}</div>}
            </Card>
          );
        })}
      </div>
    </>
  );
}
