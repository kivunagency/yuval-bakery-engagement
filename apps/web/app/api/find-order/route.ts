import { NextResponse, type NextRequest } from 'next/server';
import { findOrderRequest, findOrderResponse, type FindOrderErrorBody } from '@/lib/shared/contracts/find-order';
import { findOrder } from '@/lib/server/ordering/find-order';
import { isSameOrigin } from '@/lib/server/http/origin';
import { clientIpFrom } from '@/lib/server/http/client-ip';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store' };
const STATUS: Record<FindOrderErrorBody['error'], number> = { invalid_input: 400, forbidden_origin: 403, too_many_attempts: 429, server_error: 500 };

function fail(body: FindOrderErrorBody) {
  return NextResponse.json(body, { status: STATUS[body.error], headers: HEADERS });
}

// POST /api/find-order (US-0d). Body { phone, orderNumber }. 200 with
// { result: 'found', order } (masked view + confirmation PDF link) or
// { result: 'not_found' } for every miss: unknown number, wrong phone, both,
// or an anonymized order. 429 after the DB's per-IP or per-phone limit.
// Same-origin only (the /find-order page is the only legitimate caller).
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return fail({ error: 'forbidden_origin' });
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return fail({ error: 'invalid_input' });
  }
  const parsed = findOrderRequest.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean);
    return fail({ error: 'invalid_input', fields });
  }
  const result = await findOrder(parsed.data, clientIpFrom(request.headers));
  if (!result.ok) return fail({ error: result.error });
  return NextResponse.json(findOrderResponse.parse(result.value), { status: 200, headers: HEADERS });
}
