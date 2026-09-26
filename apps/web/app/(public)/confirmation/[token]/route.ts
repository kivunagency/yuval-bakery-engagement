import { serverEnv } from '@/lib/server/env';
import { readConfirmation } from '@/lib/server/confirmation/issue';

export const dynamic = 'force-dynamic';

// GET /confirmation/<order id>.<mac> (US-0c): the order confirmation PDF,
// byte for byte the file stored when it was issued (its sha256 is checked on
// every read). The link is the capability (lib/server/confirmation/link.ts).
// Served only while the DB says the link is live: not expired (24 months),
// not revoked, the PDF not purged, the order's PII not purged (B5).
// Every refusal is the same 404 with the same body and headers: unknown or
// badly signed token, order id or order number alone, expired, revoked,
// purged, never issued (SEC-003). next.config.ts adds no-referrer + noindex.
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

function notFound() {
  return new Response('Not found', { status: 404, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let pdf;
  try {
    pdf = await readConfirmation(token, serverEnv().SITE_URL.replace(/\/+$/, ''));
  } catch (e) {
    console.error('confirmation read failed', e instanceof Error ? e.message : 'unknown');
    return new Response('Temporarily unavailable', { status: 503, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' } });
  }
  if (!pdf) return notFound();
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      ...HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.bytes.byteLength),
      'Content-Disposition': `attachment; filename="${pdf.filename}"`,
    },
  });
}
