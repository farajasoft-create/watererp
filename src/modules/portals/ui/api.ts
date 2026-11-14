import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The Portals, Library & MSMEs API (/api/v1/portals/*). */
export const api = moduleApi('portals');
