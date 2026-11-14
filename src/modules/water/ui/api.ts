import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The water API (/api/v1/water/*). */
export const api = moduleApi('water');
