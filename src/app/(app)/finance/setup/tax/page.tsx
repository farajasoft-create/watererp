'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Checkbox, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, TableWrap } from '@/modules/finance/ui/components/ui';
import { ETIMS_TAX_TYPES } from '@/modules/finance/ui/components/compliance';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { rateOn, TaxCode } from '@/modules/finance/ui/lib/commercial';
import { useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { formatDate, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useSession } from '@/modules/finance/ui/lib/session';

interface Form {
  code: string;
  name: string;
  description: string;
  kind: 'VAT' | 'WITHHOLDING';
  country: string;
  rates: { rate: string; effectiveFrom: string }[];
  outputAccountId: string;
  inputAccountId: string;
  etimsTaxType: string;
  isActive: boolean;
}

export default function TaxCodesPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { data: codes = [], isLoading } = useTaxCodes();
  const { data: accounts = [] } = useAccounts();
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = (id: string | null) => accounts.find((a) => a.id === id);
  const editable = can('tax.manage');

  const open = (t?: TaxCode) => {
    setError(null);
    setEditing({
      id: t?.id,
      form: t
        ? { ...t, inputAccountId: t.inputAccountId ?? '', etimsTaxType: t.etimsTaxType ?? '', rates: t.rates.map((r) => ({ rate: r.rate, effectiveFrom: r.effectiveFrom.slice(0, 10) })) }
        : { code: '', name: '', description: '', kind: 'VAT', country: '', rates: [{ rate: '', effectiveFrom: '2000-01-01' }], outputAccountId: '', inputAccountId: '', etimsTaxType: '', isActive: true },
    });
  };
  const set = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  const save = useMutation({
    mutationFn: () => {
      const f = editing!.form;
      const body = { ...f, inputAccountId: f.inputAccountId || null, etimsTaxType: f.kind === 'VAT' && f.etimsTaxType ? f.etimsTaxType : null, rates: f.rates.filter((r) => r.rate !== '') };
      return editing!.id ? api.patch(`/tax-codes/${editing!.id}`, body) : api.post('/tax-codes', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tax-codes'] });
      setEditing(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const f = editing?.form;
  return (
    <>
      <PageHeader
        title="Tax codes"
        description="VAT and withholding tax codes with effective-dated rates. A new rate applies to documents dated on or after its effective date."
        actions={editable && <Button variant="primary" onClick={() => open()}>New tax code</Button>}
      />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Jurisdiction</th>
                <th className="num">Current rate</th>
                <th>Posts to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((t) => (
                <tr key={t.id} className={t.isActive ? '' : 'opacity-50'}>
                  <td className="font-mono text-xs">{t.code}</td>
                  <td>{t.name}</td>
                  <td><Badge tone={t.kind === 'VAT' ? 'blue' : 'violet'}>{t.kind === 'VAT' ? 'VAT' : 'Withholding'}</Badge></td>
                  <td className="text-muted">{t.country || 'Any'}</td>
                  <td className="num">
                    {rateOn(t, today())}%{t.rates.length > 1 && <span className="ml-1 text-xs text-muted">({t.rates.length} rates)</span>}
                  </td>
                  <td className="text-xs text-muted">
                    {account(t.outputAccountId)?.code}
                    {t.inputAccountId && ` / ${account(t.inputAccountId)?.code}`}
                  </td>
                  <td className="text-right">{editable && <Button size="sm" variant="ghost" onClick={() => open(t)}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${f?.code}` : 'New tax code'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
          </>
        }
      >
        {f && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Code">
                <Input value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Name" className="sm:col-span-2">
                <Input value={f.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Type">
                <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as Form['kind'] })}>
                  <option value="VAT">VAT / sales tax</option>
                  <option value="WITHHOLDING">Withholding tax</option>
                </Select>
              </Field>
              <Field label="Country" hint="Blank for any jurisdiction">
                <Input value={f.country} onChange={(e) => set({ country: e.target.value })} />
              </Field>
              <Field label={f.kind === 'VAT' ? 'Output tax (payable) account' : 'Withholding tax payable account'}>
                <Select value={f.outputAccountId} onChange={(e) => set({ outputAccountId: e.target.value })}>
                  <option value="">Select…</option>
                  {accounts.filter((a) => a.accountClass === 'LIABILITY' && a.isPostable).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </Select>
              </Field>
              <Field
                label={f.kind === 'VAT' ? 'Input tax (recoverable) account' : 'Withheld by customers (recoverable) account'}
                hint={f.kind === 'VAT' ? 'Blank if input tax is not recoverable' : 'Where tax customers deduct from their payments to you is held until claimed'}
              >
                <Select value={f.inputAccountId} onChange={(e) => set({ inputAccountId: e.target.value })}>
                  <option value="">{f.kind === 'VAT' ? 'Not recoverable' : 'Not used'}</option>
                  {accounts.filter((a) => a.accountClass === 'ASSET' && a.isPostable).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </Select>
              </Field>
              {f.kind === 'VAT' && (
                <Field label="KRA eTIMS tax type" hint="Kenyan branches only: how sales under this code are reported to KRA">
                  <Select value={f.etimsTaxType} onChange={(e) => set({ etimsTaxType: e.target.value })}>
                    <option value="">Not mapped</option>
                    {ETIMS_TAX_TYPES.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <Field label="Rates">
              <div className="space-y-2 pt-1">
                {f.rates.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input className="w-28 text-right" inputMode="decimal" placeholder="%" value={r.rate} onChange={(e) => set({ rates: f.rates.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)) })} aria-label="Rate percent" />
                    <span className="text-sm text-muted">% from</span>
                    <Input className="w-44" type="date" value={r.effectiveFrom} onChange={(e) => set({ rates: f.rates.map((x, j) => (j === i ? { ...x, effectiveFrom: e.target.value } : x)) })} aria-label="Effective from" />
                    <span className="text-xs text-muted">{formatDate(r.effectiveFrom)}</span>
                    {f.rates.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => set({ rates: f.rates.filter((_, j) => j !== i) })}>Remove</Button>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => set({ rates: [...f.rates, { rate: '', effectiveFrom: today() }] })}>+ Add a rate change</Button>
              </div>
            </Field>
            {editing?.id && <Checkbox label="Active" checked={f.isActive} onChange={(v) => set({ isActive: v })} />}
          </div>
        )}
      </Modal>
    </>
  );
}
