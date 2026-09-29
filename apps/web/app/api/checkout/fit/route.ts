import { NextResponse, type NextRequest } from 'next/server';
import { checkoutFitRequest, type CheckoutFitResponse } from '@/lib/shared/contracts/checkout';
import { checkCartFitsDay } from '@/lib/server/ordering/checkout-fit';
import { isSameOrigin } from '@/lib/server/http/origin';
import { DbError } from '@/lib/server/supabase/rpc';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// POST /api/checkout/fit. Body: checkoutFitRequest (lib/shared/contracts/
// checkout.ts): the day and the cart lines (product ids and quantities).
// 200 { fit }: 'fits' | 'too_big' | 'day_unavailable' | 'product_unavailable',
// the DB's answer to "does this cart pass the single-order cap on that day"
// (fn_checkout_single_order_fit). A state word only, never minutes. Read-only:
// nothing is reserved, and POST /api/orders (fn_create_standard_order) still
// decides when the order is placed. Same-origin only, like /api/orders.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: NO_STORE });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400, headers: NO_STORE });
  }
  const parsed = checkoutFitRequest.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400, headers: NO_STORE });

  try {
    const body: CheckoutFitResponse = { fit: await checkCartFitsDay(parsed.data) };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof DbError && e.code === 'order_items_invalid') {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400, headers: NO_STORE });
    }
    if (e instanceof DbError) {
      // SEC-026: the code only, never the body.
      console.error('checkout fit unavailable', e.code);
      return NextResponse.json({ error: 'fit_unavailable' }, { status: 503, headers: NO_STORE });
    }
    throw e;
  }
}
