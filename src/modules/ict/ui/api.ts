import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The ICT & Administration API (/api/v1/ict/*). */
export const api = moduleApi('ict');
