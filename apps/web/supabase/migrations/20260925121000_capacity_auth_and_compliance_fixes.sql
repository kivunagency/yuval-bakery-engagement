-- Migration: 20260925121000_capacity_auth_and_compliance_fixes
-- Fix commit atop the original 9 migrations, still on the same unmerged PR
-- (rotem's compliance-schema-review.md section "Coordination": apply after
-- the capacity fixes, same PR or the next one, not in parallel on the same
-- lines). Three batches, in the order the coordinator raised them:
--
-- PART A: BUG 1 (unpaid-holds cap wrongly counted paid orders, and raced)
--         and BUG 2 (a paid order could never be cancelled).
-- PART B: CRITICAL privilege escalation (admin functions trusted a
--         caller-supplied p_admin_id instead of deriving the actor from
--         auth.uid(); fn_set_marketing_consent had the same shape).
-- PART C: rotem's compliance-schema-review.md blockers B1 to B5, plus the
--         cheap non-blocking items (N1, N6, N7, N10, N12, N13) folded in
--         because they touch the same functions this migration already
--         rewrites. N2 to N5, N8, N9, N11 are explicitly DEFERRED, listed
--         at the end of this file with the reason each was left out.

BEGIN;

-- ============================================================
-- PART A: capacity bugs
-- ============================================================

-- BUG 1 fix. The 70% "unpaid holds" cap must apply to payment_pending
-- orders only; a paid order's minutes are legitimately spent, not an
-- abuse-prone hold. Track unpaid holds as their own counter, maintained by
-- reserve/mark-paid/release, so the cap check never has to distinguish paid
-- from unpaid by re-deriving it from `orders` on every checkout.
ALTER TABLE capacity_day_ledger
  ADD COLUMN oven_minutes_unpaid_reserved INT NOT NULL DEFAULT 0,
  ADD COLUMN work_minutes_unpaid_reserved INT NOT NULL DEFAULT 0;

ALTER TABLE capacity_day_ledger
  ADD CONSTRAINT capacity_day_ledger_oven_unpaid_bounds
    CHECK (oven_minutes_unpaid_reserved >= 0 AND oven_minutes_unpaid_reserved <= oven_minutes_reserved),
  ADD CONSTRAINT capacity_day_ledger_work_unpaid_bounds
    CHECK (work_minutes_unpaid_reserved >= 0 AND work_minutes_unpaid_reserved <= work_minutes_reserved);

COMMENT ON COLUMN capacity_day_ledger.oven_minutes_unpaid_reserved IS
  'BUG 1 fix (coordinator review of f2477b2): sum of oven-minute cost of orders CURRENTLY in payment_pending for this day only. Incremented by fn_reserve_capacity, decremented by fn_mark_order_paid (moves to paid, stops being an unpaid hold) and by fn_release_order_capacity when releasing FROM payment_pending. Never decremented when releasing from paid (BUG 2): that capacity was never counted here in the first place once it moved to paid.';

-- Backfill: every currently payment_pending order's minute-cost counts as an
-- unpaid hold today; paid/fulfilled orders do not.
UPDATE capacity_day_ledger l
SET oven_minutes_unpaid_reserved = COALESCE(sub.oven_sum, 0),
    work_minutes_unpaid_reserved = COALESCE(sub.work_sum, 0)
FROM (
  SELECT delivery_date AS day, SUM(oven_minutes_cost) AS oven_sum, SUM(work_minutes_cost) AS work_sum
  FROM orders WHERE status = 'payment_pending' GROUP BY delivery_date
) sub
WHERE l.day = sub.day;

-- fn_reserve_capacity: signature grows an unpaid_pct parameter, and the
-- unpaid-holds cap is now folded into the SAME atomic UPDATE as the hard
-- total<=total check, closing the race the old caller-side pre-check had
-- (it read the ledger, THEN called this function; two concurrent unpaid
-- orders could both pass the stale read).
DROP FUNCTION IF EXISTS fn_reserve_capacity(DATE, INT, INT);

