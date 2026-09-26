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
  'admin_required',
  'append_only_table',
  'capacity_changed_recheck_before_approving',
  'capacity_invalid_minutes',
  'capacity_invalid_pattern',
  'capacity_no_pattern_for_weekday',
  'capacity_reservation_failed',
  'capacity_total_below_reserved',
  'confirmation_delivery_requires_admin_or_service_role',
  'consent_not_own',
  'consent_source_not_allowed',
  'consent_version_mismatch',
  'custom_cake_photo_limit_reached',
  'custom_cake_photo_path_invalid',
  'custom_cake_request_not_found',
  'custom_cake_request_not_pending',
  'custom_cake_upload_closed',
  'customer_age_not_confirmed',
  'customer_dates_require_marketing_consent',
  'customer_email_not_confirmed',
  'customer_invalid_date',
  'customer_invalid_input',
  'customer_not_registered',
  'customer_phone_taken',
  'customer_sign_in_required',
  'day_range_invalid',
  'day_unavailable',
  'delivery_address_required',
  'delivery_city_in_other_zone',
  'delivery_list_invalid_day',
  'delivery_slot_unavailable',
  'delivery_zone_invalid',
  'delivery_zone_name_taken',
  'delivery_zone_not_found',
  'delivery_zone_unavailable',
  'fulfillment_type_invalid',
  'guest_phone_or_customer_required',
  'invalid_confirmation_channel',
  'invalid_consent_action',
  'lead_time_not_met',
  'not_authorized_to_delete_this_customer',
  'notification_attempt_not_pending',
  'notification_invalid_argument',
  'order_cannot_be_fulfilled_without_confirmation',
  'order_items_invalid',
  'order_number_generation_exhausted',
  'privacy_notice_version_mismatch',
  'product_unavailable',
  'push_subscription_invalid',
  'rate_limit_exceeded',
  'rate_limit_ip_exceeded',
  'rate_limit_open_orders_per_phone_exceeded',
  'rate_limit_open_requests_per_phone_exceeded',
  'retention_setting_missing',
  'service_role_required',
  'setting_out_of_range',
  'settings_invalid_input',
  'settings_invalid_value',
  'single_order_capacity_cap_exceeded',
  'step_up_required',
  'unpaid_holds_capacity_cap_exceeded',
  'unsubscribe_link_source_is_service_role_only_via_fn_unsubscribe_by_token',
  'upload_rights_not_confirmed',
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
