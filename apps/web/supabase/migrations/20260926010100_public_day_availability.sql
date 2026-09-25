-- Migration: 20260926010100_public_day_availability
-- DDD context: Capacity (api-002, public read of day availability)
--
-- What the customer may learn about a day is a state word, never minutes
-- (design-tokens.md, "הרעיון"): open / limited / full / closed / too_soon,
-- plus which products still fit on that day ("לא נכנס ביום ה׳"). Both are
-- computed HERE, in one place, never in TypeScript (CLAUDE.md: capacity
-- lives in the DB; Rule 19: one shared definition of "remaining minutes").
--
-- 1. fn_capacity_row_fits: THE predicate "does a cost of (oven, work) fit on
--    this ledger row". It is the conjunction of every condition the real
--    reservation applies: fn_reserve_capacity's WHERE (not blackout, total,
--    unpaid-holds cap) plus fn_create_standard_order's single-order cap.
--    fn_reserve_capacity itself is NOT changed here (it must stay one atomic
--    UPDATE, and api-003 owns checkout). The regression test
--    "fit agrees with the real reservation" runs both over a matrix of rows
--    and fails if they ever disagree, so a later change to either one that is
--    not mirrored in the other is caught.
-- 2. fn_day_too_soon: the 24h lead time (BRIEF, final), Asia/Jerusalem (Ran,
--    2026-09-25). Reusable by checkout (SYSTEM-CONTRACT section 3: the lead
--    time is not yet enforced by fn_create_standard_order).
-- 3. fn_public_day_availability: the only function anon gets. Per day: the
--    state word and the ids of published, available products of which one
--    unit still fits. No minutes in its output.
-- 4. capacity_day_ledger is no longer readable by anon (it held every
--    total/reserved minute, readable by anyone with the public anon key
--    through PostgREST). Read access is now admin (aal2) only; the public
--    goes through fn_public_day_availability.
--
-- New app_settings (defaults, each pending Yuval, listed in the PR):
--   day_limited_threshold_pct  25      "limited" when either resource has
--                                      less than this % of its total left
--   lead_time_hours            24      BRIEF, final
--   earliest_slot_time         "00:00" Jerusalem wall clock of the first
--                                      slot of a day. A day is too_soon when
--                                      that moment is less than
--                                      lead_time_hours away, so every slot of
--                                      a selectable day is outside the lead
--                                      time. 00:00 is the conservative
--                                      default until Yuval's hours are known.

BEGIN;

