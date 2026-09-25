-- Migration: 20260926050000_api003_checkout_slots_and_orders
-- Task: api-003 (POST /api/orders), with client-003/client-004 read paths.
-- Lane: 20260926050000..059999 (session E, checkout and payment).
--
-- 1. Structured time slots (time_slots). The order's time was free text
--    (orders.delivery_time_window), so the DB could only enforce the lead
--    time at date level (blindspot-002). A slot now has a start and an end
--    (Asia/Jerusalem wall clock), the order snapshots them, and the lead-time
--    trigger refuses a standard order whose slot starts less than
--    app_settings.lead_time_hours (24) from now. RED before this file (local
--    stack, 2026-09-26 01:19 Jerusalem): an order for 2026-09-27 with a
--    00:00 window, 22h41m away, was accepted as payment_pending.
--
-- 2. earliest_slot_time is DERIVED from time_slots. fn_day_too_soon (api-002)
--    marks a day too_soon when app_settings.earliest_slot_time on that day is
--    less than lead_time_hours away, so every slot of a selectable day is
--    outside the lead time. That only holds if earliest_slot_time is the real
--    first slot. A statement trigger on time_slots writes the earliest active
--    start into it after every change (unchanged when no slot is active).
--    Do not edit earliest_slot_time by hand: the next slot change overwrites
--    it. The day strip (day level) and the order (slot level) therefore agree:
--    a selectable day has only slots that pass the slot check, and the slot
--    check still runs at insert, because time passes between the two.
--
-- 3. fn_create_standard_order (money and capacity; CALLERS listed below):
--    - server-side only: EXECUTE revoked from anon and authenticated, granted
--      to service_role. POST /api/orders calls it with the service client and
--      passes the client IP (SEC-005 per-IP limit). Closes "anon can create
--      orders directly via PostgREST" (SYSTEM-CONTRACT section 3).
--    - p_delivery_time_window TEXT -> p_delivery_slot_id UUID (structured).
--    - p_delivery_zone_id removed: the zone and its fee are derived from the
--      delivery city in the DB. Before, the function trusted the caller's
--      zone id and never checked that the city belonged to it, so a request
--      could pair any city with the cheapest zone (SEC-008).
--    - items validated (1..30 lines, integer quantity 1..100, no duplicate
--      product): a negative quantity used to reach fn_reserve_capacity as a
--      negative cost before the order_items CHECK aborted the transaction.
--    Everything else (rate limits, caps, fn_reserve_capacity call, pricing,
--    order number, expiry, audit) is the body of 20260925121000 unchanged.
--    Callers of fn_create_standard_order after this file:
--      lib/server/ordering/create-order.ts (POST /api/orders), service role
--      qa/helpers/db.js (orderArgs / CREATE_ORDER_SQL: capacity-race,
--        business-day, regression.jobs), superuser
--      qa/regression.catalog.spec.js ("fit agrees with the real reservation")
--      qa/regression.checkout.spec.js, qa/db/slot-lead-time.test.mjs
--    fn_reserve_capacity and fn_release_order_capacity are NOT changed.
--
-- 4. fn_order_for_lookup_token: the order page (client-004) reads one order by
--    its capability token (SEC-003), service role only. Returns no name,
--    phone, email or street address: the page does not need them.
--
-- 5. Payment links (SEC-009): app_settings payment_link_bit and
--    payment_link_paybox, JSON null until Yuval sets them. anon no longer
--    reads payment_link_* rows; the server reads them through
--    fn_payment_link_settings() (service role only). The admin screen that
--    edits them is not part of this task.

BEGIN;

-- ------------------------------------------------------------
-- 1. time_slots
-- ------------------------------------------------------------
CREATE TABLE time_slots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  start_time TIME NOT NULL, -- Asia/Jerusalem wall clock
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (date_trunc('minute', start_time) = start_time AND date_trunc('minute', end_time) = end_time),
  UNIQUE (start_time, end_time)
);
COMMENT ON TABLE time_slots IS 'DDD context: Ordering. Delivery/pickup time slots (api-003), Asia/Jerusalem wall clock, the same list for every day and for both delivery and pickup. Deactivate rather than delete: orders snapshot start/end. The earliest active start is mirrored into app_settings.earliest_slot_time by trg_time_slots_sync_earliest. No slot is created here: Yuval''s hours are an open decision (PRD 10.1); seed.sql has synthetic ones for local runs.';

CREATE TRIGGER trg_time_slots_updated_at BEFORE UPDATE ON time_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE time_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "time_slots_select_public" ON time_slots FOR SELECT
  USING (is_active OR is_admin_aal2());
