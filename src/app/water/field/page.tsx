'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Badge, Button, ErrorBox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/modules/water/ui/api';
import { fmtDate, fmtUnits } from '@/lib/format';
import { compressPhoto, currentPosition, offline, QueuedReading } from '@/modules/water/ui/offline-store';

interface Stop {
  meterId: string;
  serialNo: string;
  meterType: string;
  dials: number;
  lastReading: string;
  lastReadingDate: string | null;
  average: string | null;
  read: boolean;
  customer: { accountNo: string; name: string; plotNo?: string; location?: string; status: string } | null;
}
interface Route {
  period: string;
  generatedAt: string;
  zones: { id: string; code: string; name: string }[];
  stops: Stop[];
}

const EXCEPTIONS = [
  ['NO_ACCESS', 'No access (gate locked, dog)'],
  ['METER_FAULTY', 'Meter faulty / stuck / broken glass'],
  ['METER_TAMPERED', 'Meter tampered / bypass'],
] as const;

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function uuid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Quick check against the connection's average, shown before the reader saves. */
function sanity(stop: Stop, value: string): { units: number; warning: string | null } | null {
  if (!value || Number.isNaN(Number(value))) return null;
  const units = Number(value) - Number(stop.lastReading);
  if (units < 0) return { units, warning: 'Lower than the last reading. Check the dials (or a rollover).' };
  const avg = stop.average ? Number(stop.average) : null;
  if (avg && avg >= 2 && units > avg * 2) return { units, warning: `High: average is ${fmtUnits(avg)} m³. Check for leaks and take a photo.` };
  if (avg && avg >= 2 && units < avg * 0.3) return { units, warning: `Low: average is ${fmtUnits(avg)} m³. Check the meter is turning.` };
  if (units === 0) return { units, warning: 'No consumption. Is the house occupied?' };
  return { units, warning: null };
}

