'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CustomerForm } from '@/modules/water/ui/customer-form';
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Modal, Money, Notice, PageHeader, Pager, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { label } from '@/lib/format';
import { useZones, zoneName } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';
import { Customer, Page } from '@/modules/water/ui/types';

interface ImportResult { rows: number; valid: number; errors: { row: number; legacy: string; message: string }[]; openingBalances: string; committed: boolean; created: { legacy: string; accountNo: string }[] }

/** Loads customers from the legacy system's export: every row is checked first; only a clean file is loaded. */
function ImportCustomers({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const run = useMutation({ mutationFn: (commit: boolean) => api.post<ImportResult>('/customers/import', { csv, commit }), onSuccess: (r) => r.committed && qc.invalidateQueries({ queryKey: ['customers'] }) });
  const r = run.data;
  const mapping = () => {
    const blob = new Blob([['legacy_account,account_no', ...(r?.created ?? []).map((c) => `${c.legacy},${c.accountNo}`)].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'account-mapping.csv';
    a.click();
  };
  return (
    <Modal open wide onClose={onClose} title="Import customers" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="secondary" disabled={!csv || run.isPending} onClick={() => run.mutate(false)}>Check the file</Button><Button disabled={!r || r.committed || r.errors.length > 0 || run.isPending} onClick={() => run.mutate(true)}>Load {r?.valid ?? ''} customers</Button></>}>
      <p className="mb-2 text-sm text-muted">Use the <a className="text-brand-700 hover:underline" href={`/api/v1/water/customers/import/template`}>template</a>: one row per account with its zone and tariff codes and the balance carried over. Nothing is loaded until the whole file passes.</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); run.reset(); } }} className="text-sm" />
      <ErrorBox error={run.error} />
      {r && (
        <div className="mt-3 space-y-2">
          {r.committed ? <Notice tone="green">Loaded {r.created.length} customers with opening balances of {r.openingBalances}. <button type="button" className="underline" onClick={mapping}>Download the old-to-new account numbers</button>.</Notice> : <p className="text-sm">{r.rows} rows: {r.valid} ready, {r.errors.length} with problems; opening balances {r.openingBalances}.</p>}
          {r.errors.length > 0 && <table className="table-base"><thead><tr><th>Row</th><th>Old account</th><th>Problem</th></tr></thead><tbody>{r.errors.slice(0, 200).map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.legacy}</td><td className="text-sm">{e.message}</td></tr>)}</tbody></table>}
        </div>
      )}
    </Modal>
  );
}

export default function CustomersPage() {
  const router = useRouter();
  const can = useCan();
  const { data: zones } = useZones();
  const [q, setQ] = useState({ search: '', zoneId: '', status: '', category: '', inArrears: false, page: 1 });
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => api.get<Page<Customer>>('/customers', { ...q, inArrears: q.inArrears || undefined, pageSize: 50 }),
  });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Connections, applications and accounts"
        actions={can('water.customer.manage') && <div className="flex gap-2"><Button variant="secondary" onClick={() => setImporting(true)}>Import from old system</Button><Button onClick={() => setCreating(true)}>New connection</Button></div>}
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input placeholder="Search account, name, phone, ID or plot" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
          <Select value={q.zoneId} onChange={(e) => set({ zoneId: e.target.value })} className="max-w-[12rem]">
            <option value="">All zones</option>
            {zones?.map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </Select>
          <Select value={q.status} onChange={(e) => set({ status: e.target.value })} className="max-w-[10rem]">
            <option value="">Any status</option>
            {['APPLIED', 'APPROVED', 'ACTIVE', 'DISCONNECTED', 'CLOSED', 'REJECTED'].map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </Select>
          <Select value={q.category} onChange={(e) => set({ category: e.target.value })} className="max-w-[10rem]">
            <option value="">Any category</option>
            {['DOMESTIC', 'COMMERCIAL', 'INSTITUTIONAL', 'KIOSK', 'INDUSTRIAL', 'BULK'].map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={q.inArrears} onChange={(e) => set({ inArrears: e.target.checked })} /> In arrears
          </label>
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No customers match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Zone</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th className="num">Balance (KES)</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/water/customers/${c.id}`)}>
                    <td>
                      <Link href={`/water/customers/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.accountNo}</Link>
                    </td>
                    <td>{c.name}</td>
                    <td>{label(c.category)}</td>
                    <td>{zoneName(zones, c.zoneId)}</td>
                    <td>{c.phone ? `0${c.phone.slice(3)}` : '—'}</td>
                    <td><Badge value={c.status} /></td>
                    <td className="num"><Money value={c.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {creating && <CustomerForm open onClose={() => setCreating(false)} onSaved={(c) => router.push(`/water/customers/${c.id}`)} />}
      {importing && <ImportCustomers onClose={() => setImporting(false)} />}
    </>
  );
}
