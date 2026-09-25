-- Migration: 20260926070100_delivery_list
-- DDD context: Delivery. Task: api-008 (US-7), SEC-016, SEC-017.
--
-- fn_admin_delivery_list(day): the delivery list for one day, for Yuval to
-- print or save as PDF and hand to the courier (her uncle). One call builds
-- the list AND writes the audit row, so no list leaves the system unlogged.
--
-- Minimization (threat-model.md 3.6, compliance-spec.md section 7): per stop
-- only recipient name, phone, address, city, time window and delivery notes.
-- No email, items, prices, inscription, order number or other days. The
-- order number is left out on purpose: with the phone it opens the order
-- (find-my-order, US-0d), which would show the courier items and prices.
--
-- Which orders: fulfillment_type = 'delivery', status = 'paid', that day.
-- payment_pending orders are NOT listed (safe default: an unpaid order may
-- still expire). Their count is returned, without PII, so the screen can say
-- how many are waiting. Listing them, marked, is Yuval's call (flagged).
-- Nothing is stored: the list is built at call time (compliance-spec 12).
-- No capacity or money is read or written.

BEGIN;

CREATE OR REPLACE FUNCTION fn_admin_delivery_list(p_day DATE) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_stops JSONB;
  v_pending INT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'delivery_list_invalid_day';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'name', COALESCE(o.guest_name, c.name),
           'phone', COALESCE(o.guest_phone, c.phone),
           'address', o.delivery_address,
           'city', o.delivery_city,
           'time_window', o.delivery_time_window,
           'notes', o.delivery_notes)
         ORDER BY o.delivery_time_window NULLS LAST, o.delivery_city, o.delivery_address, o.created_at), '[]'::jsonb)
  INTO v_stops
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
  WHERE o.delivery_date = p_day AND o.fulfillment_type = 'delivery' AND o.status = 'paid';

  SELECT count(*) INTO v_pending FROM orders
  WHERE delivery_date = p_day AND fulfillment_type = 'delivery' AND status = 'payment_pending';

  -- SEC-017: who generated which day's list, and how big it was. No PII.
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'delivery_list.generated', 'delivery_list', p_day::text,
    jsonb_build_object('stop_count', jsonb_array_length(v_stops), 'pending_count', v_pending));

  RETURN jsonb_build_object('day', p_day, 'stops', v_stops, 'pending_count', v_pending);
END;
$$;

-- Sorts before 20260926090000, so revoke explicitly (see 20260926070000).
REVOKE EXECUTE ON FUNCTION fn_admin_delivery_list(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_delivery_list(DATE) TO authenticated;

COMMIT;
