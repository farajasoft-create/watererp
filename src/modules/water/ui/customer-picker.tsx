'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Input, Money } from '@/components/ui';
import { api } from './api';
import { Customer, Page } from './types';

/** Search box that finds an account by number, name or phone. */
export function CustomerPicker({ onPick }: { onPick: (c: Customer) => void }) {
  const [search, setSearch] = useState('');
  const { data } = useQuery({ queryKey: ['customers', 'pick', search], queryFn: () => api.get<Page<Customer>>('/customers', { search, pageSize: 10 }), enabled: search.length >= 2 });
  return (
    <div>
      <Input placeholder="Account number, name or phone" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded border border-line">
        {data?.items.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onPick(c)} className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-brand-50">
              <span>
                <b>{c.accountNo}</b> · {c.name}
              </span>
              <Money value={c.balance} />
            </button>
          </li>
        ))}
        {search.length >= 2 && !data?.items.length && <li className="px-3 py-2 text-sm text-muted">No match</li>}
      </ul>
    </div>
  );
}
