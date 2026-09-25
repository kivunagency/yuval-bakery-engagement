import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { createDeliveryZone, listZonesForAdmin } from '@/lib/server/delivery/admin-zones';
import { zoneCreate, type AdminDeliveryZonesResponse, type DeliveryZonesApiErrorBody } from '@/lib/shared/contracts/delivery-zones';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: DeliveryZonesApiErrorBody['error'], status: number) => json({ error } satisfies DeliveryZonesApiErrorBody, status);

// GET /api/admin/delivery-zones (api-007): every zone, active or not, with its
// cities. POST: create a zone. Admin at aal2 only; the DB checks it again with
// the admin's own JWT, validates, and audits (fn_admin_create_delivery_zone).
export async function GET() {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  try {
    const zones = await listZonesForAdmin(await createUserClient());
    return json({ zones } satisfies AdminDeliveryZonesResponse, 200);
  } catch {
    return fail('server_error', 500);
  }
}

export async function POST(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = zoneCreate.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400);
  const result = await createDeliveryZone(await createUserClient(), body.data);
  return result.ok ? json(result.value, 201) : json(result.body, result.status);
}
