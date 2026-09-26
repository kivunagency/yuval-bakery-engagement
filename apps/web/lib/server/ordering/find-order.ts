import 'server-only';
import { z } from 'zod';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { serviceClient } from '@/lib/server/supabase/service';
import { confirmationLinkToken, confirmationPath } from '@/lib/server/confirmation/link';
import type { FindOrderRequest, FindOrderResponse } from '@/lib/shared/contracts/find-order';

// Find my order (US-0d, DB-PLAN.md 6). The one caller of
// fn_lookup_order_by_phone_and_number, with the service role and the client
// IP the platform reports: the DB rate-limits per IP and per phone, matches
// only phone + number together and returns the masked view. A miss and a
// wrong phone are the same `not_found`. The confirmation PDF is offered through
// its capability link (built from the order id the DB returns; the id itself
// never leaves the server), never by order number.

const row = z.object({
  order_id: z.string(),
  order_number: z.string(),
  status: z.string(),
  delivery_date: z.string(),
  fulfillment_type: z.string(),
  masked_address: z.string().nullable(),
});

const LIVE = new Set(['payment_pending', 'paid', 'fulfilled']);

export type FindOrderResult = { ok: true; value: FindOrderResponse } | { ok: false; error: 'too_many_attempts' | 'server_error' };

export async function findOrder(input: FindOrderRequest, ip: string): Promise<FindOrderResult> {
  let rows: z.infer<typeof row>[];
  try {
    rows = await callRpc(serviceClient(), 'fn_lookup_order_by_phone_and_number', { p_ip_address: ip, p_phone: input.phone, p_order_number: input.orderNumber }, z.array(row));
  } catch (e) {
    if (e instanceof DbError && e.code === 'rate_limit_exceeded') return { ok: false, error: 'too_many_attempts' };
    console.error('find order failed', e instanceof DbError ? e.code : 'unknown');
    return { ok: false, error: 'server_error' };
  }
  const r = rows[0];
  if (!r) return { ok: true, value: { result: 'not_found' } };

  let path: string | null = null;
  if (LIVE.has(r.status)) {
    try {
      path = confirmationPath(confirmationLinkToken(r.order_id));
    } catch (e) {
      console.error('confirmation link unavailable', e instanceof Error ? e.message : 'unknown');
    }
  }
  return {
    ok: true,
    value: {
      result: 'found',
      order: {
        orderNumber: r.order_number,
        status: r.status as never,
        day: r.delivery_date,
        fulfillment: r.fulfillment_type as never,
        maskedAddress: r.masked_address,
        confirmationPath: path,
      },
    },
  };
}
