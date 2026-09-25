import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callRpc } from '@/lib/server/supabase/rpc';
import { JOB_NAMES, errorMessage, recordRun } from '@/lib/server/jobs/heartbeat';

// job-001 (US-9, ADR-001, SEC-007). Every 15 minutes: expire stale
// payment_pending orders and release their capacity. All of the logic is the
// DB's (fn_expire_stale_orders -> fn_release_order_capacity, exactly once per
// order); this wrapper only calls it with the service role and reports.
const sweepResult = z.object({
  expired: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  first_error: z.string().nullable(),
});

export type ExpiryOutcome = {
  job: typeof JOB_NAMES.expiry;
  ok: boolean;
  expired: number;
  failed: number;
  error: string | null;
  heartbeat: 'written_by_db' | 'written_by_wrapper' | 'not_written';
};

/** client must be the service-role client: the function is granted to service_role only. */
export async function runExpirySweep(client: SupabaseClient): Promise<ExpiryOutcome> {
  try {
    const r = await callRpc(client, 'fn_expire_stale_orders', {}, sweepResult);
    // The DB wrote the heartbeat itself (success, or failure with last_error).
    return { job: JOB_NAMES.expiry, ok: r.failed === 0, expired: r.expired, failed: r.failed, error: r.first_error, heartbeat: 'written_by_db' };
  } catch (e) {
    const error = errorMessage(e);
    const written = await recordRun(client, JOB_NAMES.expiry, false, error);
    return { job: JOB_NAMES.expiry, ok: false, expired: 0, failed: 0, error, heartbeat: written ? 'written_by_wrapper' : 'not_written' };
  }
}
