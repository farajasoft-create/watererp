import { Connection } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileStore } from './file-store';

const R2_ENV = { R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret-example', R2_BUCKET: 'farajasoft-docs' };

describe('Cloudflare R2 file store', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const r2 = () => {
    Object.assign(process.env, R2_ENV);
    delete process.env.STORAGE_DRIVER;
    return createFileStore({} as Connection);
  };

  it('is chosen when R2 is configured and signs upload URLs', async () => {
    const store = r2();
    expect(store.driver).toBe('r2');
    expect(store.direct).toBe(true);
    const url = new URL(await store.presignPut('org/attachments/2026/10/id/invoice 1.pdf', 'application/pdf', 900));
    expect(url.origin).toBe('https://abc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/farajasoft-docs/org/attachments/2026/10/id/invoice%201.pdf');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('signs download URLs that set the file name and disposition', async () => {
    const url = new URL((await r2().presignGet('org/x.pdf', { seconds: 300, filename: 'Facture été.pdf', contentType: 'application/pdf', inline: true }))!);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toBe("inline; filename*=UTF-8''Facture%20%C3%A9t%C3%A9.pdf");
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('refuses to start with incomplete R2 settings', () => {
    Object.assign(process.env, { STORAGE_DRIVER: 'r2', R2_BUCKET: 'b' });
    delete process.env.R2_SECRET_ACCESS_KEY;
    expect(() => createFileStore({} as Connection)).toThrow(/R2_SECRET_ACCESS_KEY/);
  });

  it('falls back to GridFS when no object storage is configured', () => {
    for (const k of Object.keys(R2_ENV)) delete process.env[k];
    delete process.env.STORAGE_DRIVER;
    expect(createFileStore({} as Connection).driver).toBe('gridfs');
  });
});
