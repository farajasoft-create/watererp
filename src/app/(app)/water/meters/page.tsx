'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pager, Select } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, fmtUnits, label, today } from '@/lib/format';
import { useZones, zoneName } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';
import { Meter, Page } from '@/modules/water/ui/types';

function NewMeter({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [f, setF] = useState({ serialNo: '', make: '', sizeMm: '15', dials: '5', type: 'CUSTOMER', zoneId: '', initialReading: '0' });
  const save = useMutation({
    mutationFn: () => api.post('/meters', { ...f, sizeMm: Number(f.sizeMm), dials: Number(f.dials), zoneId: f.zoneId || null, make: f.make || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meters'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Receive meter"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.serialNo || (f.type !== 'CUSTOMER' && !f.zoneId)}>Save</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Serial number">
          <Input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} />
        </Field>
        <Field label="Make">
          <Input value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} />
        </Field>
        <Field label="Size (mm)">
          <Input inputMode="numeric" value={f.sizeMm} onChange={(e) => setF({ ...f, sizeMm: e.target.value })} />
        </Field>
        <Field label="Register dials" hint="Digits before the decimal; used to detect rollover">
          <Input inputMode="numeric" value={f.dials} onChange={(e) => setF({ ...f, dials: e.target.value })} />
        </Field>
        <Field label="Use">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="CUSTOMER">Customer meter (to stores)</option>
            <option value="BULK">Bulk / DMA inlet meter</option>
            <option value="PRODUCTION">Production / treatment works meter</option>
          </Select>
        </Field>
        <Field label="Initial reading">
          <Input inputMode="decimal" value={f.initialReading} onChange={(e) => setF({ ...f, initialReading: e.target.value })} />
        </Field>
        {f.type !== 'CUSTOMER' && (
          <Field label="Zone it measures" className="sm:col-span-2">
            <Select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
              <option value="">Select…</option>
              {zones?.map((z) => (
                <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function MeterTest({ meter, onClose }: { meter: Meter; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ at: today(), result: 'PASS', errorPercent: '', testFlow: '', certificateNo: '', testedBy: '', nextCalibration: '', note: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/meters/${meter.id}/tests`, {
        at: f.at,
        result: f.result,
        errorPercent: f.errorPercent || null,
        testFlow: f.testFlow || undefined,
        certificateNo: f.certificateNo || undefined,
        testedBy: f.testedBy || undefined,
        nextCalibration: f.nextCalibration || null,
        note: f.note || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meters'] });
      qc.invalidateQueries({ queryKey: ['calibration-due'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Accuracy test · ${meter.serialNo}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>Save test</Button>
        </>
      }
    >
      <ErrorBox error={save.error} />
      <p className="text-sm text-muted">A failed test marks an installed meter faulty, so the account is estimated until the meter is replaced.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Test date">
          <Input type="date" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />
        </Field>
        <Field label="Result">
          <Select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
          </Select>
        </Field>
        <Field label="Error at normal flow (%)" hint="Within ±2% passes">
          <Input inputMode="decimal" value={f.errorPercent} onChange={(e) => setF({ ...f, errorPercent: e.target.value })} />
        </Field>
        <Field label="Test flow">
          <Input value={f.testFlow} placeholder="e.g. Q3 2.5 m³/h" onChange={(e) => setF({ ...f, testFlow: e.target.value })} />
        </Field>
        <Field label="Certificate no.">
          <Input value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} />
        </Field>
        <Field label="Tested by (lab or officer)">
          <Input value={f.testedBy} onChange={(e) => setF({ ...f, testedBy: e.target.value })} />
        </Field>
        <Field label="Next calibration">
          <Input type="date" value={f.nextCalibration} onChange={(e) => setF({ ...f, nextCalibration: e.target.value })} />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function CalibrationDue({ onTest }: { onTest: (m: Meter) => void }) {
  const { data, error, isLoading } = useQuery({ queryKey: ['calibration-due'], queryFn: () => api.get<Meter[]>('/meters/calibration-due') });
  return (
    <Card title="Calibration due in the next 30 days or overdue" className="mb-4" padded={false}>
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No meter is due for calibration.</Empty>
      ) : (
        <table className="table-base">
          <thead>
            <tr>
              <th>Serial</th>
              <th>Status</th>
              <th>Account</th>
              <th>Due</th>
              <th>Last test</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <td className="font-medium">{m.serialNo}</td>
                <td><Badge value={m.status} /></td>
                <td>{m.customer ? `${m.customer.accountNo} · ${m.customer.name}` : '—'}</td>
                <td className={m.calibrationDue && m.calibrationDue < today() ? 'text-red-700' : ''}>{fmtDate(m.calibrationDue)}</td>
                <td>{m.lastTest ? `${label(m.lastTest.result)} ${fmtDate(m.lastTest.at)}` : 'Never tested'}</td>
                <td className="text-right">
                  <Button variant="ghost" onClick={() => onTest(m)}>Record test</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function MetersPage() {
  const can = useCan();
  const qc = useQueryClient();
  const { data: zones } = useZones();
  const [q, setQ] = useState({ search: '', status: '', type: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<Meter | null>(null);
  const [showDue, setShowDue] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['meters', q], queryFn: () => api.get<Page<Meter>>('/meters', { ...q, pageSize: 50 }) });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/meters/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meters'] }),
  });
  const set = (patch: Partial<typeof q>) => setQ((p) => ({ ...p, page: 1, ...patch }));

  return (
    <>
      <PageHeader title="Meters" subtitle="Customer, bulk and production meters" actions={
          <>
            <Button variant="secondary" onClick={() => setShowDue(!showDue)}>{showDue ? 'All meters' : 'Calibration due'}</Button>
            {can('water.meter.manage') && <Button onClick={() => setCreating(true)}>Receive meter</Button>}
          </>
        }
      />
      {showDue && <CalibrationDue onTest={setTesting} />}
      <ErrorBox error={setStatus.error} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input placeholder="Serial number" value={q.search} onChange={(e) => set({ search: e.target.value })} className="max-w-xs" />
          <Select value={q.status} onChange={(e) => set({ status: e.target.value })} className="max-w-[10rem]">
            <option value="">Any status</option>
            {['IN_STORE', 'INSTALLED', 'FAULTY', 'REMOVED', 'SCRAPPED'].map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </Select>
          <Select value={q.type} onChange={(e) => set({ type: e.target.value })} className="max-w-[10rem]">
            <option value="">Any type</option>
            <option value="CUSTOMER">Customer</option>
            <option value="BULK">Bulk</option>
            <option value="PRODUCTION">Production</option>
          </Select>
        </div>
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty>No meters.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Account / zone</th>
                  <th className="num">Last reading</th>
                  <th>Read on</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td className="font-medium">{m.serialNo}<div className="text-xs font-normal text-muted">{[m.make, `${m.sizeMm} mm`].filter(Boolean).join(' · ')}</div></td>
                    <td>{label(m.type)}</td>
                    <td><Badge value={m.status} /></td>
                    <td>
                      {m.customer ? (
                        <Link href={`/water/customers/${m.customer.id}`} className="text-brand-700 hover:underline">{m.customer.accountNo} · {m.customer.name}</Link>
                      ) : m.type !== 'CUSTOMER' ? (
                        zoneName(zones, m.zoneId)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{fmtUnits(m.lastReading)}</td>
                    <td>{fmtDate(m.lastReadingDate)}</td>
                    <td className="whitespace-nowrap text-right">
                      {can('water.meter.manage') && m.status !== 'SCRAPPED' && (
                        <Button variant="ghost" onClick={() => setTesting(m)}>Record test</Button>
                      )}
                      {can('water.meter.manage') && m.status === 'INSTALLED' && (
                        <Button variant="ghost" onClick={() => setStatus.mutate({ id: m.id, status: 'FAULTY' })}>Report faulty</Button>
                      )}
                      {can('water.meter.manage') && (m.status === 'REMOVED' || (m.status === 'FAULTY' && !m.customerId)) && (
                        <Button variant="ghost" onClick={() => setStatus.mutate({ id: m.id, status: 'IN_STORE' })}>Tested – to stores</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setQ((p) => ({ ...p, page }))} />}
      </Card>
      {creating && <NewMeter onClose={() => setCreating(false)} />}
      {testing && <MeterTest meter={testing} onClose={() => setTesting(null)} />}
    </>
  );
}
