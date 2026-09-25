-- Migration: 20260926020200_capacity_weekly_pattern
-- DDD context: Capacity (ADR-002). Task: client-007 (admin capacity screen +
-- standing weekly pattern, PRD section 4). Needs 20260926020100 (source column).
--
-- 1. capacity_weekly_pattern: one row per weekday (0 = Sunday, as EXTRACT(DOW)).
--    Admin-write only through fn_admin_set_weekly_pattern (aal2, audited).
--    No seed rows: which days are working days is an open question for Yuval
--    (PRD section 10 item 1), so the pattern starts empty and changes nothing.
-- 2. How the pattern fills capacity_day_ledger (fn_materialize_capacity_from_pattern):
--    for every day from today (Asia/Jerusalem) to today + capacity_pattern_horizon_days - 1
--    whose weekday has a pattern row:
--      - no ledger row yet            -> insert it from the pattern, source = 'pattern'
--      - row with source = 'pattern'  -> update it to the pattern
--      - row with source = 'manual'   -> never touched (Yuval's own edit wins)
--      - new totals below reserved    -> not touched, reported in the result
--    A non-working weekday becomes a blackout day with the pattern's totals.
--    Runs (a) inside fn_admin_set_weekly_pattern, so a pattern change applies
--    at once, and (b) daily from a scheduled job to roll the window forward
--    (granted to service_role; the job itself belongs to job-001's scheduler,
--    not built here). fn_admin_reset_day_to_pattern turns a manual day back
--    into a pattern day.
--    Existing rows (seed, earlier edits) have source = 'manual', so this
--    migration changes no existing capacity.
--    None of these functions writes *_reserved.

BEGIN;

CREATE TABLE capacity_weekly_pattern (
  weekday SMALLINT PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_working_day BOOLEAN NOT NULL,
  oven_minutes_total INT NOT NULL CHECK (oven_minutes_total BETWEEN 0 AND 1440),
  work_minutes_total INT NOT NULL CHECK (work_minutes_total BETWEEN 0 AND 1440),
  updated_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE capacity_weekly_pattern IS 'DDD context: Capacity. Yuval''s standing weekly pattern (PRD section 4). weekday 0 = Sunday. Written only by fn_admin_set_weekly_pattern. Read by the admin screen (aal2) and by fn_materialize_capacity_from_pattern.';

CREATE TRIGGER trg_capacity_weekly_pattern_updated_at BEFORE UPDATE ON capacity_weekly_pattern
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE capacity_weekly_pattern ENABLE ROW LEVEL SECURITY;
CREATE POLICY "capacity_weekly_pattern_select_admin" ON capacity_weekly_pattern FOR SELECT
  USING (is_admin_aal2());
REVOKE ALL ON TABLE capacity_weekly_pattern FROM anon, authenticated;
GRANT SELECT ON TABLE capacity_weekly_pattern TO authenticated;

INSERT INTO app_settings (key, value, description) VALUES
  ('capacity_pattern_horizon_days', '60', 'client-007: how many days ahead (from today, Asia/Jerusalem) the weekly pattern is written into capacity_day_ledger.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- Pattern -> ledger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_materialize_capacity_from_pattern()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_horizon INT := (SELECT value::text::int FROM app_settings WHERE key = 'capacity_pattern_horizon_days');
  v_today DATE := (now() AT TIME ZONE 'Asia/Jerusalem')::date;
  v_day DATE;
  v_p capacity_weekly_pattern%ROWTYPE;
  v_row capacity_day_ledger%ROWTYPE;
  v_written INT := 0;
  v_kept_manual INT := 0;
  v_below DATE[] := '{}';
BEGIN
  IF v_horizon IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: capacity_pattern_horizon_days';
  END IF;
  FOR v_day IN SELECT generate_series(v_today, v_today + v_horizon - 1, interval '1 day')::date LOOP
    SELECT * INTO v_p FROM capacity_weekly_pattern WHERE weekday = EXTRACT(DOW FROM v_day);
    CONTINUE WHEN NOT FOUND;

    SELECT * INTO v_row FROM capacity_day_ledger WHERE day = v_day FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout, source)
      VALUES (v_day, v_p.oven_minutes_total, v_p.work_minutes_total, NOT v_p.is_working_day, 'pattern')
      ON CONFLICT (day) DO NOTHING;
      v_written := v_written + 1;
    ELSIF v_row.source = 'manual' THEN
      v_kept_manual := v_kept_manual + 1;
    ELSIF v_p.oven_minutes_total < v_row.oven_minutes_reserved OR v_p.work_minutes_total < v_row.work_minutes_reserved THEN
      v_below := v_below || v_day;
    ELSIF (v_row.oven_minutes_total, v_row.work_minutes_total, v_row.is_blackout)
          IS DISTINCT FROM (v_p.oven_minutes_total, v_p.work_minutes_total, NOT v_p.is_working_day) THEN
      UPDATE capacity_day_ledger
      SET oven_minutes_total = v_p.oven_minutes_total,
          work_minutes_total = v_p.work_minutes_total,
          is_blackout = NOT v_p.is_working_day
      WHERE day = v_day;
      v_written := v_written + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('from', v_today, 'days', v_horizon, 'written', v_written,
    'kept_manual', v_kept_manual, 'kept_below_reserved', to_jsonb(v_below));
END;
$$;
COMMENT ON FUNCTION fn_materialize_capacity_from_pattern IS 'client-007: writes the weekly pattern into capacity_day_ledger for the next capacity_pattern_horizon_days days. Never touches a manual day, never sets a total below reserved, never touches *_reserved. Idempotent. Called by fn_admin_set_weekly_pattern and by a daily service_role job.';

CREATE OR REPLACE FUNCTION fn_admin_set_weekly_pattern(p_pattern JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_item JSONB;
  v_weekday INT;
  v_oven INT;
  v_work INT;
  v_working BOOLEAN;
  v_seen INT[] := '{}';
  v_result JSONB;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_pattern IS NULL OR jsonb_typeof(p_pattern) <> 'array' OR jsonb_array_length(p_pattern) <> 7 THEN
    RAISE EXCEPTION 'capacity_invalid_pattern';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pattern) LOOP
    BEGIN
      v_weekday := (v_item ->> 'weekday')::int;
      v_oven := (v_item ->> 'oven_minutes_total')::int;
      v_work := (v_item ->> 'work_minutes_total')::int;
      v_working := (v_item ->> 'is_working_day')::boolean;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'capacity_invalid_pattern';
    END;
    IF v_weekday IS NULL OR v_weekday NOT BETWEEN 0 AND 6 OR v_weekday = ANY(v_seen)
       OR v_oven IS NULL OR v_oven NOT BETWEEN 0 AND 1440
       OR v_work IS NULL OR v_work NOT BETWEEN 0 AND 1440 OR v_working IS NULL THEN
      RAISE EXCEPTION 'capacity_invalid_pattern';
    END IF;
    v_seen := v_seen || v_weekday;
    INSERT INTO capacity_weekly_pattern (weekday, is_working_day, oven_minutes_total, work_minutes_total, updated_by)
    VALUES (v_weekday, v_working, v_oven, v_work, auth.uid())
    ON CONFLICT (weekday) DO UPDATE
      SET is_working_day = EXCLUDED.is_working_day,
          oven_minutes_total = EXCLUDED.oven_minutes_total,
          work_minutes_total = EXCLUDED.work_minutes_total,
          updated_by = EXCLUDED.updated_by;
  END LOOP;

  v_result := fn_materialize_capacity_from_pattern();
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'capacity.weekly_pattern_updated', 'capacity_weekly_pattern', NULL,
    jsonb_build_object('pattern', p_pattern, 'materialized', v_result));
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION fn_admin_reset_day_to_pattern(p_day DATE)
RETURNS capacity_day_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_p capacity_weekly_pattern%ROWTYPE;
  v_old capacity_day_ledger%ROWTYPE;
  v_row capacity_day_ledger%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  SELECT * INTO v_p FROM capacity_weekly_pattern WHERE weekday = EXTRACT(DOW FROM p_day);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capacity_no_pattern_for_weekday';
  END IF;
  SELECT * INTO v_old FROM capacity_day_ledger WHERE day = p_day FOR UPDATE;
  IF FOUND AND (v_p.oven_minutes_total < v_old.oven_minutes_reserved OR v_p.work_minutes_total < v_old.work_minutes_reserved) THEN
    RAISE EXCEPTION 'capacity_total_below_reserved: oven % work %', v_old.oven_minutes_reserved, v_old.work_minutes_reserved;
  END IF;
  INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout, source)
  VALUES (p_day, v_p.oven_minutes_total, v_p.work_minutes_total, NOT v_p.is_working_day, 'pattern')
  ON CONFLICT (day) DO UPDATE
    SET oven_minutes_total = EXCLUDED.oven_minutes_total,
        work_minutes_total = EXCLUDED.work_minutes_total,
        is_blackout = EXCLUDED.is_blackout,
        source = 'pattern'
  RETURNING * INTO v_row;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'capacity.day_reset_to_pattern', 'capacity_day_ledger', p_day::text,
    jsonb_build_object('oven_minutes_total', v_row.oven_minutes_total, 'work_minutes_total', v_row.work_minutes_total, 'is_blackout', v_row.is_blackout));
  RETURN v_row;
END;
$$;

-- Grants. New functions are revoked from everyone first (Supabase default
-- privileges would otherwise let anon call them over PostgREST).
REVOKE EXECUTE ON FUNCTION fn_materialize_capacity_from_pattern() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_set_weekly_pattern(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_reset_day_to_pattern(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_materialize_capacity_from_pattern() TO service_role;
GRANT EXECUTE ON FUNCTION fn_admin_set_weekly_pattern(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_reset_day_to_pattern(DATE) TO authenticated;

COMMIT;
