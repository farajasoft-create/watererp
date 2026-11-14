'use client';

/**
 * A signing key held in this browser: an ECDSA P-256 key pair made with WebCrypto, the private half
 * non-exportable and kept in IndexedDB, so signatures can only be made on this device. The public half
 * is registered with the server, which verifies every signature against it.
 */

const DB = 'gerp-signing';
const STORE = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(name: string, value: unknown) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get<T>(name: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

const pem = (der: ArrayBuffer) => `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`;

/** This device's registered key, if any: the server's key id and the private key handle. */
export async function deviceKey(userId: string) {
  return get<{ keyId: string; privateKey: CryptoKey }>(`user:${userId}`);
}

/** Makes a key pair on this device and returns the public key (PEM) to register. */
export async function createDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyPem: pem(spki) };
}

export async function saveDeviceKey(userId: string, keyId: string, privateKey: CryptoKey) {
  await put(`user:${userId}`, { keyId, privateKey });
}

/** Signs text with the device key; base64 of the raw (r‖s) ECDSA signature. */
export async function signText(privateKey: CryptoKey, text: string) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
