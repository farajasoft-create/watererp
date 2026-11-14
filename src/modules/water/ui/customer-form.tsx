'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { useTariffs, useZones } from '@/modules/water/ui/hooks';
import { Customer } from '@/modules/water/ui/types';

const CATEGORIES = ['DOMESTIC', 'COMMERCIAL', 'INSTITUTIONAL', 'KIOSK', 'INDUSTRIAL', 'BULK'];

type Form = {
  name: string;
  category: string;
  idType: string;
  idNumber: string;
  kraPin: string;
  phone: string;
  altPhone: string;
  email: string;
  postalAddress: string;
  zoneId: string;
  location: string;
  plotNo: string;
  tariffId: string;
  sewered: boolean;
  notes: string;
  openingBalance: string;
  status: 'APPLIED' | 'ACTIVE';
};

function initial(c?: Customer): Form {
  return {
    name: c?.name ?? '',
    category: c?.category ?? 'DOMESTIC',
    idType: c?.idType ?? 'NATIONAL_ID',
    idNumber: c?.idNumber ?? '',
    kraPin: c?.kraPin ?? '',
    phone: c?.phone ? `0${c.phone.slice(3)}` : '',
    altPhone: c?.altPhone ? `0${c.altPhone.slice(3)}` : '',
    email: c?.email ?? '',
    postalAddress: c?.postalAddress ?? '',
    zoneId: c?.zoneId ?? '',
    location: c?.location ?? '',
    plotNo: c?.plotNo ?? '',
    tariffId: c?.tariffId ?? '',
    sewered: c?.sewered ?? false,
    notes: c?.notes ?? '',
    openingBalance: '',
    status: 'APPLIED',
  };
}

/** New connection application, legacy-account migration, or editing an account's details. */
export function CustomerForm({ customer, open, onClose, onSaved }: { customer?: Customer; open: boolean; onClose: () => void; onSaved?: (c: Customer) => void }) {
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const { data: tariffs } = useTariffs();
  const [f, setF] = useState<Form>(() => initial(customer));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const tariffOptions = (tariffs ?? []).filter((t) => t.active && t.category === f.category);

  const save = useMutation({
    mutationFn: () => {
      const { openingBalance, status, ...rest } = f;
      const body = { ...rest, sewered: f.sewered };
      return customer ? api.patch<Customer>(`/customers/${customer.id}`, body) : api.post<Customer>('/customers', { ...body, status, ...(openingBalance && { openingBalance }) });
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customer', c.id] });
      onSaved?.(c);
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={customer ? `Edit ${customer.accountNo}` : 'New connection'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.name || !f.zoneId || !f.tariffId}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer name" className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF((p) => ({ ...p, category: e.target.value, tariffId: '' }))}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
            ))}
          </Select>
        </Field>
        <Field label="Tariff">
          <Select value={f.tariffId} onChange={(e) => set('tariffId', e.target.value)}>
            <option value="">Select…</option>
            {tariffOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.code} · {t.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Zone">
          <Select value={f.zoneId} onChange={(e) => set('zoneId', e.target.value)}>
            <option value="">Select…</option>
            {(zones ?? []).filter((z) => z.active).map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Plot / house no.">
          <Input value={f.plotNo} onChange={(e) => set('plotNo', e.target.value)} />
        </Field>
        <Field label="Location / landmark" className="sm:col-span-2">
          <Input value={f.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="ID type">
          <Select value={f.idType} onChange={(e) => set('idType', e.target.value)}>
            <option value="NATIONAL_ID">National ID</option>
            <option value="PASSPORT">Passport</option>
            <option value="ALIEN_ID">Alien ID</option>
            <option value="COMPANY_REG">Company registration</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="ID / registration number">
          <Input value={f.idNumber} onChange={(e) => set('idNumber', e.target.value)} />
        </Field>
        <Field label="Phone (for bills and alerts)">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="0712 345 678" />
        </Field>
        <Field label="Alternative phone">
          <Input value={f.altPhone} onChange={(e) => set('altPhone', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="KRA PIN">
          <Input value={f.kraPin} onChange={(e) => set('kraPin', e.target.value)} />
        </Field>
        <Field label="Postal address" className="sm:col-span-2">
          <Input value={f.postalAddress} onChange={(e) => set('postalAddress', e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.sewered} onChange={(e) => set('sewered', e.target.checked)} /> Connected to the sewer (sewerage is charged)
        </label>
        {!customer && (
          <>
            <Field label="Record as" hint="Migrating an existing account? Record it as connected and enter its legacy balance.">
              <Select value={f.status} onChange={(e) => set('status', e.target.value as Form['status'])}>
                <option value="APPLIED">New application</option>
                <option value="ACTIVE">Existing connected account</option>
              </Select>
            </Field>
            <Field label="Opening balance (KES)" hint="Arrears as positive, credit as negative">
              <Input value={f.openingBalance} onChange={(e) => set('openingBalance', e.target.value)} disabled={f.status !== 'ACTIVE'} inputMode="decimal" />
            </Field>
          </>
        )}
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
