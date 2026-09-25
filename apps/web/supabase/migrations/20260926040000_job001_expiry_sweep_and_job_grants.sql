-- Migration: 20260926040000_job001_expiry_sweep_and_job_grants
-- Task: job-001 (payment_pending expiry sweep + daily retention entry points).
-- Three fixes, each reproduced RED on the local Supabase-shaped stack before
-- this file existed (qa/regression.jobs.spec.js):
--
-- 1. A failed sweep left no trace. fn_expire_stale_orders wrote last_error in
--    its EXCEPTION handler and then re-raised, which rolled that write back
--    with everything else: cron_heartbeats showed the last success and no
--    error, so a broken sweep looked like a sweep that had not run yet.
--    Same shape in fn_run_retention_sweep (its caller now records the failure
--    through fn_record_cron_run, below).
-- 2. One bad order stopped every expiry. The sweep ran all orders in one
--    transaction, so a single release that hit the ledger CHECK (the loud
--    failure ADR-002 wants) rolled back every other expiry too, on every run:
--    capacity held by genuinely stale orders was never released. Now each
--    order is released in its own subtransaction; a failure is counted and
--    reported (the run is not a success), the others still expire.
-- 3. Job and capacity internals were executable by anon over PostgREST.
--    Functions created by DROP + CREATE (or CREATE) in 20260925121000 only did
--    REVOKE ... FROM PUBLIC, but Supabase (and the local stack) grant EXECUTE
--    on new functions in public to anon, authenticated and service_role by
--    default privileges, per role, not through PUBLIC. Reproduced: anon called
--    fn_reserve_capacity through /rest/v1/rpc and held capacity with no order
--    behind it (nothing would ever release it), and could call
--    fn_anonymize_order, fn_run_retention_sweep, fn_purge_old_order_attempts
--    (resets the SEC-005 rate limit) and the other retention functions.
--    Fix: explicit REVOKE from anon and authenticated (and PUBLIC) on each
--    function listed below, then GRANT to exactly the role that needs it.
--    Only functions that already exist in earlier migrations are touched;
--    the root cause (default privileges) is reported, not changed here,
--    because changing it would alter every parallel branch's new functions.
--
-- Callers of the changed capacity-releasing function (CLAUDE.md: list them):
--   fn_expire_stale_orders: only the job-001 scheduled function
--   (lib/server/jobs/expire-orders.ts via netlify/src/expire-orders.ts).
--   It calls fn_release_order_capacity, which is NOT changed here.

BEGIN;

