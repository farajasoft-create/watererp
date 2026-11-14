import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Internal Audit API (/api/v1/internalaudit/*). */
export const api = moduleApi('internalaudit');
