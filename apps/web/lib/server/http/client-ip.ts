import 'server-only';
import { headers } from 'next/headers';

/** Client IP for rate limiting. Netlify sets x-nf-client-connection-ip itself. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-nf-client-connection-ip') ??
    h.get('x-real-ip') ??
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  ).slice(0, 64);
}
