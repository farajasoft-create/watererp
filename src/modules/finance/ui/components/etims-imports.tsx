'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useItems } from '@/modules/finance/ui/lib/operations-hooks';
import { useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, Select, TableWrap } from './ui';

interface ImportRow {
  id: string;
  declarationNumber: string;
  declarationDate: string;
  taskCd: string;
  itemSeq: number;
  hsCode: string;
  itemName: string;
  originCountry: string;
  quantity: number;
  quantityUnit: string;
  supplierName: string;
  agentName: string;
  invoiceAmount: number | null;
  invoiceCurrency: string;
  status: 'RECEIVED' | 'APPROVED' | 'REJECTED';
  rejectionReason: string;
  item: { code: string; name: string } | null;
  bill: { id: string; number: string } | null;
  report: { status: 'NONE' | 'PENDING' | 'SENT' | 'FAILED'; lastError: string };
}

const declDate = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : d);

/** Items customs cleared for our PIN: approve each as one of our stock items, or reject it. */
export function ImportsInbox() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('RECEIVED');
  const [acting, setActing] = useState<{ row: ImportRow; action: 'approve' | 'reject' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ['etims-imports', status], queryFn: () => api.get<ImportRow[]>('/etims/imports', { status: status || undefined }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['etims-imports'] });
  const fetchNow = useMutation({
    mutationFn: () => api.post<{ received: number }>('/etims/imports/fetch'),
    onSuccess: (r) => {
      setError(null);
      setNotice(`${r.received} new customs item${r.received === 1 ? '' : 's'} from KRA.`);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const manage = can('inventory.manage');
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Items customs cleared for your PIN. Approve each as one of your stock items (and the supplier bill that receives it) or reject it; KRA is told either way, and stock received on that bill is reported to KRA as an import.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="RECEIVED">To process</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </Select>
        {manage && <Button loading={fetchNow.isPending} onClick={() => fetchNow.mutate()}>Fetch from KRA now</Button>}
      </div>
      <ErrorBanner error={error} />
      {notice && <Notice tone="green">{notice}</Notice>}
      {isLoading ? (
        <Loading />
      ) : !data.length ? (
        <Empty title={status === 'RECEIVED' ? 'Nothing to process' : 'No imports'}>Customs-cleared items appear here once KRA lists them.</Empty>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Declaration</th>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th>Supplier</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="align-top">
                  <td>
                    {r.declarationNumber || r.taskCd}
                    <div className="text-xs text-muted">
                      {declDate(r.declarationDate)} · line {r.itemSeq}
                    </div>
                  </td>
                  <td>
                    {r.itemName}
                    <div className="text-xs text-muted">
                      HS {r.hsCode}
                      {r.originCountry && ` · from ${r.originCountry}`}
                    </div>
                    {r.item && (
                      <div className="text-xs">
                        → {r.item.code} {r.item.name}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {r.quantity} {r.quantityUnit}
                  </td>
                  <td>
                    {r.supplierName || '—'}
                    {r.invoiceAmount != null && (
                      <div className="text-xs text-muted">
                        {r.invoiceCurrency} {r.invoiceAmount.toLocaleString()}
                      </div>
                    )}
                    {r.bill && (
                      <div className="text-xs">
                        <Link className="text-brand-700 hover:underline" href={`/finance/purchases/bills/${r.bill.id}`}>{r.bill.number}</Link>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'gray' : 'amber'}>{r.status === 'RECEIVED' ? 'To process' : r.status.toLowerCase()}</Badge>
                    {r.report.status === 'SENT' && <div className="text-xs text-muted">Reported to KRA</div>}
                    {r.report.status === 'FAILED' && <div className="max-w-56 text-xs text-red-700">KRA: {r.report.lastError}</div>}
                    {r.rejectionReason && <div className="max-w-56 text-xs text-muted">{r.rejectionReason}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {manage && r.status === 'RECEIVED' && (
                      <span className="inline-flex gap-1">
                        <Button size="sm" onClick={() => setActing({ row: r, action: 'approve' })}>Approve</Button>
                        <Button size="sm" variant="ghost" onClick={() => setActing({ row: r, action: 'reject' })}>Reject</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {acting && (
        <ImportAction
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

function ImportAction({ row, action, onClose, onDone }: { row: ImportRow; action: 'approve' | 'reject'; onClose: () => void; onDone: (message: string) => void }) {
  const { data: items = [] } = useItems();
  const [itemId, setItemId] = useState('');
  const [billId, setBillId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bills = useQuery({
    queryKey: ['bills-recent'],
    queryFn: () => api.get<{ items: { id: string; number: string; partyName: string; supplierInvoiceNumber: string; status: string }[] }>('/invoices', { kind: 'PURCHASE_BILL', pageSize: 100 }),
    enabled: action === 'approve',
  });
  const run = useMutation({
    mutationFn: async () => {
      if (action === 'approve') {
        await api.post(`/etims/imports/${row.id}/approve`, { itemId, billId: billId || null });
        return `Approved ${row.itemName}; KRA will be told.`;
      }
      await api.post(`/etims/imports/${row.id}/reject`, { reason });
      return `Rejected ${row.itemName}; KRA will be told.`;
    },
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  });
  const ready = action === 'approve' ? !!itemId : reason.trim().length >= 3;
  return (
    <Modal
      open
      onClose={onClose}
      title={action === 'approve' ? `Approve ${row.itemName}` : `Reject ${row.itemName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={!ready} onClick={() => run.mutate()}>
            {action === 'approve' ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ErrorBanner error={error} />
        <p className="text-muted">
          {row.quantity} {row.quantityUnit} · HS {row.hsCode} · declaration {row.declarationNumber || row.taskCd}
        </p>
        {action === 'approve' ? (
          <>
            <Field label="Received as" hint="The stock item these goods are kept as">
              <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">Choose…</option>
                {items
                  .filter((i) => i.type === 'STOCK')
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code} · {i.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Supplier bill receiving them (optional)" hint="Stock received on this bill is reported to KRA as an import">
              <Select value={billId} onChange={(e) => setBillId(e.target.value)}>
                <option value="">Not yet</option>
                {(bills.data?.items ?? [])
                  .filter((b) => b.status !== 'VOID')
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · {b.partyName} · {b.supplierInvoiceNumber}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        ) : (
          <Field label="Reason" hint="Reported to KRA">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not ours / wrong consignee / short-shipped" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
