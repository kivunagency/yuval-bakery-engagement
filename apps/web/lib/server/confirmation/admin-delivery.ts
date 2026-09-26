import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { ensureConfirmation } from '@/lib/server/confirmation/issue';
import type { OrdersResult } from '@/lib/server/ordering/admin-orders';

// "I sent it" on the admin order card (US-0c, Rule 27 name: recordConfirmationSentOnWhatsApp).
// The document is issued first if nobody opened the link yet (service role,
// a system act), so the recorded sha256 is the file the link serves; then the
// delivery is recorded as the admin's own act: `client` is createUserClient(),
// the DB checks aal2 and writes the audit row with auth.uid(). This unblocks
// `fulfilled` (trg_orders_guard_fulfillment) for an order with no email.

export type ConfirmationSentResult = { id: string; orderNumber: string; recorded: boolean };

export async function recordConfirmationSentOnWhatsApp(
  client: SupabaseClient,
  orderId: string,
  siteUrl: string,
): Promise<OrdersResult<ConfirmationSentResult>> {
  try {
    const issued = await ensureConfirmation(orderId, siteUrl);
    if (!issued) return { ok: false, status: 404, body: { error: 'not_found' } };
    const recorded = await callRpc(client, 'fn_record_order_confirmation_delivered', { p_order_id: orderId, p_channel: 'whatsapp_manual' }, z.boolean());
    // false: already recorded (a second press, or the email went first). The state is what Yuval wanted either way.
    return { ok: true, value: { id: orderId, orderNumber: issued.orderNumber, recorded } };
  } catch (e) {
    if (e instanceof DbError && (e.code === 'confirmation_delivery_requires_admin_or_service_role' || e.code === 'admin_aal2_required')) {
      return { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    console.error('record confirmation sent failed', e instanceof Error ? e.message : 'unknown');
    return { ok: false, status: 500, body: { error: 'server_error' } };
  }
}
