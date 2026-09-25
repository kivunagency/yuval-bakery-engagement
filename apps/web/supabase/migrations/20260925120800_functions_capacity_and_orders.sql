-- Migration: 20260925120800_functions_capacity_and_orders
-- DDD context: Capacity + Ordering + CustomCake (the cross-context write
-- surface). This is where ADR-002's mechanism and the SEC-007 fix live.
--
-- SEC-007 FIX, stated once here (see DB-PLAN.md for the full writeup):
-- ADR-002's original release used GREATEST(0, reserved - cost), which stops
-- a double release from going NEGATIVE but does NOT stop a double release
-- from happening: a retried sweep or a race between cancel and expire could
-- still decrement twice, freeing capacity a second order legitimately holds
-- and causing overbooking. The fix makes release idempotent by gating it on
-- the ORDER's own state transition, not on the ledger arithmetic:
--   UPDATE orders SET status = :new_status
--   WHERE id = :order_id AND status = 'payment_pending'
--   RETURNING *;
-- Only if this returns a row (i.e. this call is the one that actually moved
-- the order out of payment_pending) does the function touch
-- capacity_day_ledger at all, decrementing by exactly the snapshot cost
-- stored on that order row. A second caller (retried sweep, concurrent
-- cancel+expire) finds 0 rows, does nothing, and returns released = false.
-- Exactly one release per order, structurally, not by convention.

BEGIN;

-- ============================================================
-- Internal helpers
-- ============================================================

CREATE OR REPLACE FUNCTION fn_hash_token(p_token TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_token, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION fn_write_audit_log(
  p_actor_type TEXT, p_actor_id TEXT, p_action TEXT,
  p_entity_type TEXT, p_entity_id TEXT, p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id, p_metadata);
END;
$$;

CREATE OR REPLACE FUNCTION fn_generate_order_number() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I/L, threat-model.md 3.3
  v_candidate TEXT;
  v_exists BOOLEAN;
  v_attempt INT := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    v_candidate := 'A' || (
      SELECT string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1), '')
      FROM generate_series(1, 3)
    ) || '-' || (
      SELECT string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1), '')
      FROM generate_series(1, 3)
    );
    SELECT EXISTS (SELECT 1 FROM orders WHERE order_number = v_candidate) INTO v_exists;
    EXIT WHEN NOT v_exists OR v_attempt > 8;
  END LOOP;
  IF v_exists THEN
    RAISE EXCEPTION 'order_number_generation_exhausted';
  END IF;
  RETURN v_candidate;
END;
$$;

-- Guard: orders.status may only change via functions in this file, so
-- SEC-017's audit trail can never be silently bypassed by a plain UPDATE.
CREATE OR REPLACE FUNCTION fn_guard_order_status_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('app.allow_status_change', true), '') != 'true' THEN
    RAISE EXCEPTION 'orders.status may only change via a capacity/ordering function, not a direct UPDATE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_guard_status_change
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_guard_order_status_change();

