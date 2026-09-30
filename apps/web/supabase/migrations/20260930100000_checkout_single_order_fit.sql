-- Migration: 20260930100000_checkout_single_order_fit
-- DDD context: Ordering / Capacity (checkout early warning)
--
-- The customer learned that a cart is too big for one day (the 35% single-order
-- cap, SEC-005) only after filling every field and pressing continue:
-- fn_create_standard_order raised single_order_capacity_cap_exceeded. The
-- checkout now asks earlier, when a day is chosen and whenever the cart
-- changes. The answer still comes from the DB, and the final authority stays
-- fn_create_standard_order.
--
-- 1. fn_single_order_cap_exceeded: THE single-order cap rule, in one place.
--    Before this migration the comparison was written twice, in
--    fn_create_standard_order and in fn_capacity_row_fits (api-002, the public
--    fit). Both now call this helper, and so does the new check below. Pure:
--    every input is an argument. NULL pct = no cap, exactly as before in both
--    callers (an IF on NULL does not raise; the fits predicate had an explicit
--    "pct IS NULL OR").
-- 2. fn_order_items_invalid: the shape check of p_items that
--    fn_create_standard_order made inline, moved verbatim so the new check
--    refuses the same inputs (no cast errors on a bad body).
-- 3. fn_create_standard_order: same signature, same grants (CREATE OR
--    REPLACE keeps them). Only two expressions change, each to a call of the
--    helper holding the identical expression. The minutes loop is NOT moved
--    into a helper: it reads availability, price and minutes of each product
--    in one statement, and a second statement for the minutes could see a
--    product edited in between (READ COMMITTED takes a snapshot per statement).
--    So the sum "cost x quantity over the lines" is written twice, here and in
--    fn_checkout_single_order_fit (SYSTEM-CONTRACT section 3), and
--    qa/regression.checkout.spec.js asserts the two agree over a matrix.
-- 4. fn_capacity_row_fits: same signature, its single-order clause replaced by
--    the helper.
-- 5. fn_checkout_single_order_fit(p_day, p_items): read-only. Returns a state
--    word only, never minutes or totals (threat model: capacity numbers stay
--    private): 'fits' | 'too_big' | 'day_unavailable' | 'product_unavailable'.
--    service_role only, called by POST /api/checkout/fit.
--
-- Callers of fn_create_standard_order (Rule 19), listed before changing it:
--   lib/server/ordering/create-order.ts (POST /api/orders), the only app caller;
--   qa/regression.checkout.spec.js, qa/regression.catalog.spec.js ("fit agrees
--   with the real reservation"), qa/db/capacity-race.test.mjs and
--   output/db/tests (test harnesses). No SQL function calls it.
-- Callers of fn_capacity_row_fits: fn_public_day_availability, fn_capacity_fits.

BEGIN;

-- ------------------------------------------------------------
-- 1. The single-order cap rule
-- ------------------------------------------------------------
CREATE FUNCTION fn_single_order_cap_exceeded(
  p_oven INT, p_work INT, p_oven_minutes_total INT, p_work_minutes_total INT, p_single_order_pct NUMERIC
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT COALESCE(
    p_oven > p_oven_minutes_total * p_single_order_pct / 100
    OR p_work > p_work_minutes_total * p_single_order_pct / 100,
    false);
$$;
COMMENT ON FUNCTION fn_single_order_cap_exceeded IS
  'SEC-005. THE single-order cap: one order may use at most single_order_capacity_pct of a day''s total, per resource. NULL pct = no cap. Called by fn_create_standard_order (raises), fn_capacity_row_fits (public fit) and fn_checkout_single_order_fit (checkout early warning). Internal.';

-- ------------------------------------------------------------
-- 2. The shape of p_items (moved from fn_create_standard_order)
-- ------------------------------------------------------------
CREATE FUNCTION fn_order_items_invalid(p_items JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
BEGIN
  RETURN p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 30
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR COALESCE(e ->> 'product_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          -- CASE, not OR: SQL does not promise to skip the cast for a non-number.
          OR CASE WHEN jsonb_typeof(e -> 'quantity') = 'number'
                  THEN (e ->> 'quantity')::numeric <> trunc((e ->> 'quantity')::numeric)
                       OR (e ->> 'quantity')::numeric NOT BETWEEN 1 AND 100
                  ELSE true END)
     OR (SELECT count(DISTINCT lower(e ->> 'product_id')) FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items);
END;
$$;
COMMENT ON FUNCTION fn_order_items_invalid IS
  'api-003 shape check of an order''s items (1..30 lines, uuid product ids, integer quantity 1..100, no duplicate product). Used by fn_create_standard_order and fn_checkout_single_order_fit. Internal.';

-- ------------------------------------------------------------
-- 3. fn_create_standard_order (body from 20260926050000; two expressions
--    replaced by helper calls, nothing else changed)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_create_standard_order(
  p_ip_address TEXT,
  p_customer_id UUID,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_guest_email TEXT,
  p_fulfillment_type TEXT,
  p_delivery_date DATE,
  p_delivery_slot_id UUID,
  p_delivery_address TEXT,
  p_delivery_city TEXT,
  p_delivery_notes TEXT,
  p_items JSONB,
  p_lookup_token TEXT,
  p_privacy_notice_version TEXT,
  p_terms_version TEXT,
  p_cancellation_notice_version TEXT
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_phone TEXT := COALESCE(p_guest_phone, (SELECT phone FROM customers WHERE id = p_customer_id));
  v_ip_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_attempts_per_ip_per_hour');
  v_phone_pending_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'open_payment_pending_per_phone_max');
  v_single_order_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'single_order_capacity_pct');
  v_unpaid_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'unpaid_holds_capacity_pct');
  v_expiry_hours NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'payment_pending_expiry_hours_standard');
  v_ip_attempts INT;
  v_open_pending INT;
  v_item JSONB;
  v_product products%ROWTYPE;
  v_oven_total INT := 0;
  v_work_total INT := 0;
  v_subtotal NUMERIC(10,2) := 0;
  v_delivery_fee NUMERIC(10,2) := 0;
  v_zone_id UUID;
  v_city TEXT;
  v_address TEXT;
  v_slot time_slots%ROWTYPE;
  v_ledger capacity_day_ledger%ROWTYPE;
  v_order orders%ROWTYPE;
