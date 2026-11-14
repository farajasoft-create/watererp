'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { label } from '@/lib/format';
import { api } from './api';

export const METHODS = ['OPEN_NATIONAL', 'OPEN_INTERNATIONAL', 'RESTRICTED', 'RFP', 'TWO_STAGE', 'DESIGN_COMPETITION', 'RFQ', 'LOW_VALUE', 'DIRECT', 'SPECIALLY_PERMITTED', 'FRAMEWORK'];
export const CATEGORIES = ['GOODS', 'WORKS', 'SERVICES', 'CONSULTANCY'];
export const RESERVATIONS = ['NONE', 'YOUTH', 'WOMEN', 'PWD', 'ALL_AGPO', 'LOCAL'];
export const RESERVED_LABEL: Record<string, string> = { NONE: 'Open to all', YOUTH: 'Youth (AGPO)', WOMEN: 'Women (AGPO)', PWD: 'Persons with disability (AGPO)', ALL_AGPO: 'Any AGPO group', LOCAL: 'Local firms' };

export interface Tender {
  id: string;
  number: string;
  title: string;
  description?: string;
  method: string;
  category: string;
  reservedFor: string;
  estimate: string;
  planReference?: string;
  budgetLine?: string;
  justification?: string;
  bidSecurity: string;
  bidValidityDays: number;
  documentIds: string[];
  closingAt: string;
  openingAt: string;
  openingVenue?: string;
  mandatory: string[];
  criteria: { name: string; weight: number }[];
  passMark: number;
  financialWeight: number;
  status: string;
}

/** A datetime-local value (local time) to an ISO string with offset. */
export const toIso = (local: string) => (local ? new Date(local).toISOString() : '');
export const toLocal = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function TenderForm({ tender, onClose, onSaved }: { tender?: Tender; onClose: () => void; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: tender?.title ?? '',
    description: tender?.description ?? '',
    method: tender?.method ?? 'OPEN_NATIONAL',
    category: tender?.category ?? 'GOODS',
    reservedFor: tender?.reservedFor ?? 'NONE',
    estimate: tender?.estimate ?? '',
    planReference: tender?.planReference ?? '',
    budgetLine: tender?.budgetLine ?? '',
    justification: tender?.justification ?? '',
    bidSecurity: tender?.bidSecurity ?? '0',
    bidValidityDays: String(tender?.bidValidityDays ?? 120),
    closingAt: toLocal(tender?.closingAt),
    openingAt: toLocal(tender?.openingAt),
    openingVenue: tender?.openingVenue ?? '',
    mandatory: (tender?.mandatory ?? ['Certificate of incorporation or registration', 'Valid tax compliance certificate', 'Confidential business questionnaire', 'Bid security']).join('\n'),
    criteria: (tender?.criteria ?? []).map((c) => `${c.name}: ${c.weight}`).join('\n'),
    passMark: String(tender?.passMark ?? 70),
    financialWeight: String(tender?.financialWeight ?? 100),
  });
  const save = useMutation({
    mutationFn: () => {
      const criteria = f.criteria.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.lastIndexOf(':');
        return { name: l.slice(0, i).trim(), weight: Number(l.slice(i + 1)) };
      });
      const body = {
        ...f,
        description: f.description || undefined,
        planReference: f.planReference || undefined,
        budgetLine: f.budgetLine || undefined,
        justification: f.justification || undefined,
        openingVenue: f.openingVenue || undefined,
        bidValidityDays: Number(f.bidValidityDays),
        closingAt: toIso(f.closingAt),
        openingAt: toIso(f.openingAt || f.closingAt),
        mandatory: f.mandatory.split('\n').map((l) => l.trim()).filter(Boolean),
        criteria,
        passMark: Number(f.passMark),
        financialWeight: Number(f.financialWeight),
        documentIds: tender?.documentIds ?? [],
      };
      return tender ? api.put<Tender>(`/tenders/${tender.id}`, body) : api.post<Tender>('/tenders', body);
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['tenders'] });
      onSaved?.(t.id);
      onClose();
    },
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open wide onClose={onClose} title={tender ? `Edit ${tender.number}` : 'New tender'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || f.title.length < 5 || !f.estimate || !f.closingAt}>Save draft</Button></>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" className="sm:col-span-3"><Input value={f.title} onChange={t('title')} /></Field>
        <Field label="Method"><Select value={f.method} onChange={t('method')}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
        <Field label="Category"><Select value={f.category} onChange={t('category')}>{CATEGORIES.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
        <Field label="Reserved for"><Select value={f.reservedFor} onChange={t('reservedFor')}>{RESERVATIONS.map((m) => <option key={m} value={m}>{RESERVED_LABEL[m]}</option>)}</Select></Field>
        <Field label="Estimate (KES)"><Input inputMode="decimal" value={f.estimate} onChange={t('estimate')} /></Field>
        <Field label="Procurement plan item"><Input value={f.planReference} onChange={t('planReference')} /></Field>
        <Field label="Budget line"><Input value={f.budgetLine} onChange={t('budgetLine')} /></Field>
        {!['OPEN_NATIONAL', 'OPEN_INTERNATIONAL'].includes(f.method) && <Field label="Why not open tendering" className="sm:col-span-3"><Textarea rows={2} value={f.justification} onChange={t('justification')} /></Field>}
        <Field label="Bid security (KES)"><Input inputMode="decimal" value={f.bidSecurity} onChange={t('bidSecurity')} /></Field>
        <Field label="Bid validity (days)"><Input inputMode="numeric" value={f.bidValidityDays} onChange={t('bidValidityDays')} /></Field>
        <Field label="Opening venue"><Input value={f.openingVenue} onChange={t('openingVenue')} /></Field>
        <Field label="Closing"><Input type="datetime-local" value={f.closingAt} onChange={t('closingAt')} /></Field>
        <Field label="Opening (blank: at closing)"><Input type="datetime-local" value={f.openingAt} onChange={t('openingAt')} /></Field>
        <div />
        <Field label="Description" className="sm:col-span-3"><Textarea rows={3} value={f.description} onChange={t('description')} /></Field>
        <Field label="Mandatory requirements (one per line)" className="sm:col-span-3"><Textarea rows={4} value={f.mandatory} onChange={t('mandatory')} /></Field>
        <Field label="Technical criteria, 'name: weight' per line (weights add to 100; blank for none)" className="sm:col-span-2"><Textarea rows={4} value={f.criteria} onChange={t('criteria')} /></Field>
        <div className="space-y-2">
          <Field label="Technical pass mark"><Input inputMode="numeric" value={f.passMark} onChange={t('passMark')} /></Field>
          <Field label="Price weight (100: lowest evaluated price)"><Input inputMode="numeric" value={f.financialWeight} onChange={t('financialWeight')} /></Field>
        </div>
      </div>
    </Modal>
  );
}
