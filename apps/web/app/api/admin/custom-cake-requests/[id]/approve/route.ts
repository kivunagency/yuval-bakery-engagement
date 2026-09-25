import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { approveCustomCake } from '@/lib/server/custom-cake/admin';
import { uuid } from '@/lib/shared/contracts/primitives';
import { customCakeApprove, type CustomCakeAdminErrorBody } from '@/lib/shared/contracts/custom-cake';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (body: CustomCakeAdminErrorBody, status: number) => json(body, status);

// POST /api/admin/custom-cake-requests/[id]/approve (api-006, PRD US-2,
// ADR-002). Admin at aal2, same Origin. Body: price, oven and work minutes.
// One DB call creates the order (payment_pending) and reserves the minutes in
// the same transaction; if the day no longer has room nothing is written and
// the answer is 409 capacity_changed with a fresh capacity check. Never
// overbooks, and there is no override (a decision for Ran, see the PR).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail({ error: 'unauthorized' }, 401);
  if (!isSameOrigin(request)) return fail({ error: 'forbidden_origin' }, 403);
  const id = uuid.safeParse((await params).id);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail({ error: 'invalid_input' }, 400);
  }
  const body = customCakeApprove.safeParse(raw);
  if (!id.success || !body.success) return fail({ error: 'invalid_input' }, 400);

  const result = await approveCustomCake(await createUserClient(), id.data, body.data);
  return result.ok ? json(result.value, 200) : fail({ error: result.error, check: result.check }, result.status);
}
