import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc, DbError, type DbErrorCode } from '@/lib/server/supabase/rpc';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import type { CheckoutError, CreateOrderRequest } from '@/lib/shared/contracts/checkout';

// Guest checkout (api-003). The one caller of fn_create_standard_order in the
// app. Runs with the service role: the function is not executable by anon or
// authenticated, so nobody can skip this route (and the IP it passes for the
// SEC-005 per-IP limit) by calling PostgREST directly. Price, delivery fee,
// capacity and the slot lead time are all decided inside the DB function.
// Registered-customer checkout (p_customer_id) is not built yet (api-010);
// it must derive the customer id from the session, never from the request.

/** 128 random bits, base64url (22 chars). Shown once, stored only as sha256 (SEC-003). */
export function newLookupToken(): string {
  return randomBytes(16).toString('base64url');
}

const createdOrder = z.object({ id: z.string(), order_number: z.string(), status: z.literal('payment_pending') });

export type CreateOrderResult = { ok: true; token: string; orderId: string } | { ok: false; error: CheckoutError; pickAnotherDay?: true };

// Every DB refusal the checkout can meet, as the screen needs it. Capacity or
// day gone: back to the day picker. Anything unknown is a generic error.
const DB_TO_CHECKOUT: Partial<Record<DbErrorCode, { error: CheckoutError; pickAnotherDay?: true }>> = {
  capacity_reservation_failed: { error: 'day_full', pickAnotherDay: true },
  day_unavailable: { error: 'day_full', pickAnotherDay: true },
  unpaid_holds_capacity_cap_exceeded: { error: 'day_almost_full', pickAnotherDay: true },
  single_order_capacity_cap_exceeded: { error: 'order_too_big' },
  lead_time_not_met: { error: 'too_soon', pickAnotherDay: true },
  delivery_slot_unavailable: { error: 'slot_unavailable' },
  delivery_zone_unavailable: { error: 'city_not_served' },
  product_unavailable: { error: 'product_unavailable' },
  rate_limit_ip_exceeded: { error: 'too_many_attempts' },
  rate_limit_open_orders_per_phone_exceeded: { error: 'too_many_open_orders' },
  order_items_invalid: { error: 'invalid_input' },
  fulfillment_type_invalid: { error: 'invalid_input' },
  delivery_address_required: { error: 'invalid_input' },
  guest_phone_or_customer_required: { error: 'invalid_input' },
};

export function mapOrderDbError(code: DbErrorCode | 'unknown'): { error: CheckoutError; pickAnotherDay?: true } {
  return (code !== 'unknown' && DB_TO_CHECKOUT[code]) || { error: 'server_error' };
}

export async function createStandardOrder(input: CreateOrderRequest, ip: string): Promise<CreateOrderResult> {
  const token = newLookupToken();
  const delivery = input.fulfillment === 'delivery';
  try {
    const created = await callRpc(
      serviceClient(),
      'fn_create_standard_order',
      {
        p_ip_address: ip,
        p_customer_id: null,
        p_guest_name: input.name,
        p_guest_phone: input.phone,
        p_guest_email: input.email ?? null,
        p_fulfillment_type: input.fulfillment,
        p_delivery_date: input.day,
        p_delivery_slot_id: input.slotId,
        p_delivery_address: delivery ? (input.address ?? null) : null,
        p_delivery_city: delivery ? (input.city ?? null) : null,
        p_delivery_notes: input.notes || null,
        p_items: input.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
        p_lookup_token: token,
        p_privacy_notice_version: TEXT_VERSIONS.privacy,
        p_terms_version: TEXT_VERSIONS.terms,
        p_cancellation_notice_version: TEXT_VERSIONS.cancellation,
      },
      createdOrder,
    );
    return { ok: true, token, orderId: created.id };
  } catch (e) {
    if (e instanceof DbError) {
      const mapped = mapOrderDbError(e.code);
      // SEC-026: the code only, never the request body or the raw message (it can hold ids).
      if (mapped.error === 'server_error') console.error('order creation failed', e.code);
      return { ok: false, ...mapped };
    }
    throw e;
  }
}
