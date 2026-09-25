import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// Static security headers. The CSP (with a per-request nonce) is set in
// middleware.ts, because a nonce cannot be static (SEC-019).
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // Order pages and their API carry a capability token in the URL: no
    // Referer to Bit/PayBox or anyone else, no indexing (SEC-003). Listed after
    // the catch-all so this Referrer-Policy wins.
    const orderHeaders = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/order/:path*', headers: orderHeaders },
      { source: '/api/orders/:path*', headers: orderHeaders },
    ];
  },
};

export default withNextIntl(nextConfig);
