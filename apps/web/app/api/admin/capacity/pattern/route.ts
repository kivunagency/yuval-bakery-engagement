import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { setWeeklyPattern } from '@/lib/server/capacity/admin-capacity-day';
import { weeklyPatternPut } from '@/lib/shared/contracts/capacity-pattern';
import type { CapacityApiErrorBody } from '@/lib/shared/contracts/capacity';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: CapacityApiErrorBody['error'], status: number) => json({ error } satisfies CapacityApiErrorBody, status);

// PUT /api/admin/capacity/pattern (client-007): save the standing weekly
// pattern (all 7 weekdays) and write it into the next days of the ledger,
// never over a day Yuval set by hand and never below reserved minutes.
export async function PUT(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = weeklyPatternPut.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400);
  const result = await setWeeklyPattern(await createUserClient(), body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
