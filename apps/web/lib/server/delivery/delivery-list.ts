import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { deliveryListRow, toDeliveryList, type DeliveryList, type DeliveryListApiErrorBody, type DeliveryListQuery } from '@/lib/shared/contracts/delivery-list';

// generateDeliveryList (Rule 27 operation name, ADR-001): the one handler
// behind GET /api/admin/delivery-list and the /admin/delivery screen, and the
// one the operations registry (ops-registry-001) must call too. An agent
// principal gets redactDeliveryListForAgent() of the result, never the list
// itself (SEC-004). `client` must be createUserClient(): the DB checks the
// admin's own aal2 JWT and writes the audit row (SEC-017) in the same call.

export type DeliveryListResult = { ok: true; value: DeliveryList } | { ok: false; status: number; body: DeliveryListApiErrorBody };

export async function generateDeliveryList(client: SupabaseClient, input: DeliveryListQuery): Promise<DeliveryListResult> {
  try {
    const row = await callRpc(client, 'fn_admin_delivery_list', { p_day: input.date }, deliveryListRow);
    return { ok: true, value: toDeliveryList(row) };
  } catch (e) {
    if (e instanceof DbError && e.code === 'admin_aal2_required') return { ok: false, status: 401, body: { error: 'unauthorized' } };
    if (e instanceof DbError && e.code === 'delivery_list_invalid_day') return { ok: false, status: 400, body: { error: 'invalid_input' } };
    return { ok: false, status: 500, body: { error: 'server_error' } };
  }
}
