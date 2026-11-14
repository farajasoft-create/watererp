'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { BankAccount, Party, PartyType, TaxCode } from './commercial';

export function useTaxCodes() {
  return useQuery({ queryKey: ['tax-codes'], queryFn: () => api.get<TaxCode[]>('/tax-codes'), staleTime: 60_000 });
}

export function useParties(type: PartyType, entityId?: string) {
  return useQuery({
    queryKey: ['parties', type, entityId ?? 'all'],
    queryFn: () => api.get<Party[]>(type === 'CUSTOMER' ? '/customers' : '/suppliers', { entityId }),
    staleTime: 30_000,
  });
}

export function useBankAccounts(entityId?: string) {
  return useQuery({
    queryKey: ['bank-accounts', entityId ?? 'all'],
    queryFn: () => api.get<BankAccount[]>('/bank-accounts', { entityId }),
    staleTime: 30_000,
  });
}