function Capture({ stop, onDone, onCancel }: { stop: Stop; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [exception, setException] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = exception ? null : sanity(stop, value);

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const small = await compressPhoto(file);
      setPhoto(small);
      setPreview(URL.createObjectURL(small));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the photo');
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!exception && !value) return setError('Enter the reading or choose why it could not be read');
    if (check?.warning && !photo) return setError('Take a photo of the meter face for an unusual reading');
    setBusy(true);
    const gps = await currentPosition();
    await offline.enqueue({
      clientId: uuid(),
      meterId: stop.meterId,
      serialNo: stop.serialNo,
      accountNo: stop.customer?.accountNo ?? null,
      value: exception ? null : value,
      fieldException: (exception || null) as QueuedReading['fieldException'],
      readAt: new Date().toISOString(),
      gps,
      note: note || undefined,
      photo,
    });
    setBusy(false);
    onDone();
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="rounded-lg border border-line bg-white p-3">
        <div className="text-lg font-semibold">{stop.customer?.accountNo ?? 'Bulk meter'}</div>
        <div className="text-sm">{stop.customer?.name}</div>
        <div className="text-xs text-muted">{[stop.customer?.plotNo, stop.customer?.location].filter(Boolean).join(' · ')}</div>
        <div className="mt-2 grid grid-cols-2 text-sm">
          <span className="text-muted">Meter</span>
          <span className="font-medium">{stop.serialNo}</span>
          <span className="text-muted">Last reading</span>
          <span>{fmtUnits(stop.lastReading)} ({fmtDate(stop.lastReadingDate)})</span>
          <span className="text-muted">Average</span>
          <span>{stop.average ? `${fmtUnits(stop.average)} m³` : '—'}</span>
        </div>
      </div>
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <Field label="Reading">
        <Input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} disabled={Boolean(exception)} className="py-3 text-2xl tracking-widest" />
      </Field>
      {check && (
        <div className={`rounded-md px-3 py-2 text-sm ${check.warning ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>
          {fmtUnits(check.units)} m³ used. {check.warning}
        </div>
      )}
      <Field label="Could not read?">
        <Select value={exception} onChange={(e) => setException(e.target.value)}>
          <option value="">Read normally</option>
          {EXCEPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label="Photo of the meter face">
        <input type="file" accept="image/*" capture="environment" onChange={(e) => onPhoto(e.target.files?.[0])} className="block w-full text-sm" />
      </Field>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img src={preview} alt="Meter" className="max-h-48 rounded border border-line" />}
      <Field label="Note (leak, illegal connection…)">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1 py-3" onClick={onCancel}>Back</Button>
        <Button type="submit" className="flex-1 py-3" disabled={busy}>{busy ? 'Saving…' : 'Save reading'}</Button>
      </div>
    </form>
  );
}

export default function FieldPage() {
  const [route, setRoute] = useState<Route | null>(null);
  const [queue, setQueue] = useState<QueuedReading[]>([]);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [search, setSearch] = useState('');
  const [showRead, setShowRead] = useState(false);
  const [current, setCurrent] = useState<Stop | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshQueue = useCallback(async () => setQueue(await offline.queue()), []);

  const download = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get<Route>('/field/route');
      await offline.set('route', r);
      setRoute(r);
      setStatus(`Route downloaded: ${r.stops.length} meters for ${r.period}`);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      else setStatus('Offline: using the route saved on this phone');
    }
  }, []);

  const sync = useCallback(async () => {
    const items = await offline.queue();
    if (!items.length || !navigator.onLine) return;
    setSyncing(true);
    setError(null);
    try {
      // Photos first, one by one; each uploaded photo id is saved so a retry skips it.
      for (const item of items) {
        if (item.photo && !item.photoId) {
          const res = await fetch('/api/v1/water/readings/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: item.photo, credentials: 'same-origin' });
          if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.message ?? 'Photo upload failed');
          item.photoId = ((await res.json()) as { id: string }).id;
          await offline.enqueue(item);
        }
      }
      const { results } = await api.post<{ results: { clientId: string; ok: boolean; error?: string }[] }>('/readings/sync', {
        readings: items.map((i) => ({ clientId: i.clientId, meterId: i.meterId, value: i.value, fieldException: i.fieldException, readAt: i.readAt, gps: i.gps, photoId: i.photoId ?? null, note: i.note })),
      });
      let ok = 0;
      for (const r of results) {
        if (r.ok) {
          await offline.dequeue(r.clientId);
          ok++;
        } else {
          const item = items.find((i) => i.clientId === r.clientId);
          if (item) await offline.enqueue({ ...item, error: r.error });
        }
      }
      setStatus(`Synced ${ok} of ${results.length} readings`);
      await refreshQueue();
    } catch (err) {
      setError(err);
    } finally {
      setSyncing(false);
    }
  }, [refreshQueue]);

  useEffect(() => {
    (async () => {
      const saved = await offline.get<Route>('route');
      if (saved) setRoute(saved);
      await refreshQueue();
      if (navigator.onLine) await download();
    })();
    // Back in coverage: push whatever was captured offline.
    const up = () => sync();
    window.addEventListener('online', up);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => window.removeEventListener('online', up);
  }, [download, refreshQueue, sync]);

  const queuedMeters = useMemo(() => new Set(queue.map((q) => q.meterId)), [queue]);
  const stops = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (route?.stops ?? []).filter((st) => {
      const done = st.read || queuedMeters.has(st.meterId);
      if (done && !showRead && !s) return false;
      if (!s) return true;
      return [st.serialNo, st.customer?.accountNo, st.customer?.name, st.customer?.plotNo].some((v) => v?.toLowerCase().includes(s));
    });
  }, [route, search, showRead, queuedMeters]);
  const done = route ? route.stops.filter((s) => s.read || queuedMeters.has(s.meterId)).length : 0;

  return (
    <main className="mx-auto min-h-screen max-w-md bg-canvas p-3">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <div className="font-semibold">Meter reading <span className="text-brand-600">{route?.period}</span></div>
          <div className="text-xs text-muted">{route ? `${done} of ${route.stops.length} read` : 'No route on this phone yet'}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={online ? 'green' : 'amber'}>{online ? 'Online' : 'Offline'}</Badge>
          <Link href="/water" className="text-xs text-brand-700">Office</Link>
        </div>
      </header>

      <div className="mb-3 space-y-2">
        <ErrorBox error={error} />
        {status && <Notice>{status}</Notice>}
        {queue.length > 0 && (
          <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
            <span>{queue.length} reading(s) waiting to sync{queue.some((q) => q.error) ? ' (some failed)' : ''}</span>
            <Button onClick={sync} disabled={!online || syncing}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
          </div>
        )}
      </div>

      {current ? (
        <Capture
          stop={current}
          onCancel={() => setCurrent(null)}
          onDone={async () => {
            setCurrent(null);
            await refreshQueue();
            if (navigator.onLine) sync();
          }}
        />
      ) : (
        <>
          <div className="mb-2 flex gap-2">
            <Input placeholder="Search account, name, meter, plot" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button variant="secondary" onClick={download} disabled={!online}>Refresh</Button>
          </div>
          <label className="mb-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} /> Show meters already read
          </label>
          <ul className="space-y-2">
            {stops.slice(0, 200).map((s) => {
              const queued = queuedMeters.has(s.meterId);
              const failed = queue.find((q) => q.meterId === s.meterId)?.error;
              return (
                <li key={s.meterId}>
                  <button type="button" onClick={() => setCurrent(s)} className="w-full rounded-lg border border-line bg-white p-3 text-left active:bg-brand-50">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{s.customer?.accountNo ?? `Bulk ${s.serialNo}`}</span>
                      {s.read ? <Badge value="APPROVED">Read</Badge> : queued ? <Badge tone={failed ? 'red' : 'amber'}>{failed ? 'Sync failed' : 'Saved'}</Badge> : null}
                    </div>
                    <div className="text-sm">{s.customer?.name}</div>
                    <div className="text-xs text-muted">{[s.customer?.plotNo, s.customer?.location, `meter ${s.serialNo}`].filter(Boolean).join(' · ')}</div>
                    {failed && <div className="mt-1 text-xs text-red-700">{failed}</div>}
                  </button>
                </li>
              );
            })}
          </ul>
          {route && stops.length > 200 && <p className="mt-2 text-center text-xs text-muted">Showing 200; search to narrow down.</p>}
          {route && !stops.length && <p className="mt-6 text-center text-sm text-muted">All meters on the route are read.</p>}
        </>
      )}
    </main>
  );
}
