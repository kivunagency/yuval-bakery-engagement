import { NextResponse } from 'next/server';
import { getOrderByToken } from '@/lib/server/ordering/order-by-token';

export const dynamic = 'force-dynamic';

// Order pages carry a capability token: never cached, never indexed, never
// sent on as a Referer (SEC-003).
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };

// GET /api/orders/[token] (SEC-003). The token is the only key: an order
// number or an internal id gets the same 404 as an unknown or expired token.
// Returns the same view the order page renders (orderView contract).
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const order = await getOrderByToken(token);
  if (!order) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: HEADERS });
  return NextResponse.json(order, { headers: HEADERS });
}
