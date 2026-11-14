'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, ErrorBox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { api } from './api';

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Ticket {
  id: string;
  number: string;
  channel: string;
  requesterId: string;
  requesterName: string;
  department?: string;
  location?: string;
  phone?: string;
  categoryId: string;
  category: string;
  priority: Priority;
  subject: string;
  description?: string;
  assetTag?: string;
  status: string;
  assignedTo: string | null;
  assignedName?: string;
  respondBy: string;
  resolveBy: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolution?: string;
  rating: number | null;
  feedback?: string;
  reopenCount: number;
  escalationLevel: number;
  overdue?: boolean;
  createdAt: string;
  history?: { at: string; byName?: string; action: string; note?: string }[];
  comments?: { id: string; at: string; byName?: string; body: string; internal: boolean }[];
  related?: { id: string; number: string; subject: string; status: string; createdAt: string }[];
}

const PRIORITY_TONE = { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue', LOW: 'gray' } as const;
export const PriorityBadge = ({ p }: { p: Priority }) => <Badge tone={PRIORITY_TONE[p]}>{p.toLowerCase()}</Badge>;

export const PRIORITY_HELP: Record<Priority, string> = {
  CRITICAL: 'Many people or a key system cannot work',
  HIGH: 'You cannot work',
  MEDIUM: 'Work is slowed down',
  LOW: 'A request or a small nuisance',
};

/** Raise an IT request; officers can also log one taken by phone or at the desk for someone else. */
export function NewTicket({ onClose, forOthers = false }: { onClose: () => void; forOthers?: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const cats = useQuery({ queryKey: ['ict-categories'], queryFn: () => api.get<{ id: string; name: string }[]>('/helpdesk/categories') });
  const people = useDirectory();
  const [f, setF] = useState({ categoryId: '', priority: 'MEDIUM' as Priority, subject: '', description: '', location: '', phone: '', department: '', assetTag: '', requesterId: '', channel: 'PHONE' });
  const save = useMutation({
    mutationFn: () =>
      api.post<Ticket>('/helpdesk/tickets', {
        categoryId: f.categoryId,
        priority: f.priority,
        subject: f.subject,
        description: f.description || undefined,
        location: f.location || undefined,
        phone: f.phone || undefined,
        department: f.department || undefined,
        assetTag: f.assetTag || undefined,
        ...(forOthers && f.requesterId && { requesterId: f.requesterId, channel: f.channel }),
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['ict-mine'] });
      qc.invalidateQueries({ queryKey: ['ict-desk'] });
      router.push(`/ict/tickets/${t.id}`);
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={forOthers ? 'Log a request' : 'New IT request'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.categoryId || f.subject.trim().length < 3 || (forOthers && !f.requesterId)}>{save.isPending ? 'Sending…' : 'Send'}</Button>
        </>
      }
    >
      <ErrorBox error={save.error || cats.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {forOthers && (
          <>
            <Field label="For">
              <Select value={f.requesterId} onChange={(e) => setF({ ...f, requesterId: e.target.value })}>
                <option value="">Choose who called</option>
                {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Received by">
              <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
                <option value="PHONE">Phone</option>
                <option value="WALK_IN">Walk-in</option>
                <option value="EMAIL">Email</option>
              </Select>
            </Field>
          </>
        )}
        <Field label="What is it about">
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">Choose a category</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="How urgent" hint={PRIORITY_HELP[f.priority]}>
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
          </Select>
        </Field>
        <Field label="Subject" className="sm:col-span-2"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={150} placeholder="Printer on the 2nd floor jams every page" /></Field>
        <Field label="Details" className="sm:col-span-2"><Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} placeholder="What happens, since when, any error message" /></Field>
        <Field label="Asset tag" hint="On the sticker, if it is about equipment"><Input value={f.assetTag} onChange={(e) => setF({ ...f, assetTag: e.target.value })} maxLength={40} /></Field>
        <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={80} /></Field>
        <Field label="Office / location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={120} /></Field>
        <Field label="Phone or extension"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} /></Field>
      </div>
    </Modal>
  );
}
