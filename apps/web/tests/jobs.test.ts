import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { runExpirySweep } from '@/lib/server/jobs/expire-orders';
import { runRetention } from '@/lib/server/jobs/retention';

// Wrapper behaviour the local-stack regression cannot force: the RPC itself
// failing (DB unreachable, timeout). The DB paths are covered by
// qa/regression.jobs.spec.js against the real local stack.
type Call = { fn: string; args: unknown };

function fakeClient(respond: (fn: string, args: unknown) => { data?: unknown; error?: { message: string } } | 'throw') {
  const calls: Call[] = [];
  const client = {
    rpc: async (fn: string, args?: unknown) => {
      calls.push({ fn, args });
      const r = respond(fn, args);
      if (r === 'throw') throw new Error('fetch failed');
      return { data: r.data ?? null, error: r.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('runExpirySweep', () => {
  it('reports the DB result and lets the DB own the heartbeat', async () => {
    const { client, calls } = fakeClient(() => ({ data: { expired: 3, failed: 0, first_error: null } }));
    expect(await runExpirySweep(client)).toEqual({
      job: 'expire_payment_pending_orders', ok: true, expired: 3, failed: 0, error: null, heartbeat: 'written_by_db',
    });
    expect(calls.map((c) => c.fn)).toEqual(['fn_expire_stale_orders']);
  });

  it('a partial failure is not ok', async () => {
    const { client } = fakeClient(() => ({ data: { expired: 2, failed: 1, first_error: 'order x: boom' } }));
    expect(await runExpirySweep(client)).toMatchObject({ ok: false, expired: 2, failed: 1, error: 'order x: boom' });
  });

  it('when the sweep call itself fails, records the failure through fn_record_cron_run', async () => {
    const { client, calls } = fakeClient((fn) => (fn === 'fn_expire_stale_orders' ? { error: { message: 'canceling statement due to statement timeout' } } : {}));
    const out = await runExpirySweep(client);
    expect(out).toMatchObject({ ok: false, heartbeat: 'written_by_wrapper', error: 'canceling statement due to statement timeout' });
    expect(calls[1]).toEqual({ fn: 'fn_record_cron_run', args: { p_job_name: 'expire_payment_pending_orders', p_ok: false, p_error: out.error } });
  });

  it('says so when not even the heartbeat could be written', async () => {
    const { client } = fakeClient(() => 'throw');
    expect(await runExpirySweep(client)).toMatchObject({ ok: false, heartbeat: 'not_written', error: 'fetch failed' });
  });
});

describe('runRetention', () => {
  it('runs every step even when one fails, and records the failure', async () => {
    const { client, calls } = fakeClient((fn) => {
      if (fn === 'fn_run_retention_sweep') return { data: { orders_purged: 1, custom_cake_requests_purged: 0 } };
      if (fn === 'fn_purge_old_audit_log') return { error: { message: 'retention_setting_missing: audit_log_retention_years' } };
      if (fn.startsWith('fn_purge_')) return { data: 0 };
      return { data: [] };
    });
    const out = await runRetention(client);
    expect(out.ok).toBe(false);
    expect(out.steps.map((s) => [s.step, s.ok])).toEqual([
      ['anonymize_due_records', true], ['purge_order_attempts', true], ['purge_lookup_attempts', true],
      ['purge_audit_log', false], ['purge_push_subscriptions', true],
    ]);
    const hb = calls.find((c) => c.fn === 'fn_record_cron_run');
    expect(hb?.args).toEqual({ p_job_name: 'retention_sweep', p_ok: false, p_error: 'purge_audit_log: retention_setting_missing: audit_log_retention_years' });
  });

  it('never calls the purge markers for Storage objects it did not delete', async () => {
    const { client, calls } = fakeClient((fn) => (fn === 'fn_run_retention_sweep' ? { data: { orders_purged: 0, custom_cake_requests_purged: 0 } } : fn.startsWith('fn_purge_') ? { data: 0 } : { data: [{ entity_type: 'confirmation_pdf' }] }));
    const out = await runRetention(client);
    expect(out.ok).toBe(true);
    expect(out.did_not_run.storage_confirmation_pdf_deletion.pdfs_due).toBe(1);
    expect(calls.map((c) => c.fn)).not.toContain('fn_mark_photos_purged');
    expect(calls.map((c) => c.fn)).not.toContain('fn_mark_confirmation_pdf_purged');
  });
});
