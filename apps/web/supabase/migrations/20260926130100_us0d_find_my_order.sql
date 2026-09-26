-- 20260926130100_us0d_find_my_order.sql (session L lane 1300xx)
-- US-0d: find my order by phone + order number (DB-PLAN.md section 6).
--
-- fn_lookup_order_by_phone_and_number was granted to anon, so a direct
-- PostgREST call chose its own p_ip_address and the per-IP limit could be
-- skipped by inventing a new "IP" per call (compliance-schema-review.md
-- section 2 note 3). Now it is service_role only: the one caller is
-- POST /api/find-order, which passes the client IP the platform reports
-- (lib/server/http/client-ip.ts). The per-phone limit applies as before.
--
-- The result gains order_id, read by the server only: it builds the
-- confirmation PDF link from it (lib/server/confirmation/link.ts) and never
-- sends the id itself. Everything else is unchanged: both the phone and the
-- order number must match together; a wrong phone and a wrong number give the
-- same empty result; the view is masked; a purged order is not findable (N7).
-- The order number is compared after the same normalization the server does
-- (upper case, spaces removed), so "a2y7 ycp" finds A2Y7-YCP.
--
-- Caller: app/api/find-order/route.ts via lib/server/ordering/find-order.ts.
-- No other caller in the app (the function was not called before this task).

DROP FUNCTION fn_lookup_order_by_phone_and_number(TEXT, TEXT, TEXT);

CREATE FUNCTION fn_lookup_order_by_phone_and_number(p_ip_address TEXT, p_phone TEXT, p_order_number TEXT)
RETURNS TABLE (order_id UUID, order_number TEXT, status TEXT, delivery_date DATE, fulfillment_type TEXT, masked_address TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_ip_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_per_ip_per_hour');
  v_phone_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_lookup_attempts_per_phone_per_hour');
  v_ip_attempts INT;
  v_phone_attempts INT;
  v_number TEXT := upper(regexp_replace(coalesce(p_order_number, ''), '\s', '', 'g'));
  v_order orders%ROWTYPE;
  v_found BOOLEAN;
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF v_ip_limit IS NULL OR v_phone_limit IS NULL THEN
    RAISE EXCEPTION 'rate_limit_exceeded'; -- fails closed without its settings
  END IF;

  SELECT count(*) INTO v_ip_attempts FROM order_lookup_attempts
  WHERE ip_address = p_ip_address AND created_at > now() - interval '1 hour';
  SELECT count(*) INTO v_phone_attempts FROM order_lookup_attempts
  WHERE phone_e164 = p_phone AND created_at > now() - interval '1 hour';

  IF v_ip_attempts >= v_ip_limit OR v_phone_attempts >= v_phone_limit THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  SELECT o.* INTO v_order FROM orders o
  WHERE o.order_number = v_number
    AND o.pii_purged_at IS NULL -- N7: an anonymized order is no longer findable
    AND (o.guest_phone = p_phone
         OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.phone = p_phone))
  LIMIT 1;
  v_found := FOUND;

  INSERT INTO order_lookup_attempts (ip_address, phone_e164, order_number_tried, matched)
  VALUES (p_ip_address, p_phone, left(v_number, 32), v_found);

  IF NOT v_found THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_order.id, v_order.order_number, v_order.status, v_order.delivery_date, v_order.fulfillment_type,
    CASE WHEN v_order.delivery_address IS NOT NULL
         THEN v_order.delivery_city || ', ' || left(v_order.delivery_address, 1) || '***'
         ELSE NULL END;
END;
$$;
COMMENT ON FUNCTION fn_lookup_order_by_phone_and_number IS 'US-0d: phone AND order number together, never either alone; one empty answer for every miss; masked view (city + first character of the street); rate limited per IP and per phone (order_lookup_attempts), fails closed. service_role only since 20260926130100 (the IP comes from the server). order_id is for the server (confirmation link), never shown.';
REVOKE EXECUTE ON FUNCTION fn_lookup_order_by_phone_and_number(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_lookup_order_by_phone_and_number(TEXT, TEXT, TEXT) TO service_role;
