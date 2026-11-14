'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { Cycle, Tariff, Zone } from './types';

export function useZones() {
  return useQuery({ queryKey: ['zones'], queryFn: () => api.get<Zone[]>('/zones'), staleTime: 60_000 });
}

export function useTariffs() {
  return useQuery({ queryKey: ['tariffs'], queryFn: () => api.get<Tariff[]>('/tariffs'), staleTime: 60_000 });
}

export function useCycles() {
  return useQuery({ queryKey: ['cycles'], queryFn: () => api.get<Cycle[]>('/cycles') });
}

export function zoneName(zones: Zone[] | undefined, id: string | null | undefined): string {
  if (!id) return 'All zones';
  const z = zones?.find((x) => x.id === id);
  return z ? `${z.code} · ${z.name}` : '—';
}
