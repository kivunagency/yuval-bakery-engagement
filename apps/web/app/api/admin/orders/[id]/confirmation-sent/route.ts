import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { serverEnv } from '@/lib/server/env';
import { recordConfirmationSentOnWhatsApp } from '@/lib/server/confirmation/admin-delivery';
import { fail, json, parseOrderAction } from '@/lib/server/ordering/admin-order-route';

export const dynamic = 'force-dynamic';

// POST /api/admin/orders/[id]/confirmation-sent (US-0c): Yuval pressed "I sent
// it" after sending the confirmation link on WhatsApp. Records
// confirmation_channel = whatsapp_manual (write-once) as the admin's own JWT at
// aal2; this is what lets a guest order with no email be marked fulfilled.
// 200 { id, orderNumber, recorded } (recorded false = it was already recorded).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = await parseOrderAction(request, params);
  if (!id) return fail('invalid_input', 400);
  const result = await recordConfirmationSentOnWhatsApp(await createUserClient(), id, serverEnv().SITE_URL.replace(/\/+$/, ''));
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