CREATE OR REPLACE FUNCTION fn_reserve_capacity(
  p_day DATE, p_oven_minutes INT, p_work_minutes INT, p_unpaid_pct NUMERIC DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day DATE;
BEGIN
  UPDATE capacity_day_ledger
  SET oven_minutes_reserved = oven_minutes_reserved + p_oven_minutes,
      work_minutes_reserved = work_minutes_reserved + p_work_minutes,
      oven_minutes_unpaid_reserved = oven_minutes_unpaid_reserved + p_oven_minutes,
      work_minutes_unpaid_reserved = work_minutes_unpaid_reserved + p_work_minutes
  WHERE day = p_day
    AND is_blackout = false
    AND oven_minutes_reserved + p_oven_minutes <= oven_minutes_total
    AND work_minutes_reserved + p_work_minutes <= work_minutes_total
    AND (p_unpaid_pct IS NULL
         OR oven_minutes_unpaid_reserved + p_oven_minutes <= oven_minutes_total * p_unpaid_pct / 100)
    AND (p_unpaid_pct IS NULL
         OR work_minutes_unpaid_reserved + p_work_minutes <= work_minutes_total * p_unpaid_pct / 100)
  RETURNING day INTO v_day;

  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_reserve_capacity(DATE, INT, INT, NUMERIC) FROM PUBLIC;
COMMENT ON FUNCTION fn_reserve_capacity IS 'BUG 1 fix: unpaid-holds cap folded into this one atomic UPDATE, checked against *_unpaid_reserved (payment_pending only), never against the combined paid+unpaid total. Called by fn_create_standard_order and fn_approve_custom_cake_request, both passing the live unpaid_holds_capacity_pct app_setting.';

-- BUG 2 + SEC-007 fix. Capacity-holding statuses are payment_pending AND
-- paid (documented once, here and in DB-PLAN.md; a future in_preparation/
-- ready status must be added explicitly, never assumed). "expired" only
-- ever applies to a payment_pending order (the timeout is a pre-payment
-- concept). "cancelled" may apply to payment_pending OR paid: Yuval must be
-- able to cancel a paid order (refund handled by her, outside the app), and
-- the held minutes must come back exactly once.
CREATE OR REPLACE FUNCTION fn_release_order_capacity(
  p_order_id UUID, p_new_status TEXT, p_actor_type TEXT DEFAULT 'system', p_actor_id TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_allowed_from TEXT[];
  v_was_unpaid BOOLEAN;
BEGIN
  IF p_new_status NOT IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION 'fn_release_order_capacity only accepts expired or cancelled, got %', p_new_status;
  END IF;

  v_allowed_from := CASE WHEN p_new_status = 'expired' THEN ARRAY['payment_pending']
                          ELSE ARRAY['payment_pending', 'paid'] END;

  -- Row lock held for the rest of this function: (a) lets us read the OLD
  -- status reliably for the unpaid-bookkeeping decision below (RETURNING
  -- only ever gives the NEW row), and (b) a concurrent second caller
  -- (retried sweep, cancel racing expire on the SAME order) blocks here,
  -- then sees the already-updated status and returns false. SEC-007
  -- idempotency now holds under real lock contention, not only under a
  -- single guarded UPDATE's implicit re-check (that mechanism was already
  -- correct; FOR UPDATE makes the "was it unpaid" read safe too).
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT (v_order.status = ANY(v_allowed_from)) THEN
    RETURN false; -- already released, or never eligible: idempotent no-op
  END IF;
  v_was_unpaid := (v_order.status = 'payment_pending');

  PERFORM set_config('app.allow_status_change', 'true', true);
  UPDATE orders
  SET status = p_new_status,
      cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE cancelled_at END,
      expired_at = CASE WHEN p_new_status = 'expired' THEN now() ELSE expired_at END
  WHERE id = p_order_id; -- safe: this session holds the row lock from FOR UPDATE above

  UPDATE capacity_day_ledger
  SET oven_minutes_reserved = oven_minutes_reserved - v_order.oven_minutes_cost,
      work_minutes_reserved = work_minutes_reserved - v_order.work_minutes_cost,
      oven_minutes_unpaid_reserved = oven_minutes_unpaid_reserved - (CASE WHEN v_was_unpaid THEN v_order.oven_minutes_cost ELSE 0 END),
      work_minutes_unpaid_reserved = work_minutes_unpaid_reserved - (CASE WHEN v_was_unpaid THEN v_order.work_minutes_cost ELSE 0 END)
  WHERE day = v_order.delivery_date;

  PERFORM fn_write_audit_log(p_actor_type, p_actor_id, 'order.' || p_new_status,
    'order', p_order_id::text, jsonb_build_object('delivery_date', v_order.delivery_date, 'from_status', v_order.status));

  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_release_order_capacity IS 'SEC-007 + BUG 2 fix (coordinator review of f2477b2). Capacity-holding statuses: payment_pending and paid. fulfilled does NOT release (the bake already happened, the time was genuinely spent).';

COMMIT;

BEGIN;

-- fn_create_standard_order: remove the racy caller-side unpaid-cap
-- pre-check (BUG 1's root cause -- it read the ledger, THEN reserved, with
-- no lock between), pass unpaid_pct into the now-atomic fn_reserve_capacity
-- instead. Also B4b: stop writing the raw checkout IP into the undeletable
-- audit_log (it already lives in order_attempt_log with its own retention).
CREATE OR REPLACE FUNCTION fn_create_standard_order(
  p_ip_address TEXT,
  p_customer_id UUID,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_guest_email TEXT,
  p_fulfillment_type TEXT,
  p_delivery_date DATE,
  p_delivery_time_window TEXT,
  p_delivery_zone_id UUID,
  p_delivery_address TEXT,
  p_delivery_city TEXT,
  p_delivery_notes TEXT,
  p_items JSONB,
  p_lookup_token TEXT,
  p_privacy_notice_version TEXT,
  p_terms_version TEXT,
  p_cancellation_notice_version TEXT
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  v_ledger capacity_day_ledger%ROWTYPE;
  v_order orders%ROWTYPE;
BEGIN
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

  IF p_fulfillment_type = 'delivery' THEN
    SELECT fee_displayed INTO v_delivery_fee FROM delivery_zones WHERE id = p_delivery_zone_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery_zone_unavailable';
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

  -- BUG 1 fix: the unpaid-holds cap is no longer pre-checked against a
  -- stale read here. It is enforced INSIDE fn_reserve_capacity's single
  -- atomic UPDATE, against oven/work_minutes_unpaid_reserved (payment_pending
  -- only, never paid orders), closing both the correctness bug and the race.
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
    delivery_address, delivery_city, delivery_notes,
    subtotal_displayed, delivery_fee_displayed, total_displayed,
    oven_minutes_cost, work_minutes_cost,
    privacy_notice_version, terms_version, cancellation_notice_version,
    payment_pending_expires_at
  ) VALUES (
    fn_generate_order_number(), fn_hash_token(p_lookup_token), now() + interval '30 days', 'payment_pending',
    p_customer_id, p_guest_name, p_guest_phone, p_guest_email,
    p_fulfillment_type, p_delivery_date, p_delivery_time_window, p_delivery_zone_id,
    p_delivery_address, p_delivery_city, p_delivery_notes,
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
-- signature unchanged: ACL (anon, authenticated) persists.
COMMENT ON FUNCTION fn_create_standard_order IS 'SEC-005/SEC-008/ADR-002/BUG-1-fix in one transaction. Unpaid-holds cap enforced atomically inside fn_reserve_capacity, not pre-checked here.';

COMMIT;

-- ============================================================
-- PART B: CRITICAL privilege escalation fix
-- ============================================================
-- Every admin function below trusted a caller-supplied p_admin_id, checked
-- only that the id existed in `admins`, never that the CALLER was that id.
-- Every registered customer holds `authenticated` and these functions were
-- GRANTed to `authenticated`, so any customer who learned Yuval's admin UUID
-- (visible in audit_log.actor_id, orders.handled_by-style columns, etc.)
-- could mark any order paid, cancel any order, approve/decline any custom
-- cake, or zero a day's capacity. The comment at the end of the previous
-- migration ("a stolen JWT with the wrong role gets an exception from inside
-- the function") was true for fn_create_standard_order/fn_lookup_order_by_
-- phone_and_number, and FALSE for this whole family: they never checked the
-- JWT's own identity at all.
--
-- Fix: drop p_admin_id from every one of these functions. The actor is now
-- ALWAYS auth.uid(), checked against is_admin_aal2() (admin role AND AAL2),
-- never a parameter. Each DROP+CREATE below is a signature change, so the
-- REVOKE/GRANT that follows is not cosmetic: without it, Postgres's default
-- "new function is EXECUTE-able by PUBLIC" would silently reopen the hole
-- this migration exists to close.

BEGIN;

DROP FUNCTION IF EXISTS fn_mark_order_paid(UUID, UUID);
CREATE OR REPLACE FUNCTION fn_mark_order_paid(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  PERFORM set_config('app.allow_status_change', 'true', true);
  UPDATE orders SET status = 'paid', paid_at = now()
  WHERE id = p_order_id AND status = 'payment_pending'
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- BUG 1 bookkeeping: this order stops being an "unpaid hold" the moment
  -- it is marked paid, even though it keeps its capacity reservation.
  UPDATE capacity_day_ledger
  SET oven_minutes_unpaid_reserved = oven_minutes_unpaid_reserved - v_order.oven_minutes_cost,
      work_minutes_unpaid_reserved = work_minutes_unpaid_reserved - v_order.work_minutes_cost
  WHERE day = v_order.delivery_date;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'order.marked_paid', 'order', p_order_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_mark_order_paid(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mark_order_paid(UUID) TO authenticated;

DROP FUNCTION IF EXISTS fn_mark_order_fulfilled(UUID, UUID);
CREATE OR REPLACE FUNCTION fn_mark_order_fulfilled(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  PERFORM set_config('app.allow_status_change', 'true', true);
  UPDATE orders SET status = 'fulfilled', fulfilled_at = now()
  WHERE id = p_order_id AND status = 'paid';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'order.marked_fulfilled', 'order', p_order_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_mark_order_fulfilled(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mark_order_fulfilled(UUID) TO authenticated;

DROP FUNCTION IF EXISTS fn_cancel_order(UUID, UUID);
CREATE OR REPLACE FUNCTION fn_cancel_order(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  RETURN fn_release_order_capacity(p_order_id, 'cancelled', 'admin', auth.uid()::text);
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_cancel_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cancel_order(UUID) TO authenticated;

DROP FUNCTION IF EXISTS fn_admin_set_day_capacity(UUID, DATE, INT, INT, BOOLEAN);
CREATE OR REPLACE FUNCTION fn_admin_set_day_capacity(
  p_day DATE, p_oven_minutes_total INT, p_work_minutes_total INT, p_is_blackout BOOLEAN
) RETURNS capacity_day_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row capacity_day_ledger%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout)
  VALUES (p_day, p_oven_minutes_total, p_work_minutes_total, p_is_blackout)
  ON CONFLICT (day) DO UPDATE
    SET oven_minutes_total = EXCLUDED.oven_minutes_total,
        work_minutes_total = EXCLUDED.work_minutes_total,
        is_blackout = EXCLUDED.is_blackout
  RETURNING * INTO v_row;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'capacity.day_updated', 'capacity_day_ledger', p_day::text,
    jsonb_build_object('oven_minutes_total', p_oven_minutes_total, 'work_minutes_total', p_work_minutes_total, 'is_blackout', p_is_blackout));
  RETURN v_row;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_admin_set_day_capacity(DATE, INT, INT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_admin_set_day_capacity(DATE, INT, INT, BOOLEAN) TO authenticated;

DROP FUNCTION IF EXISTS fn_approve_custom_cake_request(UUID, UUID, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION fn_approve_custom_cake_request(
  p_request_id UUID,
  p_price NUMERIC, p_oven_minutes INT, p_work_minutes INT,
  p_lookup_token TEXT, p_privacy_notice_version TEXT, p_terms_version TEXT, p_cancellation_notice_version TEXT
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req custom_cake_requests%ROWTYPE;
  v_expiry_hours NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'payment_pending_expiry_hours_custom_cake');
  v_unpaid_pct NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'unpaid_holds_capacity_pct');
  v_order orders%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;

  SELECT * INTO v_req FROM custom_cake_requests WHERE id = p_request_id AND status = 'pending_review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom_cake_request_not_pending';
  END IF;

  -- BUG 1 fix applied here too (Rule 19: one shared definition of "is there
  -- room", not a special case for custom cakes).
  IF NOT fn_reserve_capacity(v_req.desired_date, p_oven_minutes, p_work_minutes, v_unpaid_pct) THEN
    RAISE EXCEPTION 'capacity_changed_recheck_before_approving';
  END IF;

  PERFORM set_config('app.allow_status_change', 'true', true);
  INSERT INTO orders (
    order_number, lookup_token_hash, lookup_token_expires_at, status,
    customer_id, guest_name, guest_phone, guest_email,
    fulfillment_type, delivery_date, order_source, custom_cake_request_id,
    subtotal_displayed, delivery_fee_displayed, total_displayed,
    oven_minutes_cost, work_minutes_cost,
    privacy_notice_version, terms_version, cancellation_notice_version,
    payment_pending_expires_at
  ) VALUES (
    fn_generate_order_number(), fn_hash_token(p_lookup_token), now() + interval '30 days', 'payment_pending',
    v_req.customer_id, v_req.requester_name, v_req.requester_phone, v_req.requester_email,
    'pickup', v_req.desired_date, 'custom_cake', v_req.id,
    p_price, 0, p_price,
    p_oven_minutes, p_work_minutes,
    p_privacy_notice_version, p_terms_version, p_cancellation_notice_version,
    now() + (v_expiry_hours || ' hours')::interval
  ) RETURNING * INTO v_order;

  UPDATE custom_cake_requests
  SET status = 'approved', price_displayed = p_price,
      oven_minutes_cost = p_oven_minutes, work_minutes_cost = p_work_minutes,
      order_id = v_order.id
  WHERE id = p_request_id;

  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'custom_cake.approved', 'custom_cake_request', p_request_id::text,
    jsonb_build_object('order_id', v_order.id));

  RETURN v_order;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_approve_custom_cake_request(UUID, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_approve_custom_cake_request(UUID, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS fn_decline_custom_cake_request(UUID, UUID, TEXT);
CREATE OR REPLACE FUNCTION fn_decline_custom_cake_request(p_request_id UUID, p_reason TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  UPDATE custom_cake_requests SET status = 'declined', decline_reason = p_reason
  WHERE id = p_request_id AND status = 'pending_review';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'custom_cake.declined', 'custom_cake_request', p_request_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_decline_custom_cake_request(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_decline_custom_cake_request(UUID, TEXT) TO authenticated;

COMMIT;

-- ============================================================
-- PART C: rotem's compliance-schema-review.md blockers (B1-B5) + cheap
-- non-blocking items folded in because they touch the same functions.
-- ============================================================

BEGIN;

-- ---- B5a: fn_record_order_confirmation_delivered was callable by ANY
-- authenticated user with no check, which opened the exact gate
-- trg_orders_guard_fulfillment (US-0c) exists to close. Also make it
-- single-write: the hash is only proof of what was sent if a second call
-- cannot silently overwrite it.
CREATE OR REPLACE FUNCTION fn_record_order_confirmation_delivered(
  p_order_id UUID, p_channel TEXT, p_pdf_path TEXT, p_pdf_sha256 TEXT, p_link_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (is_admin_aal2() OR current_user = 'service_role') THEN
    RAISE EXCEPTION 'confirmation_delivery_requires_admin_or_service_role';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp_manual') THEN
    RAISE EXCEPTION 'invalid_confirmation_channel: %', p_channel;
  END IF;
  UPDATE orders
  SET confirmation_channel = p_channel,
      confirmation_delivered_at = now(),
      confirmation_pdf_path = p_pdf_path,
      confirmation_pdf_sha256 = p_pdf_sha256,
      confirmation_link_token_hash = fn_hash_token(p_link_token),
      confirmation_link_expires_at = now() + interval '24 months'
  WHERE id = p_order_id AND confirmation_delivered_at IS NULL; -- B5a: write once
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log(CASE WHEN is_admin_aal2() THEN 'admin' ELSE 'system' END,
    COALESCE(auth.uid()::text, 'service_role'), 'order.confirmation_delivered', 'order', p_order_id::text,
    jsonb_build_object('channel', p_channel));
  RETURN true;
END;
$$;
-- signature unchanged from the original grant point: ACLs persist, but
-- restated for auditability.
REVOKE EXECUTE ON FUNCTION fn_record_order_confirmation_delivered(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_record_order_confirmation_delivered(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ---- B5b: a revocable confirmation link and a way to record the PDF was
-- actually deleted from Storage.
ALTER TABLE orders
  ADD COLUMN confirmation_link_revoked_at TIMESTAMPTZ,
  ADD COLUMN confirmation_pdf_purged_at TIMESTAMPTZ;
COMMENT ON COLUMN orders.confirmation_link_revoked_at IS 'B5b (rotem review): set by fn_anonymize_order. The route serving the confirmation link/PDF MUST check confirmation_link_revoked_at IS NULL AND confirmation_pdf_purged_at IS NULL AND pii_purged_at IS NULL before serving anything -- this is an application-layer contract this column exists to support, documented in DB-PLAN.md, not enforced by RLS (there is no anon/authenticated SELECT on orders at all, per SEC-001/SEC-003; the serving route uses the service role and must re-implement this check itself).';
COMMENT ON COLUMN orders.confirmation_pdf_purged_at IS 'B5b: set ONLY by fn_mark_confirmation_pdf_purged, which the caller must invoke ONLY after the Storage API has confirmed deletion (Rule 20: never mark deleted what was not actually deleted).';

CREATE OR REPLACE FUNCTION fn_mark_confirmation_pdf_purged(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE orders SET confirmation_pdf_purged_at = now()
  WHERE id = p_order_id AND confirmation_pdf_path IS NOT NULL AND confirmation_pdf_purged_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_mark_confirmation_pdf_purged(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mark_confirmation_pdf_purged(UUID) TO service_role;
COMMENT ON FUNCTION fn_mark_confirmation_pdf_purged IS 'service_role only: called from the retention sweep after Storage deletion is confirmed, never from the client.';

-- ---- B1a: the CHECK constraints on orders made anonymization of ANY
-- delivery order, or ANY guest order, impossible: the customer-deletion
-- flow would always roll back for these, which are most of the customers
-- (BRIEF: guest checkout is the norm). Both CHECKs get a pii_purged_at
-- escape hatch; the floor they enforce (an order must have a name/phone/
-- address while it is live) is unchanged for every non-purged row.
ALTER TABLE orders DROP CONSTRAINT orders_check;
ALTER TABLE orders ADD CONSTRAINT orders_check
  CHECK (pii_purged_at IS NOT NULL OR customer_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL));

ALTER TABLE orders DROP CONSTRAINT orders_check1;
ALTER TABLE orders ADD CONSTRAINT orders_check1
  CHECK (pii_purged_at IS NOT NULL OR fulfillment_type = 'pickup' OR (delivery_address IS NOT NULL AND delivery_city IS NOT NULL));

-- ---- B1b/B1c: custom_cake_requests' requester_name/requester_phone were
-- NOT NULL, which would block anonymization the same way. Nullable now,
-- with the same pii_purged_at escape hatch as orders.
ALTER TABLE custom_cake_requests ALTER COLUMN requester_name DROP NOT NULL;
ALTER TABLE custom_cake_requests ALTER COLUMN requester_phone DROP NOT NULL;
ALTER TABLE custom_cake_requests ADD CONSTRAINT custom_cake_requests_pii_required
  CHECK (pii_purged_at IS NOT NULL OR (requester_name IS NOT NULL AND requester_phone IS NOT NULL));

-- customers.name was NOT NULL; N12 (Rule 1: no hardcoded Hebrew in the DB)
-- means anonymization sets NULL, not a Hebrew literal, and the UI
-- translates an absent name via he.json/en.json.
ALTER TABLE customers ALTER COLUMN name DROP NOT NULL;

-- ---- B1b: Rule 19, one canonical definition of "scrub PII off an order" /
-- "off a custom-cake request", used by BOTH the customer-initiated deletion
-- path and the retention sweep, and reachable for GUEST records (which have
-- no customer_id, so the old fn_anonymize_customer alone never touched them
-- -- most of this business's customers, per the BRIEF).
CREATE OR REPLACE FUNCTION fn_anonymize_order(p_order_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE orders
  SET guest_name = NULL, guest_phone = NULL, guest_email = NULL,
      delivery_address = NULL, delivery_notes = NULL,
      confirmation_link_revoked_at = COALESCE(confirmation_link_revoked_at, now()),
      pii_purged_at = now()
  WHERE id = p_order_id AND pii_purged_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_anonymize_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_anonymize_order(UUID) TO service_role;
COMMENT ON FUNCTION fn_anonymize_order IS 'Rule 19: the ONE definition of "scrub PII off an order". Called by fn_anonymize_customer (registered path) and directly by fn_run_retention_sweep (guest path, B1b). Leaves delivery_city, amounts, status, dates (accounting retention). Idempotent. Revokes the confirmation link (B5b) in the same call.';

CREATE OR REPLACE FUNCTION fn_anonymize_custom_cake_request(p_request_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE custom_cake_requests
  SET requester_name = NULL, requester_phone = NULL, requester_email = NULL,
      inscription_text = NULL, notes = NULL, decline_reason = NULL,
      pii_purged_at = now()
  WHERE id = p_request_id AND pii_purged_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_anonymize_custom_cake_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_anonymize_custom_cake_request(UUID) TO service_role;

-- fn_anonymize_customer rewritten to call both helpers over EVERY order and
-- request the customer has (B1b), and to log a consent withdrawal if they
-- were opted in (compliance-spec.md: deletion implies withdrawal).
CREATE OR REPLACE FUNCTION fn_anonymize_customer(p_customer_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_was_opted_in BOOLEAN;
  v_order_id UUID;
  v_request_id UUID;
BEGIN
  SELECT marketing_opt_in INTO v_was_opted_in FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE customers
  SET name = NULL, phone = 'purged-' || id::text, email = NULL,
      birthday_day = NULL, birthday_month = NULL, anniversary_day = NULL, anniversary_month = NULL,
      deleted_at = COALESCE(deleted_at, now())
  WHERE id = p_customer_id;

  FOR v_order_id IN SELECT id FROM orders WHERE customer_id = p_customer_id AND pii_purged_at IS NULL LOOP
    PERFORM fn_anonymize_order(v_order_id);
  END LOOP;

  FOR v_request_id IN SELECT id FROM custom_cake_requests WHERE customer_id = p_customer_id AND pii_purged_at IS NULL LOOP
    PERFORM fn_anonymize_custom_cake_request(v_request_id);
  END LOOP;

  IF v_was_opted_in THEN
    INSERT INTO consent_events (customer_id, customer_email_snapshot, purpose, channel, action, consent_version, source)
    VALUES (p_customer_id, NULL, 'marketing', 'email', 'withdrawn', 'n/a-account-deleted', 'account_deletion');
  END IF;

  PERFORM fn_write_audit_log('system', p_customer_id::text, 'customer.anonymized', 'customer', p_customer_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_anonymize_customer IS 'B1b fix: now reaches every order and custom-cake request the customer has, via fn_anonymize_order/fn_anonymize_custom_cake_request (Rule 19). File storage deletion (inspiration photos) still happens via the Storage API in lib/server/, then fn_mark_photos_purged, never a DELETE on storage.objects.';

-- ---- B1b: admin lookup so Yuval can act on a GUEST's access/deletion
-- request (compliance-spec.md section 6, "find by phone").
CREATE OR REPLACE FUNCTION fn_find_guest_records_by_phone(p_phone TEXT)
RETURNS TABLE (kind TEXT, id UUID, order_number TEXT, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  RETURN QUERY
    SELECT 'order'::text, o.id, o.order_number, o.status, o.created_at
    FROM orders o WHERE o.guest_phone = p_phone AND o.pii_purged_at IS NULL
    UNION ALL
    SELECT 'custom_cake_request'::text, r.id, NULL::text, r.status, r.created_at
    FROM custom_cake_requests r WHERE r.requester_phone = p_phone AND r.pii_purged_at IS NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_find_guest_records_by_phone(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_find_guest_records_by_phone(TEXT) TO authenticated;

-- ---- B1c: custom_cake_photos purge, two-step because Storage deletion is
-- an API call, not SQL (compliance-spec.md section 6).
CREATE OR REPLACE FUNCTION fn_photos_due_for_purge() RETURNS TABLE (custom_cake_request_id UUID, storage_path TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT p.custom_cake_request_id, p.storage_path
  FROM custom_cake_photos p
  JOIN custom_cake_requests r ON r.id = p.custom_cake_request_id
  LEFT JOIN orders o ON o.id = r.order_id
  WHERE r.photos_purged_at IS NULL
    AND (
      (r.status = 'declined' AND r.updated_at < now() - ((SELECT (value)::text::int FROM app_settings WHERE key = 'photo_retention_days') || ' days')::interval)
      OR
      (o.id IS NOT NULL AND o.status IN ('fulfilled', 'expired', 'cancelled')
       AND COALESCE(o.fulfilled_at, o.expired_at, o.cancelled_at) < now() - ((SELECT (value)::text::int FROM app_settings WHERE key = 'photo_retention_days') || ' days')::interval)
    );
$$;
REVOKE EXECUTE ON FUNCTION fn_photos_due_for_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_photos_due_for_purge() TO service_role;

CREATE OR REPLACE FUNCTION fn_mark_photos_purged(p_request_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM custom_cake_photos WHERE custom_cake_request_id = p_request_id;
  UPDATE custom_cake_requests SET photos_purged_at = now() WHERE id = p_request_id AND photos_purged_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_mark_photos_purged(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mark_photos_purged(UUID) TO service_role;
COMMENT ON FUNCTION fn_mark_photos_purged IS 'Called ONLY after the Storage API has confirmed the file(s) are deleted (Rule 20).';

-- N10: a direct DELETE via the Data API orphans the Storage object.
REVOKE DELETE ON TABLE custom_cake_photos FROM authenticated;

-- ---- B1d: retention_until was never populated anywhere. Set it on the
-- transition into a terminal state, via trigger (so it happens no matter
-- which function performs the transition).
CREATE OR REPLACE FUNCTION fn_set_order_retention_until() RETURNS TRIGGER AS $$
DECLARE
  v_guest_months INT;
  v_unconsummated_days INT;
BEGIN
  IF NEW.status IN ('fulfilled', 'expired', 'cancelled') AND OLD.status NOT IN ('fulfilled', 'expired', 'cancelled') THEN
    IF NEW.status = 'fulfilled' THEN
      SELECT (value)::text::int INTO v_guest_months FROM app_settings WHERE key = 'guest_pii_months';
      NEW.retention_until := COALESCE(NEW.fulfilled_at, now()) + (v_guest_months || ' months')::interval;
    ELSE
      -- B1d recommendation: an order that never became a real transaction
      -- (expired or cancelled pre-fulfillment) does not need the same
      -- retention as a completed sale, per purpose-limitation. Shorter
      -- default, its own app_settings key, pending Yuval/accountant.
      SELECT (value)::text::int INTO v_unconsummated_days FROM app_settings WHERE key = 'unconsummated_order_pii_days';
      NEW.retention_until := COALESCE(NEW.expired_at, NEW.cancelled_at, now()) + (v_unconsummated_days || ' days')::interval;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_set_retention_until
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_set_order_retention_until();

CREATE OR REPLACE FUNCTION fn_set_custom_cake_retention_until() RETURNS TRIGGER AS $$
DECLARE
  v_days INT;
BEGIN
  IF NEW.status = 'declined' AND OLD.status <> 'declined' THEN
    SELECT (value)::text::int INTO v_days FROM app_settings WHERE key = 'unconsummated_order_pii_days';
    NEW.retention_until := now() + (v_days || ' days')::interval;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_custom_cake_requests_set_retention_until
  BEFORE UPDATE ON custom_cake_requests
  FOR EACH ROW EXECUTE FUNCTION fn_set_custom_cake_retention_until();

CREATE OR REPLACE FUNCTION fn_retention_due() RETURNS TABLE (entity_type TEXT, entity_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'order'::text, id FROM orders WHERE retention_until IS NOT NULL AND retention_until < now() AND pii_purged_at IS NULL
  UNION ALL
  SELECT 'custom_cake_request'::text, id FROM custom_cake_requests WHERE retention_until IS NOT NULL AND retention_until < now() AND pii_purged_at IS NULL
  UNION ALL
  -- Not auto-purged by fn_run_retention_sweep (Storage deletion needs the
  -- application layer, B5b); listed here so nothing forgets to check.
  SELECT 'confirmation_pdf'::text, id FROM orders WHERE confirmation_pdf_path IS NOT NULL AND confirmation_pdf_purged_at IS NULL AND pii_purged_at IS NOT NULL;
$$;
REVOKE EXECUTE ON FUNCTION fn_retention_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_retention_due() TO service_role;

CREATE OR REPLACE FUNCTION fn_run_retention_sweep() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  v_orders_purged INT := 0;
  v_requests_purged INT := 0;
BEGIN
  FOR r IN SELECT * FROM fn_retention_due() WHERE entity_type = 'order' LOOP
    IF fn_anonymize_order(r.entity_id) THEN v_orders_purged := v_orders_purged + 1; END IF;
  END LOOP;
  FOR r IN SELECT * FROM fn_retention_due() WHERE entity_type = 'custom_cake_request' LOOP
    IF fn_anonymize_custom_cake_request(r.entity_id) THEN v_requests_purged := v_requests_purged + 1; END IF;
  END LOOP;

  UPDATE cron_heartbeats SET last_run_at = now(), last_success_at = now(), last_error = NULL WHERE job_name = 'retention_sweep';
  RETURN jsonb_build_object('orders_purged', v_orders_purged, 'custom_cake_requests_purged', v_requests_purged);
EXCEPTION WHEN OTHERS THEN
  UPDATE cron_heartbeats SET last_run_at = now(), last_error = SQLERRM WHERE job_name = 'retention_sweep';
  RAISE;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_run_retention_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_run_retention_sweep() TO service_role;

INSERT INTO cron_heartbeats (job_name) VALUES ('retention_sweep') ON CONFLICT DO NOTHING;

-- ---- B2: the FK + ON DELETE SET NULL on consent_events.customer_id made
-- Postgres run an UPDATE on every referencing row when a customer was
-- deleted, which trg_consent_events_append_only then rejected outright.
-- Reproduced in the throwaway container before this fix (see DB-PLAN.md).
-- Fix: no FK at all, matching what the spec actually asked for ("an
-- identifier + email stays as evidence") -- the FK's SET NULL would have
-- destroyed the identifier anyway, even if it had not also broken the
-- trigger.
ALTER TABLE consent_events DROP CONSTRAINT consent_events_customer_id_fkey;
COMMENT ON COLUMN consent_events.customer_id IS 'B2 fix (rotem review, reproduced 2026-09-25): evidence ref, no FK on purpose. Kept after customer deletion per compliance-spec.md section 3. The former FK + ON DELETE SET NULL triggered the append-only guard on every registered-customer deletion that had ever touched consent.';

ALTER TABLE privacy_requests DROP CONSTRAINT privacy_requests_customer_id_fkey;
COMMENT ON COLUMN privacy_requests.customer_id IS 'B2 fix: evidence ref, no FK, same reasoning as consent_events.customer_id -- the request record keeps its link even after the customer row is gone.';

CREATE OR REPLACE FUNCTION fn_hard_delete_customer(p_customer_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (auth.uid() = p_customer_id OR is_admin_aal2() OR current_user = 'service_role') THEN
    RAISE EXCEPTION 'not_authorized_to_delete_this_customer';
  END IF;
  -- B2: anonymize FIRST (orders/requests keep their now-scrubbed rows and
  -- financial history), THEN delete auth.users (cascades to customers).
  -- The reverse order would delete the customer row first and leave live
  -- guest-shaped PII on their orders with nothing left to anonymize through.
  PERFORM fn_anonymize_customer(p_customer_id);
  DELETE FROM auth.users WHERE id = p_customer_id;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_hard_delete_customer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_hard_delete_customer(UUID) TO authenticated, service_role;
COMMENT ON FUNCTION fn_hard_delete_customer IS 'B2: the one correct order of operations. This is the contract jordan''s DELETE /api/me route must call, documented in DB-PLAN.md, never reimplemented client-side.';

CREATE OR REPLACE FUNCTION fn_customers_due_for_hard_delete() RETURNS TABLE (customer_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM customers WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days';
$$;
REVOKE EXECUTE ON FUNCTION fn_customers_due_for_hard_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_customers_due_for_hard_delete() TO service_role;

-- ---- B3a: fn_set_marketing_consent trusted p_customer_id with no
-- ownership check at all, and any string as consent_version/source.
ALTER TABLE consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('registration', 'profile', 'unsubscribe_link', 'admin_on_request', 'account_deletion'));

CREATE OR REPLACE FUNCTION fn_set_marketing_consent(
  p_customer_id UUID, p_action TEXT, p_consent_version TEXT, p_source TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_active_version TEXT;
BEGIN
  IF p_action NOT IN ('granted', 'withdrawn') THEN
    RAISE EXCEPTION 'invalid_consent_action';
  END IF;

  -- B3a: nobody sets consent for someone else, except an AAL2 admin acting
  -- on a phone request (source admin_on_request), or service_role via the
  -- dedicated unsubscribe path (fn_unsubscribe_by_token, never this
  -- function directly, and only ever to withdraw).
  IF NOT (p_customer_id = auth.uid() OR is_admin_aal2() OR current_user = 'service_role') THEN
    RAISE EXCEPTION 'consent_not_own';
  END IF;
  IF p_source = 'admin_on_request' AND NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_on_request_requires_admin';
  END IF;
  IF p_source = 'unsubscribe_link' THEN
    RAISE EXCEPTION 'unsubscribe_link_source_is_service_role_only_via_fn_unsubscribe_by_token';
  END IF;
  IF p_action = 'granted' THEN
    -- B3a: consent must be to the notice version actually shown, not any
    -- string the caller supplies.
    SELECT value #>> '{}' INTO v_active_version FROM app_settings WHERE key = 'active_marketing_consent_version';
    IF v_active_version IS NULL OR p_consent_version IS DISTINCT FROM v_active_version THEN
      RAISE EXCEPTION 'consent_version_mismatch';
    END IF;
  END IF;

  SELECT email INTO v_email FROM customers WHERE id = p_customer_id;

  UPDATE customers
  SET marketing_opt_in = (p_action = 'granted'),
      marketing_consent_version = p_consent_version,
      marketing_opt_in_at = CASE WHEN p_action = 'granted' THEN now() ELSE marketing_opt_in_at END,
      marketing_opt_out_at = CASE WHEN p_action = 'withdrawn' THEN now() ELSE marketing_opt_out_at END,
      -- compliance-spec.md section 3: birthday/anniversary have no purpose
      -- once marketing consent is withdrawn.
      birthday_day = CASE WHEN p_action = 'withdrawn' THEN NULL ELSE birthday_day END,
      birthday_month = CASE WHEN p_action = 'withdrawn' THEN NULL ELSE birthday_month END,
      anniversary_day = CASE WHEN p_action = 'withdrawn' THEN NULL ELSE anniversary_day END,
      anniversary_month = CASE WHEN p_action = 'withdrawn' THEN NULL ELSE anniversary_month END
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO consent_events (customer_id, customer_email_snapshot, purpose, channel, action, consent_version, source)
  VALUES (p_customer_id, v_email, 'marketing', 'email', p_action, p_consent_version, p_source);

  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_set_marketing_consent(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_set_marketing_consent(UUID, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION fn_unsubscribe_by_token(p_token TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer_id UUID;
  v_email TEXT;
  v_version TEXT;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'fn_unsubscribe_by_token is service_role only (called from the unauthenticated /unsubscribe route using the service key)';
  END IF;
  SELECT id, email, marketing_consent_version INTO v_customer_id, v_email, v_version
  FROM customers WHERE unsubscribe_token = p_token;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE customers
  SET marketing_opt_in = false, marketing_opt_out_at = now(),
      birthday_day = NULL, birthday_month = NULL, anniversary_day = NULL, anniversary_month = NULL
  WHERE id = v_customer_id;
  INSERT INTO consent_events (customer_id, customer_email_snapshot, purpose, channel, action, consent_version, source)
  VALUES (v_customer_id, v_email, 'marketing', 'email', 'withdrawn', COALESCE(v_version, 'n/a'), 'unsubscribe_link');
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_unsubscribe_by_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_unsubscribe_by_token(TEXT) TO service_role;

-- ---- B3b: column-level grant, RLS's own-row policy is not what was
-- leaking here, the blanket table GRANT UPDATE was.
REVOKE UPDATE ON TABLE customers FROM authenticated;
GRANT UPDATE (name, phone, email, birthday_day, birthday_month, anniversary_day, anniversary_month) ON customers TO authenticated;

-- ---- B4a: order_attempt_log purge, same shape as fn_purge_old_lookup_attempts.
CREATE OR REPLACE FUNCTION fn_purge_old_order_attempts() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_days INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_attempts_retention_days');
  v_count INT;
BEGIN
  IF v_days IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: order_attempts_retention_days'; -- N6
  END IF;
  DELETE FROM order_attempt_log WHERE created_at < now() - (v_days || ' days')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_purge_old_order_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_purge_old_order_attempts() TO service_role;

-- N6 applied to the sibling purge function too: a missing setting silently
-- deleting zero rows forever is a Rule 20 violation, not a safe no-op.
CREATE OR REPLACE FUNCTION fn_purge_old_lookup_attempts() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_days INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_retention_days');
  v_count INT;
BEGIN
  IF v_days IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: order_lookup_attempts_retention_days';
  END IF;
  DELETE FROM order_lookup_attempts WHERE created_at < now() - (v_days || ' days')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
-- signature unchanged: ACL (service_role) persists.

-- ---- B4b: audit_log stopped taking the raw checkout IP (it already lives
-- in order_attempt_log with its own retention, B4a); the trigger now allows
-- DELETE only under an explicit retention_purge flag, so a real purge
-- function is possible without making the table mutable to any app role.
CREATE OR REPLACE FUNCTION forbid_mutation_unless_retention_purge() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.retention_purge', true), '') = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append_only_table: % on % is not permitted', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_unless_retention_purge();
COMMENT ON TRIGGER trg_audit_log_append_only ON audit_log IS 'B4b: DELETE allowed ONLY when app.retention_purge=true for the statement, set solely by fn_purge_old_audit_log (service_role). consent_events keeps the strict forbid_mutation() (no purge path exists for it yet, N3 deferred).';

CREATE OR REPLACE FUNCTION fn_purge_old_audit_log() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_years INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'audit_log_retention_years');
  v_count INT;
BEGIN
  IF v_years IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: audit_log_retention_years';
  END IF;
  PERFORM set_config('app.retention_purge', 'true', true);
  DELETE FROM audit_log WHERE created_at < now() - (v_years || ' years')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_purge_old_audit_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_purge_old_audit_log() TO service_role;

-- ---- N1: a birthday day with no month (or vice versa) is data with no
-- purpose (compliance-spec.md's own purpose-limitation reasoning, applied
-- to the pairing itself).
ALTER TABLE customers ADD CONSTRAINT customers_birthday_pair CHECK ((birthday_day IS NULL) = (birthday_month IS NULL));
ALTER TABLE customers ADD CONSTRAINT customers_anniversary_pair CHECK ((anniversary_day IS NULL) = (anniversary_month IS NULL));

-- ---- N7 + section 2 note 2: an anonymized order must stop being
-- findable, and the checkout audit log must stop carrying a raw IP.
CREATE OR REPLACE FUNCTION fn_lookup_order_by_phone_and_number(
  p_ip_address TEXT, p_phone TEXT, p_order_number TEXT
) RETURNS TABLE (
  order_number TEXT, status TEXT, delivery_date DATE, fulfillment_type TEXT, masked_address TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ip_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_per_ip_per_hour');
  v_phone_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_per_phone_per_hour');
  v_ip_attempts INT;
  v_phone_attempts INT;
  v_order orders%ROWTYPE;
  v_found BOOLEAN;
BEGIN
  SELECT count(*) INTO v_ip_attempts FROM order_lookup_attempts
  WHERE ip_address = p_ip_address AND created_at > now() - interval '1 hour';
  SELECT count(*) INTO v_phone_attempts FROM order_lookup_attempts
  WHERE phone_e164 = p_phone AND created_at > now() - interval '1 hour';

  IF v_ip_attempts >= v_ip_limit OR v_phone_attempts >= v_phone_limit THEN
    INSERT INTO order_lookup_attempts (ip_address, phone_e164, order_number_tried, matched)
    VALUES (p_ip_address, p_phone, p_order_number, false);
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  SELECT o.* INTO v_order FROM orders o
  WHERE o.order_number = upper(p_order_number)
    AND o.pii_purged_at IS NULL -- N7: an anonymized order is no longer findable
    AND (o.guest_phone = p_phone
         OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.phone = p_phone))
  LIMIT 1;
  v_found := FOUND;

  INSERT INTO order_lookup_attempts (ip_address, phone_e164, order_number_tried, matched)
  VALUES (p_ip_address, p_phone, p_order_number, v_found);

  IF NOT v_found THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_order.order_number, v_order.status, v_order.delivery_date, v_order.fulfillment_type,
    CASE WHEN v_order.delivery_address IS NOT NULL
         THEN v_order.delivery_city || ', ' || left(v_order.delivery_address, 1) || '***'
         ELSE NULL END;
END;
$$;
-- signature unchanged: ACL (anon, authenticated) persists.

-- ---- N13: expired push subscriptions should not accumulate forever.
CREATE OR REPLACE FUNCTION fn_purge_old_push_subscriptions() RETURNS INT
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH deleted AS (
    DELETE FROM push_subscriptions WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days'
    RETURNING 1
  ) SELECT count(*)::int FROM deleted;
$$;
REVOKE EXECUTE ON FUNCTION fn_purge_old_push_subscriptions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_purge_old_push_subscriptions() TO service_role;

-- ---- Missing app_settings keys (compliance-schema-review.md section 5),
-- plus the marketing-consent-version key B3a needs.
INSERT INTO app_settings (key, value, description) VALUES
  ('order_attempts_retention_days', '30', 'B4a.'),
  ('unconsummated_order_pii_days', '90', 'B1d, pending Yuval/accountant confirmation (compliance-spec.md section 13 question 1).'),
  ('audit_log_retention_years', '7', 'B4b, pending accountant confirmation.'),
  ('consent_evidence_retention_years', '7', 'N3 (purge function deferred, see migration footer), pending legal advice.'),
  ('privacy_requests_retention_years', '3', 'N4 (retention_until population deferred, see migration footer).'),
  ('active_marketing_consent_version', '"marketing-2026-10-v1"', 'B3a: fn_set_marketing_consent rejects a granted action whose version does not match this exactly.')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ============================================================
-- Explicitly DEFERRED from compliance-schema-review.md (not applied here,
-- listed so nobody assumes they were):
-- N2 (inactivity notice/delete for 36-month-dormant profiles): needs its
--   own notice-sending flow (email), not just a DB column; out of scope for
--   a schema-only fix pass.
-- N3 (consent_events.customer_email_snapshot purge after 7 years from last
--   withdrawal): app_settings key added above, the actual purge function is
--   not, because it needs a "last withdrawal per customer" query rotem's
--   note flags as still needing the exact legal retention period confirmed.
-- N4 (privacy_requests.retention_until population + purge): same shape as
--   N3, same reason: the key is seeded, the trigger/sweep is not.
-- N5 (hash phone/ip in order_attempt_log / order_lookup_attempts instead of
--   raw values): touches every caller of both rate-limit paths and the
--   uniqueness semantics of the rate-limit query itself (hash equality
--   still works for exact-match rate limiting, but changes what the
--   function signature accepts); left as a follow-up, not bundled into an
--   already-large fix migration.
-- N8/N9 (delivery_list_links rename to token_hash + Phase 2 serving
--   function): rotem's own note says this needs maya/erez to decide the
--   MVP-vs-Phase-2 question (PRD US-7 vs threat-model SEC-016 disagree on
--   whether a link ships in MVP at all); a schema rename ahead of that
--   product decision would likely need to be redone.
-- N11 (app_settings floor/ceiling trigger on retention keys): genuinely
--   cheap, deferred only because it was not exercised by any test in this
--   round; flag to pick up in the next pass over app_settings.
-- Also NOT done: fn_create_standard_order's rejected-attempt-loses-evidence
-- behavior (section 6 item 3) -- a conscious accepted trade-off per rotem's
-- own framing ("worth a conscious decision"), not a bug.
-- ============================================================

-- ============================================================
-- PART D: fix found WHILE testing Part B (not in any review doc): the
-- blanket "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC /
-- anon / authenticated" in 20260925120800 ran AFTER is_admin()/has_aal2()/
-- is_admin_aal2() were created, and no GRANT ever restored their execute
-- privilege. Every RLS policy that calls is_admin_aal2() (most of them)
-- would raise "permission denied for function is_admin_aal2" for a real
-- anon/authenticated caller, not just an attacker -- this broke ordinary
-- reads/writes for every real user, caught only by actually running a query
-- as `authenticated` rather than as postgres. Fixed here.
-- ============================================================

BEGIN;

GRANT EXECUTE ON FUNCTION is_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION has_aal2() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION is_admin_aal2() TO anon, authenticated;

COMMIT;
