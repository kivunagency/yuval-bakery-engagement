import 'server-only';
import { headers } from 'next/headers';

// Client IP for rate limiting (SEC-005: checkout, custom-cake requests,
// admin login). Netlify sets x-nf-client-connection-ip itself; the fallbacks
// serve other proxies and the local stack. That Netlify overwrites a
// client-supplied value is UNVERIFIED (SYSTEM-CONTRACT section 3).
export function clientIpFrom(h: Headers): string {
  return (
    h.get('x-nf-client-connection-ip') ??
    h.get('x-real-ip') ??
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  ).slice(0, 64);
}

/** Same, for server actions and components that have no Request object. */
export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}
