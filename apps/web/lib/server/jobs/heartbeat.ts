import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DbError } from '@/lib/server/supabase/rpc';

// Job names are the cron_heartbeats.job_name rows the 45-minute staleness
// alert (SEC-007, OPS-005) reads.
export const JOB_NAMES = {
  expiry: 'expire_payment_pending_orders',
  retention: 'retention_sweep',
  capacityRollforward: 'capacity_rollforward',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// The DB's own message, detail included (DbError keeps only the code in
// .message): an operator reading the heartbeat needs the detail.
export function errorMessage(e: unknown): string {
  if (e instanceof DbError) return e.raw;
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/**
 * Record a run in cron_heartbeats through fn_record_cron_run (service_role).
 * Used when the DB function could not record it itself: it failed, and its
 * own heartbeat write rolled back with it. Returns false when even this write
 * fails (DB unreachable): then only the staleness alert can see the problem.
 */
export async function recordRun(client: SupabaseClient, job: JobName, ok: boolean, error: string | null): Promise<boolean> {
  try {
    const { error: rpcError } = await client.rpc('fn_record_cron_run', { p_job_name: job, p_ok: ok, p_error: error });
    return !rpcError;
  } catch {
    return false;
  }
}
