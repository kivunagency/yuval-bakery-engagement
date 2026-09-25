import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callRpc } from '@/lib/server/supabase/rpc';
import { JOB_NAMES, errorMessage, recordRun } from '@/lib/server/jobs/heartbeat';

// Daily retention (compliance-spec.md section 3, SEC-028, DB-PLAN.md 10.4 B1/B4).
// Each step is its own DB function and its own transaction: one failing step
// is reported and does not stop the others. The run succeeds only if every
// step did.
const count = z.number().int().nonnegative();
const STEPS = [
  { step: 'anonymize_due_records', fn: 'fn_run_retention_sweep', schema: z.object({ orders_purged: count, custom_cake_requests_purged: count }) },
  { step: 'purge_order_attempts', fn: 'fn_purge_old_order_attempts', schema: count },
  { step: 'purge_lookup_attempts', fn: 'fn_purge_old_lookup_attempts', schema: count },
  { step: 'purge_audit_log', fn: 'fn_purge_old_audit_log', schema: count },
  { step: 'purge_push_subscriptions', fn: 'fn_purge_old_push_subscriptions', schema: count },
] as const;

type StepResult = { step: string; ok: true; result: unknown } | { step: string; ok: false; error: string };

export type RetentionOutcome = {
  job: typeof JOB_NAMES.retention;
  ok: boolean;
  steps: StepResult[];
  // Not done by this job, reported so nobody reads silence as "deleted".
  did_not_run: {
    storage_photo_deletion: { reason: string; photos_due: number | null };
    storage_confirmation_pdf_deletion: { reason: string; pdfs_due: number | null };
    customer_hard_delete: { reason: string; customers_due: number | null };
  };
  heartbeat: 'written_by_wrapper' | 'not_written';
};

async function countRows(client: SupabaseClient, fn: string, filter?: (row: Record<string, unknown>) => boolean): Promise<number | null> {
  const { data, error } = await client.rpc(fn);
  if (error || !Array.isArray(data)) return null;
  return filter ? data.filter(filter).length : data.length;
}

/** client must be the service-role client. */
export async function runRetention(client: SupabaseClient): Promise<RetentionOutcome> {
  const steps: StepResult[] = [];
  for (const s of STEPS) {
    try {
      steps.push({ step: s.step, ok: true, result: await callRpc(client, s.fn, {}, s.schema) });
    } catch (e) {
      steps.push({ step: s.step, ok: false, error: errorMessage(e) });
    }
  }

  const failed = steps.filter((s) => !s.ok);
  const ok = failed.length === 0;
  const error = ok ? null : failed.map((s) => `${s.step}: ${s.ok ? '' : s.error}`).join('; ');
  const written = await recordRun(client, JOB_NAMES.retention, ok, error);

  return {
    job: JOB_NAMES.retention,
    ok,
    steps,
    did_not_run: {
      storage_photo_deletion: {
        reason: 'no Storage buckets yet; fn_mark_photos_purged is only called after Storage confirms deletion',
        photos_due: await countRows(client, 'fn_photos_due_for_purge'),
      },
      storage_confirmation_pdf_deletion: {
        reason: 'no Storage buckets yet; fn_mark_confirmation_pdf_purged is only called after Storage confirms deletion',
        pdfs_due: await countRows(client, 'fn_retention_due', (r) => r.entity_type === 'confirmation_pdf'),
      },
      customer_hard_delete: {
        reason: 'not wired: fn_hard_delete_customer checks current_user = service_role inside SECURITY DEFINER, which is never true there',
        customers_due: await countRows(client, 'fn_customers_due_for_hard_delete'),
      },
    },
    heartbeat: written ? 'written_by_wrapper' : 'not_written',
  };
}
