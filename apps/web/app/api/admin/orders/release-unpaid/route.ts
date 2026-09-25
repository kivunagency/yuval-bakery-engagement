import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { releaseUnpaidForDay } from '@/lib/server/ordering/admin-orders';
import { fail, json } from '@/lib/server/ordering/admin-order-route';
import { releaseUnpaidBody } from '@/lib/shared/contracts/admin-orders';

export const dynamic = 'force-dynamic';

// POST /api/admin/orders/release-unpaid (client-009, SEC-006 response tool):
// cancel every order of one day that is still waiting for payment, each
// through fn_release_order_capacity. Paid orders of that day are not touched.
export async function POST(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail('invalid_input', 400);
  }
  const body = releaseUnpaidBody.safeParse(raw);
  if (!body.success) return fail('invalid_input', 400);
  const result = await releaseUnpaidForDay(await createUserClient(), body.data.day);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
