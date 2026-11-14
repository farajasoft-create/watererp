'use client';

import { useState } from 'react';

/**
 * Goes back to the first page when any filter changes. The page is adjusted while rendering (React's
 * "adjusting state when a prop changes"), so the list never fetches the old page with the new filters.
 */
export function useResetPage(filters: unknown[], setPage: (page: number) => void) {
  const key = JSON.stringify(filters);
  const [last, setLast] = useState(key);
  if (last !== key) {
    setLast(key);
    setPage(1);
  }
}

/**
 * Runs `apply` once for each new value of `data` (for example, filling a form from a record that has just
 * loaded), during render rather than in an effect.
 */
export function useApplyOnce<T>(data: T | undefined | null, apply: (data: T) => void) {
  const [applied, setApplied] = useState<T | null>(null);
  if (data && data !== applied) {
    setApplied(data);
    apply(data);
  }
}
