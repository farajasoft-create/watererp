'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, formatDateTime, today } from '@/modules/finance/ui/lib/format';
import { useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Badge, Button, Card, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, Notice, PageHeader, Select, TableWrap } from './ui';

// ----- Tax withheld by customers --------------------------------------------------------------------

interface Withholding {
  taxCodeId: string;
  taxCode: string;
  rate: string;
  base: string;
  amount: string;
  certificateNumber: string;
  certificateDate: string | null;
}

/** On a receipt: what the customer withheld, and recording their certificates. */
export function CustomerWithholdingCard({ paymentId, currency, withholdings, posted }: { paymentId: string; currency: string; withholdings: Withholding[]; posted: boolean }) {
  const { can } = useSession();
  const precision = usePrecision();
  const [recording, setRecording] = useState<Withholding | null>(null);
  if (!withholdings.length) return null;
  return (
    <Card title="Tax withheld by the customer" padded={false}>
      <table className="table-base">
        <thead>
          <tr>
            <th>Tax</th>
            <th className="num">Base</th>
            <th className="num">Withheld</th>
            <th>Certificate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {withholdings.map((w) => (
            <tr key={w.taxCodeId}>
              <td>
                {w.taxCode} <span className="text-xs text-muted">{w.rate}%</span>
              </td>
              <td className="num">{formatAmount(w.base, precision(currency))}</td>
              <td className="num">{formatAmount(w.amount, precision(currency))}</td>
              <td>{w.certificateNumber ? `${w.certificateNumber} · ${formatDate(w.certificateDate)}` : <Badge tone="amber">Awaited</Badge>}</td>
              <td className="text-right">{posted && can('ar.manage') && <Button size="sm" variant="ghost" onClick={() => setRecording(w)}>{w.certificateNumber ? 'Change' : 'Record certificate'}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {recording && <CertificateDialog paymentId={paymentId} withholding={recording} onClose={() => setRecording(null)} />}
    </Card>
  );
}

function CertificateDialog({ paymentId, withholding, onClose, onSaved }: { paymentId: string; withholding: Withholding; onClose: () => void; onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const [number, setNumber] = useState(withholding.certificateNumber);
  const [date, setDate] = useState(withholding.certificateDate?.slice(0, 10) ?? today());
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post(`/payments/${paymentId}/withholding-certificates`, { taxCodeId: withholding.taxCodeId, certificateNumber: number, certificateDate: date }),
    onSuccess: () => {
      for (const key of [['payment', paymentId], ['withholding-certificates']]) queryClient.invalidateQueries({ queryKey: key });
      onSaved?.();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`${withholding.taxCode} certificate`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={number.trim().length < 3} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <p className="text-sm text-muted">The withholding certificate (from iTax) is what lets you claim the {withholding.amount} withheld.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Certificate number">
            <Input value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Certificate date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

interface CertificateRow extends Withholding {
  paymentId: string;
  number: string;
  date: string;
  customerId: string;
  customerName: string;
  customerTaxId: string;
  currency: string;
  amountFunctional: string;
  daysOutstanding: number | null;
}

export function WithholdingCertificatesPage() {
  const { entity } = useSession();
  const precision = usePrecision();
  const [status, setStatus] = useState<'MISSING' | 'RECEIVED' | 'ALL'>('MISSING');
  const [recording, setRecording] = useState<CertificateRow | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['withholding-certificates', entity?.id, status],
    queryFn: () => api.get<{ items: CertificateRow[]; outstandingFunctional: string }>('/payments/withholding-certificates', { entityId: entity?.id, status }),
  });
  const fp = precision(entity?.functionalCurrency ?? 'KES');
  return (
    <>
      <PageHeader
        title="Withholding certificates"
        description="Tax customers deducted from their payments (income tax and VAT withholding). Record each certificate as it arrives so the credit can be claimed on your returns."
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="MISSING">Awaiting certificate</option>
          <option value="RECEIVED">Certificate received</option>
          <option value="ALL">All</option>
        </Select>
        {data && status !== 'RECEIVED' && (
          <span className="text-sm text-muted">
            Awaited: <b className="text-ink tabular-nums">{formatAmount(data.outstandingFunctional, fp)} {entity?.functionalCurrency}</b>
          </span>
        )}
      </div>
      <ErrorBanner error={error} />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title={status === 'MISSING' ? 'No certificates awaited' : 'Nothing here'}>{status === 'MISSING' ? 'Every amount customers withheld has its certificate.' : undefined}</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Customer</th>
                <th>Tax</th>
                <th className="num">Withheld</th>
                <th>Certificate</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={`${r.paymentId}${r.taxCodeId}`}>
                  <td>
                    <Link className="text-brand-700 hover:underline" href={`/finance/sales/receipts/${r.paymentId}`}>{r.number}</Link>
                    <div className="text-xs text-muted">{formatDate(r.date)}</div>
                  </td>
                  <td>
                    {r.customerName}
                    {r.customerTaxId && <div className="text-xs text-muted">PIN {r.customerTaxId}</div>}
                  </td>
                  <td>{r.taxCode}</td>
                  <td className="num">
                    {formatAmount(r.amount, precision(r.currency))} {r.currency}
                  </td>
                  <td>
                    {r.certificateNumber ? (
                      `${r.certificateNumber} · ${formatDate(r.certificateDate)}`
                    ) : (
                      <Badge tone={(r.daysOutstanding ?? 0) > 60 ? 'red' : 'amber'}>{r.daysOutstanding} days</Badge>
                    )}
                  </td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setRecording(r)}>{r.certificateNumber ? 'Change' : 'Record'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {recording && <CertificateDialog paymentId={recording.paymentId} withholding={recording} onClose={() => setRecording(null)} />}
    </>
  );
}

// ----- Text messages -----------------------------------------------------------------------------

export function SmsSettingsCard() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['sms-settings'], queryFn: () => api.get<{ enabled: boolean; paymentConfirmations: boolean; approvalAlerts: boolean; driver: string }>('/organisation/sms') });
  const [to, setTo] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (v: { enabled: boolean; paymentConfirmations: boolean; approvalAlerts?: boolean }) => api.patch('/organisation/sms', v),
    onSuccess: (v) => queryClient.setQueryData(['sms-settings'], v),
    onError: (err) => setResult(errorMessage(err)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ status: string; lastError: string; provider: string; cost: string | null }>('/sms/test', { to }),
    onSuccess: (r) => setResult(r.status === 'SENT' ? (r.provider === 'capture' ? 'Captured in the SMS log (no provider configured).' : `Sent${r.cost ? ` (${r.cost})` : ''}.`) : `Not sent yet: ${r.lastError || r.status}`),
    onError: (err) => setResult(errorMessage(err)),
  });
  if (!data) return null;
  const manage = can('org.manage');
  return (
    <Card title="Text messages (SMS)">
      <div className="space-y-3 text-sm">
        {data.driver === 'capture' ? (
          <Notice tone="amber">No SMS provider is configured (AT_USERNAME and AT_API_KEY for Africa&rsquo;s Talking), so messages are kept in the SMS log instead of being sent.</Notice>
        ) : (
          <p className="text-muted">Messages are sent through Africa&rsquo;s Talking and billed per message.</p>
        )}
        <Checkbox label="Send text messages to customers (invoice links, reminders)" checked={data.enabled} disabled={!manage} onChange={(enabled) => save.mutate({ enabled, paymentConfirmations: data.paymentConfirmations })} />
        {data.enabled && (
          <Checkbox label="Confirm M-Pesa payments to the payer's phone, with the balance left" checked={data.paymentConfirmations} disabled={!manage} onChange={(paymentConfirmations) => save.mutate({ enabled: true, paymentConfirmations })} />
        )}
        {data.enabled && (
          <Checkbox
            label="Let approvers get a text when something is waiting for them (each person opts in under Account security)"
            checked={data.approvalAlerts}
            disabled={!manage}
            onChange={(approvalAlerts) => save.mutate({ enabled: true, paymentConfirmations: data.paymentConfirmations, approvalAlerts })}
          />
        )}
        {data.enabled && manage && (
          <div className="flex flex-wrap items-center gap-2">
            <Input className="w-44" inputMode="tel" placeholder="0712 345 678" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button size="sm" loading={test.isPending} disabled={!to.trim()} onClick={() => test.mutate()}>Send a test message</Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {can('users.manage') && <Link href="/finance/setup/sms" className="text-xs text-brand-700 hover:underline">SMS log</Link>}
          {result && <span className="text-xs text-muted">{result}</span>}
        </div>
      </div>
    </Card>
  );
}

export function SmsLogPage() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['sms', status],
    queryFn: () => api.get<{ driver: string; items: { id: string; to: string; message: string; category: string; status: string; lastError: string; cost: string | null; createdAt: string }[] }>('/sms', { status: status || undefined, limit: 100 }),
  });
  return (
    <>
      <PageHeader title="SMS log" description="Text messages sent or attempted for your organisation in the last year. Numbers are partly hidden." />
      {data?.driver === 'capture' && (
        <div className="mb-3">
          <Notice tone="amber">No SMS provider is configured: these messages were captured, not delivered.</Notice>
        </div>
      )}
      <Select className="mb-3 w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="">All</option>
        <option value="PENDING">Pending</option>
        <option value="SENT">Sent</option>
        <option value="FAILED">Failed</option>
      </Select>
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No messages yet" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Message</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="align-top">
                  <td className="whitespace-nowrap text-xs">{formatDateTime(m.createdAt)}</td>
                  <td className="whitespace-nowrap text-xs">{m.to}</td>
                  <td className="text-xs">{m.message}</td>
                  <td className="text-xs">{m.category}</td>
                  <td>
                    <Badge tone={m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : 'amber'}>{m.status.toLowerCase()}</Badge>
                    {m.cost && <div className="text-xs text-muted">{m.cost}</div>}
                    {m.lastError && <div className="max-w-56 text-xs text-red-700">{m.lastError}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </>
  );
}

