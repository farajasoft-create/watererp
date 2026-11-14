'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { Account, Branch, Currency, Dimension, Entity, Me } from './types';

interface Session {
  me: Me;
  can: (permission: string) => boolean;
  entities: Entity[];
  entity: Entity | null;
  setEntityId: (id: string) => void;
}

const SessionContext = createContext<Session | null>(null);
const ENTITY_KEY = 'fs.entityId';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false, staleTime: 60_000 });
}

export function useEntities(enabled = true) {
  return useQuery({ queryKey: ['entities'], queryFn: () => api.get<Entity[]>('/entities'), enabled, staleTime: 60_000 });
}

export function useBranches(entityId?: string) {
  return useQuery({
    queryKey: ['branches', entityId ?? 'all'],
    queryFn: () => api.get<Branch[]>('/branches', { entityId }),
    staleTime: 60_000,
  });
}

export function useAccounts(entityId?: string) {
  return useQuery({
    queryKey: ['accounts', entityId ?? 'all'],
    queryFn: () => api.get<Account[]>('/accounts', { entityId }),
    staleTime: 60_000,
  });
}

export function useDimensions() {
  return useQuery({ queryKey: ['dimensions'], queryFn: () => api.get<Dimension[]>('/dimensions'), staleTime: 60_000 });
}

export function useCurrencies() {
  return useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies'), staleTime: 300_000 });
}

const subscribeStorage = (onChange: () => void) => {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
};
const readEntity = () => {
  try {
    return localStorage.getItem(ENTITY_KEY);
  } catch {
    return null;
  }
};

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const { data: entities = [] } = useEntities();
  // The entity chosen in this browser (storage may be unavailable in private mode: then the first entity).
  const stored = useSyncExternalStore(subscribeStorage, readEntity, () => null);
  const [chosen, setEntityIdState] = useState<string | null>(null);
  const entityId = chosen ?? stored;

  const setEntityId = useCallback((id: string) => {
    setEntityIdState(id);
    try {
      localStorage.setItem(ENTITY_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  const entity = useMemo(
    () => entities.find((e) => e.id === entityId) ?? entities.find((e) => e.isActive) ?? entities[0] ?? null,
    [entities, entityId],
  );
  const can = useCallback((p: string) => me.permissions.includes(p), [me.permissions]);

  return (
    <SessionContext.Provider value={{ me, can, entities, entity, setEntityId }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** Precision lookup for formatting amounts in a currency. */
export function usePrecision() {
  const { data } = useCurrencies();
  return useCallback((code?: string | null) => data?.find((c) => c.code === code)?.precision ?? 2, [data]);
}
