import 'server-only';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { CHECKOUT_FIT_STATES, type CheckoutFitRequest, type CheckoutFitState } from '@/lib/shared/contracts/checkout';

// Checkout early warning. The one caller of fn_checkout_single_order_fit, a
// read-only DB function granted to service_role only. The DB computes the
// cart's minutes and compares them with the single-order cap
// (fn_single_order_cap_exceeded, the same rule fn_create_standard_order
// raises on). Nothing here decides capacity; this only passes the answer on.

const state = z.enum(CHECKOUT_FIT_STATES);

export async function checkCartFitsDay(input: CheckoutFitRequest): Promise<CheckoutFitState> {
  return callRpc(
    serviceClient(),
    'fn_checkout_single_order_fit',
    { p_day: input.day, p_items: input.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })) },
    state,
  );
}
