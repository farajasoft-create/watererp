import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Estates & Tenants API (/api/v1/estates/*). */
export const api = moduleApi('estates');
