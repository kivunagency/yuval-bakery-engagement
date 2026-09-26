import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from '@/lib/server/supabase/rpc';
import { JOB_NAMES, errorMessage, recordRun } from '@/lib/server/jobs/heartbeat';
import { materializeRow } from '@/lib/shared/contracts/capacity-pattern';

// capacity-rollforward (client-007 follow-up, PRD section 4). Once a day:
// write Yuval's weekly pattern into capacity_day_ledger for the next
// capacity_pattern_horizon_days days (60), so the day that just entered the
// window opens without her saving the pattern again. All of the logic is the
// DB's (fn_materialize_capacity_from_pattern: never a manual day, never below
// reserved, never *_reserved, idempotent); this wrapper calls it with the
// service role and records the run in cron_heartbeats, success or failure.
// Days kept because the pattern is below what is already reserved are not a
// failure: they are reported, and Yuval sees them on the calendar.

export type RollforwardOutcome = {
  job: typeof JOB_NAMES.capacityRollforward;
  ok: boolean;
  from: string | null;
  days: number;
  written: number;
  kept_manual: number;
  kept_below_reserved: string[];
  error: string | null;
  heartbeat: 'written_by_wrapper' | 'not_written';
};

/** client must be the service-role client: the function is granted to service_role only. */
export async function runCapacityRollforward(client: SupabaseClient): Promise<RollforwardOutcome> {
  const job = JOB_NAMES.capacityRollforward;
  try {
    const r = await callRpc(client, 'fn_materialize_capacity_from_pattern', {}, materializeRow);
    const written = await recordRun(client, job, true, null);
    return {
      job, ok: true, from: r.from, days: r.days, written: r.written, kept_manual: r.kept_manual, kept_below_reserved: r.kept_below_reserved,
      error: null, heartbeat: written ? 'written_by_wrapper' : 'not_written',
    };
  } catch (e) {
    const error = errorMessage(e);
    const written = await recordRun(client, job, false, error);
    return { job, ok: false, from: null, days: 0, written: 0, kept_manual: 0, kept_below_reserved: [], error, heartbeat: written ? 'written_by_wrapper' : 'not_written' };
  }
}
