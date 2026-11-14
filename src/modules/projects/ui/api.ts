import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Projects & Donors API (/api/v1/projects/*). */
export const api = moduleApi('projects');
