import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { cancelOrder } from '@/lib/server/ordering/admin-orders';
import { fail, json, parseOrderAction } from '@/lib/server/ordering/admin-order-route';

export const dynamic = 'force-dynamic';

// POST /api/admin/orders/[id]/cancel (api-004): payment_pending or paid -> cancelled; the held minutes come back exactly once (fn_release_order_capacity, SEC-007). A refund of a paid order is Yuval's, outside the app.
// Admin at aal2 only; the DB checks it again with the admin's own JWT and
// writes the audit row with auth.uid().
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = await parseOrderAction(request, params);
  if (!id) return fail('invalid_input', 400);
  const result = await cancelOrder(await createUserClient(), id);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
