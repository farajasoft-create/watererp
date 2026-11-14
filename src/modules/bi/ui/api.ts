import { ApiError, moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Reports & Analytics API (/api/v1/bi/*). */
export const api = moduleApi('bi');

/** POSTs to an export endpoint and saves the file it returns. */
export async function downloadPost(path: string, body: unknown, fallbackName: string) {
  const res = await fetch(`/api/v1/bi${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.message ?? 'Export failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