BEGIN
  -- api-003: shape checks the caller (the route's Zod contract) already made,
  -- repeated here because money and capacity are computed from them.
  IF fn_order_items_invalid(p_items) THEN
    RAISE EXCEPTION 'order_items_invalid';
  END IF;
  IF p_fulfillment_type IS NULL OR p_fulfillment_type NOT IN ('delivery', 'pickup') THEN
    RAISE EXCEPTION 'fulfillment_type_invalid';
  END IF;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'guest_phone_or_customer_required';
  END IF;

  INSERT INTO order_attempt_log (ip_address, phone_e164) VALUES (p_ip_address, v_phone);

  SELECT count(*) INTO v_ip_attempts FROM order_attempt_log
  WHERE ip_address = p_ip_address AND created_at > now() - interval '1 hour';
  IF v_ip_attempts > v_ip_limit THEN
    RAISE EXCEPTION 'rate_limit_ip_exceeded';
  END IF;

  SELECT count(*) INTO v_open_pending FROM orders
  WHERE status = 'payment_pending'
    AND (guest_phone = v_phone OR customer_id = p_customer_id);
  IF v_open_pending >= v_phone_pending_limit THEN
    RAISE EXCEPTION 'rate_limit_open_orders_per_phone_exceeded';
  END IF;

  -- The same sum is written in fn_checkout_single_order_fit (see the header).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM products
    WHERE id = (v_item ->> 'product_id')::uuid AND is_available AND is_published AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_unavailable: %', v_item ->> 'product_id';
    END IF;
    v_oven_total := v_oven_total + v_product.oven_minutes_cost * (v_item ->> 'quantity')::int;
    v_work_total := v_work_total + v_product.work_minutes_cost * (v_item ->> 'quantity')::int;
    v_subtotal := v_subtotal + v_product.price_displayed * (v_item ->> 'quantity')::int;
  END LOOP;

  -- api-003: the slot must be an active one; its start is checked against the
  -- lead time by trg_orders_lead_time at insert.
  SELECT * INTO v_slot FROM time_slots WHERE id = p_delivery_slot_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_slot_unavailable';
  END IF;

  IF p_fulfillment_type = 'delivery' THEN
    -- api-003 (SEC-008): the zone and its fee follow from the city, never
    -- from a zone id the caller sends.
    v_city := btrim(p_delivery_city);
    v_address := NULLIF(btrim(p_delivery_address), '');
    SELECT z.id, z.fee_displayed INTO v_zone_id, v_delivery_fee
    FROM delivery_zone_cities c JOIN delivery_zones z ON z.id = c.zone_id
    WHERE c.city = v_city AND z.is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery_zone_unavailable';
    END IF;
    IF v_address IS NULL THEN
      RAISE EXCEPTION 'delivery_address_required';
    END IF;
  END IF;

  SELECT * INTO v_ledger FROM capacity_day_ledger WHERE day = p_delivery_date;
  IF NOT FOUND OR v_ledger.is_blackout THEN
    RAISE EXCEPTION 'day_unavailable';
  END IF;
  -- Single-order cap: about this order's own size vs the day's TOTAL, not
  -- shared mutable state, so a plain pre-check has no race to close.
  IF fn_single_order_cap_exceeded(v_oven_total, v_work_total, v_ledger.oven_minutes_total, v_ledger.work_minutes_total, v_single_order_pct) THEN
    RAISE EXCEPTION 'single_order_capacity_cap_exceeded';
  END IF;

  -- The unpaid-holds cap is enforced INSIDE fn_reserve_capacity's single
  -- atomic UPDATE (BUG 1 fix, 20260925121000).
  IF NOT fn_reserve_capacity(p_delivery_date, v_oven_total, v_work_total, v_unpaid_pct) THEN
    -- Best-effort diagnostic only, for the error message; the authoritative
    -- accept/reject decision already happened atomically above.
    SELECT * INTO v_ledger FROM capacity_day_ledger WHERE day = p_delivery_date;
    IF v_ledger.oven_minutes_reserved + v_oven_total > v_ledger.oven_minutes_total
       OR v_ledger.work_minutes_reserved + v_work_total > v_ledger.work_minutes_total THEN
      RAISE EXCEPTION 'capacity_reservation_failed';
    ELSE
      RAISE EXCEPTION 'unpaid_holds_capacity_cap_exceeded';
    END IF;
  END IF;

  PERFORM set_config('app.allow_status_change', 'true', true);
  INSERT INTO orders (
    order_number, lookup_token_hash, lookup_token_expires_at, status,
    customer_id, guest_name, guest_phone, guest_email,
    fulfillment_type, delivery_date, delivery_time_window, delivery_zone_id,
    delivery_slot_id, delivery_slot_start, delivery_slot_end,
    delivery_address, delivery_city, delivery_notes,
    subtotal_displayed, delivery_fee_displayed, total_displayed,
    oven_minutes_cost, work_minutes_cost,
    privacy_notice_version, terms_version, cancellation_notice_version,
    payment_pending_expires_at
  ) VALUES (
    fn_generate_order_number(), fn_hash_token(p_lookup_token), now() + interval '30 days', 'payment_pending',
    p_customer_id, p_guest_name, p_guest_phone, p_guest_email,
    p_fulfillment_type, p_delivery_date,
    to_char(v_slot.start_time, 'HH24:MI') || '-' || to_char(v_slot.end_time, 'HH24:MI'), v_zone_id,
    v_slot.id, v_slot.start_time, v_slot.end_time,
    v_address, v_city, p_delivery_notes,
    v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee,
    v_oven_total, v_work_total,
    p_privacy_notice_version, p_terms_version, p_cancellation_notice_version,
    now() + (v_expiry_hours || ' hours')::interval
  ) RETURNING * INTO v_order;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item ->> 'product_id')::uuid;
    INSERT INTO order_items (order_id, product_id, product_name_snapshot, unit_price_displayed, quantity, line_total_displayed)
    VALUES (v_order.id, v_product.id, v_product.name, v_product.price_displayed, (v_item ->> 'quantity')::int,
            v_product.price_displayed * (v_item ->> 'quantity')::int);
  END LOOP;

  -- B4b: no raw IP in the undeletable audit_log. The IP already lives in
  -- order_attempt_log above, with its own retention (fn_purge_old_order_attempts).
  PERFORM fn_write_audit_log('system',
    CASE WHEN p_customer_id IS NOT NULL THEN 'checkout:customer:' || p_customer_id::text ELSE 'checkout:anon' END,
    'order.created', 'order', v_order.id::text, '{}'::jsonb);

  RETURN v_order;
