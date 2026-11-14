import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The HR API (/api/v1/hr/*). */
export const api = moduleApi('hr');
