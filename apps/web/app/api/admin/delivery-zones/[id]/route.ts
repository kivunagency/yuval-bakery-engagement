import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { deleteDeliveryZone, updateDeliveryZone } from '@/lib/server/delivery/admin-zones';
import { zoneIdParam, zonePatch, type DeliveryZonesApiErrorBody } from '@/lib/shared/contracts/delivery-zones';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: DeliveryZonesApiErrorBody['error'], status: number) => json({ error } satisfies DeliveryZonesApiErrorBody, status);

// PATCH /api/admin/delivery-zones/[id] (api-007): change name, fee, active
// flag and/or the whole city list. DELETE: remove the zone (orders keep the
// fee they were created with). A city already in another zone is a 409 that
// names the city and that zone.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = zoneIdParam.safeParse((await params).id);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = zonePatch.safeParse(raw);
  if (!id.success || !body.success) return fail('invalid_input', 400);
  const result = await updateDeliveryZone(await createUserClient(), id.data, body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = zoneIdParam.safeParse((await params).id);
  if (!id.success) return fail('invalid_input', 400);
  const result = await deleteDeliveryZone(await createUserClient(), id.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
