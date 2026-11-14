'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { today } from '@/lib/format';
import { Customer, Meter, Page } from '@/modules/water/ui/types';

function useInvalidateCustomer(customerId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['customer', customerId] });
    qc.invalidateQueries({ queryKey: ['statement', customerId] });
    qc.invalidateQueries({ queryKey: ['customers'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['meters'] });
  };
}

/** Cash-office or bank receipt against an account. */
export function PaymentForm({ customer, onClose }: { customer: Pick<Customer, 'id' | 'accountNo' | 'name' | 'balance'>; onClose: () => void }) {
  const invalidate = useInvalidateCustomer(customer.id);
  const [f, setF] = useState({ amount: Number(customer.balance) > 0 ? customer.balance : '', channel: 'CASH', reference: '', paidAt: today(), payerName: '', chequeNo: '', drawerBank: '' });
  const save = useMutation({
    mutationFn: () => api.post('/payments', { ...f, customerId: customer.id, payerName: f.payerName || undefined, chequeNo: f.chequeNo || undefined, drawerBank: f.drawerBank || undefined }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Receive payment · ${customer.accountNo}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.amount || !f.reference}>Record payment</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">{customer.name}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (KES)">
          <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Channel">
          <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="CASH">Cash office</option>
            <option value="BANK">Bank deposit</option>
            <option value="CHEQUE">Cheque</option>
            <option value="MPESA">M-Pesa (manual entry)</option>
          </Select>
        </Field>
        <Field label={f.channel === 'MPESA' ? 'M-Pesa code' : f.channel === 'BANK' ? 'Bank reference / slip no.' : f.channel === 'CHEQUE' ? 'Banking slip / reference' : 'Receipt book no.'}>
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        {f.channel === 'CHEQUE' && (
          <>
            <Field label="Cheque no."><Input value={f.chequeNo} onChange={(e) => setF({ ...f, chequeNo: e.target.value })} /></Field>
            <Field label="Drawer's bank"><Input value={f.drawerBank} onChange={(e) => setF({ ...f, drawerBank: e.target.value })} /></Field>
          </>
        )}
        <Field label="Date paid">
          <Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} />
        </Field>
        <Field label="Paid by (optional)" className="sm:col-span-2">
          <Input value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function AdjustmentForm({ customer, onClose }: { customer: Pick<Customer, 'id' | 'accountNo'>; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ direction: 'CREDIT', amount: '', category: 'BILLING_ERROR', reason: '' });
  const save = useMutation({
    mutationFn: () => api.post('/adjustments', { customerId: customer.id, amount: f.direction === 'CREDIT' ? `-${f.amount}` : f.amount, category: f.category, reason: f.reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adjustments'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Request adjustment · ${customer.accountNo}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.amount || f.reason.length < 5}>Submit for approval</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="CREDIT">Credit (reduce what is owed)</option>
            <option value="DEBIT">Debit note (increase what is owed)</option>
          </Select>
        </Field>
        <Field label="Amount (KES)">
          <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/^-/, '') })} />
        </Field>
        <Field label="Reason category" className="sm:col-span-2">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="BILLING_ERROR">Billing error</option>
            <option value="LEAK_ALLOWANCE">Leak allowance</option>
            <option value="METER_FAULT">Meter fault</option>
            <option value="WAIVER">Waiver</option>
            <option value="DEBIT_NOTE">Debit note</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Explanation" className="sm:col-span-2">
          <Textarea rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
      </div>
      <p className="text-xs text-muted">Another user with approval rights must approve it before the account changes.</p>
    </Modal>
  );
}

/** Fits a meter from stores, replacing the account's current meter if it has one. */
export function InstallMeterForm({ customer, onClose }: { customer: Pick<Customer, 'id' | 'accountNo' | 'meterId'>; onClose: () => void }) {
  const invalidate = useInvalidateCustomer(customer.id);
  const [search, setSearch] = useState('');
  const [f, setF] = useState({ meterId: '', reading: '0', date: today(), oldMeterFinalReading: '', note: '' });
  const { data: meters } = useQuery({ queryKey: ['meters', 'store', search], queryFn: () => api.get<Page<Meter>>('/meters', { status: 'IN_STORE', type: 'CUSTOMER', search, pageSize: 50 }) });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/meters/${f.meterId}/install`, {
        customerId: customer.id,
        reading: f.reading,
        date: f.date,
        note: f.note || undefined,
        ...(customer.meterId && { oldMeterFinalReading: f.oldMeterFinalReading }),
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`${customer.meterId ? 'Replace' : 'Install'} meter · ${customer.accountNo}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.meterId || (Boolean(customer.meterId) && !f.oldMeterFinalReading)}>
            {customer.meterId ? 'Replace meter' : 'Install meter'}
          </Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <Field label="Find a meter in stores">
        <Input placeholder="Serial number" value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      <Field label="Meter">
        <Select value={f.meterId} onChange={(e) => setF({ ...f, meterId: e.target.value })}>
          <option value="">Select…</option>
          {meters?.items.map((m) => (
            <option key={m.id} value={m.id}>{m.serialNo} {m.make ? `· ${m.make}` : ''} · {m.sizeMm} mm</option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reading on the new meter">
          <Input inputMode="decimal" value={f.reading} onChange={(e) => setF({ ...f, reading: e.target.value })} />
        </Field>
        <Field label="Date fitted">
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        {customer.meterId && (
          <Field label="Final reading on the old meter" hint="Billed in the next run" className="sm:col-span-2">
            <Input inputMode="decimal" value={f.oldMeterFinalReading} onChange={(e) => setF({ ...f, oldMeterFinalReading: e.target.value })} />
          </Field>
        )}
        <Field label="Note" className="sm:col-span-2">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
