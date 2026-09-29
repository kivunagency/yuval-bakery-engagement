import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { ORDER_STATUSES } from '@/lib/shared/types';
import {
  adminOrderActionResult,
  releaseUnpaidRow,
  type AdminOrderAction,
  type AdminOrderActionResult,
  type AdminOrdersApiErrorBody,
  type ReleaseUnpaidResult,
} from '@/lib/shared/contracts/admin-orders';

// Admin order operations (Rule 27 names, ADR-001): markOrderPaid, cancelOrder,
// markOrderFulfilled, releaseUnpaidForDay. These are the one handler behind
// each /api/admin/orders route, and the ones the operations registry
// (ops-registry-001) must call too, so the UI and the registry never diverge.
//
// `client` must be createUserClient(): the DB functions check the admin's own
// aal2 JWT (is_admin_aal2()) and write the audit row with auth.uid(). Which
// transition is allowed, and whether capacity is released, is decided by the
// DB only (fn_release_order_capacity for cancel, SEC-007); nothing here
// checks a status before calling.

export type OrdersResult<T> = { ok: true; value: T } | { ok: false; status: number; body: AdminOrdersApiErrorBody };

const RPC_BY_ACTION: Record<AdminOrderAction, string> = {
  'mark-paid': 'fn_mark_order_paid',
  cancel: 'fn_cancel_order',
  'mark-fulfilled': 'fn_mark_order_fulfilled',
};

const orderStateRow = z.object({ id: z.string(), order_number: z.string(), status: z.enum(ORDER_STATUSES) });

async function readOrderState(client: SupabaseClient, id: string): Promise<AdminOrderActionResult | null> {
  const { data, error } = await client.from('orders').select('id, order_number, status').eq('id', id).maybeSingle();
  if (error) throw new Error('order_read_failed');
  if (!data) return null;
  const row = orderStateRow.parse(data);
  return adminOrderActionResult.parse({ id: row.id, orderNumber: row.order_number, status: row.status });
}

function errorResult(e: unknown): OrdersResult<never> {
  if (e instanceof DbError) {
    switch (e.code) {
      case 'admin_aal2_required':
        return { ok: false, status: 401, body: { error: 'unauthorized' } };
      case 'order_cannot_be_fulfilled_without_confirmation':
        return { ok: false, status: 409, body: { error: 'confirmation_required', status: 'paid' } };
      case 'day_range_invalid':
        return { ok: false, status: 400, body: { error: 'invalid_input' } };
    }
  }
  console.error('admin order action failed', e);
  return { ok: false, status: 500, body: { error: 'server_error' } };
}

async function runOrderAction(client: SupabaseClient, action: AdminOrderAction, id: string): Promise<OrdersResult<AdminOrderActionResult>> {
  try {
    const changed = await callRpc(client, RPC_BY_ACTION[action], { p_order_id: id }, z.boolean());
    const order = await readOrderState(client, id);
    if (!order) return { ok: false, status: 404, body: { error: 'not_found' } };
    // false = the DB found the order in a status this action does not start from
    // (already paid, expired by the sweep a moment ago, cancelled twice...).
    if (!changed) return { ok: false, status: 409, body: { error: 'invalid_transition', status: order.status } };
    return { ok: true, value: order };
  } catch (e) {
    return errorResult(e);
  }
}

/** payment_pending -> paid. The unpaid hold becomes a paid one; the minutes stay reserved. */
export function markOrderPaid(client: SupabaseClient, id: string) {
  return runOrderAction(client, 'mark-paid', id);
}

/** payment_pending or paid -> cancelled, releasing the held minutes exactly once (fn_release_order_capacity). */
export function cancelOrder(client: SupabaseClient, id: string) {
  return runOrderAction(client, 'cancel', id);
}

/** paid -> fulfilled. Refused by trg_orders_guard_fulfillment (409 confirmation_required) for a guest with no email until the confirmation was delivered (US-0c). */
export function markOrderFulfilled(client: SupabaseClient, id: string) {
  return runOrderAction(client, 'mark-fulfilled', id);
}

/** SEC-006: cancel every payment_pending order of one day, each through fn_release_order_capacity. Paid orders are never touched. */
export async function releaseUnpaidForDay(client: SupabaseClient, day: string): Promise<OrdersResult<ReleaseUnpaidResult>> {
  try {
    const row = await callRpc(client, 'fn_admin_release_unpaid_for_day', { p_day: day }, releaseUnpaidRow);
    return { ok: true, value: { day: row.day, released: row.released, orderNumbers: row.order_numbers } };
  } catch (e) {
    return errorResult(e);
  }
}
