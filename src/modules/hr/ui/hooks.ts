'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { Department, EmployeeOption, LeaveType } from './types';

export function useDepartments() {
  return useQuery({ queryKey: ['hr-departments'], queryFn: () => api.get<Department[]>('/departments'), staleTime: 60_000 });
}

export function useLeaveTypes(enabled = true) {
  return useQuery({ queryKey: ['hr-leave-types'], queryFn: () => api.get<LeaveType[]>('/leave-types'), staleTime: 60_000, enabled });
}

export function useEmployeeOptions(enabled = true) {
  return useQuery({ queryKey: ['hr-employee-options'], queryFn: () => api.get<EmployeeOption[]>('/employees/options'), staleTime: 30_000, enabled });
}

export function departmentName(departments: Department[] | undefined, id: string | null | undefined): string {
  if (!id) return '—';
  return departments?.find((d) => d.id === id)?.name ?? '—';
}

export const fullName = (e: { firstName: string; lastName: string; otherNames?: string }) => [e.firstName, e.otherNames, e.lastName].filter(Boolean).join(' ');

export function lastMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
