'use client';

/** A small IndexedDB wrapper: the downloaded route and the queue of readings waiting to sync. */

const DB_NAME = 'farajasoft-water-field';
const VERSION = 1;

export interface QueuedReading {
  clientId: string;
  meterId: string;
  serialNo: string;
  accountNo: string | null;
  value: string | null;
  fieldException: 'NO_ACCESS' | 'METER_FAULTY' | 'METER_TAMPERED' | null;
  readAt: string;
  gps: { lat: number; lng: number; accuracy?: number } | null;
  note?: string;
  photo: Blob | null;
  /** Set once the photo is uploaded, so a retry does not upload it again. */
  photoId?: string | null;
  error?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'clientId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const offline = {
  get: <T>(key: string) => tx<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key: string, value: unknown) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  queue: () => tx<QueuedReading[]>('queue', 'readonly', (s) => s.getAll() as IDBRequest<QueuedReading[]>),
  enqueue: (r: QueuedReading) => tx('queue', 'readwrite', (s) => s.put(r)),
  dequeue: (clientId: string) => tx('queue', 'readwrite', (s) => s.delete(clientId)),
};

/** Shrinks a camera photo to at most 1280 px and JPEG, so it uploads quickly on a weak signal. */
export async function compressPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo'))), 'image/jpeg', 0.7));
}

export function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    ),
  );
}
