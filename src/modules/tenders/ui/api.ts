import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Tenders (PPADA) API (/api/v1/tenders/*). */
export const api = moduleApi('tenders');