CREATE POLICY "time_slots_admin_write" ON time_slots FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());
REVOKE ALL ON TABLE time_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE time_slots TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE time_slots TO authenticated; -- aal2 admin only, by the policy
GRANT SELECT ON TABLE time_slots TO service_role;

CREATE FUNCTION fn_sync_earliest_slot_time() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_first TIME := (SELECT min(start_time) FROM time_slots WHERE is_active);
BEGIN
  IF v_first IS NOT NULL THEN
    UPDATE app_settings SET value = to_jsonb(to_char(v_first, 'HH24:MI'))
    WHERE key = 'earliest_slot_time' AND value IS DISTINCT FROM to_jsonb(to_char(v_first, 'HH24:MI'));
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION fn_sync_earliest_slot_time IS 'api-003: keeps app_settings.earliest_slot_time equal to the earliest active time_slots.start_time, so fn_day_too_soon (day strip) and the slot-level lead-time check agree. Unchanged when no slot is active.';
REVOKE EXECUTE ON FUNCTION fn_sync_earliest_slot_time() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_time_slots_sync_earliest
  AFTER INSERT OR UPDATE OR DELETE ON time_slots
  FOR EACH STATEMENT EXECUTE FUNCTION fn_sync_earliest_slot_time();

-- ------------------------------------------------------------
-- 2. orders: the slot snapshot, and the hour-level lead time
-- ------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN delivery_slot_id UUID, -- time_slots.id at order time. No FK: slots may be edited or removed later, the snapshot below is what the order means.
  ADD COLUMN delivery_slot_start TIME,
  ADD COLUMN delivery_slot_end TIME,
  ADD CONSTRAINT orders_slot_snapshot_complete CHECK (
    (delivery_slot_start IS NULL AND delivery_slot_end IS NULL) OR
    (delivery_slot_start IS NOT NULL AND delivery_slot_end IS NOT NULL AND delivery_slot_end > delivery_slot_start));
COMMENT ON COLUMN orders.delivery_slot_start IS 'api-003: slot start, Asia/Jerusalem wall clock on delivery_date. Lead time is measured to this instant (fn_slot_starts_at). delivery_time_window keeps the same slot as HH:MM-HH:MM text for existing readers.';

-- The instant a slot starts: its Jerusalem wall clock on its date, DST-aware.
CREATE FUNCTION fn_slot_starts_at(p_day DATE, p_start TIME) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT (p_day + p_start) AT TIME ZONE 'Asia/Jerusalem';
$$;
COMMENT ON FUNCTION fn_slot_starts_at IS 'api-003: the instant a slot starting at p_start (Asia/Jerusalem wall clock) on p_day begins. Mirrored by jerusalemInstant() in lib/shared/time/jerusalem.ts.';

-- True when a slot starting at p_start on p_day is at least the lead time
-- (app_settings.lead_time_hours, 24 by default) after p_at. Real hours, so a
-- DST night is not 24 wall-clock hours.
CREATE FUNCTION fn_slot_meets_lead_time(p_day DATE, p_start TIME, p_at TIMESTAMPTZ DEFAULT now()) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT fn_slot_starts_at(p_day, p_start)
         >= p_at + make_interval(hours => COALESCE((SELECT (value)::text::int FROM app_settings WHERE key = 'lead_time_hours'), 24));
$$;
COMMENT ON FUNCTION fn_slot_meets_lead_time IS 'api-003: slot-level lead time (BRIEF: at least 24 hours before delivery; read as 24 real hours before the slot start, Asia/Jerusalem). Mirrored by slotMeetsLeadTime() in lib/shared/time/jerusalem.ts, parity tested in qa/db/slot-lead-time.test.mjs.';

