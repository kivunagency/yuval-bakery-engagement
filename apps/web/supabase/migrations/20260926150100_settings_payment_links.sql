-- Migration: 20260926150100_settings_payment_links
-- Task: settings-payment (wave 3, session N), SEC-009: Yuval edits her Bit
-- and PayBox links (app_settings payment_link_bit / payment_link_paybox,
-- api-003). Needs 20260926150000 (no direct write path to app_settings).
-- Lane: 20260926150000..159999.
--
-- SEC-009: changing where customers pay is the most valuable thing a stolen
-- admin session could do, so a change needs more than an aal2 session:
--
-- 1. A FRESH second factor, checked by the DB, not only by the app: the
--    caller's JWT must carry a TOTP step (amr method "totp") from the last
--    5 minutes (fn_admin_totp_verified_within). The API route asks Yuval for
--    a code and verifies it with Supabase Auth right before the call, which
--    issues a new access token with a new amr timestamp. An aal2 session
--    whose TOTP step is older (up to the 12h session cap, SEC-013) is refused
--    with step_up_required, whoever calls the function.
-- 2. Only https links on the host allowlist of lib/shared/payment/links.ts
--    (PAYMENT_LINK_HOSTS, still UNVERIFIED against Yuval's real links; the
--    two lists must change together): no user, no port, at most 500
--    characters. JSON null unsets a link (the order page shows a placeholder).
-- 3. One audit row per change (settings.payment_links_updated: from/to, the
--    TOTP step time and a change id) and, from the app, an email to every
--    admin (notification event payment_links_changed, facts read back from
--    that audit row, so the mail says what the DB wrote, not what the caller
--    claims).
--
-- notification_attempts (job-002) gains the event payment_links_changed and
-- the entity type setting_change; nothing else of it changes.

BEGIN;

-- ------------------------------------------------------------
-- 1. Fresh TOTP step, read from the caller's JWT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_totp_verified_within(p_seconds INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT COALESCE((
    SELECT max((a ->> 'timestamp')::bigint)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) AS a
    WHERE a ->> 'method' = 'totp' AND (a ->> 'timestamp') ~ '^[0-9]{1,12}$'
  ) >= extract(epoch FROM now()) - p_seconds, false);