-- ============================================================
-- Capacity: reserve (ADR-002, unchanged mechanism)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_reserve_capacity(
  p_day DATE, p_oven_minutes INT, p_work_minutes INT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row RECORD;
BEGIN
  UPDATE capacity_day_ledger
  SET oven_minutes_reserved = oven_minutes_reserved + p_oven_minutes,
      work_minutes_reserved = work_minutes_reserved + p_work_minutes
  WHERE day = p_day
    AND is_blackout = false
    AND oven_minutes_reserved + p_oven_minutes <= oven_minutes_total
    AND work_minutes_reserved + p_work_minutes <= work_minutes_total
  RETURNING day INTO v_row;

  RETURN FOUND;
END;
$$;
COMMENT ON FUNCTION fn_reserve_capacity IS 'ADR-002 mechanism. Single conditional UPDATE...WHERE...RETURNING, atomic without an explicit row lock. Called only from fn_create_standard_order / fn_approve_custom_cake_request, inside their transaction.';

-- ============================================================
-- Capacity: release (SEC-007 fix)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_release_order_capacity(
  p_order_id UUID, p_new_status TEXT, p_actor_type TEXT DEFAULT 'system', p_actor_id TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF p_new_status NOT IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION 'fn_release_order_capacity only accepts expired or cancelled, got %', p_new_status;
  END IF;

  PERFORM set_config('app.allow_status_change', 'true', true);

  -- The idempotency guard: this UPDATE can succeed at most once per order,
  -- because the second caller's WHERE status = 'payment_pending' matches no
  -- row (SEC-007 fix, see the top-of-file comment).
  UPDATE orders
  SET status = p_new_status,
      cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE cancelled_at END,
      expired_at = CASE WHEN p_new_status = 'expired' THEN now() ELSE expired_at END
  WHERE id = p_order_id AND status = 'payment_pending'
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RETURN false; -- already released (or never payment_pending): no-op, idempotent
  END IF;

  UPDATE capacity_day_ledger
  SET oven_minutes_reserved = oven_minutes_reserved - v_order.oven_minutes_cost,
      work_minutes_reserved = work_minutes_reserved - v_order.work_minutes_cost
  WHERE day = v_order.delivery_date;
  -- No GREATEST(0, ...) here on purpose: because release is now gated by the
  -- orders.status transition above and each order's snapshot cost is exact,
  -- this can never go negative under correct operation. If it somehow did,
  -- the CHECK constraint on capacity_day_ledger aborts the transaction
  -- loudly (Rule 20: fail loud, not silently-clamped-to-zero).

  PERFORM fn_write_audit_log(p_actor_type, p_actor_id, 'order.' || p_new_status,
    'order', p_order_id::text, jsonb_build_object('delivery_date', v_order.delivery_date));

  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_release_order_capacity IS 'SEC-007 fix. Idempotent by construction: the guarded UPDATE...WHERE status=''payment_pending'' can match at most once per order. Called by the job-001 sweep (fn_expire_stale_orders) and by admin cancel.';

-- ============================================================
-- job-001: expiry sweep (heartbeat + idempotent per-order release)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_expire_stale_orders() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order_id UUID;
  v_count INT := 0;
BEGIN
  FOR v_order_id IN
    SELECT id FROM orders
    WHERE status = 'payment_pending' AND payment_pending_expires_at < now()
  LOOP
    IF fn_release_order_capacity(v_order_id, 'expired', 'system', 'cron:job-001') THEN
      v_count := v_count + 1;
    END IF;
    -- If it returns false, another concurrent sweep/cancel already moved this
    -- order out of payment_pending: correctly not double-counted, not an error.
  END LOOP;

  UPDATE cron_heartbeats
  SET last_run_at = now(), last_success_at = now(), last_error = NULL
  WHERE job_name = 'expire_payment_pending_orders';

  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  UPDATE cron_heartbeats
  SET last_run_at = now(), last_error = SQLERRM
  WHERE job_name = 'expire_payment_pending_orders';
  RAISE;
END;
$$;
COMMENT ON FUNCTION fn_expire_stale_orders IS 'job-001. Safe to run concurrently or be retried: each order releases at most once (fn_release_order_capacity). Writes cron_heartbeats every run whether it finds work or not, so a stopped scheduler is visible within 45 minutes (threat-model.md section 2.9).';

CREATE OR REPLACE FUNCTION fn_cancel_order(p_order_id UUID, p_admin_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_cancel_order: % is not an admin', p_admin_id;
  END IF;
  RETURN fn_release_order_capacity(p_order_id, 'cancelled', 'admin', p_admin_id::text);
END;
$$;

-- ============================================================
-- Order creation (SEC-005 rate limits, SEC-008 server-priced, ADR-002 atomic)
-- ============================================================

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

  -- SEC-005 step 1: fail-closed rate-limit evidence, same transaction.
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

  -- SEC-008: price and minute-cost come ONLY from products, never from the
  -- caller's payload, no matter what the client-supplied p_items carries.
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

  -- SEC-005 step 3/4: single-order and day-wide unpaid-hold caps, read live
  -- (not from a frozen snapshot) so a hold added after this check started is
  -- still counted correctly.
  SELECT * INTO v_ledger FROM capacity_day_ledger WHERE day = p_delivery_date;
  IF NOT FOUND OR v_ledger.is_blackout THEN
    RAISE EXCEPTION 'day_unavailable';
  END IF;
  IF v_oven_total > v_ledger.oven_minutes_total * v_single_order_pct / 100
     OR v_work_total > v_ledger.work_minutes_total * v_single_order_pct / 100 THEN
    RAISE EXCEPTION 'single_order_capacity_cap_exceeded';
  END IF;
  IF (v_ledger.oven_minutes_reserved + v_oven_total) > v_ledger.oven_minutes_total * v_unpaid_pct / 100
     OR (v_ledger.work_minutes_reserved + v_work_total) > v_ledger.work_minutes_total * v_unpaid_pct / 100 THEN
    RAISE EXCEPTION 'unpaid_holds_capacity_cap_exceeded';
  END IF;

  IF NOT fn_reserve_capacity(p_delivery_date, v_oven_total, v_work_total) THEN
    RAISE EXCEPTION 'capacity_reservation_failed'; -- lost the race, whole transaction rolls back (ADR-002)
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

  PERFORM fn_write_audit_log('system', p_ip_address, 'order.created', 'order', v_order.id::text, '{}'::jsonb);

  RETURN v_order;
END;
$$;
COMMENT ON FUNCTION fn_create_standard_order IS 'SEC-005/SEC-008/ADR-002 in one transaction: rate-limit check, server-priced totals, single-order and unpaid-holds caps, atomic fn_reserve_capacity, order+items insert. Any RAISE EXCEPTION rolls back the whole transaction, never a partial order (ADR-002 scope note).';

-- ============================================================
-- Custom cake approve/decline (the documented cross-context write)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_approve_custom_cake_request(
  p_request_id UUID, p_admin_id UUID,
  p_price NUMERIC, p_oven_minutes INT, p_work_minutes INT,
  p_lookup_token TEXT, p_privacy_notice_version TEXT, p_terms_version TEXT, p_cancellation_notice_version TEXT
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req custom_cake_requests%ROWTYPE;
  v_expiry_hours NUMERIC := (SELECT (value)::text::numeric FROM app_settings WHERE key = 'payment_pending_expiry_hours_custom_cake');
  v_order orders%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_approve_custom_cake_request: % is not an admin', p_admin_id;
  END IF;

  SELECT * INTO v_req FROM custom_cake_requests WHERE id = p_request_id AND status = 'pending_review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom_cake_request_not_pending';
  END IF;

  -- PRD US-2 AC: "never a silent overbook". If capacity vanished since the
  -- request was opened for review, this fails and the whole approve
  -- transaction rolls back; the admin UI is told to re-check (ADR-002).
  IF NOT fn_reserve_capacity(v_req.desired_date, p_oven_minutes, p_work_minutes) THEN
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

  PERFORM fn_write_audit_log('admin', p_admin_id::text, 'custom_cake.approved', 'custom_cake_request', p_request_id::text,
    jsonb_build_object('order_id', v_order.id));

  RETURN v_order;
END;
$$;
COMMENT ON FUNCTION fn_approve_custom_cake_request IS 'The cross-context write domain-map.md section 2 documents: CustomCake creates an Ordering aggregate and reserves Capacity in the SAME transaction. Fulfillment defaults to pickup here; delivery details are collected in a follow-up admin edit per PRD (custom cakes are reviewed manually, not self-checkout).';

CREATE OR REPLACE FUNCTION fn_decline_custom_cake_request(p_request_id UUID, p_admin_id UUID, p_reason TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_decline_custom_cake_request: % is not an admin', p_admin_id;
  END IF;
  UPDATE custom_cake_requests SET status = 'declined', decline_reason = p_reason
  WHERE id = p_request_id AND status = 'pending_review';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', p_admin_id::text, 'custom_cake.declined', 'custom_cake_request', p_request_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION fn_mark_order_paid(p_order_id UUID, p_admin_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_mark_order_paid: % is not an admin', p_admin_id;
  END IF;
  PERFORM set_config('app.allow_status_change', 'true', true);
  UPDATE orders SET status = 'paid', paid_at = now()
  WHERE id = p_order_id AND status = 'payment_pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', p_admin_id::text, 'order.marked_paid', 'order', p_order_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION fn_admin_set_day_capacity(
  p_admin_id UUID, p_day DATE, p_oven_minutes_total INT, p_work_minutes_total INT, p_is_blackout BOOLEAN
) RETURNS capacity_day_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row capacity_day_ledger%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_admin_set_day_capacity: % is not an admin', p_admin_id;
  END IF;
  INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout)
  VALUES (p_day, p_oven_minutes_total, p_work_minutes_total, p_is_blackout)
  ON CONFLICT (day) DO UPDATE
    SET oven_minutes_total = EXCLUDED.oven_minutes_total,
        work_minutes_total = EXCLUDED.work_minutes_total,
        is_blackout = EXCLUDED.is_blackout
  RETURNING * INTO v_row;
  -- The CHECK constraints (reserved <= total) fire here too: shrinking a
  -- day's total below what is already reserved aborts, on purpose.
  PERFORM fn_write_audit_log('admin', p_admin_id::text, 'capacity.day_updated', 'capacity_day_ledger', p_day::text,
    jsonb_build_object('oven_minutes_total', p_oven_minutes_total, 'work_minutes_total', p_work_minutes_total, 'is_blackout', p_is_blackout));
  RETURN v_row;
END;
$$;

-- ============================================================
-- Consent (s.30A) and anonymization (Rule 19: one shared definition)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_marketing_consent(
  p_customer_id UUID, p_action TEXT, p_consent_version TEXT, p_source TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
BEGIN
  IF p_action NOT IN ('granted', 'withdrawn') THEN
    RAISE EXCEPTION 'invalid_consent_action';
  END IF;
  SELECT email INTO v_email FROM customers WHERE id = p_customer_id;

  UPDATE customers
  SET marketing_opt_in = (p_action = 'granted'),
      marketing_consent_version = p_consent_version,
      marketing_opt_in_at = CASE WHEN p_action = 'granted' THEN now() ELSE marketing_opt_in_at END,
      marketing_opt_out_at = CASE WHEN p_action = 'withdrawn' THEN now() ELSE marketing_opt_out_at END
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO consent_events (customer_id, customer_email_snapshot, purpose, channel, action, consent_version, source)
  VALUES (p_customer_id, v_email, 'marketing', 'email', p_action, p_consent_version, p_source);

  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_set_marketing_consent IS 'compliance-spec.md section 5: the ONLY writer of customers.marketing_opt_in. The send-query gate reads consent_events (the append-only log), never this derived flag, so a customer withdrawn a minute ago is provably excluded.';

-- Rule 19/24: one canonical anonymization function, used by BOTH the
-- retention sweep (SEC-028) and the customer-initiated deletion request
-- (compliance-spec.md section 6), never two copies of "how do we scrub PII".
CREATE OR REPLACE FUNCTION fn_anonymize_customer(p_customer_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE customers
  SET name = 'נמחק', phone = 'purged-' || id::text, email = NULL,
      birthday_day = NULL, birthday_month = NULL, anniversary_day = NULL, anniversary_month = NULL,
      deleted_at = COALESCE(deleted_at, now())
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE orders
  SET guest_name = CASE WHEN guest_name IS NOT NULL THEN 'נמחק' ELSE NULL END,
      guest_phone = CASE WHEN guest_phone IS NOT NULL THEN 'purged' ELSE NULL END,
      guest_email = NULL, delivery_address = NULL, delivery_notes = NULL,
      pii_purged_at = now()
  WHERE customer_id = p_customer_id AND pii_purged_at IS NULL;
  -- financial fields (subtotal_displayed, total_displayed, status, dates) are
  -- deliberately left untouched: compliance-spec.md section 3 keeps them for
  -- the accounting retention period after identifying fields are gone.

  PERFORM fn_write_audit_log('system', p_customer_id::text, 'customer.anonymized', 'customer', p_customer_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_anonymize_customer IS 'Rule 19: single canonical definition of "scrub this customer''s PII", called by both the deletion-request handler and the retention sweep. File storage deletion (inspiration photos) happens in lib/server/identity/anonymize.ts via the Storage API, not here, per compliance-spec.md section 6 (a DELETE on storage.objects would orphan the file).';

-- ============================================================
-- US-0c: confirmation delivery guard + fulfillment + PDF recording
-- ============================================================

-- Defense in depth alongside fn_mark_order_fulfilled below: even a direct
-- admin UPDATE (allowed by RLS for admin rows) cannot flip status to
-- 'fulfilled' for an order with no known email until confirmation_delivered_at
-- is set. "No known email" = no guest_email AND (no customer_id OR that
-- customer has no email on file).
CREATE OR REPLACE FUNCTION fn_guard_order_fulfillment() RETURNS TRIGGER AS $$
DECLARE
  v_has_email BOOLEAN;
BEGIN
  IF NEW.status = 'fulfilled' AND OLD.status IS DISTINCT FROM 'fulfilled' THEN
    v_has_email := NEW.guest_email IS NOT NULL
      OR (NEW.customer_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.email IS NOT NULL));
    IF NOT v_has_email AND NEW.confirmation_delivered_at IS NULL THEN
      RAISE EXCEPTION 'order_cannot_be_fulfilled_without_confirmation: order % has no email on file and confirmation_delivered_at is null (US-0c)', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_guard_fulfillment
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_guard_order_fulfillment();
COMMENT ON TRIGGER trg_orders_guard_fulfillment ON orders IS 'US-0c (coordinator, 2026-09-25): enforced at the DB layer, not only in app code, per the instruction that accompanied this requirement.';

CREATE OR REPLACE FUNCTION fn_mark_order_fulfilled(p_order_id UUID, p_admin_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'fn_mark_order_fulfilled: % is not an admin', p_admin_id;
  END IF;
  PERFORM set_config('app.allow_status_change', 'true', true);
  UPDATE orders SET status = 'fulfilled', fulfilled_at = now()
  WHERE id = p_order_id AND status = 'paid';
  -- trg_orders_guard_fulfillment fires as part of this UPDATE and raises if
  -- confirmation is missing; the exception propagates and this function's
  -- own change rolls back, so callers see the reason directly.
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', p_admin_id::text, 'order.marked_fulfilled', 'order', p_order_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION fn_record_order_confirmation_delivered(
  p_order_id UUID, p_channel TEXT, p_pdf_path TEXT, p_pdf_sha256 TEXT, p_link_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
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
  WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('system', p_channel, 'order.confirmation_delivered', 'order', p_order_id::text,
    jsonb_build_object('channel', p_channel));
  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_record_order_confirmation_delivered IS 'Called once, right after the confirmation PDF is generated and sent (email automatically, or by the admin after a manual WhatsApp send). The PDF itself is immutable in a private bucket; this just records the fact and hash. confirmation_link_token_hash/expires_at back the >=24 month signed link (CHECK constraint on orders enforces the minimum span).';

-- ============================================================
-- US-0d: find-my-order by phone + order_number, never phone alone
-- ============================================================

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
  -- Fails closed: counted BEFORE this attempt is logged, so the (limit+1)th
  -- try is rejected outright, and every attempt (successful or not) is still
  -- logged for the count to mean anything on the next call.
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
    AND (o.guest_phone = p_phone
         OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.phone = p_phone))
  LIMIT 1;
  v_found := FOUND;

  INSERT INTO order_lookup_attempts (ip_address, phone_e164, order_number_tried, matched)
  VALUES (p_ip_address, p_phone, p_order_number, v_found);

  IF NOT v_found THEN
    RETURN; -- empty result set: identical whether the phone doesn't exist, the
             -- order_number is wrong, or both. Never distinguishes (SEC-003's
             -- uniform-response pattern, applied here to lookup, not just token access).
  END IF;

  RETURN QUERY SELECT
    v_order.order_number, v_order.status, v_order.delivery_date, v_order.fulfillment_type,
    CASE WHEN v_order.delivery_address IS NOT NULL
         THEN v_order.delivery_city || ', ' || left(v_order.delivery_address, 1) || '***'
         ELSE NULL END;
END;
$$;
COMMENT ON FUNCTION fn_lookup_order_by_phone_and_number IS 'US-0d: phone alone is never sufficient, order_number alone is never sufficient, both together are required. masked_address never returns the street number or full address, only city + first character, matching threat-model.md''s "no PII beyond what confirms this is the customer''s own order" posture. Rate-limited per IP and per phone, fails closed (order_lookup_attempts insert happens inside the same transaction as the limit check).';

CREATE OR REPLACE FUNCTION fn_purge_old_lookup_attempts() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_days INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_retention_days');
  v_count INT;
BEGIN
  DELETE FROM order_lookup_attempts WHERE created_at < now() - (v_days || ' days')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION fn_purge_old_lookup_attempts IS 'Called from the same daily retention job as SEC-028. Evidence-only table, 90-day default retention (app_settings), not the 24-month order-confirmation window.';

-- ============================================================
-- Lock down execution (SEC-001): default deny, then name the exceptions.
-- ============================================================
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;

-- Functions genuinely safe to expose over the Data API as RPC. Everything
-- else (fn_reserve_capacity, fn_release_order_capacity, fn_expire_stale_orders,
-- fn_write_audit_log, fn_anonymize_customer, fn_hash_token) stays internal,
-- callable only from other SECURITY DEFINER functions in this file, never
-- directly by anon or authenticated.
GRANT EXECUTE ON FUNCTION fn_create_standard_order TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_set_marketing_consent TO authenticated;
GRANT EXECUTE ON FUNCTION fn_mark_order_paid TO authenticated;
GRANT EXECUTE ON FUNCTION fn_mark_order_fulfilled TO authenticated;
GRANT EXECUTE ON FUNCTION fn_record_order_confirmation_delivered TO authenticated;
GRANT EXECUTE ON FUNCTION fn_cancel_order TO authenticated;
GRANT EXECUTE ON FUNCTION fn_approve_custom_cake_request TO authenticated;
GRANT EXECUTE ON FUNCTION fn_decline_custom_cake_request TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_set_day_capacity TO authenticated;
GRANT EXECUTE ON FUNCTION fn_lookup_order_by_phone_and_number TO anon, authenticated;
-- fn_create_standard_order and fn_lookup_order_by_phone_and_number are
-- granted to anon deliberately: guest checkout and find-my-order both have
-- no session (US-3, US-0d). Every internal admin check inside the other
-- granted functions still re-verifies via the admins table, so a stolen JWT
-- with the wrong role gets an exception from inside the function, not a
-- bypass.

-- Scheduled-job entry points (job-001 and its US-0d sibling). These are
-- called directly by the Netlify Scheduled Function using the service_role
-- key, not from inside another SECURITY DEFINER function, so they need an
-- explicit grant of their own: REVOKE ... FROM PUBLIC above also revokes the
-- default-for-everyone execute right that service_role would otherwise have
-- inherited. Fixed here rather than left as a silent gap.
GRANT EXECUTE ON FUNCTION fn_expire_stale_orders TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_lookup_attempts TO service_role;

COMMIT;