INSERT INTO app_settings (key, value, description) VALUES
  ('day_limited_threshold_pct', '25', 'Public day strip: a day shows "limited" when either resource (oven or work minutes) has less than this % of its total left. api-002 default, pending Yuval.'),
  ('lead_time_hours', '24', 'Minimum lead time before a delivery/pickup day (BRIEF, final). Asia/Jerusalem. Read by fn_day_too_soon.'),
  ('earliest_slot_time', '"00:00"', 'Jerusalem wall-clock time of the first delivery/pickup slot of any day (HH:MM). A day is too_soon when this moment on that day is less than lead_time_hours away. 00:00 = conservative default, pending Yuval''s working hours.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- 1. The fit predicate (pure: every input is an argument)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_capacity_row_fits(
  l capacity_day_ledger, p_oven INT, p_work INT, p_unpaid_pct NUMERIC, p_single_order_pct NUMERIC
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT l.day IS NOT NULL
     AND NOT l.is_blackout
     -- fn_reserve_capacity: hard totals
     AND l.oven_minutes_reserved + p_oven <= l.oven_minutes_total
     AND l.work_minutes_reserved + p_work <= l.work_minutes_total
     -- fn_reserve_capacity: unpaid-holds cap (NULL pct = no cap, as there)
     AND (p_unpaid_pct IS NULL OR l.oven_minutes_unpaid_reserved + p_oven <= l.oven_minutes_total * p_unpaid_pct / 100)
     AND (p_unpaid_pct IS NULL OR l.work_minutes_unpaid_reserved + p_work <= l.work_minutes_total * p_unpaid_pct / 100)
     -- fn_create_standard_order: single-order cap (NULL pct = no cap, as there)
     AND (p_single_order_pct IS NULL OR p_oven <= l.oven_minutes_total * p_single_order_pct / 100)
     AND (p_single_order_pct IS NULL OR p_work <= l.work_minutes_total * p_single_order_pct / 100);
$$;
COMMENT ON FUNCTION fn_capacity_row_fits IS
  'api-002. THE definition of "a cost of (oven, work) minutes fits on this ledger row": fn_reserve_capacity''s WHERE plus fn_create_standard_order''s single-order cap. Read-only mirror; the reservation itself stays the atomic UPDATE in fn_reserve_capacity. qa/regression.catalog.spec.js asserts the two agree.';

-- Same predicate against the live row and the live settings.
CREATE OR REPLACE FUNCTION fn_capacity_fits(p_day DATE, p_oven INT, p_work INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT COALESCE((
    SELECT fn_capacity_row_fits(
      l, p_oven, p_work,
      (SELECT (value)::text::numeric FROM app_settings WHERE key = 'unpaid_holds_capacity_pct'),
      (SELECT (value)::text::numeric FROM app_settings WHERE key = 'single_order_capacity_pct'))
    FROM capacity_day_ledger l WHERE l.day = p_day
  ), false);
$$;
COMMENT ON FUNCTION fn_capacity_fits IS 'api-002. fn_capacity_row_fits on the live ledger row and live app_settings. Internal (no anon/authenticated grant).';

-- ------------------------------------------------------------
-- 2. Lead time
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_day_too_soon(p_day DATE) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT ((p_day + COALESCE((SELECT (value #>> '{}')::time FROM app_settings WHERE key = 'earliest_slot_time'), time '00:00'))
            AT TIME ZONE 'Asia/Jerusalem')
         < now() + make_interval(hours => COALESCE((SELECT (value)::text::int FROM app_settings WHERE key = 'lead_time_hours'), 24));
$$;
COMMENT ON FUNCTION fn_day_too_soon IS
  'api-002. True when the first slot of p_day (app_settings.earliest_slot_time, Asia/Jerusalem wall clock) is less than app_settings.lead_time_hours from now. Checkout (api-003) should reuse it to enforce the lead time server-side.';

-- ------------------------------------------------------------
-- 3. The public read
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_public_day_availability(p_from DATE, p_to DATE)
RETURNS TABLE (day DATE, state TEXT, fitting_product_ids UUID[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_unpaid_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'unpaid_holds_capacity_pct');
  v_single_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'single_order_capacity_pct');
  v_limited_pct NUMERIC := COALESCE((SELECT (value)::text::numeric FROM app_settings WHERE key = 'day_limited_threshold_pct'), 25);
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'day_range_invalid';
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT g::date AS d FROM generate_series(p_from, p_to, interval '1 day') AS g
  ),
  sellable AS (
    SELECT p.id, p.oven_minutes_cost, p.work_minutes_cost
    FROM products p
    WHERE p.is_published AND p.is_available AND p.deleted_at IS NULL
  ),
  per_day AS (
    SELECT days.d,
           l AS led,
           (l.day IS NULL OR l.is_blackout OR l.oven_minutes_total = 0 OR l.work_minutes_total = 0) AS is_closed,
           fn_day_too_soon(days.d) AS is_too_soon,
           COALESCE((
             SELECT array_agg(s.id ORDER BY s.id)
             FROM sellable s
             WHERE fn_capacity_row_fits(l, s.oven_minutes_cost, s.work_minutes_cost, v_unpaid_pct, v_single_pct)
           ), '{}') AS fits
    FROM days LEFT JOIN capacity_day_ledger l ON l.day = days.d
  )
  SELECT per_day.d,
         CASE
           -- too_soon first: inside the lead time the reason a customer
           -- cannot order is the lead time, whatever the ledger says.
           WHEN per_day.is_too_soon THEN 'too_soon'
           WHEN per_day.is_closed THEN 'closed'
           WHEN (per_day.led).oven_minutes_reserved >= (per_day.led).oven_minutes_total
             OR (per_day.led).work_minutes_reserved >= (per_day.led).work_minutes_total
             OR (cardinality(per_day.fits) = 0 AND EXISTS (SELECT 1 FROM sellable)) THEN 'full'
           WHEN (per_day.led).oven_minutes_total - (per_day.led).oven_minutes_reserved < (per_day.led).oven_minutes_total * v_limited_pct / 100
             OR (per_day.led).work_minutes_total - (per_day.led).work_minutes_reserved < (per_day.led).work_minutes_total * v_limited_pct / 100 THEN 'limited'
           ELSE 'open'
         END,
         -- Only an orderable day lists what fits: nothing fits on a closed,
         -- too-soon or full day from the customer's point of view.
         CASE WHEN per_day.is_closed OR per_day.is_too_soon THEN '{}'::uuid[] ELSE per_day.fits END
  FROM per_day
  ORDER BY per_day.d;
END;
$$;
COMMENT ON FUNCTION fn_public_day_availability IS
  'api-002. Public day strip: per day a state word (too_soon > closed > full > limited > open; closed = no ledger row, blackout, or a zero total) and the published, available products of which one unit fits (fn_capacity_row_fits). Never returns minutes. Range at most 63 days. Granted to anon.';

-- Functions are executable by PUBLIC by default; the blanket REVOKE in
-- 20260925120800 only covered functions that existed then.
REVOKE EXECUTE ON FUNCTION fn_capacity_row_fits(capacity_day_ledger, INT, INT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_capacity_fits(DATE, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_day_too_soon(DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_public_day_availability(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_public_day_availability(DATE, DATE) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_capacity_fits(DATE, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_day_too_soon(DATE) TO service_role;

-- ------------------------------------------------------------
-- 4. The ledger itself is no longer public
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "capacity_day_ledger_select_public" ON capacity_day_ledger;
DROP POLICY IF EXISTS "capacity_day_ledger_select_admin" ON capacity_day_ledger;
CREATE POLICY "capacity_day_ledger_select_admin" ON capacity_day_ledger FOR SELECT
  USING (is_admin_aal2());
REVOKE SELECT ON TABLE capacity_day_ledger FROM anon;
-- authenticated keeps the SELECT grant; the policy above limits it to an
-- aal2 admin (the capacity admin screen). Registered customers read the
-- public function like everyone else.

COMMIT;
