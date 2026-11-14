import { expect } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { Db } from '../../src/modules/finance/core/database/db.service';
import { handleApi } from '../../src/modules/finance/core/routes';

export interface TestResponse {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- assertions read arbitrary JSON
  headers: Headers;
}

/** A small Supertest-style request builder that calls the API router in-process. */
class TestRequest implements PromiseLike<TestResponse> {
  private headers = new Headers({ 'x-forwarded-for': '127.0.0.1' });
  private payload: unknown;
  private rawBody: Uint8Array | null = null;
  private expected: number | null = null;

  constructor(
    private readonly method: string,
    private readonly url: string,
  ) {}

  set(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  }

  send(body: unknown) {
    this.payload = body;
    return this;
  }

  /** Sends bytes as the body (file uploads). */
  raw(data: Uint8Array | string, contentType = 'application/octet-stream') {
    this.rawBody = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.headers.set('content-type', contentType);
    return this;
  }

  expect(status: number) {
    this.expected = status;
    return this;
  }

  private async run(): Promise<TestResponse> {
    if (this.payload !== undefined && !this.rawBody) this.headers.set('content-type', 'application/json');
    const res = await handleApi(
      new Request(`http://localhost${this.url}`, {
        method: this.method,
        headers: this.headers,
        body: this.rawBody ? Buffer.from(this.rawBody) : this.payload !== undefined ? JSON.stringify(this.payload) : undefined,
      }),
    );
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    const out = { status: res.status, body: text ? (json ? JSON.parse(text) : text) : null, headers: res.headers };
    if (this.expected !== null) {
      expect({ status: out.status, body: out.status === this.expected ? undefined : out.body }).toEqual({ status: this.expected, body: undefined });
    }
    return out;
  }

  then<A = TestResponse, B = never>(onfulfilled?: ((value: TestResponse) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(onfulfilled, onrejected);
  }
}

export const api = () => ({
  get: (url: string) => new TestRequest('GET', url),
  post: (url: string) => new TestRequest('POST', url),
  put: (url: string) => new TestRequest('PUT', url),
  patch: (url: string) => new TestRequest('PATCH', url),
  delete: (url: string) => new TestRequest('DELETE', url),
});

/** Connects to the test database, wipes it and recreates collections and indexes. */
export async function createTestApp(): Promise<{ db: Db }> {
  const { db } = await getServices();
  await db.connection.dropDatabase();
  await db.ensureSchema();
  return { db };
}

export async function closeTestApp() {
  const { db } = await getServices();
  await db.connection.close();
}
