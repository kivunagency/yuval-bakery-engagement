import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { readNotificationConfig } from '@/lib/server/notification/config';
import { isAllowedPushEndpoint, type PushApiErrorBody, type PushSubscriptionBody } from '@/lib/shared/contracts/push';

// client-012: register / revoke this browser's push subscription for the
// signed-in admin. `client` is createUserClient(): the DB function checks
// aal2 and takes the admin id from the JWT (SEC-018), never from the body.

type Result = { ok: true; status: number; body: unknown } | { ok: false; status: number; body: PushApiErrorBody };
const fail = (error: PushApiErrorBody['error'], status: number): Result => ({ ok: false, status, body: { error } });

function mapDbError(e: unknown): Result {
  if (e instanceof DbError && e.code === 'admin_aal2_required') return fail('unauthorized', 401);
  if (e instanceof DbError && e.code === 'push_subscription_invalid') return fail('invalid_input', 400);
  console.error(JSON.stringify({ push_subscription: 'db_error', code: e instanceof DbError ? e.code : 'unknown' }));
  return fail('unavailable', 503);
}

export async function registerPushSubscription(client: SupabaseClient, body: PushSubscriptionBody): Promise<Result> {
  const { push } = readNotificationConfig();
  if (!push.enabled) return fail('unavailable', 503);
  if (!isAllowedPushEndpoint(body.endpoint, { allowLocal: push.allowLocalEndpoints })) return fail('endpoint_not_allowed', 400);
  try {
    await callRpc(client, 'fn_admin_register_push_subscription', { p_endpoint: body.endpoint, p_p256dh: body.keys.p256dh, p_auth_key: body.keys.auth }, z.guid());
    return { ok: true, status: 201, body: { ok: true } };
  } catch (e) {
    return mapDbError(e);
  }
}

export async function revokePushSubscription(client: SupabaseClient, endpoint: string): Promise<Result> {
  try {
    const revoked = await callRpc(client, 'fn_admin_revoke_push_subscription', { p_endpoint: endpoint }, z.boolean());
    return { ok: true, status: 200, body: { revoked } };
  } catch (e) {
    return mapDbError(e);
  }
}

/** Active push devices of this admin, for the settings screen (read through the aal2 RLS policy). */
export async function countAdminPushDevices(client: SupabaseClient, adminId: string): Promise<number> {
  const { count, error } = await client
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('admin_id', adminId)
    .is('revoked_at', null);
  return error ? 0 : (count ?? 0);
}