REVOKE EXECUTE ON FUNCTION fn_slot_starts_at(DATE, TIME) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_slot_meets_lead_time(DATE, TIME, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_slot_starts_at(DATE, TIME) TO service_role;
GRANT EXECUTE ON FUNCTION fn_slot_meets_lead_time(DATE, TIME, TIMESTAMPTZ) TO service_role;

-- fn_guard_lead_time (blindspot-002) gains the slot check. The date floor is
-- unchanged. Still a BEFORE INSERT trigger, so it holds for any insert path.
CREATE OR REPLACE FUNCTION fn_guard_lead_time() RETURNS TRIGGER
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
  -- api-003: the hour-level check, measured to the slot's start. Nested, not
  -- AND-ed: custom_cake_requests rows have no slot column, and PL/pgSQL
  -- resolves NEW.delivery_slot_start even when the first operand is false.
  IF TG_TABLE_NAME = 'orders' THEN
    IF NEW.delivery_slot_start IS NOT NULL
       AND NOT fn_slot_meets_lead_time(NEW.delivery_date, NEW.delivery_slot_start, now()) THEN
      RAISE EXCEPTION 'lead_time_not_met: slot % % starts less than the lead time from now', NEW.delivery_date, NEW.delivery_slot_start;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_guard_lead_time() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. fn_create_standard_order, server-side only, structured slot
-- ------------------------------------------------------------
DROP FUNCTION fn_create_standard_order(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION fn_create_standard_order(
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
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
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
     OR (SELECT count(DISTINCT lower(e ->> 'product_id')) FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) THEN
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
  IF v_oven_total > v_ledger.oven_minutes_total * v_single_order_pct / 100
     OR v_work_total > v_ledger.work_minutes_total * v_single_order_pct / 100 THEN
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
COMMENT ON FUNCTION fn_create_standard_order IS 'SEC-005/SEC-008/ADR-002 in one transaction: rate limits, server-priced totals (zone fee from the city), single-order cap, atomic fn_reserve_capacity (unpaid-holds cap inside it), order+items insert; the slot lead time is checked by trg_orders_lead_time. api-003: service_role only, called by POST /api/orders.';
REVOKE EXECUTE ON FUNCTION fn_create_standard_order(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_create_standard_order(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 4. Read one order by its capability token (SEC-003)
-- ------------------------------------------------------------
CREATE FUNCTION fn_order_for_lookup_token(p_token TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'order_number', o.order_number,
    'status', o.status,
    'fulfillment_type', o.fulfillment_type,
    'delivery_date', o.delivery_date,
    'slot_start', to_char(o.delivery_slot_start, 'HH24:MI'),
    'slot_end', to_char(o.delivery_slot_end, 'HH24:MI'),
    'delivery_city', o.delivery_city,
    'subtotal', o.subtotal_displayed,
    'delivery_fee', o.delivery_fee_displayed,
    'total', o.total_displayed,
    'payment_pending_expires_at', o.payment_pending_expires_at,
    'created_at', o.created_at,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', i.product_name_snapshot, 'quantity', i.quantity,
               'unit_price', i.unit_price_displayed, 'line_total', i.line_total_displayed)
             ORDER BY i.created_at, i.id)
      FROM order_items i WHERE i.order_id = o.id), '[]'::jsonb)
  )
  FROM orders o
  WHERE length(p_token) >= 20
    AND o.lookup_token_hash = fn_hash_token(p_token)
    AND o.lookup_token_expires_at > now()
    AND o.pii_purged_at IS NULL;
$$;
COMMENT ON FUNCTION fn_order_for_lookup_token IS 'SEC-003/client-004: one order by its capability token (sha256 match, not expired), or NULL. NULL for unknown, expired and purged alike (one uniform answer). No name, phone, email or street address in the result. service_role only; called by the order page and GET /api/orders/[token].';
REVOKE EXECUTE ON FUNCTION fn_order_for_lookup_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_order_for_lookup_token(TEXT) TO service_role;

-- ------------------------------------------------------------
-- 5. Payment links (SEC-009)
-- ------------------------------------------------------------
INSERT INTO app_settings (key, value, description) VALUES
  ('payment_link_bit', 'null', 'Yuval''s Bit payment link (https). Shown on the order page only if its host is on the allowlist in lib/shared/payment/links.ts. null renders a visible placeholder. SEC-009: the editing screen must require a fresh aal2, audit the change and email Yuval.'),
  ('payment_link_paybox', 'null', 'Yuval''s PayBox payment link (https). Same rules as payment_link_bit.')
ON CONFLICT (key) DO NOTHING;

DROP POLICY IF EXISTS "app_settings_select_public" ON app_settings;
CREATE POLICY "app_settings_select_public" ON app_settings FOR SELECT
  USING ((key NOT LIKE 'business\_%' AND key NOT LIKE 'payment\_link\_%') OR is_admin_aal2());

CREATE FUNCTION fn_payment_link_settings() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'bit', fn_setting_text('payment_link_bit'),
    'paybox', fn_setting_text('payment_link_paybox'));
$$;
COMMENT ON FUNCTION fn_payment_link_settings IS 'SEC-009: the only read path for payment_link_* settings outside an aal2 admin. Fixed whitelist; each value is text or null (unset, blank or not a string). service_role only (the order page is server-rendered).';
REVOKE EXECUTE ON FUNCTION fn_payment_link_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_link_settings() TO service_role;

COMMIT;
