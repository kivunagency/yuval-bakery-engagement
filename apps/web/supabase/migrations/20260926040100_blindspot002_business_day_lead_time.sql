-- Migration: 20260926040100_blindspot002_business_day_lead_time
-- Task: blindspot-002 (business day and 24-hour lead time in Asia/Jerusalem).
--
-- Audit of every business-day use before this file (grep for CURRENT_DATE,
-- now()::date, ::date, date_trunc, AT TIME ZONE over supabase/):
--   - No migration derives a calendar day from an instant. capacity_day_ledger.day
--     and orders.delivery_date are plain DATEs chosen by the caller, and every
--     time comparison (expiry, retention, rate limits) is instant vs instant,
--     which does not depend on a zone.
--   - supabase/seed.sql used CURRENT_DATE, i.e. the SESSION zone's date. The
--     DB session zone is UTC (local stack: Etc/UTC; hosted Supabase: UTC by
--     default, ASSUMED, re-check at infra-001). Between 00:00 and 02:00/03:00
--     Jerusalem time that is still yesterday. Fixed in seed.sql to use
--     fn_business_date().
--   - The real gap: nothing in the DB enforced the 24-hour lead time, nor even
--     "not in the past". RED on the local stack (qa/db/business-day.test.mjs):
--     fn_create_standard_order accepted an order for today and for 3 days ago,
--     and custom_cake_requests accepted a request for today.
--
-- Rule (recorded in ADR-002, "Business day and lead time"):
--   business date of an instant = its calendar date in Asia/Jerusalem.
--   earliest delivery date      = business date of (now + 24 hours).
-- A delivery DATE before that is less than 24 hours away at every hour of the
-- day, so it is refused here. This is the floor the DB can know from a date
-- alone; a delivery on the earliest date at an hour less than 24 hours away
-- is the time-window check the checkout route must add (api-003). Whether
-- Yuval wants the stricter "whole day at least 24h away" reading is an open
-- question for her (ADR-002), not decided here.
--
-- Enforced by trigger, not inside fn_create_standard_order, so the check does
-- not depend on which branch last replaced that function's body, and so it
-- also covers custom_cake_requests, which has no creation function yet.
-- No capacity or money function is changed by this file.

BEGIN;

CREATE FUNCTION fn_business_date(p_at TIMESTAMPTZ DEFAULT now()) RETURNS DATE
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT (p_at AT TIME ZONE 'Asia/Jerusalem')::date;
$$;
COMMENT ON FUNCTION fn_business_date IS 'blindspot-002: the calendar date in Asia/Jerusalem at an instant. Never CURRENT_DATE or now()::date in business logic: those use the session zone (UTC on Supabase).';

CREATE FUNCTION fn_earliest_delivery_date(p_at TIMESTAMPTZ DEFAULT now()) RETURNS DATE
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  -- interval '24 hours' (not '1 day'): an absolute span, so DST nights are
  -- 24 real hours too.
  SELECT fn_business_date(p_at + interval '24 hours');
$$;
COMMENT ON FUNCTION fn_earliest_delivery_date IS 'blindspot-002: first delivery DATE allowed for an order placed at p_at (24-hour lead time, Asia/Jerusalem). Mirrored by earliestDeliveryDate() in lib/shared/time/jerusalem.ts; parity tested in qa/db/business-day.test.mjs.';

-- Readable by the storefront (the day picker needs the same floor).
REVOKE EXECUTE ON FUNCTION fn_business_date(TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fn_earliest_delivery_date(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_business_date(TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_earliest_delivery_date(TIMESTAMPTZ) TO anon, authenticated, service_role;

CREATE FUNCTION fn_guard_lead_time() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_day DATE;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    -- Custom-cake orders are created by Yuval's approval, possibly close to the
    -- day; the customer's own lead time was checked on the request.
    IF NEW.order_source <> 'standard' THEN
      RETURN NEW;
    END IF;
    v_day := NEW.delivery_date;
  ELSE
    v_day := NEW.desired_date;
  END IF;
  IF v_day < fn_earliest_delivery_date(now()) THEN
    RAISE EXCEPTION 'lead_time_not_met: % is before %', v_day, fn_earliest_delivery_date(now());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_guard_lead_time() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_orders_lead_time
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_guard_lead_time();

CREATE TRIGGER trg_custom_cake_requests_lead_time
  BEFORE INSERT ON custom_cake_requests
  FOR EACH ROW EXECUTE FUNCTION fn_guard_lead_time();

COMMIT;
