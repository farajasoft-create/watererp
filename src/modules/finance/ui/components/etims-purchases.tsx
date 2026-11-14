'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, today } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { ImportsInbox } from './etims-imports';
import { Badge, Button, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap } from './ui';

interface EtimsPurchaseRow {
  id: string;
  supplierTin: string;
  supplierName: string;
  supplierInvcNo: string;
  supplierId: string | null;
  date: string;
  taxableAmount: string;
  taxAmount: string;
  totalAmount: string;
  status: 'RECEIVED' | 'MATCHED' | 'ACCEPTED' | 'REJECTED';
  rejectionReason: string;
  bill: { id: string; number: string; status: string; total: string } | null;
  report: { status: 'NONE' | 'PENDING' | 'SENT' | 'FAILED'; lastError: string };
}

const TONE = { RECEIVED: 'amber', MATCHED: 'blue', ACCEPTED: 'green', REJECTED: 'gray' } as const;
const LABEL = { RECEIVED: 'To process', MATCHED: 'Bill in progress', ACCEPTED: 'Accepted', REJECTED: 'Rejected' } as const;

export function EtimsPurchasesPage() {
  const [tab, setTab] = useState<'inbox' | 'imports' | 'risk'>('inbox');
  return (
    <>
      <PageHeader
        title="KRA eTIMS purchases"
        description="Invoices suppliers registered with KRA against your PIN, and goods customs cleared for you. Match each invoice to its bill (or create the bill from it) and approve each import as one of your items; KRA is told. Input VAT is claimable only on invoices registered in eTIMS."
      />
      <div className="mb-3 flex gap-2">
        <Button variant={tab === 'inbox' ? 'primary' : 'secondary'} onClick={() => setTab('inbox')}>Invoices from KRA</Button>
        <Button variant={tab === 'imports' ? 'primary' : 'secondary'} onClick={() => setTab('imports')}>Imports (customs)</Button>
        <Button variant={tab === 'risk' ? 'primary' : 'secondary'} onClick={() => setTab('risk')}>Input VAT at risk</Button>
      </div>
      {tab === 'inbox' ? <Inbox /> : tab === 'imports' ? <ImportsInbox /> : <UnregisteredBills />}
    </>
  );
}

