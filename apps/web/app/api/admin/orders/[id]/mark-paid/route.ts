import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { markOrderPaid } from '@/lib/server/ordering/admin-orders';
import { fail, json, parseOrderAction } from '@/lib/server/ordering/admin-order-route';

export const dynamic = 'force-dynamic';

// POST /api/admin/orders/[id]/mark-paid (api-004): payment_pending -> paid. Show the expected amount before calling (SEC-008): the screen does, this route takes no amount.
// Admin at aal2 only; the DB checks it again with the admin's own JWT and
// writes the audit row with auth.uid().
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = await parseOrderAction(request, params);
  if (!id) return fail('invalid_input', 400);
  const result = await markOrderPaid(await createUserClient(), id);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
