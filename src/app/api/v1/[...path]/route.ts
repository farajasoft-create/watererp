import { handleApi } from '@/platform/api';

/** Every /api/v1/* request is served by the API router (src/platform/api.ts). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Billing runs issue thousands of bills; give them headroom beyond the default.
export const maxDuration = 300;

const handler = (req: Request) => handleApi(req);

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
