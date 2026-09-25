import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

// Error codes the DB functions raise (RAISE EXCEPTION '<code>'). Kept as the
// exact strings so API routes can map them to HTTP responses without parsing
// free text. Generated from the RAISE EXCEPTION codes in supabase/migrations;
// tests/db-error-codes.test.ts fails when a migration adds one not listed here.
export const DB_ERROR_CODES = [
  'admin_aal2_required',
  'admin_on_request_requires_admin',
  'append_only_table',
  'capacity_changed_recheck_before_approving',
  'capacity_reservation_failed',
  'confirmation_delivery_requires_admin_or_service_role',
  'consent_not_own',
  'consent_version_mismatch',
  'custom_cake_request_not_pending',
  'day_range_invalid',
  'day_unavailable',
  'delivery_zone_unavailable',
  'guest_phone_or_customer_required',
  'invalid_confirmation_channel',
  'invalid_consent_action',
  'not_authorized_to_delete_this_customer',
  'order_cannot_be_fulfilled_without_confirmation',
  'order_number_generation_exhausted',
  'product_unavailable',
  'rate_limit_exceeded',
  'rate_limit_ip_exceeded',
  'rate_limit_open_orders_per_phone_exceeded',
  'retention_setting_missing',
  'single_order_capacity_cap_exceeded',
  'unpaid_holds_capacity_cap_exceeded',
  'unsubscribe_link_source_is_service_role_only_via_fn_unsubscribe_by_token',
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export class DbError extends Error {
  constructor(
    readonly code: DbErrorCode | 'unknown',
    readonly raw: string,
  ) {
    super(code === 'unknown' ? `db error: ${raw}` : code);
  }
}

function toDbError(message: string): DbError {
  // Functions raise '<code>' or '<code>: detail'. Match the leading token exactly.
  const token = message.split(':')[0]?.trim() ?? '';
  const known = DB_ERROR_CODES.find((c) => c === token);
  return new DbError(known ?? 'unknown', message);
}

// Call a DB function and validate its result with a Zod schema, so nothing
// untyped crosses from the DB into the app.
export async function callRpc<T extends z.ZodType>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  schema: T,
): Promise<z.infer<T>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw toDbError(error.message);
  return schema.parse(data);
}