function Inbox() {
  const { can } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('RECEIVED');
  const [acting, setActing] = useState<{ row: EtimsPurchaseRow; action: 'bill' | 'link' | 'reject' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ['etims-purchases', status], queryFn: () => api.get<EtimsPurchaseRow[]>('/etims/purchases', { status: status || undefined }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['etims-purchases'] });
  const fetchNow = useMutation({
    mutationFn: () => api.post<{ received: number; matched: number }>('/etims/purchases/fetch'),
    onSuccess: (r) => {
      setError(null);
      setNotice(`${r.received} new invoice${r.received === 1 ? '' : 's'} from KRA${r.matched ? `, ${r.matched} matched to bills already entered` : ''}.`);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const kes = precision('KES');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="RECEIVED">To process</option>
          <option value="MATCHED">Bill in progress</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </Select>
        {can('ap.manage') && <Button loading={fetchNow.isPending} onClick={() => fetchNow.mutate()}>Fetch from KRA now</Button>}
        <span className="text-xs text-muted">Fetched automatically every day.</span>
      </div>
      <ErrorBanner error={error} />
      {notice && <Notice tone="green">{notice}</Notice>}
      {isLoading ? (
        <Loading />
      ) : !data.length ? (
        <Empty title={status === 'RECEIVED' ? 'Nothing to process' : 'No invoices'}>Supplier invoices registered in KRA eTIMS appear here.</Empty>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Invoice</th>
                <th className="num">VAT</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap">{formatDate(r.date)}</td>
                  <td>
                    {r.supplierName || '—'}
                    <div className="text-xs text-muted">PIN {r.supplierTin}</div>
                  </td>
                  <td>
                    {r.supplierInvcNo}
                    {r.bill && (
                      <div className="text-xs">
                        <Link className="text-brand-700 hover:underline" href={`/finance/purchases/bills/${r.bill.id}`}>{r.bill.number}</Link>
                      </div>
                    )}
                  </td>
                  <td className="num">{formatAmount(r.taxAmount, kes)}</td>
                  <td className="num">{formatAmount(r.totalAmount, kes)}</td>
                  <td>
                    <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                    {r.report.status === 'SENT' && <div className="text-xs text-muted">Reported to KRA</div>}
                    {r.report.status === 'FAILED' && <div className="max-w-56 text-xs text-red-700">KRA: {r.report.lastError}</div>}
                    {r.rejectionReason && <div className="max-w-56 text-xs text-muted">{r.rejectionReason}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {can('ap.manage') && r.status === 'RECEIVED' && (
                      <span className="inline-flex gap-1">
                        <Button size="sm" onClick={() => setActing({ row: r, action: 'bill' })}>Create bill</Button>
                        <Button size="sm" variant="ghost" onClick={() => setActing({ row: r, action: 'link' })}>Link</Button>
                        <Button size="sm" variant="ghost" onClick={() => setActing({ row: r, action: 'reject' })}>Reject</Button>
                      </span>
                    )}
                    {can('ap.manage') && r.status === 'MATCHED' && <Button size="sm" variant="ghost" onClick={() => setActing({ row: r, action: 'reject' })}>Reject</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {acting && (
        <PurchaseAction
          {...acting}
          onClose={() => setActing(null)}
          onDone={(message) => {
            setNotice(message);
            setActing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PurchaseAction({ row, action, onClose, onDone }: { row: EtimsPurchaseRow; action: 'bill' | 'link' | 'reject'; onClose: () => void; onDone: (message: string) => void }) {
  const { entity } = useSession();
  const [accountId, setAccountId] = useState('');
  const [billId, setBillId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const accounts = useQuery({
    queryKey: ['accounts', 'postable', entity?.id],
    queryFn: () => api.get<{ id: string; code: string; name: string; accountClass: string; accountType: string; isControl: boolean }[]>('/accounts', { postableOnly: true, activeOnly: true, entityId: entity?.id }),
    enabled: action === 'bill',
  });
  const bills = useQuery({
    queryKey: ['bills-for', row.supplierId],
    queryFn: () => api.get<{ items: { id: string; number: string; supplierInvoiceNumber: string; total: string; status: string; etimsPurchaseId?: string | null }[] }>('/invoices', { kind: 'PURCHASE_BILL', partyId: row.supplierId!, pageSize: 100 }),
    enabled: action === 'link' && !!row.supplierId,
  });
  const run = useMutation({
    mutationFn: async () => {
      if (action === 'bill') {
        const res = await api.post<{ number: string; difference: string | null }>(`/etims/purchases/${row.id}/bill`, { accountId: accountId || null });
        return `Created draft ${res.number}${res.difference ? ` (it differs from the eTIMS total by ${res.difference}; check the lines)` : ''}. Code it and send it for approval.`;
      }
      if (action === 'link') {
        await api.post(`/etims/purchases/${row.id}/link`, { billId });
        return 'Linked.';
      }
      await api.post(`/etims/purchases/${row.id}/reject`, { reason });
      return `Rejected invoice ${row.supplierInvcNo}; KRA will be told.`;
    },
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  // Expenses and the assets a purchase can create; never cash, bank, receivables or control accounts.
  const chargeable = (accounts.data ?? []).filter((a) => !a.isControl && (['EXPENSE', 'COST_OF_SALES'].includes(a.accountClass) || ['INVENTORY', 'PREPAYMENT', 'FIXED_ASSET'].includes(a.accountType)));
  const ready = action === 'link' ? !!billId : action === 'reject' ? reason.trim().length >= 3 : true;
  const title = action === 'bill' ? `Create a bill from invoice ${row.supplierInvcNo}` : action === 'link' ? `Link invoice ${row.supplierInvcNo} to a bill` : `Reject invoice ${row.supplierInvcNo}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={!ready} onClick={() => run.mutate()}>
            {action === 'bill' ? 'Create draft bill' : action === 'link' ? 'Link' : 'Reject'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ErrorBanner error={error} />
        <p className="text-muted">
          {row.supplierName || row.supplierTin} · {formatDate(row.date)} · KES {row.totalAmount} (VAT {row.taxAmount})
        </p>
        {action === 'bill' && (
          <Field label="Charge to" hint="The supplier's default account if it has one; lines can be recoded on the draft">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Supplier default</option>
              {chargeable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {action === 'link' &&
          (!row.supplierId ? (
            <Notice tone="amber">No supplier with PIN {row.supplierTin} is on file. Add the PIN to the supplier, or create the bill from this invoice.</Notice>
          ) : (
            <Field label="Bill">
              <Select value={billId} onChange={(e) => setBillId(e.target.value)}>
                <option value="">Choose…</option>
                {(bills.data?.items ?? [])
                  .filter((b) => !b.etimsPurchaseId && b.status !== 'VOID')
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · supplier invoice {b.supplierInvoiceNumber} · {b.total}
                    </option>
                  ))}
              </Select>
            </Field>
          ))}
        {action === 'reject' && (
          <Field label="Reason" hint="Reported to KRA; the supplier should cancel or correct the invoice">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not our order / duplicate / wrong amount" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

interface UnregisteredBill {
  id?: string;
  _id?: string;
  number: string;
  date: string;
  partyName: string;
  supplierTaxId: string;
  supplierInvoiceNumber: string;
  taxTotal: string;
  currency: string;
}

function UnregisteredBills() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [range, setRange] = useState(() => {
    const t = today();
    return { from: `${t.slice(0, 8)}01`, to: t };
  });
  const { data, isLoading } = useQuery({
    queryKey: ['etims-unregistered', entity?.id, range],
    queryFn: () => api.get<{ items: UnregisteredBill[]; inputVatAtRisk: string }>('/etims/unregistered-bills', { entityId: entity!.id, ...range }),
    enabled: !!entity,
  });
  const fp = precision(entity?.functionalCurrency ?? 'KES');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
        {data && (
          <p className="pb-2 text-sm">
            Input VAT at risk:{' '}
            <b className="tabular-nums">
              {formatAmount(data.inputVatAtRisk, fp)} {entity?.functionalCurrency}
            </b>
          </p>
        )}
      </div>
      <p className="text-xs text-muted">Posted bills with VAT from suppliers with a KRA PIN that are not matched to an invoice registered in eTIMS. Ask the supplier to register the invoice; it is linked automatically when it arrives.</p>
      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty title="Nothing at risk">Every bill with VAT in the period is matched to an eTIMS invoice.</Empty>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Supplier</th>
                <th>Supplier invoice</th>
                <th className="num">VAT</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => {
                const id = b.id ?? b._id;
                return (
                  <tr key={id}>
                    <td>
                      <Link className="text-brand-700 hover:underline" href={`/finance/purchases/bills/${id}`}>{b.number}</Link>
                      <div className="text-xs text-muted">{formatDate(b.date)}</div>
                    </td>
                    <td>
                      {b.partyName}
                      <div className="text-xs text-muted">PIN {b.supplierTaxId}</div>
                    </td>
                    <td>{b.supplierInvoiceNumber}</td>
                    <td className="num">
                      {formatAmount(b.taxTotal, precision(b.currency))} {b.currency}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

/** On a supplier bill: whether the supplier's invoice is registered in KRA eTIMS. */
export function BillEtimsNotice({ billId }: { billId: string }) {
  const { data } = useQuery({
    queryKey: ['etims-bill', billId],
    queryFn: () => api.get<{ registered: boolean; inputVatAtRisk?: boolean; purchase: { supplierInvcNo: string; status: string } | null }>(`/etims/purchases/by-bill/${billId}`),
    retry: false,
  });
  if (!data) return null;
  if (data.registered && data.purchase) {
    return (
      <Notice tone="green">
        Registered in KRA eTIMS as the supplier&rsquo;s invoice {data.purchase.supplierInvcNo}
        {data.purchase.status === 'ACCEPTED' ? ', accepted' : ''}.
      </Notice>
    );
  }
  if (data.inputVatAtRisk) {
    return (
      <Notice tone="amber">
        This invoice is not registered in KRA eTIMS, so its input VAT may not be claimable. Ask the supplier to register it; it is linked automatically when it arrives (
        <Link className="underline" href="/finance/purchases/etims">
          eTIMS supplier invoices
        </Link>
        ).
      </Notice>
    );
  }
  return null;
}
