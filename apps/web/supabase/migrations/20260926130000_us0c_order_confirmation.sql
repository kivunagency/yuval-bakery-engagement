-- 20260926130000_us0c_order_confirmation.sql (session L lane 1300xx)
-- US-0c: the written order confirmation (s.14C(b)) as an immutable PDF,
-- stored once in a private bucket and served for at least 24 months through
-- a tokened link (DB-PLAN.md sections 7 and 10.4 B5, threat-model SEC-003).
--
-- 1. Bucket `order-confirmations`: private, PDF only, 1 MB. No storage.objects
--    policy for anon or authenticated: RLS denies them everything; the server
--    reads and writes with the service role only.
--
-- 2. fn_order_public_view(order id): the ONE definition of what a customer may
--    see of an order (Rule 15). fn_order_for_lookup_token (the order page,
--    client-004) now returns it, and the confirmation PDF is built from it too,
--    so the screen and the PDF can never disagree. Adds `order_source` (the
--    cancellation wording differs for a custom cake) and `order_id` (read by
--    the server only; GET /api/orders/[token] strips it through its contract).
--
-- 3. Issuing is separated from delivering. Before this migration the only
--    writer, fn_record_order_confirmation_delivered, wrote the PDF path, hash
--    and link token at the moment of DELIVERY. But the customer downloads the
--    PDF from the order page right after checkout, and Yuval's WhatsApp
--    message needs the link BEFORE she sends it, so the document must exist
--    before any delivery is recorded. Now:
--      fn_issue_order_confirmation      service_role, write-once: path, sha256,
--                                       link token hash, link expiry (24 months).
--      fn_record_order_confirmation_delivered(order, channel)
--                                       write-once: channel + delivered_at,
--                                       only for an issued, live confirmation.
--    The stored sha256 is still the proof of what was sent: it is written once
--    at issue, the link serves only that file (the server checks the hash on
--    every read), and delivery can only be recorded after it.
--    Callers of the old 5-argument function: none in the app (it had no route
--    yet, SYSTEM-CONTRACT section 3); a test set the columns by SQL.
--
-- 4. fn_confirmation_by_link_token: the serving route's one read. NULL, one
--    uniform answer, unless the token hash matches, the link has not expired,
--    and confirmation_link_revoked_at, confirmation_pdf_purged_at and
--    pii_purged_at are all NULL (B5).
--
-- 5. fn_order_confirmation_source(order id): what the server needs to issue
--    the PDF and to show the admin card (view, state, whether an email exists).

-- ------------------------------------------------------------
-- 1. Bucket
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema not present (plain postgres): bucket skipped';
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('order-confirmations', 'order-confirmations', false, 1048576, ARRAY['application/pdf'])
  ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
END $$;

