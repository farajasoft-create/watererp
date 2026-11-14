export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

function toQuery(q?: Query): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) params.set(k, v.join(','));
    } else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await fetch(`/api/v1${path}${toQuery(query)}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(', ') : (data?.message ?? res.statusText);
    throw new ApiError(res.status, message, data?.errors);
  }
  return data as T;
}

/** Calls under a prefix: the platform API at the root, each module's under /<module>. */
export function moduleApi(prefix = '') {
  const base = prefix ? `/${prefix}` : '';
  return {
    get: <T>(path: string, query?: Query) => request<T>('GET', `${base}${path}`, undefined, query),
    post: <T>(path: string, body?: unknown) => request<T>('POST', `${base}${path}`, body ?? {}),
    put: <T>(path: string, body: unknown) => request<T>('PUT', `${base}${path}`, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', `${base}${path}`, body),
    delete: <T>(path: string) => request<T>('DELETE', `${base}${path}`),
  };
}

/** The platform API: sign-in, users, modules, organisation settings, ledger, SMS. */
export const api = moduleApi();

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details?.length) return err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
