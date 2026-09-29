import { after, NextResponse, type NextRequest } from 'next/server';
import { createOrderRequest, type CheckoutErrorBody } from '@/lib/shared/contracts/checkout';
import { createStandardOrder } from '@/lib/server/ordering/create-order';
import { isSameOrigin } from '@/lib/server/http/origin';
import { clientIpFrom } from '@/lib/server/http/client-ip';
import { onOrderCreated } from '@/lib/server/confirmation/on-order-created';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const STATUS: Record<CheckoutErrorBody['error'], number> = {
  invalid_input: 400,
  forbidden_origin: 403,
  day_full: 409,
  day_almost_full: 409,
  order_too_big: 409,
  too_soon: 409,
  slot_unavailable: 409,
  city_not_served: 409,
  product_unavailable: 409,
  too_many_attempts: 429,
  too_many_open_orders: 429,
  server_error: 500,
};

function fail(body: CheckoutErrorBody) {
  return NextResponse.json(body, { status: STATUS[body.error], headers: NO_STORE });
}

// POST /api/orders (api-003). Guest checkout. Body: createOrderRequest
// (lib/shared/contracts/checkout.ts): product ids and quantities, day, slot,
// delivery or pickup, city and address, contact details. Never an amount:
// the DB prices the order (SEC-008). 201 { token }: the capability token of
// the order page /order/<token> (SEC-003). Same-origin only (the checkout
// page is the only legitimate caller).
// Not built here, needs an account of Yuval's: a Turnstile check (SEC-005
// layer 1). The DB's rate limits and caps (layers 2-4) apply regardless.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return fail({ error: 'forbidden_origin' });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return fail({ error: 'invalid_input' });
  }
  const parsed = createOrderRequest.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean);
    return fail({ error: 'invalid_input', fields });
  }

  const result = await createStandardOrder(parsed.data, clientIpFrom(request.headers));
  if (!result.ok) return fail({ error: result.error, ...(result.pickAnotherDay ? { pickAnotherDay: true } : {}) });
  // After the response: issue the confirmation PDF, notify (admin push and
  // email, customer email with the PDF) and record an emailed confirmation
  // (US-0c). Never fails the order.
  after(() => onOrderCreated(result.orderId));
  return NextResponse.json({ token: result.token }, { status: 201, headers: NO_STORE });
}