-- ------------------------------------------------------------------
-- Heartbeat writer, one definition for every scheduled job.
-- ok = true: last_run_at and last_success_at move, last_error clears.
-- ok = false: last_run_at moves, last_error is set, last_success_at stays,
-- so "how long since the job last succeeded" stays truthful.
-- ------------------------------------------------------------------
CREATE FUNCTION fn_record_cron_run(p_job_name TEXT, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  INSERT INTO cron_heartbeats (job_name, last_run_at, last_success_at, last_error)
  VALUES (p_job_name, now(), CASE WHEN p_ok THEN now() END, CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END)
  ON CONFLICT (job_name) DO UPDATE
    SET last_run_at = EXCLUDED.last_run_at,
        last_success_at = CASE WHEN p_ok THEN EXCLUDED.last_run_at ELSE cron_heartbeats.last_success_at END,
        last_error = EXCLUDED.last_error;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_record_cron_run(TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_record_cron_run(TEXT, BOOLEAN, TEXT) TO service_role;
COMMENT ON FUNCTION fn_record_cron_run IS 'job-001: the one writer of cron_heartbeats. Called by fn_expire_stale_orders itself, and by lib/server/jobs when a job failed before it could record anything (its own write rolled back with it). service_role only.';

-- ------------------------------------------------------------------
-- job-001 sweep, v2. Return type changes (INT -> JSONB), hence DROP.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_expire_stale_orders();

CREATE FUNCTION fn_expire_stale_orders() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_order_id UUID;
  v_expired INT := 0;
  v_failed INT := 0;
  v_first_error TEXT;
BEGIN
  FOR v_order_id IN
    SELECT id FROM orders
    WHERE status = 'payment_pending' AND payment_pending_expires_at < now()
    ORDER BY payment_pending_expires_at, id
  LOOP
    -- Own subtransaction per order: a failure here rolls back this order's
    -- status flip AND its ledger release together (never one without the
    -- other), and leaves every other order's expiry intact.
    BEGIN
      IF fn_release_order_capacity(v_order_id, 'expired', 'system', 'cron:job-001') THEN
        v_expired := v_expired + 1;
      END IF;
      -- false: a concurrent cancel, payment or second sweep already moved it
      -- out of payment_pending. Released exactly once elsewhere, not an error.
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_first_error := COALESCE(v_first_error, 'order ' || v_order_id::text || ': ' || SQLERRM);
    END;
  END LOOP;

  -- Written on every run, work or not: this is also the Supabase keep-alive
  -- (ADR-001) and the liveness signal the 45-minute alert reads (SEC-007).
  PERFORM fn_record_cron_run('expire_payment_pending_orders', v_failed = 0,
    CASE WHEN v_failed > 0 THEN v_failed || ' order(s) failed to expire; first: ' || v_first_error END);

  RETURN jsonb_build_object('expired', v_expired, 'failed', v_failed, 'first_error', v_first_error);
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_expire_stale_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_expire_stale_orders() TO service_role;
COMMENT ON FUNCTION fn_expire_stale_orders IS 'job-001, every 15 minutes (netlify/src/expire-orders.ts). Each stale payment_pending order is released through fn_release_order_capacity (exactly once per order, SEC-007) in its own subtransaction. Returns {expired, failed, first_error}. Heartbeat written every run. service_role only.';

-- ------------------------------------------------------------------
-- Grants (fix 3). Internal: callable only from other SECURITY DEFINER
-- functions, by no API role at all.
-- ------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION fn_reserve_capacity(DATE, INT, INT, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_set_order_retention_until() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_set_custom_cake_retention_until() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION forbid_mutation_unless_retention_purge() FROM PUBLIC, anon, authenticated, service_role;

-- Scheduled-job and server-only entry points: service_role only.
REVOKE EXECUTE ON FUNCTION fn_run_retention_sweep() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_retention_due() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_anonymize_order(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_anonymize_custom_cake_request(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_purge_old_order_attempts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_purge_old_lookup_attempts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_purge_old_audit_log() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_purge_old_push_subscriptions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_photos_due_for_purge() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_mark_photos_purged(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_mark_confirmation_pdf_purged(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_customers_due_for_hard_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_unsubscribe_by_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_run_retention_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION fn_retention_due() TO service_role;
GRANT EXECUTE ON FUNCTION fn_anonymize_order(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_anonymize_custom_cake_request(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_order_attempts() TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_lookup_attempts() TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_audit_log() TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_push_subscriptions() TO service_role;
GRANT EXECUTE ON FUNCTION fn_photos_due_for_purge() TO service_role;
GRANT EXECUTE ON FUNCTION fn_mark_photos_purged(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_mark_confirmation_pdf_purged(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_customers_due_for_hard_delete() TO service_role;
GRANT EXECUTE ON FUNCTION fn_unsubscribe_by_token(TEXT) TO service_role;

-- Admin functions: meant for authenticated only (each also checks
-- is_admin_aal2() inside, so anon got admin_aal2_required, not a bypass;
-- closed anyway so the grant says what the design says).
REVOKE EXECUTE ON FUNCTION fn_mark_order_paid(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_mark_order_fulfilled(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_cancel_order(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_admin_set_day_capacity(DATE, INT, INT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_approve_custom_cake_request(UUID, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_decline_custom_cake_request(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_find_guest_records_by_phone(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION fn_hard_delete_customer(UUID) FROM anon;

COMMIT;
