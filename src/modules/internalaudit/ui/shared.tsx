'use client';

import { useRef, useState } from 'react';
import { uploadDocument } from '@/components/attachments';
import { Badge, Button, ErrorBox } from '@/components/ui';

export const RATINGS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Rating = (typeof RATINGS)[number];
const TONE = { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue', LOW: 'gray' } as const;
export const RatingBadge = ({ r }: { r?: string | null }) => (r ? <Badge tone={TONE[r as Rating] ?? 'gray'}>{r.toLowerCase()}</Badge> : null);

/** Cell colour for a 1–25 risk score on the heat map. */
export const heatClass = (score: number) => (score >= 17 ? 'bg-red-200 text-red-900' : score >= 10 ? 'bg-amber-200 text-amber-900' : score >= 5 ? 'bg-yellow-100 text-yellow-900' : 'bg-emerald-100 text-emerald-900');

export interface Finding {
  id: string;
  engagementId: string;
  ref: string;
  title: string;
  condition?: string;
  criteria?: string;
  cause?: string;
  effect?: string;
  rating: Rating;
  recommendation?: string;
  workpaperId?: string | null;
  ownerId?: string | null;
  ownerName?: string;
  response?: string;
  accepted?: boolean | null;
  action?: string;
  dueDate?: string | null;
  originalDueDate?: string | null;
  status: string;
  updates?: { at: string; byName: string; note: string; kind: string; documentIds?: string[] }[];
  daysOverdue?: number;
  band?: string;
  engagement?: { id: string; number: string; title: string; status?: string; area?: string } | null;
  documents?: { id: string; name: string; createdAt: string }[];
  isOwner?: boolean;
}

/** Choose files, upload them to the document store, and hand their ids on (to attach as evidence). */
export function EvidencePicker({ onUploaded, label = 'Add evidence', meta = {} }: { onUploaded: (ids: string[]) => unknown; label?: string; meta?: Record<string, string | undefined> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const ids: string[] = [];
      for (const f of Array.from(files)) ids.push((await uploadDocument(f, meta)).id);
      await onUploaded(ids);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <ErrorBox error={error} />
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => pick(e.target.files)} />
      <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Uploading…' : label}</Button>
    </span>
  );
}
