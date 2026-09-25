-- Migration: 20260926020100_admin_set_day_capacity_errors
-- DDD context: Capacity (ADR-002). Task: api-009 (PATCH /api/admin/capacity/[date]).
--
-- fn_admin_set_day_capacity (same signature, same grants):
--   - a total below what is already reserved used to fail on the ledger CHECK
--     constraint with a raw "violates check constraint" error (a 500 in the
--     app). It now locks the day and raises the machine code
--     capacity_total_below_reserved, with the reserved minutes as detail
--     (the API maps it to 409);
--   - minutes outside 0..1440 or NULL input raise capacity_invalid_minutes;
--   - the day is marked source = 'manual' (new column): Yuval set it by hand,
--     so the weekly pattern (client-007) never overwrites it;
--   - the audit row also records the previous values.
-- Callers of fn_admin_set_day_capacity: app/api/admin/capacity/[date]/route.ts
-- (via lib/server/capacity/admin-capacity.ts updateDayCapacity), and the tests
-- output/db/tests/privilege_test.sql and qa/regression.spec.js "auth chain".
-- No SQL function calls it. It never writes *_reserved, so fn_reserve_capacity,
-- fn_release_order_capacity and the capacity_never_negative invariant are
-- unchanged. Existing ledger rows get source = 'manual' (the default), so no
-- existing capacity changes.

BEGIN;

ALTER TABLE capacity_day_ledger
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'pattern'));
COMMENT ON COLUMN capacity_day_ledger.source IS 'manual = set by Yuval for this day (fn_admin_set_day_capacity), never overwritten by the weekly pattern; pattern = written from capacity_weekly_pattern and may be rewritten by it (client-007).';

-- ------------------------------------------------------------
-- fn_admin_set_day_capacity: clear error codes, source = 'manual'
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_set_day_capacity(
  p_day DATE, p_oven_minutes_total INT, p_work_minutes_total INT, p_is_blackout BOOLEAN
) RETURNS capacity_day_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_old capacity_day_ledger%ROWTYPE;
  v_row capacity_day_ledger%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_day IS NULL OR p_is_blackout IS NULL
     OR p_oven_minutes_total IS NULL OR p_oven_minutes_total NOT BETWEEN 0 AND 1440
     OR p_work_minutes_total IS NULL OR p_work_minutes_total NOT BETWEEN 0 AND 1440 THEN
    RAISE EXCEPTION 'capacity_invalid_minutes';
  END IF;

  -- Lock the day so no reservation lands between this check and the write.
  SELECT * INTO v_old FROM capacity_day_ledger WHERE day = p_day FOR UPDATE;
  IF FOUND AND (p_oven_minutes_total < v_old.oven_minutes_reserved OR p_work_minutes_total < v_old.work_minutes_reserved) THEN
    RAISE EXCEPTION 'capacity_total_below_reserved: oven % work %', v_old.oven_minutes_reserved, v_old.work_minutes_reserved;
  END IF;

  INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout, source)
  VALUES (p_day, p_oven_minutes_total, p_work_minutes_total, p_is_blackout, 'manual')
  ON CONFLICT (day) DO UPDATE
    SET oven_minutes_total = EXCLUDED.oven_minutes_total,
        work_minutes_total = EXCLUDED.work_minutes_total,
        is_blackout = EXCLUDED.is_blackout,
        source = 'manual'
  RETURNING * INTO v_row;

  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'capacity.day_updated', 'capacity_day_ledger', p_day::text,
    jsonb_build_object('oven_minutes_total', p_oven_minutes_total, 'work_minutes_total', p_work_minutes_total, 'is_blackout', p_is_blackout,
      'previous', CASE WHEN v_old.day IS NULL THEN NULL ELSE jsonb_build_object(
        'oven_minutes_total', v_old.oven_minutes_total, 'work_minutes_total', v_old.work_minutes_total,
        'is_blackout', v_old.is_blackout, 'source', v_old.source) END));
  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_admin_set_day_capacity(DATE, INT, INT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_admin_set_day_capacity(DATE, INT, INT, BOOLEAN) TO authenticated;

COMMIT;
