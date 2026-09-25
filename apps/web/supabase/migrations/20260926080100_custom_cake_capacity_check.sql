-- Migration: 20260926080100_custom_cake_capacity_check
-- DDD context: CustomCake reading Capacity (api-006, client-008, PRD US-2)
--
-- The live capacity warning on the admin approval screen. Yuval types a price
-- and oven/work minutes; before she clicks approve the screen asks the DB
-- whether that cost fits the requested day. The answer is computed HERE with
-- the one fit predicate, fn_capacity_row_fits (api-002), never in TypeScript
-- (CLAUDE.md: no second "is there room" check in app code; Rule 19).
--
-- The predicate is called with the arguments fn_approve_custom_cake_request
-- uses for its reservation: the live unpaid_holds_capacity_pct, and NO
-- single-order cap (approval passes only unpaid_pct to fn_reserve_capacity;
-- the 35% cap is a checkout rule, fn_create_standard_order). So "fits" here
-- equals "approve would reserve", which the regression test
-- "check agrees with approve" asserts over a matrix of costs.
--
-- The warning is advice, not a lock: between the check and the click another
-- order can take the minutes. Approval itself still reserves atomically and
-- raises capacity_changed_recheck_before_approving (ADR-002); the route turns
-- that into a 409 with a fresh answer from this function.
--
-- No override: PRD US-2 allows approving "with an explicit acknowledgment"
-- when capacity is short. The DB has no such path (fn_reserve_capacity is the
-- only way to hold minutes and it refuses), and adding a bypass is a
-- capacity decision for Ran, raised in the PR, not taken here.
--
-- No function that computes money or capacity is changed by this migration.

BEGIN;

CREATE OR REPLACE FUNCTION fn_admin_custom_cake_capacity_check(p_request_id UUID, p_oven_minutes INT, p_work_minutes INT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_req custom_cake_requests%ROWTYPE;
  v_ledger capacity_day_ledger%ROWTYPE;
  v_unpaid_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'unpaid_holds_capacity_pct');
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_oven_minutes IS NULL OR p_work_minutes IS NULL OR p_oven_minutes < 0 OR p_work_minutes < 0
     OR p_oven_minutes > 1440 OR p_work_minutes > 1440 THEN
    RAISE EXCEPTION 'capacity_invalid_minutes';
  END IF;
  SELECT * INTO v_req FROM custom_cake_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom_cake_request_not_found';
  END IF;
  SELECT * INTO v_ledger FROM capacity_day_ledger WHERE day = v_req.desired_date;

  RETURN jsonb_build_object(
    'day', v_req.desired_date,
    'day_passed', v_req.desired_date < fn_business_date(now()),
    'has_day', v_ledger.day IS NOT NULL,
    'is_blackout', COALESCE(v_ledger.is_blackout, false),
    'fits', v_ledger.day IS NOT NULL AND fn_capacity_row_fits(v_ledger, p_oven_minutes, p_work_minutes, v_unpaid_pct, NULL),
    'oven_minutes_total', v_ledger.oven_minutes_total,
    'oven_minutes_left', v_ledger.oven_minutes_total - v_ledger.oven_minutes_reserved,
    'work_minutes_total', v_ledger.work_minutes_total,
    'work_minutes_left', v_ledger.work_minutes_total - v_ledger.work_minutes_reserved,
    -- Room left under the unpaid-holds cap (an approved cake starts unpaid).
    'oven_minutes_unpaid_left', CASE WHEN v_unpaid_pct IS NULL THEN NULL
      ELSE floor(v_ledger.oven_minutes_total * v_unpaid_pct / 100)::int - v_ledger.oven_minutes_unpaid_reserved END,
    'work_minutes_unpaid_left', CASE WHEN v_unpaid_pct IS NULL THEN NULL
      ELSE floor(v_ledger.work_minutes_total * v_unpaid_pct / 100)::int - v_ledger.work_minutes_unpaid_reserved END
  );
END;
$$;
COMMENT ON FUNCTION fn_admin_custom_cake_capacity_check IS 'api-006/client-008. Admin (aal2) only, read-only. Whether a custom cake of (oven, work) minutes fits its requested day, by fn_capacity_row_fits with exactly the arguments fn_approve_custom_cake_request reserves with (live unpaid cap, no single-order cap). Advice only: approval reserves atomically.';

REVOKE EXECUTE ON FUNCTION fn_admin_custom_cake_capacity_check(UUID, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_custom_cake_capacity_check(UUID, INT, INT) TO authenticated;

COMMIT;