-- ------------------------------------------------------------
-- 2. One customer-visible view of an order
-- ------------------------------------------------------------
CREATE FUNCTION fn_order_public_view(p_order_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'status', o.status,
    'order_source', o.order_source,
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
  WHERE o.id = p_order_id AND o.pii_purged_at IS NULL;
$$;
COMMENT ON FUNCTION fn_order_public_view IS 'US-0c / Rule 15: the one customer-visible view of an order (no name, phone, email, street address or notes). Used by fn_order_for_lookup_token (order page) and fn_order_confirmation_source (the PDF). NULL once PII is purged. Internal: no grant, reached only through those two.';
REVOKE EXECUTE ON FUNCTION fn_order_public_view(UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION fn_order_for_lookup_token(p_token TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT fn_order_public_view(o.id)
  FROM orders o
  WHERE length(p_token) >= 20
    AND o.lookup_token_hash = fn_hash_token(p_token)
    AND o.lookup_token_expires_at > now()
    AND o.pii_purged_at IS NULL;
$$;
-- Same signature: its grant (service_role only) is unchanged.

-- ------------------------------------------------------------
-- 3a. Issue the confirmation (write-once)
-- ------------------------------------------------------------
CREATE FUNCTION fn_issue_order_confirmation(p_order_id UUID, p_pdf_path TEXT, p_pdf_sha256 TEXT, p_link_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[0-9a-f]{64}$'
     OR p_pdf_path IS DISTINCT FROM ('orders/' || p_order_id::text || '/' || p_pdf_sha256 || '.pdf')
     OR p_link_token IS NULL OR length(p_link_token) < 60 THEN
    RAISE EXCEPTION 'confirmation_invalid_argument';
  END IF;

  SELECT status INTO v_status FROM orders
  WHERE id = p_order_id AND pii_purged_at IS NULL AND confirmation_link_revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_order_not_available';
  END IF;

  UPDATE orders
  SET confirmation_pdf_path = p_pdf_path,
      confirmation_pdf_sha256 = p_pdf_sha256,
      confirmation_link_token_hash = fn_hash_token(p_link_token),
      confirmation_link_expires_at = now() + interval '24 months'
  WHERE id = p_order_id AND confirmation_pdf_path IS NULL;
  IF NOT FOUND THEN
    RETURN false; -- already issued: the first document stays (immutable)
  END IF;
  -- Only a live order gets a first document; an expired or cancelled one
  -- that never had it does not need a confirmation of a sale that did not happen.
  IF v_status NOT IN ('payment_pending', 'paid', 'fulfilled') THEN
    RAISE EXCEPTION 'confirmation_order_not_available';
  END IF;
  PERFORM fn_write_audit_log('system', 'service_role', 'order.confirmation_issued', 'order', p_order_id::text,
    jsonb_build_object('sha256', p_pdf_sha256));
  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_issue_order_confirmation IS 'US-0c: records the confirmation PDF (private bucket path orders/<id>/<sha256>.pdf, its sha256) and the hash of its link token, link valid 24 months. Write-once: a second call returns false and changes nothing. service_role only (fn_is_service_role). Refused for a purged or revoked order, and for a first issue on an expired or cancelled one.';
REVOKE EXECUTE ON FUNCTION fn_issue_order_confirmation(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_issue_order_confirmation(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 3b. Record the delivery (write-once, after issue)
-- ------------------------------------------------------------
DROP FUNCTION fn_record_order_confirmation_delivered(UUID, TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION fn_record_order_confirmation_delivered(p_order_id UUID, p_channel TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_admin BOOLEAN := is_admin_aal2();
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('email', 'whatsapp_manual') THEN
    RAISE EXCEPTION 'invalid_confirmation_channel: %', p_channel;
  END IF;
  -- The system sends the email; only Yuval can say she sent the WhatsApp.
  IF p_channel = 'email' AND NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'confirmation_delivery_requires_admin_or_service_role';
  END IF;
  IF p_channel = 'whatsapp_manual' AND NOT v_admin THEN
    RAISE EXCEPTION 'confirmation_delivery_requires_admin_or_service_role';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM orders
    WHERE id = p_order_id
      AND confirmation_pdf_path IS NOT NULL
      AND confirmation_link_revoked_at IS NULL
      AND confirmation_pdf_purged_at IS NULL
      AND pii_purged_at IS NULL
  ) THEN
    RAISE EXCEPTION 'confirmation_not_issued';
  END IF;

  UPDATE orders
  SET confirmation_channel = p_channel, confirmation_delivered_at = now()
  WHERE id = p_order_id AND confirmation_delivered_at IS NULL; -- B5a: write once
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log(CASE WHEN v_admin THEN 'admin' ELSE 'system' END,
    COALESCE(auth.uid()::text, 'service_role'), 'order.confirmation_delivered', 'order', p_order_id::text,
    jsonb_build_object('channel', p_channel));
  RETURN true;
END;
$$;
COMMENT ON FUNCTION fn_record_order_confirmation_delivered IS 'US-0c: records how the written confirmation reached the customer; opens trg_orders_guard_fulfillment for an order with no email. email: service role only (after the mail was sent). whatsapp_manual: aal2 admin only (Yuval pressed "I sent it"). Requires an issued, live confirmation (fn_issue_order_confirmation). Write-once: a second call returns false.';
REVOKE EXECUTE ON FUNCTION fn_record_order_confirmation_delivered(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_order_confirmation_delivered(UUID, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The serving route's read (B5)
-- ------------------------------------------------------------
CREATE FUNCTION fn_confirmation_by_link_token(p_token TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'pdf_path', o.confirmation_pdf_path,
    'pdf_sha256', o.confirmation_pdf_sha256)
  FROM orders o
  WHERE length(p_token) >= 60
    AND o.confirmation_link_token_hash = fn_hash_token(p_token)
    AND o.confirmation_link_expires_at > now()
    AND o.confirmation_pdf_path IS NOT NULL
    AND o.confirmation_link_revoked_at IS NULL
    AND o.confirmation_pdf_purged_at IS NULL
    AND o.pii_purged_at IS NULL;
$$;
COMMENT ON FUNCTION fn_confirmation_by_link_token IS 'US-0c / B5: the stored PDF of a confirmation link, or NULL (unknown, expired, revoked, purged and anonymized alike: one uniform answer). service_role only; called by GET /confirmation/[token].';
REVOKE EXECUTE ON FUNCTION fn_confirmation_by_link_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_confirmation_by_link_token(TEXT) TO service_role;

-- ------------------------------------------------------------
-- 5. What the server needs to issue and to show state
-- ------------------------------------------------------------
CREATE FUNCTION fn_order_confirmation_source(p_order_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'view', fn_order_public_view(o.id),
    'pdf_path', o.confirmation_pdf_path,
    'pdf_sha256', o.confirmation_pdf_sha256,
    'link_token_hash', o.confirmation_link_token_hash,
    'link_live', o.confirmation_pdf_path IS NOT NULL AND o.confirmation_link_expires_at > now()
                 AND o.confirmation_link_revoked_at IS NULL AND o.confirmation_pdf_purged_at IS NULL,
    'delivered_at', o.confirmation_delivered_at,
    'channel', o.confirmation_channel,
    -- same rule as trg_orders_guard_fulfillment
    'has_email', o.guest_email IS NOT NULL
                 OR (o.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.email IS NOT NULL)))
  FROM orders o
  WHERE o.id = p_order_id AND o.pii_purged_at IS NULL AND o.confirmation_link_revoked_at IS NULL;
$$;
COMMENT ON FUNCTION fn_order_confirmation_source IS 'US-0c: one order as the confirmation needs it: the public view (fn_order_public_view), the stored PDF state and whether an email is on file. NULL for a purged or revoked order. service_role only.';
REVOKE EXECUTE ON FUNCTION fn_order_confirmation_source(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_order_confirmation_source(UUID) TO service_role;
