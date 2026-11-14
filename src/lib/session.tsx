'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { Me } from './types';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 5 * 60_000 });
}

export function useCan() {
  const { data } = useMe();
  return (permission: string) => Boolean(data?.permissions.includes(permission));
}
