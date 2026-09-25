-- 20260926090000_sec_default_privileges_and_service_role_check.sql
-- Orchestrator lane (0900xx). Two security fixes found in wave 1.
--
-- 1. Default privileges (found independently by job-001, db-005 and
--    compliance-002). On Supabase, a function created in public is EXECUTE-able
--    by anon and authenticated through the default privileges, even after
--    REVOKE ... FROM PUBLIC. job-001 revoked the 12 functions that were exposed
--    (anon could hold capacity with fn_reserve_capacity and reset the SEC-005
--    rate limit). This removes the cause: functions that migrations (run as
--    postgres) create from now on are callable by nobody until the migration
--    GRANTs them explicitly. Existing functions and their grants are untouched.
--
-- 2. `current_user = 'service_role'` inside a SECURITY DEFINER function is
--    never true: there current_user is the function owner. So the service-role
--    paths of these four functions were dead (RED: the service key calling
--    fn_unsubscribe_by_token got "is service_role only"). The caller's role is
--    read from the verified JWT instead (PostgREST checks its signature), via
--    one helper. Only that check changes in each body.

-- Both are needed: the schema-level default grants anon/authenticated
-- directly, and the global default grants PUBLIC (which anon inherits).
-- service_role keeps its default grant (server-side jobs).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION fn_is_service_role() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;
COMMENT ON FUNCTION fn_is_service_role IS 'True when the request carries a verified service_role JWT. Use this, never current_user, inside SECURITY DEFINER functions (current_user is the owner there).';
REVOKE EXECUTE ON FUNCTION fn_is_service_role() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_record_order_confirmation_delivered(p_order_id uuid, p_channel text, p_pdf_path text, p_pdf_sha256 text, p_link_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT (is_admin_aal2() OR fn_is_service_role()) THEN
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
$function$

;

CREATE OR REPLACE FUNCTION public.fn_set_marketing_consent(p_customer_id uuid, p_action text, p_consent_version text, p_source text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
  IF NOT (p_customer_id = auth.uid() OR is_admin_aal2() OR fn_is_service_role()) THEN
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
$function$

;

CREATE OR REPLACE FUNCTION public.fn_unsubscribe_by_token(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_customer_id UUID;
  v_email TEXT;
  v_version TEXT;
BEGIN
  IF NOT fn_is_service_role() THEN
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
$function$

;

CREATE OR REPLACE FUNCTION public.fn_hard_delete_customer(p_customer_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT (auth.uid() = p_customer_id OR is_admin_aal2() OR fn_is_service_role()) THEN
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
$function$

;