// ----- KRA eTIMS --------------------------------------------------------------------------------------

interface Device {
  id: string;
  branchId: string;
  enabled: boolean;
  environment: 'sandbox' | 'production';
  tin: string;
  bhfId: string;
  dvcSrlNo: string;
  sdcId: string;
  mrcNo: string;
  initialised: boolean;
  initialisedAt: string | null;
  lastInvcNo: number;
  defaultItemClassCode: string;
  defaultTaxType: string;
  lastError: string;
  pending: number;
  failed: number;
  stockPending: number;
  stockFailed: number;
}

interface StockReport {
  id: string;
  sourceNumber: string;
  sourceType: string;
  sarTyCd: string;
  sarNo: number | null;
  date: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  lastError: string;
  lines: { quantity: string; item: { code: string; name: string } | null }[];
}

const SAR_LABEL: Record<string, string> = { '01': 'Import', '02': 'Purchase', '03': 'Return in', '04': 'Transfer in', '06': 'Adjustment in', '11': 'Sale', '12': 'Return out', '13': 'Transfer out', '16': 'Adjustment out' };

interface Submission {
  id: string;
  documentNumber: string;
  invoiceId: string;
  kind: 'SALE' | 'CREDIT';
  status: string;
  invcNo: number | null;
  attempts: number;
  lastError: string;
  createdAt: string;
  sentAt: string | null;
  curRcptNo: number | null;
}

