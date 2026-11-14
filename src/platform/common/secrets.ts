import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Key for secrets stored in settings (API keys, gateway passwords). Defaults to JWT_SECRET; keep it stable. */
function key(): Buffer {
  const material = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) throw new Error('JWT_SECRET must be set');
  return createHash('sha256').update(`farajasoft-water:${material}`).digest();
}

/** AES-256-GCM; the result is `iv.tag.ciphertext` in base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Shows only the last characters of a secret, for settings screens. */
export function maskSecret(value: string | null | undefined): string | null {
  return value ? `••••${value.slice(-4)}` : null;
}
