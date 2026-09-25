-- Migration: 20260926110000_job002_notification_attempts_and_push
-- Lane: session K (notifications), 2026-09-26 11xxxx.
-- DDD context: Notification (job-002, client-012). threat-model SEC-015, SEC-018.
--
-- 1. notification_attempts: one row per attempt to notify one recipient on one
--    channel, and its outcome (sent / failed / refused / skipped). A failed
--    notification never touches the order; this table is the evidence.
--    Recipients are stored as a sha256 hash only (never the address).
-- 2. Email spend cap (Rule 30, ADR-001 Resend free tier 100/day), counted HERE,
--    in the DB, under an advisory lock, so two servers cannot both take the
--    last slot: hard cap (100), alert threshold (80), a customer sub-cap (60)
--    so admin notifications always keep room (SEC-015), and at most 3 emails
--    per customer address per day (SEC-015). Counted per Asia/Jerusalem day.
-- 3. Read-only "facts" functions: the exact fields a message may carry, read
--    from the DB (never from the caller), service_role only.
-- 4. Web push subscriptions: register / revoke by an admin at aal2 with the
--    actor from auth.uid() (SEC-018); direct table writes are revoked so the
--    functions are the only write path. Service role lists active ones and
--    retires an endpoint the push service reports gone (404/410).
--
-- Every function here is callable by nobody unless granted below (default
-- privileges, 20260926090000). None is granted to anon.

BEGIN;

-- ---------------------------------------------------------------- settings
INSERT INTO app_settings (key, value, description) VALUES
  ('email_daily_hard_cap', '100', 'job-002 / Rule 30: the sender refuses every email above this many per Asia/Jerusalem day (Resend free tier is 100/day, ADR-001).'),
  ('email_daily_alert_at', '80', 'job-002 / Rule 30: when the day''s email count reaches this, the admin gets one push alert (ADR-001: alert at 80/day).'),
  ('email_daily_customer_cap', '60', 'SEC-015: customer-facing emails stop at this many per day, so admin notifications always keep room under the hard cap.'),
  ('email_per_recipient_daily_cap', '3', 'SEC-015: at most this many emails per customer address per day.'),
  ('notification_attempts_retention_days', '90', 'job-002: notification_attempts rows older than this are deleted by the daily retention job.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- table
CREATE TABLE notification_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event TEXT NOT NULL CHECK (event IN ('order_created', 'custom_cake_requested', 'custom_cake_approved', 'custom_cake_declined', 'email_quota_alert')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'push')),
  audience TEXT NOT NULL CHECK (audience IN ('admin', 'customer')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'custom_cake_request', 'quota')),
  entity_id TEXT NOT NULL,
  recipient_hash TEXT NOT NULL, -- sha256 hex of the lower-cased email, or of the push subscription id. Never the address.
  business_day DATE NOT NULL DEFAULT fn_business_date(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'refused', 'skipped')),
  reason TEXT, -- refusal / skip / failure code; never PII
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
COMMENT ON TABLE notification_attempts IS 'DDD context: Notification (job-002). One row per notification attempt and its outcome. Written only by fn_notification_* (service_role). Hashes only, no addresses. The email rows with status pending/sent are what the daily cap counts.';

-- The cap counts and the per-recipient count, per day.
CREATE INDEX notification_attempts_day_idx ON notification_attempts (business_day, channel, audience, status);
CREATE INDEX notification_attempts_recipient_idx ON notification_attempts (business_day, recipient_hash) WHERE channel = 'email';
-- Idempotency: one live (pending or sent) attempt per event, entity, channel, recipient.
CREATE UNIQUE INDEX notification_attempts_once_idx ON notification_attempts (event, entity_id, channel, recipient_hash)
  WHERE status IN ('pending', 'sent');

ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_attempts_select_admin" ON notification_attempts FOR SELECT USING (is_admin_aal2());
REVOKE ALL ON TABLE notification_attempts FROM anon, authenticated;
GRANT SELECT ON TABLE notification_attempts TO authenticated; -- rows visible only through the aal2 policy above

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION fn_notification_setting_int(p_key TEXT) RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v INT;
BEGIN
  SELECT (value)::text::int INTO v FROM app_settings WHERE key = p_key;
  IF v IS NULL OR v < 0 THEN
    RAISE EXCEPTION 'retention_setting_missing: %', p_key;
  END IF;
  RETURN v;
