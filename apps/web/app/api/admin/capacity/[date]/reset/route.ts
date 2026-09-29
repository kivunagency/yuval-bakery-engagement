import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { resetDayToPattern } from '@/lib/server/capacity/admin-capacity-day';
import { capacityDayParam, type CapacityApiErrorBody } from '@/lib/shared/contracts/capacity';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: CapacityApiErrorBody['error'], status: number) => json({ error } satisfies CapacityApiErrorBody, status);

// POST /api/admin/capacity/[date]/reset (client-007): a day Yuval set by hand
// goes back to the weekly pattern (and follows it again from now on).
export async function POST(request: Request, { params }: { params: Promise<{ date: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const day = capacityDayParam.safeParse((await params).date);
  if (!day.success) return fail('invalid_input', 400);
  const result = await resetDayToPattern(await createUserClient(), day.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