$$;
COMMENT ON FUNCTION fn_admin_totp_verified_within IS 'SEC-009: true when the caller''s JWT carries a TOTP step (amr method totp) no older than p_seconds. Supabase Auth stamps it when a code is verified.';
REVOKE EXECUTE ON FUNCTION fn_admin_totp_verified_within(INT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Host allowlist (mirror of PAYMENT_LINK_HOSTS)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_payment_link_valid(p_method TEXT, p_url TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT p_url IS NOT NULL AND length(p_url) <= 500 AND p_url !~ '[[:space:][:cntrl:]]' AND CASE p_method
    WHEN 'bit' THEN p_url ~ '^https://(bitpay\.co\.il|www\.bitpay\.co\.il)(/[^?#]*)?([?][^#]*)?(#.*)?$'
    WHEN 'paybox' THEN p_url ~ '^https://(payboxapp\.com|www\.payboxapp\.com|links\.payboxapp\.com|payboxapp\.page\.link)(/[^?#]*)?([?][^#]*)?(#.*)?$'
    ELSE false
  END;
$$;
COMMENT ON FUNCTION fn_payment_link_valid IS 'SEC-009: https, allowlisted host (same list as PAYMENT_LINK_HOSTS in lib/shared/payment/links.ts, UNVERIFIED), no user/port, no spaces, at most 500 characters. Hosts are matched in lower case as new URL() writes them.';
REVOKE EXECUTE ON FUNCTION fn_payment_link_valid(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The write
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_set_payment_links(p_values JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_key TEXT;
  v_new JSONB;
  v_old JSONB;
  v_changed JSONB := '{}'::jsonb;
  v_change_id UUID;
  v_totp_at BIGINT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF NOT fn_admin_totp_verified_within(300) THEN
    RAISE EXCEPTION 'step_up_required';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' OR p_values = '{}'::jsonb THEN
    RAISE EXCEPTION 'settings_invalid_input';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF v_key NOT IN ('payment_link_bit', 'payment_link_paybox') THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    v_new := p_values -> v_key;
    IF NOT (jsonb_typeof(v_new) = 'null'
            OR (jsonb_typeof(v_new) = 'string' AND fn_payment_link_valid(substr(v_key, 14), v_new #>> '{}'))) THEN
      RAISE EXCEPTION 'settings_invalid_value: %', v_key;
    END IF;
  END LOOP;

  PERFORM 1 FROM app_settings WHERE key IN ('payment_link_bit', 'payment_link_paybox') ORDER BY key FOR UPDATE;
  FOR v_key IN SELECT jsonb_object_keys(p_values) ORDER BY 1 LOOP
    v_new := p_values -> v_key;
    SELECT value INTO v_old FROM app_settings WHERE key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    IF v_old IS DISTINCT FROM v_new THEN
      UPDATE app_settings SET value = v_new, updated_by = auth.uid() WHERE key = v_key;
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('from', v_old, 'to', v_new));
    END IF;
  END LOOP;

  IF v_changed <> '{}'::jsonb THEN
    v_change_id := gen_random_uuid();
    SELECT max((a ->> 'timestamp')::bigint) INTO v_totp_at
    FROM jsonb_array_elements(auth.jwt() -> 'amr') AS a WHERE a ->> 'method' = 'totp';
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'settings.payment_links_updated', 'app_settings', v_change_id::text,
      jsonb_build_object('change_id', v_change_id, 'changed', v_changed, 'totp_verified_at', to_timestamp(v_totp_at)));
  END IF;

  RETURN jsonb_build_object(
    'change_id', v_change_id,
    'changed', (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(v_changed) AS k),
    'bit', (SELECT value FROM app_settings WHERE key = 'payment_link_bit'),
    'paybox', (SELECT value FROM app_settings WHERE key = 'payment_link_paybox'));
END;
$$;
COMMENT ON FUNCTION fn_admin_set_payment_links IS 'SEC-009: aal2 admin with a TOTP step in the last 5 minutes sets payment_link_bit / payment_link_paybox (https, allowlisted host, or JSON null). Writes only changed keys, one audit row settings.payment_links_updated with from/to, the TOTP time and a change id (returned; the app emails every admin with it). Raises step_up_required without a fresh TOTP step.';
REVOKE EXECUTE ON FUNCTION fn_admin_set_payment_links(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_set_payment_links(JSONB) TO authenticated;

-- ------------------------------------------------------------
-- 4. Notification: the email to every admin
-- ------------------------------------------------------------
ALTER TABLE notification_attempts DROP CONSTRAINT IF EXISTS notification_attempts_event_check;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_event_check
  CHECK (event IN ('order_created', 'custom_cake_requested', 'custom_cake_approved', 'custom_cake_declined', 'email_quota_alert', 'payment_links_changed'));
ALTER TABLE notification_attempts DROP CONSTRAINT IF EXISTS notification_attempts_entity_type_check;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_entity_type_check
  CHECK (entity_type IN ('order', 'custom_cake_request', 'quota', 'setting_change'));

-- What the mail says, read back from the audit row the change wrote.
CREATE OR REPLACE FUNCTION fn_notification_payment_links_facts(p_change_id UUID)
RETURNS TABLE (change_id UUID, changed_at TIMESTAMPTZ, admin_name TEXT, bit_changed BOOLEAN, paybox_changed BOOLEAN, bit_link JSONB, paybox_link JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_change_id, l.created_at, a.display_name,
         l.metadata -> 'changed' ? 'payment_link_bit',
         l.metadata -> 'changed' ? 'payment_link_paybox',
         l.metadata #> '{changed,payment_link_bit,to}',
         l.metadata #> '{changed,payment_link_paybox,to}'
  FROM audit_log l
  LEFT JOIN admins a ON a.id::text = l.actor_id
  WHERE l.action = 'settings.payment_links_updated' AND l.entity_id = p_change_id::text
  LIMIT 1;
$$;
COMMENT ON FUNCTION fn_notification_payment_links_facts IS 'SEC-009/job-002: the facts of one payment-link change, from its audit row (never from the caller). service_role only.';
REVOKE EXECUTE ON FUNCTION fn_notification_payment_links_facts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_notification_payment_links_facts(UUID) TO service_role;

COMMIT;