END;
$$;

-- ------------------------------------------------------------
-- 4. fn_capacity_row_fits: single-order clause through the helper
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
     -- the single-order cap, the one definition (NULL pct = no cap)
     AND NOT fn_single_order_cap_exceeded(p_oven, p_work, l.oven_minutes_total, l.work_minutes_total, p_single_order_pct);
$$;

-- ------------------------------------------------------------
-- 5. The checkout early warning (read-only)
-- ------------------------------------------------------------
CREATE FUNCTION fn_checkout_single_order_fit(p_day DATE, p_items JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_single_order_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'single_order_capacity_pct');
  v_item JSONB;
  v_product products%ROWTYPE;
  v_oven_total INT := 0;
  v_work_total INT := 0;
  v_ledger capacity_day_ledger%ROWTYPE;
BEGIN
  IF fn_order_items_invalid(p_items) THEN
    RAISE EXCEPTION 'order_items_invalid';
  END IF;

  -- The same sum as fn_create_standard_order's loop (see the header).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM products
    WHERE id = (v_item ->> 'product_id')::uuid AND is_available AND is_published AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RETURN 'product_unavailable';
    END IF;
    v_oven_total := v_oven_total + v_product.oven_minutes_cost * (v_item ->> 'quantity')::int;
    v_work_total := v_work_total + v_product.work_minutes_cost * (v_item ->> 'quantity')::int;
  END LOOP;

  SELECT * INTO v_ledger FROM capacity_day_ledger WHERE day = p_day;
  IF NOT FOUND OR v_ledger.is_blackout THEN
    RETURN 'day_unavailable';
  END IF;
  IF fn_single_order_cap_exceeded(v_oven_total, v_work_total, v_ledger.oven_minutes_total, v_ledger.work_minutes_total, v_single_order_pct) THEN
    RETURN 'too_big';
  END IF;
  RETURN 'fits';
END;
$$;
COMMENT ON FUNCTION fn_checkout_single_order_fit IS
  'Checkout early warning: does this cart pass the single-order cap on p_day? Returns a state word only (fits / too_big / day_unavailable / product_unavailable), never minutes. Read-only; fn_create_standard_order stays the authority. service_role only, called by POST /api/checkout/fit.';

-- New functions are callable by nobody by default (20260925121300) except
-- service_role through its default grant; say it explicitly for each.
REVOKE EXECUTE ON FUNCTION fn_single_order_cap_exceeded(INT, INT, INT, INT, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_order_items_invalid(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_checkout_single_order_fit(DATE, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_checkout_single_order_fit(DATE, JSONB) TO service_role;

COMMIT;
