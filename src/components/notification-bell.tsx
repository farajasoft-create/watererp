'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface Notification {
  id: string;
  title: string;
  body?: string;
  link?: string;
  readAt?: string | null;
  createdAt: string;
}

/** The bell: unread count, checked every minute, and the latest notifications. */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications'), refetchInterval: 60_000 });
  const read = useMutation({ mutationFn: () => api.post('/notifications/read', {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="relative rounded p-1 text-base hover:bg-slate-100" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}>
        🔔
        {Boolean(data?.unread) && <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{data!.unread > 9 ? '9+' : data!.unread}</span>}
      </button>
      {open && (
        <div className="absolute bottom-8 left-0 z-50 w-80 rounded-lg border border-line bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-semibold">
            Notifications
            {Boolean(data?.unread) && <button type="button" className="text-xs font-normal text-brand-700" onClick={() => read.mutate()}>Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {!data?.items.length && <li className="px-3 py-6 text-center text-sm text-muted">Nothing yet.</li>}
            {data?.items.map((n) => (
              <li key={n.id} className={n.readAt ? 'px-3 py-2' : 'bg-brand-50 px-3 py-2'}>
                {n.link ? <Link href={n.link} onClick={() => setOpen(false)} className="text-sm font-medium hover:text-brand-700">{n.title}</Link> : <span className="text-sm font-medium">{n.title}</span>}
                {n.body && <div className="text-xs text-muted">{n.body}</div>}
                <div className="text-[11px] text-muted">{fmtDateTime(n.createdAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
