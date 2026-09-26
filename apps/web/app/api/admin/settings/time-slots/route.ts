import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { updateTimeSlots } from '@/lib/server/settings/order-settings';
import { timeSlotsUpdate, type OrderSettingsApiErrorBody } from '@/lib/shared/contracts/order-settings';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: OrderSettingsApiErrorBody['error'], status: number, fields?: string[]) =>
  json({ error, ...(fields && fields.length > 0 ? { fields } : {}) } satisfies OrderSettingsApiErrorBody, status);

// PUT /api/admin/settings/time-slots (settings-slots): the whole active list of delivery/pickup time slots ([{start, end}], HH:MM). Same start and end keeps the slot; a removed slot is turned off, never deleted (orders keep their own copy). earliest_slot_time follows the first slot.
// Admin at aal2 only, same Origin; the DB checks aal2 again, validates and audits.
export async function PUT(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = timeSlotsUpdate.safeParse(raw);
  if (!body.success) return fail(body.error.issues.some((i) => i.message === 'overlap') ? 'overlap' : 'invalid_input', 400, []);
  const result = await updateTimeSlots(await createUserClient(), body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
