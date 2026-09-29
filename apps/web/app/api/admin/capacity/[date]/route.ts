import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { updateDayCapacity } from '@/lib/server/capacity/admin-capacity';
import { capacityDayParam, dayCapacityPatch, type CapacityApiErrorBody } from '@/lib/shared/contracts/capacity';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: CapacityApiErrorBody['error'], status: number) => json({ error } satisfies CapacityApiErrorBody, status);

// PATCH /api/admin/capacity/[date] (api-009): set a day's oven and work
// minutes and its blackout flag. Admin at aal2 only; the DB checks it again
// with the admin's own JWT (fn_admin_set_day_capacity) and refuses a total
// below what is already reserved (409 below_reserved, with the reserved minutes).
export async function PATCH(request: Request, { params }: { params: Promise<{ date: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);

  const day = capacityDayParam.safeParse((await params).date);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = dayCapacityPatch.safeParse(raw);
  if (!day.success || !body.success) return fail('invalid_input', 400);

  const result = await updateDayCapacity(await createUserClient(), day.data, body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
