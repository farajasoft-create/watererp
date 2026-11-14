'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Facility {
  id: string;
  code: string;
  name: string;
  type: string;
  zoneId?: string | null;
  capacity: string;
  gps?: { lat?: number; lng?: number };
  operator?: { name?: string; phone?: string };
  pricePerJerrican?: string;
  active: boolean;
}

export function useFacilities(type?: string) {
  return useQuery({ queryKey: ['facilities', type ?? ''], queryFn: () => api.get<Facility[]>('/facilities', { type }) });
}
