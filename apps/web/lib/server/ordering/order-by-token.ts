import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { lookupToken, orderView, type OrderView } from '@/lib/shared/contracts/checkout';

// One order by its capability token (SEC-003, client-004). THE source of the
// order page, GET /api/orders/[token] and the confirmation PDF (US-0c, Rule
// 15): all three read fn_order_public_view through parsePublicOrder below, so
// the screen and the PDF cannot disagree. Unknown, expired, purged and
// malformed tokens all return null: callers answer them with one identical 404.

/** fn_order_public_view's JSON (migration 20260926130000). order_id is for the server only; OrderView never carries it. */
export const publicOrderRow = z.object({
  order_id: z.string(),
  order_number: z.string(),
  status: z.string(),
  order_source: z.string(),
  fulfillment_type: z.string(),
  delivery_date: z.string(),
  slot_start: z.string().nullable(),
  slot_end: z.string().nullable(),
  delivery_city: z.string().nullable(),
  subtotal: z.coerce.number(),
  delivery_fee: z.coerce.number(),
  total: z.coerce.number(),
  payment_pending_expires_at: z.string().nullable(),
  created_at: z.string(),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), unit_price: z.coerce.number(), line_total: z.coerce.number() })),
});
export type PublicOrderRow = z.infer<typeof publicOrderRow>;

export type PublicOrder = { id: string; createdAt: string; view: OrderView };

export function parsePublicOrder(r: PublicOrderRow): PublicOrder {
  return {
    id: r.order_id,
    createdAt: r.created_at,
    view: orderView.parse({
      orderNumber: r.order_number,
      status: r.status,
      source: r.order_source,
      fulfillment: r.fulfillment_type,
      day: r.delivery_date,
      slotStart: r.slot_start,
      slotEnd: r.slot_end,
      city: r.delivery_city,
      subtotal: r.subtotal,
      deliveryFee: r.delivery_fee,
      total: r.total,
      paymentPendingExpiresAt: r.payment_pending_expires_at,
      items: r.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unit_price, lineTotal: i.line_total })),
    }),
  };
}

/** The order and its internal id (for the confirmation link), or null. */
export const getPublicOrderByToken = cache(async (token: string): Promise<PublicOrder | null> => {
  if (!lookupToken.safeParse(token).success) return null;
  const r = await callRpc(serviceClient(), 'fn_order_for_lookup_token', { p_token: token }, publicOrderRow.nullable());
  return r ? parsePublicOrder(r) : null;
});

export async function getOrderByToken(token: string): Promise<OrderView | null> {
  return (await getPublicOrderByToken(token))?.view ?? null;
}
