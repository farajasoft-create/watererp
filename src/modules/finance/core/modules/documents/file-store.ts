import { AwsClient } from 'aws4fetch';
import mongoose, { Connection, Types } from 'mongoose';

/**
 * Where attachment contents live. Production uses Cloudflare R2 (S3-compatible object storage), so
 * MongoDB only holds metadata and large scans and photos never pass through the database. GridFS is
 * the fallback for local development, and an in-memory store backs the tests.
 */
export interface FileStore {
  readonly driver: 'r2' | 'gridfs' | 'memory';
  /** Whether browsers can upload straight to the store with a signed URL (bypassing request limits). */
  readonly direct: boolean;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** The first bytes only (signature checks without downloading the whole file). */
  head(key: string, bytes: number): Promise<{ size: number; start: Buffer } | null>;
  delete(key: string): Promise<void>;
  /** A short-lived URL the browser can PUT the file to. */
  presignPut(key: string, contentType: string, seconds: number): Promise<string>;
  /** A short-lived URL that serves the file with the given name and disposition. */
  presignGet(key: string, opts: { seconds: number; filename: string; contentType: string; inline: boolean }): Promise<string | null>;
}

const disposition = (filename: string, inline: boolean) => `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`;

class R2Store implements FileStore {
  readonly driver = 'r2' as const;
  readonly direct = true;
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; endpoint?: string }) {
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' });
    const endpoint = (cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
    this.base = `${endpoint}/${cfg.bucket}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, data: Buffer, contentType: string) {
    const res = await this.client.fetch(this.url(key), { method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': contentType } });
    if (!res.ok) throw new Error(`R2 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  async get(key: string) {
    const res = await this.client.fetch(this.url(key), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async head(key: string, bytes: number) {
    const res = await this.client.fetch(this.url(key), { method: 'GET', headers: { range: `bytes=0-${bytes - 1}` } });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) throw new Error(`R2 read failed (${res.status})`);
    const start = Buffer.from(await res.arrayBuffer());
    const range = res.headers.get('content-range');
    const size = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length') ?? start.length);
    return { size, start };
  }

  async delete(key: string) {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status})`);
  }

  async presignPut(key: string, _contentType: string, seconds: number) {
    const signed = await this.client.sign(new Request(`${this.url(key)}?X-Amz-Expires=${seconds}`, { method: 'PUT' }), { aws: { signQuery: true } });
    return signed.url;
  }

  async presignGet(key: string, opts: { seconds: number; filename: string; contentType: string; inline: boolean }) {
    const q = new URLSearchParams({
      'X-Amz-Expires': String(opts.seconds),
      'response-content-type': opts.contentType,
      'response-content-disposition': disposition(opts.filename, opts.inline),
      'response-cache-control': 'private, no-store',
    });
    const signed = await this.client.sign(new Request(`${this.url(key)}?${q}`, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  }
}

/** Development fallback: files in the `attachments` GridFS bucket, keyed by object id. */
class GridFsStore implements FileStore {
  readonly driver = 'gridfs' as const;
  readonly direct = false;
  constructor(private readonly connection: Connection) {}

  private bucket() {
    return new mongoose.mongo.GridFSBucket(this.connection.db!, { bucketName: 'finance_attachments' });
  }

  private id(key: string) {
    return new Types.ObjectId(key.split('/').pop()!.slice(0, 24));
  }

  async put(key: string, data: Buffer, contentType: string) {
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket().openUploadStreamWithId(this.id(key), key, { metadata: { contentType } });
      stream.on('error', reject).on('finish', () => resolve());
      stream.end(data);
    });
  }

  async get(key: string) {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of this.bucket().openDownloadStream(this.id(key))) chunks.push(chunk as Buffer);
    } catch {
      return null;
    }
    return Buffer.concat(chunks);
  }

  async head(key: string, bytes: number) {
    const data = await this.get(key);
    return data ? { size: data.length, start: data.subarray(0, bytes) } : null;
  }

  async delete(key: string) {
    await this.bucket()
      .delete(this.id(key))
      .catch(() => undefined);
  }

  async presignPut(): Promise<string> {
    throw new Error('Direct uploads need object storage (R2)');
  }

  async presignGet() {
    return null;
  }
}

/** Tests: objects in a map; "presigned" URLs are memory:// keys the test harness writes to. */
export class MemoryStore implements FileStore {
  readonly driver = 'memory' as const;
  readonly direct = true;
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, data: Buffer, contentType: string) {
    this.objects.set(key, { data, contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.data ?? null;
  }
  async head(key: string, bytes: number) {
    const o = this.objects.get(key);
    return o ? { size: o.data.length, start: o.data.subarray(0, bytes) } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async presignPut(key: string) {
    return `memory://${key}`;
  }
  async presignGet(key: string) {
    return this.objects.has(key) ? `memory://${key}` : null;
  }
}

const globalStore = globalThis as unknown as { __farajasoftMemoryStore?: MemoryStore };

export function createFileStore(connection: Connection, forced?: 'gridfs'): FileStore {
  const env = process.env;
  const driver = forced ?? env.STORAGE_DRIVER ?? (env.R2_BUCKET ? 'r2' : 'gridfs');
  if (driver === 'r2') {
    const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => !env[k] && !(k === 'R2_ACCOUNT_ID' && env.R2_ENDPOINT));
    if (missing.length) throw new Error(`Cloudflare R2 storage needs ${missing.join(', ')}`);
    return new R2Store({ accountId: env.R2_ACCOUNT_ID ?? '', accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!, bucket: env.R2_BUCKET!, endpoint: env.R2_ENDPOINT });
  }
  if (driver === 'memory') return (globalStore.__farajasoftMemoryStore ??= new MemoryStore());
  return new GridFsStore(connection);
}
