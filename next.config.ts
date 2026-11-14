import path from 'path';
import type { NextConfig } from 'next';

const dev = process.env.NODE_ENV !== 'production';

/**
 * Content Security Policy for the app's pages. Next.js bootstraps with inline scripts, so scripts and
 * styles allow 'unsafe-inline'; everything else is limited to this origin.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? ' ws:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The field app uses the camera (meter photos) and location (GPS tag on each reading).
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  // The API (src/platform, src/modules/*/server) runs in Node.js route handlers; keep the database driver out of the bundle.
  serverExternalPackages: ['mongoose', 'bcryptjs', 'pdfkit'],
  // PDFKit (finance invoices and vouchers) reads its built-in font metrics from disk at run time.
  outputFileTracingIncludes: { '/api/v1/[...path]': ['./node_modules/pdfkit/js/data/**'] },
  poweredByHeader: false,
  // Pin the project root so a lockfile in a parent folder is never mistaken for the workspace root.
  outputFileTracingRoot: path.resolve('.'),
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/((?!api/).*)', headers: [{ key: 'Content-Security-Policy', value: csp }] },
      // The service worker must be able to control the whole field app.
      { source: '/sw.js', headers: [{ key: 'Service-Worker-Allowed', value: '/' }, { key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default nextConfig;