END;
$$;

-- ---------------------------------------------------------------- begin / finish
-- Starts one attempt. For email it takes a slot under the daily caps, or
-- records a refusal. Returns:
--   {attempt_id, allowed, reason, alert, sent_today, hard_cap}
-- allowed=false with reason 'duplicate' inserts nothing (the live attempt exists).
CREATE OR REPLACE FUNCTION fn_notification_begin(
  p_event TEXT, p_channel TEXT, p_audience TEXT, p_entity_type TEXT, p_entity_id TEXT, p_recipient_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_day DATE := fn_business_date();
  v_hard INT; v_alert INT; v_customer_cap INT; v_recipient_cap INT;
  v_total INT := 0; v_customer INT := 0; v_recipient INT := 0;
  v_reason TEXT := NULL;
  v_id UUID;
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_recipient_hash IS NULL OR p_recipient_hash !~ '^[0-9a-f]{64}$' OR p_entity_id IS NULL OR length(p_entity_id) > 64 THEN
    RAISE EXCEPTION 'notification_invalid_argument';
  END IF;

  IF EXISTS (SELECT 1 FROM notification_attempts
             WHERE event = p_event AND entity_id = p_entity_id AND channel = p_channel
               AND recipient_hash = p_recipient_hash AND status IN ('pending', 'sent')) THEN
    RETURN jsonb_build_object('attempt_id', NULL, 'allowed', false, 'reason', 'duplicate', 'alert', false, 'sent_today', NULL, 'hard_cap', NULL);
  END IF;

  IF p_channel = 'email' THEN
    -- One writer at a time per day: the count and the insert are one step.
    PERFORM pg_advisory_xact_lock(hashtext('notification_email_quota'), hashtext(v_day::text));
    v_hard := fn_notification_setting_int('email_daily_hard_cap');
    v_alert := fn_notification_setting_int('email_daily_alert_at');
    v_customer_cap := fn_notification_setting_int('email_daily_customer_cap');
    v_recipient_cap := fn_notification_setting_int('email_per_recipient_daily_cap');

    SELECT count(*),
           count(*) FILTER (WHERE audience = 'customer'),
           count(*) FILTER (WHERE recipient_hash = p_recipient_hash)
      INTO v_total, v_customer, v_recipient
      FROM notification_attempts
     WHERE business_day = v_day AND channel = 'email' AND status IN ('pending', 'sent');

    IF v_total >= v_hard THEN
      v_reason := 'daily_cap';
    ELSIF p_audience = 'customer' AND v_customer >= v_customer_cap THEN
      v_reason := 'customer_daily_cap';
    ELSIF p_audience = 'customer' AND v_recipient >= v_recipient_cap THEN
      v_reason := 'recipient_daily_cap';
    END IF;
  END IF;

  -- A duplicate that raced past the check above lands on the unique index.
  BEGIN
    INSERT INTO notification_attempts (event, channel, audience, entity_type, entity_id, recipient_hash, business_day, status, reason, finished_at)
    VALUES (p_event, p_channel, p_audience, p_entity_type, p_entity_id, p_recipient_hash, v_day,
            CASE WHEN v_reason IS NULL THEN 'pending' ELSE 'refused' END, v_reason,
            CASE WHEN v_reason IS NULL THEN NULL ELSE now() END)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('attempt_id', NULL, 'allowed', false, 'reason', 'duplicate', 'alert', false, 'sent_today', NULL, 'hard_cap', NULL);
  END;

  RETURN jsonb_build_object(
    'attempt_id', v_id,
    'allowed', v_reason IS NULL,
    'reason', v_reason,
    -- exactly once per day: the attempt that brings the count to the threshold
    'alert', p_channel = 'email' AND v_reason IS NULL AND v_total + 1 = v_alert,
    'sent_today', CASE WHEN p_channel = 'email' THEN v_total + CASE WHEN v_reason IS NULL THEN 1 ELSE 0 END ELSE NULL END,
    'hard_cap', v_hard
  );
END;
$$;
COMMENT ON FUNCTION fn_notification_begin IS 'job-002: start one notification attempt. Email: takes a slot under email_daily_hard_cap, email_daily_customer_cap and email_per_recipient_daily_cap (Asia/Jerusalem day, advisory lock), or records a refusal. alert=true once per day when the count reaches email_daily_alert_at. service_role only.';

CREATE OR REPLACE FUNCTION fn_notification_finish(p_attempt_id UUID, p_status TEXT, p_reason TEXT, p_provider_message_id TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'notification_invalid_argument';
  END IF;
  UPDATE notification_attempts
     SET status = p_status, reason = left(p_reason, 200), provider_message_id = left(p_provider_message_id, 200), finished_at = now()
   WHERE id = p_attempt_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification_attempt_not_pending';
  END IF;
END;
$$;
COMMENT ON FUNCTION fn_notification_finish IS 'job-002: close a pending attempt as sent or failed. A failed email frees its slot under the daily cap (only pending/sent count). service_role only.';

-- Records an attempt that was decided without trying (no address given, PDF
-- not built yet, provider not configured, no push subscription). Takes no
-- quota slot.
CREATE OR REPLACE FUNCTION fn_notification_record_skipped(
  p_event TEXT, p_channel TEXT, p_audience TEXT, p_entity_type TEXT, p_entity_id TEXT, p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  INSERT INTO notification_attempts (event, channel, audience, entity_type, entity_id, recipient_hash, status, reason, finished_at)
  VALUES (p_event, p_channel, p_audience, p_entity_type, left(p_entity_id, 64),
          encode(digest('none', 'sha256'), 'hex'), 'skipped', left(p_reason, 200), now());
END;
$$;

-- ---------------------------------------------------------------- facts (read-only)
-- Exactly what a message may carry. Phone and address are NOT returned: no
-- notification needs them (SEC-018, and they never go into email either).
CREATE OR REPLACE FUNCTION fn_notification_order_facts(p_order_id UUID)
RETURNS TABLE (order_id UUID, order_number TEXT, status TEXT, order_source TEXT, customer_name TEXT, customer_email TEXT,
               fulfillment_type TEXT, delivery_date DATE, total_displayed NUMERIC, payment_pending_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  RETURN QUERY
  SELECT o.id, o.order_number, o.status, o.order_source,
         COALESCE(c.name, o.guest_name), COALESCE(o.guest_email, c.email),
         o.fulfillment_type, o.delivery_date, o.total_displayed, o.payment_pending_expires_at
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
   WHERE o.id = p_order_id AND o.pii_purged_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fn_notification_custom_cake_facts(p_request_id UUID)
RETURNS TABLE (request_id UUID, status TEXT, requester_name TEXT, requester_email TEXT, desired_date DATE,
               price_displayed NUMERIC, decline_reason TEXT, order_id UUID, order_number TEXT, payment_pending_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  RETURN QUERY
  SELECT r.id, r.status, COALESCE(c.name, r.requester_name), COALESCE(r.requester_email, c.email), r.desired_date,
         r.price_displayed, r.decline_reason, o.id, o.order_number, o.payment_pending_expires_at
    FROM custom_cake_requests r
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN orders o ON o.id = r.order_id
   WHERE r.id = p_request_id AND r.pii_purged_at IS NULL;
END;
$$;

-- Admin addresses for admin notifications: the Auth email of every admin.
CREATE OR REPLACE FUNCTION fn_notification_admin_emails()
RETURNS TABLE (email TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  RETURN QUERY SELECT u.email::text FROM admins a JOIN auth.users u ON u.id = a.id WHERE u.email IS NOT NULL ORDER BY a.created_at;
END;
$$;

-- ---------------------------------------------------------------- push subscriptions
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_key_lengths
  CHECK (length(endpoint) <= 1024 AND length(p256dh) <= 128 AND length(auth_key) <= 64);

-- The functions below are the only write path (CLAUDE.md: writes through
-- SECURITY DEFINER functions). Reads stay behind the aal2 policy.
REVOKE INSERT, UPDATE, DELETE ON TABLE push_subscriptions FROM authenticated;

CREATE OR REPLACE FUNCTION fn_admin_register_push_subscription(p_endpoint TEXT, p_p256dh TEXT, p_auth_key TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https?://' OR length(p_endpoint) > 1024
     OR p_p256dh IS NULL OR p_p256dh !~ '^[A-Za-z0-9_-]{80,100}$'
     OR p_auth_key IS NULL OR p_auth_key !~ '^[A-Za-z0-9_-]{16,32}$' THEN
    RAISE EXCEPTION 'push_subscription_invalid';
  END IF;
  -- The same browser re-subscribing (or another admin's old endpoint on a
  -- shared device) becomes this admin's, active again.
  INSERT INTO push_subscriptions (admin_id, endpoint, p256dh, auth_key)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth_key)
  ON CONFLICT (endpoint) DO UPDATE
     SET admin_id = auth.uid(), p256dh = EXCLUDED.p256dh, auth_key = EXCLUDED.auth_key, revoked_at = NULL
  RETURNING id INTO v_id;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'push.subscribed', 'push_subscription', v_id::text, '{}'::jsonb);
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_admin_register_push_subscription IS 'client-012 / SEC-018: an admin at aal2 registers this browser for web push. Actor from auth.uid() only. The app also checks the endpoint host against the push-service allowlist before calling.';

CREATE OR REPLACE FUNCTION fn_admin_revoke_push_subscription(p_endpoint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  UPDATE push_subscriptions SET revoked_at = now()
   WHERE endpoint = p_endpoint AND admin_id = auth.uid() AND revoked_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'push.unsubscribed', 'push_subscription', v_id::text, '{}'::jsonb);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION fn_notification_active_push_subscriptions()
RETURNS TABLE (id UUID, endpoint TEXT, p256dh TEXT, auth_key TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  -- Only subscriptions whose owner is still an admin.
  RETURN QUERY SELECT s.id, s.endpoint, s.p256dh, s.auth_key
    FROM push_subscriptions s JOIN admins a ON a.id = s.admin_id
   WHERE s.revoked_at IS NULL ORDER BY s.created_at;
END;
$$;

-- p_gone: the push service answered 404/410, the endpoint is dead for good.
CREATE OR REPLACE FUNCTION fn_notification_push_result(p_subscription_id UUID, p_gone BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_gone THEN
    UPDATE push_subscriptions SET revoked_at = now() WHERE id = p_subscription_id AND revoked_at IS NULL;
  ELSE
    UPDATE push_subscriptions SET last_success_at = now() WHERE id = p_subscription_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------- retention
CREATE OR REPLACE FUNCTION fn_purge_old_notification_attempts() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_count INT;
BEGIN
  DELETE FROM notification_attempts
   WHERE created_at < now() - make_interval(days => fn_notification_setting_int('notification_attempts_retention_days'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------- grants
REVOKE EXECUTE ON FUNCTION fn_notification_setting_int(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_begin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_finish(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_record_skipped(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_order_facts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_custom_cake_facts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_admin_emails() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_register_push_subscription(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_revoke_push_subscription(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_active_push_subscriptions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_notification_push_result(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_purge_old_notification_attempts() FROM PUBLIC, anon, authenticated;

-- Server-side sender (lib/server/notification, service key).
GRANT EXECUTE ON FUNCTION fn_notification_begin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_finish(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_record_skipped(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_order_facts(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_custom_cake_facts(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_admin_emails() TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_active_push_subscriptions() TO service_role;
GRANT EXECUTE ON FUNCTION fn_notification_push_result(UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION fn_purge_old_notification_attempts() TO service_role;
-- Admin at aal2, as their own JWT (checked inside).
GRANT EXECUTE ON FUNCTION fn_admin_register_push_subscription(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_revoke_push_subscription(TEXT) TO authenticated;

COMMIT;
