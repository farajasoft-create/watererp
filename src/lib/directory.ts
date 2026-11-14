'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
}

/** Active users of the organisation (those with a role in `module` when given), for assigning work. */
export function useDirectory(module?: string) {
  return useQuery({ queryKey: ['directory', module ?? ''], queryFn: () => api.get<DirectoryUser[]>('/users/directory', { module }), staleTime: 5 * 60_000 });
}
