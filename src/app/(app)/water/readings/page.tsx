'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Pager, Select, Textarea } from '@/components/ui';
import { csvDate, parseCsv } from '@/lib/csv';
import { api } from '@/modules/water/ui/api';
import { currentPeriod, fmtDateTime, fmtUnits, label } from '@/lib/format';
import { useCycles } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';
import { Page, Reading } from '@/modules/water/ui/types';

function Review({ reading, onClose }: { reading: Reading; onClose: () => void }) {
  const qc = useQueryClient();
  const [corrected, setCorrected] = useState('');
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (action: 'APPROVE' | 'REJECT') => api.post(`/readings/${reading.id}/review`, { action, correctedValue: corrected || null, note: note || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['readings'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Review reading · ${reading.meterSerial}`}
      footer={
        <>
          <Button variant="danger" onClick={() => review.mutate('REJECT')} disabled={review.isPending}>Reject (re-read or estimate)</Button>
          <Button onClick={() => review.mutate('APPROVE')} disabled={review.isPending}>{corrected ? 'Approve corrected value' : 'Approve'}</Button>
        </>
      }
    >
      <ErrorBox error={review.error} />
      <dl className="grid grid-cols-3 gap-y-1 text-sm">
        <dt className="text-muted">Account</dt>
        <dd className="col-span-2">{reading.customer ? `${reading.customer.accountNo} · ${reading.customer.name}` : 'Bulk meter'}</dd>
        <dt className="text-muted">Previous</dt>
        <dd className="col-span-2">{fmtUnits(reading.previousValue)}</dd>
        <dt className="text-muted">Reading</dt>
        <dd className="col-span-2 font-medium">{fmtUnits(reading.value)} ({fmtUnits(reading.registerUnits)} m³)</dd>
        <dt className="text-muted">Exception</dt>
        <dd className="col-span-2"><Badge value={reading.exception} /></dd>
        <dt className="text-muted">Reader</dt>
        <dd className="col-span-2">{reading.readerName ?? '—'} · {fmtDateTime(reading.readAt)}</dd>
        {reading.note && (
          <>
            <dt className="text-muted">Reader&apos;s note</dt>
            <dd className="col-span-2">{reading.note}</dd>
          </>
        )}
        {reading.gps && (
          <>
            <dt className="text-muted">GPS</dt>
            <dd className="col-span-2">
              <a className="text-brand-700 hover:underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${reading.gps.lat}&mlon=${reading.gps.lng}#map=18/${reading.gps.lat}/${reading.gps.lng}`}>
                {reading.gps.lat.toFixed(5)}, {reading.gps.lng.toFixed(5)}
              </a>
              {reading.gps.accuracy ? ` (±${Math.round(reading.gps.accuracy)} m)` : ''}
            </dd>
          </>
        )}
      </dl>
      {reading.photoId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/v1/water/readings/photos/${reading.photoId}`} alt="Meter face" className="max-h-72 w-full rounded border border-line object-contain" />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Corrected value (optional)" hint="From the photo or a re-read">
          <Input inputMode="decimal" value={corrected} onChange={(e) => setCorrected(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ReadingsInner() {
  const params = useSearchParams();
  const can = useCan();
  const qc = useQueryClient();
  const { data: cycles } = useCycles();
  const openCycle = cycles?.find((c) => c.status === 'OPEN');
  const [q, setQ] = useState({ period: '', status: params.get('status') ?? '', exceptionsOnly: params.get('status') === 'PENDING', page: 1 });
  const period = q.period || openCycle?.period || cycles?.[0]?.period || '';
  const [reviewing, setReviewing] = useState<Reading | null>(null);
  const [newPeriod, setNewPeriod] = useState(currentPeriod());
  const { data, error, isLoading } = useQuery({
    queryKey: ['readings', { ...q, period }],
    queryFn: () => api.get<Page<Reading>>('/readings', { period, status: q.status, exceptionsOnly: q.exceptionsOnly || undefined, page: q.page, pageSize: 50 }),
    enabled: Boolean(period),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cycles'] });
    qc.invalidateQueries({ queryKey: ['readings'] });
  };
  const open = useMutation({ mutationFn: () => api.post('/cycles', { period: newPeriod }), onSuccess: invalidate });
  const close = useMutation({ mutationFn: (p: string) => api.post(`/cycles/${p}/close`), onSuccess: invalidate });
  const estimate = useMutation({ mutationFn: (p: string) => api.post<{ estimated: number; awaitingReview: number }>(`/cycles/${p}/estimate`, {}), onSuccess: invalidate });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));
  const [importing, setImporting] = useState(false);

  return (
    <>
      {importing && <ReadingImport onClose={() => setImporting(false)} />}
      <PageHeader
        title="Meter readings"
        subtitle={openCycle ? `Cycle ${openCycle.period} is open for reading` : 'No reading cycle is open'}
        actions={
          can('water.billing.run') &&
          (openCycle ? (
            <>
              {can('water.reading.approve') && (
                <>
                  <Button variant="secondary" onClick={() => setImporting(true)}>Upload readings (CSV)</Button>
                  <Button variant="secondary" onClick={() => estimate.mutate(openCycle.period)} disabled={estimate.isPending}>Estimate unread meters</Button>
                </>
              )}
              <Button variant="secondary" onClick={() => close.mutate(openCycle.period)} disabled={close.isPending}>Close cycle</Button>
            </>
          ) : (
            <>
              <Input type="month" value={newPeriod} onChange={(e) => setNewPeriod(e.target.value)} className="w-40" />
              <Button onClick={() => open.mutate()} disabled={open.isPending}>Open reading cycle</Button>
            </>
          ))
        }
      />
      <div className="mb-4 space-y-2">
        <ErrorBox error={open.error || close.error || estimate.error} />
        {estimate.data && (
          <Notice tone="green">
            {estimate.data.estimated} connections estimated. {estimate.data.awaitingReview > 0 && `${estimate.data.awaitingReview} readings still await review and were not estimated.`}
          </Notice>
        )}
      </div>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Select value={period} onChange={(e) => set({ period: e.target.value })} className="max-w-[10rem]">
            {cycles?.map((c) => (
              <option key={c.id} value={c.period}>{c.period} ({label(c.status)})</option>
            ))}
          </Select>
          <Select value={q.status} onChange={(e) => set({ status: e.target.value })} className="max-w-[10rem]">
            <option value="">Any status</option>
            {['PENDING', 'APPROVED', 'REJECTED', 'BILLED'].map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={q.exceptionsOnly} onChange={(e) => set({ exceptionsOnly: e.target.checked })} /> Exceptions only
          </label>
        </div>
        <ErrorBox error={error} />
        {!period ? (
          <Empty>Open a reading cycle to start capturing readings.</Empty>
        ) : isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No readings match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Meter</th>
                  <th>Account</th>
                  <th className="num">Previous</th>
                  <th className="num">Reading</th>
                  <th className="num">Units</th>
                  <th>Type</th>
                  <th>Exception</th>
                  <th>Status</th>
                  <th>Reader</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.meterSerial}</td>
                    <td>{r.customer ? `${r.customer.accountNo} · ${r.customer.name}` : 'Bulk'}</td>
                    <td className="num">{r.type === 'ESTIMATED' ? '—' : fmtUnits(r.previousValue)}</td>
                    <td className="num">{fmtUnits(r.value)}</td>
                    <td className="num">{fmtUnits(r.units)}</td>
                    <td><Badge value={r.type} /></td>
                    <td>{r.exception !== 'NONE' && <Badge value={r.exception} />}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="text-xs">{r.readerName}<div className="text-muted">{fmtDateTime(r.readAt)}</div></td>
                    <td className="text-right">
                      {can('water.reading.approve') && r.status === 'PENDING' && <Button variant="ghost" onClick={() => setReviewing(r)}>Review</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {reviewing && <Review reading={reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}

interface ImportResult {
  imported: number;
  failed: number;
  results: { row: number; serialNo: string; ok: boolean; duplicate?: boolean; status?: string; exception?: string; error?: string }[];
}

/** Bulk upload: a CSV of meter serial, reading and date (from Excel or a handheld logger). */
function ReadingImport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const rows = parseCsv(text)
    .filter((r) => r.length >= 2 && /\d/.test(r[1]))
    .map((r) => ({ serialNo: r[0], value: r[1].replace(/,/g, ''), readAt: csvDate(r[2] ?? '') ?? new Date().toISOString().slice(0, 10), note: r[3] || undefined }));
  const upload = useMutation({
    mutationFn: () => api.post<ImportResult>('/readings/import', { rows }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['readings'] }),
  });
  return (
    <Modal open wide onClose={onClose} title="Upload readings" footer={<Button onClick={() => upload.mutate()} disabled={upload.isPending || !rows.length}>Upload {rows.length} readings</Button>}>
      <ErrorBox error={upload.error} />
      <p className="text-sm text-muted">
        One reading per line: <code>meter serial, reading, date, note</code>. The date may be 2026-10-28 or 28/10/2026; a header row is skipped. Each reading gets the same checks as the field app, and uploading the same file twice records nothing twice.
      </p>
      <Input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) setText(await file.text());
        }}
      />
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'SN10023, 1234.5, 2026-10-28\nSN10024, 870, 28/10/2026'} />
      {upload.data && (
        <>
          <Notice tone={upload.data.failed ? 'amber' : 'green'}>
            {upload.data.imported} recorded, {upload.data.results.filter((r) => r.duplicate).length} already there, {upload.data.failed} failed.
          </Notice>
          {upload.data.failed > 0 && (
            <ul className="max-h-48 overflow-y-auto text-sm">
              {upload.data.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.row} className="text-red-700">
                    Line {r.row} ({r.serialNo}): {r.error}
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

export default function ReadingsPage() {
  return (
    <Suspense>
      <ReadingsInner />
    </Suspense>
  );
}
