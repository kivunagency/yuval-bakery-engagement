import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { lookupToken, orderView, type OrderView } from '@/lib/shared/contracts/checkout';

// One order by its capability token (SEC-003, client-004). THE source of the
// order page, GET /api/orders/[token] and, later, the confirmation PDF (US-0c,
// wave 3: Rule 15, generate it from this same view, not from a second query).
// Unknown, expired, purged and malformed tokens all return null: callers
// answer them with one identical 404.

const row = z
  .object({
    order_number: z.string(),
    status: z.string(),
    fulfillment_type: z.string(),
    delivery_date: z.string(),
    slot_start: z.string().nullable(),
    slot_end: z.string().nullable(),
    delivery_city: z.string().nullable(),
    subtotal: z.coerce.number(),
    delivery_fee: z.coerce.number(),
    total: z.coerce.number(),
    payment_pending_expires_at: z.string().nullable(),
    items: z.array(z.object({ name: z.string(), quantity: z.number(), unit_price: z.coerce.number(), line_total: z.coerce.number() })),
  })
  .nullable();

export const getOrderByToken = cache(async (token: string): Promise<OrderView | null> => {
  if (!lookupToken.safeParse(token).success) return null;
  const r = await callRpc(serviceClient(), 'fn_order_for_lookup_token', { p_token: token }, row);
  if (!r) return null;
  return orderView.parse({
    orderNumber: r.order_number,
    status: r.status,
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
  });
});