const TAX_TYPES = [
  ['A', 'A · Exempt'],
  ['B', 'B · Standard 16%'],
  ['C', 'C · Zero-rated'],
  ['D', 'D · Non-VAT'],
  ['E', 'E · Reduced 8%'],
];

export function EtimsPage() {
  const { can, entities } = useSession();
  const { data: branches = [] } = useBranches();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ branchId: string; device?: Device } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['etims-devices'], queryFn: () => api.get<Device[]>('/etims/devices') });
  const [status, setStatus] = useState('');
  const submissions = useQuery({ queryKey: ['etims-submissions', status], queryFn: () => api.get<Submission[]>('/etims/submissions', { status: status || undefined, limit: 100 }) });
  const refresh = () => ['etims-devices', 'etims-submissions', 'etims-stock'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const initialise = useMutation({
    mutationFn: (id: string) => api.post<Device>(`/etims/devices/${id}/initialise`),
    onSuccess: () => {
      setNotice('Initialised with KRA. Posted sales invoices and credit notes in this branch are now reported automatically.');
      setError(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const stockRetry = useMutation({
    mutationFn: (id: string) => api.post<{ sent: number; failed: number }>(`/etims/devices/${id}/stock/retry`),
    onSuccess: (r) => {
      setNotice(`${r.sent} stock report${r.sent === 1 ? '' : 's'} sent to KRA${r.failed ? `; ${r.failed} still failing (see the error below)` : ''}.`);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const stockReports = useQuery({ queryKey: ['etims-stock'], queryFn: () => api.get<StockReport[]>('/etims/stock-reports', { limit: 50 }), enabled: can('inventory.view') });
  const retry = useMutation({
    mutationFn: (id: string) => api.post<{ sent: number; failed: number }>(`/etims/devices/${id}/retry`),
    onSuccess: (r) => {
      setNotice(`${r.sent} sent to KRA${r.failed ? `; ${r.failed} still failing (see the error below)` : ''}.`);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const manage = can('compliance.manage');
  // eTIMS is Kenyan: only branches of entities that report in KES.
  const kenyan = branches.filter((b) => b.isActive && entities.find((e) => e.id === b.entityId)?.functionalCurrency === 'KES');
  return (
    <>
      <PageHeader
        title="KRA eTIMS"
        description="Each branch reports its sales invoices and credit notes to KRA through an Online Sales Control Unit (OSCU). Documents go in order with no gaps in numbering; KRA's signature and QR code are then printed on them."
      />
      <div className="space-y-4">
        <ErrorBanner error={error ?? devices.error} />
        {notice && <Notice tone="green">{notice}</Notice>}
        <TableWrap>
          {devices.isLoading ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>KRA PIN / branch</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th className="num">Last invoice no.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {kenyan.map((b) => {
                  const d = devices.data?.find((x) => x.branchId === b.id);
                  return (
                    <tr key={b.id} className="align-top">
                      <td>
                        {b.code} · {b.name}
                      </td>
                      <td>{d ? `${d.tin} / ${d.bhfId}` : <span className="text-muted">Not connected</span>}</td>
                      <td className="text-xs">
                        {d?.dvcSrlNo}
                        {d?.sdcId && <div className="text-muted">SDC {d.sdcId}</div>}
                      </td>
                      <td>
                        {!d ? null : !d.initialised ? (
                          <Badge tone="amber">Not initialised</Badge>
                        ) : d.enabled ? (
                          <Badge tone={d.environment === 'production' ? 'green' : 'blue'}>{d.environment === 'production' ? 'Reporting (live)' : 'Reporting (sandbox)'}</Badge>
                        ) : (
                          <Badge>Paused</Badge>
                        )}
                        {d && (d.pending > 0 || d.failed > 0) && (
                          <div className="mt-1 text-xs text-muted">
                            {d.pending} waiting{d.failed ? `, ${d.failed} failing` : ''}
                          </div>
                        )}
                        {d && (d.stockPending > 0 || d.stockFailed > 0) && (
                          <div className="mt-1 text-xs text-muted">
                            Stock: {d.stockPending} waiting{d.stockFailed ? `, ${d.stockFailed} failing` : ''}
                          </div>
                        )}
                        {d?.lastError && <div className="mt-1 max-w-72 text-xs text-red-700">{d.lastError}</div>}
                      </td>
                      <td className="num">{d?.lastInvcNo ?? ''}</td>
                      <td className="whitespace-nowrap text-right">
                        {manage && (
                          <span className="inline-flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing({ branchId: b.id, device: d })}>{d ? 'Settings' : 'Connect'}</Button>
                            {d && !d.initialised && <Button size="sm" loading={initialise.isPending && initialise.variables === d.id} onClick={() => initialise.mutate(d.id)}>Initialise</Button>}
                            {d && d.initialised && (d.pending > 0 || d.failed > 0) && <Button size="sm" loading={retry.isPending && retry.variables === d.id} onClick={() => retry.mutate(d.id)}>Send now</Button>}
                            {d && d.initialised && <Button size="sm" variant="ghost" loading={stockRetry.isPending && stockRetry.variables === d.id} onClick={() => stockRetry.mutate(d.id)}>Send stock</Button>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </TableWrap>

        <Card
          title="Documents reported to KRA"
          padded={false}
          actions={
            <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All</option>
              <option value="PENDING">Waiting</option>
              <option value="FAILED">Failing</option>
              <option value="SENT">Registered</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          }
        >
          {!submissions.data?.length ? (
            <div className="p-4">
              <Empty title="Nothing reported yet">Posted sales invoices and credit notes in connected branches appear here.</Empty>
            </div>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Posted</th>
                  <th className="num">KRA invoice no.</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {submissions.data.map((sub) => (
                  <tr key={sub.id} className="align-top">
                    <td>
                      <Link className="text-brand-700 hover:underline" href={`/finance/sales/invoices/${sub.invoiceId}`}>{sub.documentNumber}</Link>
                      {sub.kind === 'CREDIT' && <span className="ml-1 text-xs text-muted">credit note</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">{formatDateTime(sub.createdAt)}</td>
                    <td className="num">{sub.invcNo ?? '—'}</td>
                    <td>
                      <EtimsBadge status={sub.status} />
                      {sub.lastError && sub.status !== 'SENT' && <div className="mt-1 max-w-80 text-xs text-red-700">{sub.lastError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {can('inventory.view') && (
        <Card title="Stock movements reported to KRA" padded={false} className="mt-4">
          {!stockReports.data?.length ? (
            <div className="p-4">
              <Empty title="No stock reported yet">Receipts, sales, transfers and adjustments at connected branches are reported to KRA, with what is left of each item.</Empty>
            </div>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Document</th>
                  <th>Movement</th>
                  <th>Items</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {stockReports.data.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap">{formatDate(r.date)}</td>
                    <td>{r.sourceNumber}</td>
                    <td>
                      {SAR_LABEL[r.sarTyCd] ?? r.sarTyCd}
                      {r.sarNo != null && <div className="text-xs text-muted">KRA no. {r.sarNo}</div>}
                    </td>
                    <td className="text-xs">{r.lines.map((l) => `${l.item?.code ?? '?'} × ${Number(l.quantity)}`).join(', ')}</td>
                    <td>
                      <Badge tone={r.status === 'SENT' ? 'green' : r.status === 'FAILED' ? 'red' : 'amber'}>{r.status === 'SENT' ? 'Reported' : r.status === 'FAILED' ? 'KRA rejected' : 'Waiting'}</Badge>
                      {r.lastError && r.status !== 'SENT' && <div className="mt-1 max-w-72 text-xs text-red-700">{r.lastError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {editing && <DeviceDialog branchId={editing.branchId} device={editing.device} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  );
}

export function EtimsBadge({ status }: { status: string }) {
  const tone = status === 'SENT' ? 'green' : status === 'FAILED' ? 'red' : status === 'CANCELLED' ? 'gray' : 'amber';
  const label = status === 'SENT' ? 'KRA registered' : status === 'FAILED' ? 'KRA rejected' : status === 'CANCELLED' ? 'Not reported' : 'Sending to KRA';
  return <Badge tone={tone}>{label}</Badge>;
}

function DeviceDialog({ branchId, device, onClose, onSaved }: { branchId: string; device?: Device; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    enabled: device?.enabled ?? true,
    environment: device?.environment ?? 'sandbox',
    tin: device?.tin ?? '',
    bhfId: device?.bhfId ?? '00',
    dvcSrlNo: device?.dvcSrlNo ?? '',
    defaultItemClassCode: device?.defaultItemClassCode ?? '',
    defaultTaxType: device?.defaultTaxType ?? 'D',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch('/etims/devices', { branchId, ...form }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const locked = !!device && device.lastInvcNo > 0;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={device ? 'eTIMS settings' : 'Connect branch to KRA eTIMS'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} />
        <p className="text-sm text-muted">
          Apply for an OSCU on the KRA eTIMS portal for this branch; KRA issues the device serial number. After saving, choose <b>Initialise</b> to fetch the communication key.
        </p>
        {locked && <Notice tone="amber">This branch has reported invoices to KRA, so its PIN, branch ID, device and environment can no longer be changed here.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="KRA PIN">
            <Input value={form.tin} disabled={locked} onChange={(e) => set({ tin: e.target.value.toUpperCase() })} placeholder="P051234567A" />
          </Field>
          <Field label="KRA branch ID" hint="00 for the head office">
            <Input value={form.bhfId} disabled={locked} maxLength={2} onChange={(e) => set({ bhfId: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Device serial number">
            <Input value={form.dvcSrlNo} disabled={locked} onChange={(e) => set({ dvcSrlNo: e.target.value.trim() })} />
          </Field>
          <Field label="Environment">
            <Select value={form.environment} disabled={locked} onChange={(e) => set({ environment: e.target.value as 'sandbox' | 'production' })}>
              <option value="sandbox">Sandbox (certification)</option>
              <option value="production">Production</option>
            </Select>
          </Field>
          <Field label="Default item classification" hint="KRA classification code used for lines whose item has none (e.g. a services code)">
            <Input inputMode="numeric" value={form.defaultItemClassCode} onChange={(e) => set({ defaultItemClassCode: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Tax type for lines without a tax code">
            <Select value={form.defaultTaxType} onChange={(e) => set({ defaultTaxType: e.target.value })}>
              {TAX_TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox label="Report this branch's sales to KRA" checked={form.enabled} onChange={(enabled) => set({ enabled })} />
      </div>
    </Modal>
  );
}

/** For tax-code and item editors. */
export const ETIMS_TAX_TYPES = TAX_TYPES;
