import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import {
  ledgerRow,
  toAdminDayCapacity,
  type AdminDayCapacity,
  type CapacityApiErrorBody,
  type DayCapacityPatch,
} from '@/lib/shared/contracts/capacity';

// updateDayCapacity (Rule 27 operation name, ADR-001): the one handler behind
// PATCH /api/admin/capacity/[date], and the one the operations registry
// (ops-registry-001) must call too, so the UI and the registry never diverge.
// `client` must be createUserClient(): the DB checks the admin's own aal2 JWT
// and derives the actor from auth.uid(). Capacity is decided by the DB only;
// nothing here checks "is there room".

export type CapacityResult<T> = { ok: true; value: T } | { ok: false; status: number; body: CapacityApiErrorBody };

/** Maps a DB error from an admin capacity function to an HTTP answer. */
export async function capacityErrorResult(client: SupabaseClient, day: string, e: unknown): Promise<CapacityResult<never>> {
  if (e instanceof DbError) {
    switch (e.code) {
      case 'admin_aal2_required':
        return { ok: false, status: 401, body: { error: 'unauthorized' } };
      case 'capacity_invalid_minutes':
      case 'capacity_invalid_pattern':
        return { ok: false, status: 400, body: { error: 'invalid_input' } };
      case 'capacity_no_pattern_for_weekday':
        return { ok: false, status: 409, body: { error: 'no_pattern_for_weekday' } };
      case 'capacity_total_below_reserved': {
        const { data } = await client.from('capacity_day_ledger').select('oven_minutes_reserved, work_minutes_reserved').eq('day', day).maybeSingle();
        return {
          ok: false,
          status: 409,
          body: {
            error: 'below_reserved',
            reserved: data ? { ovenMinutes: data.oven_minutes_reserved as number, workMinutes: data.work_minutes_reserved as number } : undefined,
          },
        };
      }
    }
  }
  return { ok: false, status: 500, body: { error: 'server_error' } };
}

export async function updateDayCapacity(client: SupabaseClient, day: string, input: DayCapacityPatch): Promise<CapacityResult<AdminDayCapacity>> {
  try {
    const row = await callRpc(
      client,
      'fn_admin_set_day_capacity',
      { p_day: day, p_oven_minutes_total: input.ovenMinutesTotal, p_work_minutes_total: input.workMinutesTotal, p_is_blackout: input.isBlackout },
      ledgerRow,
    );
    return { ok: true, value: toAdminDayCapacity(row) };
  } catch (e) {
    return capacityErrorResult(client, day, e);
  }
}
