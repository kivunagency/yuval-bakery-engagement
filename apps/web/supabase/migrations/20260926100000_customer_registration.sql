-- Migration: 20260926100000_customer_registration
-- DDD context: Identity. Task api-010 (optional customer registration, PRD US-4).
-- Lane 20260926100000..20260926109999 (session J).
--
-- 1. customer_auth_attempts + fn_customer_auth_attempt_begin/finish: rate
--    limit for customer sign-up (every attempt counts: SEC-015, no mail
--    bombing of a victim's address) and customer sign-in (failures count:
--    SEC-014). Hashes only, same shape as admin_auth_attempts (db-005), a
--    separate table because the limits, the retention and the audience differ.
-- 2. fn_register_customer: creates the customers row for the signed-in user
--    after Supabase Auth confirmed the email. Email comes from auth.users,
--    never from the caller. Removes the sign-up data parked in
--    user_metadata ('yb_registration') in the same transaction, so name and
--    phone do not stay in a second place anonymization never reaches.
-- 3. fn_update_my_profile: the customer's own edits (s.14 correction). The
--    blanket column UPDATE grant on customers is revoked: writes go through
--    functions only (CLAUDE.md).
-- 4. Birthday/anniversary exist only for marketing benefits (compliance-spec
--    section 3: "deleted when marketing consent is withdrawn, no other
--    purpose"), so the DB refuses them without marketing consent, and refuses
--    impossible dates (31 Feb). No year column, as before.
-- 5. fn_set_marketing_consent: a customer acting on their own row may use the
--    sources 'registration' and 'profile' only (they could previously write
--    'account_deletion', which is evidence of a different event), and a
--    deleted account cannot grant. Body otherwise unchanged from 20260925121300.
--
-- The account page reads the customer's own orders through the existing RLS
-- policy orders_select_own_registered (customer_id = auth.uid()). Guest
-- orders are never linked to an account by phone or email (SEC-003).
--
-- New functions are callable by nobody until granted (20260925121300).

BEGIN;

-- ============================================================
-- 1. Rate limit
-- ============================================================
CREATE TABLE customer_auth_attempts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signup', 'login')),
  ip_hash TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  succeeded BOOLEAN, -- NULL while in flight; counted as a failure until finished
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE customer_auth_attempts IS 'DDD context: Identity. Customer sign-up and sign-in attempts for rate limiting (api-010, SEC-014/SEC-015). Hashes only. Written only by fn_customer_auth_attempt_begin/finish (service_role). Rows older than customer_auth_attempts_retention_days are purged by fn_customer_auth_attempt_begin itself.';

CREATE INDEX customer_auth_attempts_ip_idx ON customer_auth_attempts (kind, ip_hash, created_at);
CREATE INDEX customer_auth_attempts_account_idx ON customer_auth_attempts (kind, account_hash, created_at);

ALTER TABLE customer_auth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE customer_auth_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE customer_auth_attempts_id_seq FROM anon, authenticated;

INSERT INTO app_settings (key, value, description) VALUES
  ('customer_auth_window_minutes', '15', 'api-010: window for the customer sign-up / sign-in rate limit.'),
  ('customer_signup_per_ip', '5', 'api-010 (SEC-014): sign-up attempts allowed per client IP per window, successful or not.'),
  ('customer_signup_per_email', '3', 'api-010 (SEC-015): sign-up attempts allowed per email address per window, so nobody can make Auth mail a victim over and over.'),
  ('customer_login_failures_per_ip', '5', 'api-010 (SEC-014): failed customer sign-ins allowed per client IP per window.'),
  ('customer_login_failures_per_account', '10', 'api-010 (SEC-014): failed sign-ins allowed per account per window, from all IPs together.'),
  ('customer_auth_attempts_retention_days', '30', 'api-010: customer_auth_attempts rows older than this are deleted.')
ON CONFLICT (key) DO NOTHING;

-- Returns the attempt id, or NULL when the IP or the account is over its
-- limit (nothing is recorded then). Advisory locks serialize attempts on the
-- same account and IP, so parallel requests cannot all slip under the limit.
CREATE OR REPLACE FUNCTION fn_customer_auth_attempt_begin(p_kind TEXT, p_ip TEXT, p_account TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_window INTERVAL := make_interval(mins => (SELECT value::text::int FROM app_settings WHERE key = 'customer_auth_window_minutes'));
  v_retention INT := (SELECT value::text::int FROM app_settings WHERE key = 'customer_auth_attempts_retention_days');
  v_per_ip INT;
  v_per_account INT;
  v_ip_hash TEXT;
  v_account_hash TEXT;
  v_id BIGINT;
BEGIN
  IF p_kind = 'signup' THEN
    v_per_ip := (SELECT value::text::int FROM app_settings WHERE key = 'customer_signup_per_ip');
    v_per_account := (SELECT value::text::int FROM app_settings WHERE key = 'customer_signup_per_email');
  ELSIF p_kind = 'login' THEN
    v_per_ip := (SELECT value::text::int FROM app_settings WHERE key = 'customer_login_failures_per_ip');
    v_per_account := (SELECT value::text::int FROM app_settings WHERE key = 'customer_login_failures_per_account');
  ELSE
    RAISE EXCEPTION 'fn_customer_auth_attempt_begin: unknown kind %', p_kind;
  END IF;
  IF v_window IS NULL OR v_per_ip IS NULL OR v_per_account IS NULL OR v_retention IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: customer_auth_*';
  END IF;
  v_ip_hash := fn_hash_token(coalesce(p_ip, 'unknown'));
  v_account_hash := fn_hash_token(lower(trim(coalesce(p_account, ''))));

  PERFORM pg_advisory_xact_lock(hashtext('customer_auth:' || v_account_hash));
  PERFORM pg_advisory_xact_lock(hashtext('customer_auth_ip:' || v_ip_hash));

  DELETE FROM customer_auth_attempts WHERE created_at < now() - make_interval(days => v_retention);

  -- Sign-up: every attempt counts (a successful sign-up still sent a mail).
  -- Sign-in: only failures count.
  IF (SELECT count(*) FROM customer_auth_attempts
      WHERE kind = p_kind AND ip_hash = v_ip_hash
        AND (p_kind = 'signup' OR succeeded IS DISTINCT FROM true)
        AND created_at > now() - v_window) >= v_per_ip
     OR (SELECT count(*) FROM customer_auth_attempts
      WHERE kind = p_kind AND account_hash = v_account_hash
        AND (p_kind = 'signup' OR succeeded IS DISTINCT FROM true)
        AND created_at > now() - v_window) >= v_per_account
  THEN
    RETURN NULL;
  END IF;

  INSERT INTO customer_auth_attempts (kind, ip_hash, account_hash)
  VALUES (p_kind, v_ip_hash, v_account_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_customer_auth_attempt_begin IS 'api-010: customer sign-up/sign-in rate limit. NULL = over the limit. service_role only (the caller is not signed in yet).';

CREATE OR REPLACE FUNCTION fn_customer_auth_attempt_finish(p_attempt_id BIGINT, p_succeeded BOOLEAN)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE customer_auth_attempts SET succeeded = p_succeeded WHERE id = p_attempt_id AND succeeded IS NULL;
$$;

-- ============================================================
-- 4. Birthday / anniversary integrity
-- ============================================================
-- A real day of a month (29 Feb allowed: no year is stored), both parts or
-- neither, and only while marketing consent is on.
CREATE OR REPLACE FUNCTION fn_is_day_of_month(p_day SMALLINT, p_month SMALLINT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_day IS NULL AND p_month IS NULL THEN true
    WHEN p_day IS NULL OR p_month IS NULL THEN false
    WHEN p_month NOT BETWEEN 1 AND 12 OR p_day < 1 THEN false
    ELSE p_day <= extract(day FROM (make_date(2000, p_month, 1) + interval '1 month - 1 day'))::int
  END
$$;
REVOKE EXECUTE ON FUNCTION fn_is_day_of_month(SMALLINT, SMALLINT) FROM PUBLIC, anon, authenticated;

ALTER TABLE customers ADD CONSTRAINT customers_birthday_valid
  CHECK (fn_is_day_of_month(birthday_day, birthday_month));
ALTER TABLE customers ADD CONSTRAINT customers_anniversary_valid
  CHECK (fn_is_day_of_month(anniversary_day, anniversary_month));
ALTER TABLE customers ADD CONSTRAINT customers_dates_require_marketing_consent
  CHECK (marketing_opt_in OR (birthday_day IS NULL AND birthday_month IS NULL AND anniversary_day IS NULL AND anniversary_month IS NULL));
COMMENT ON CONSTRAINT customers_dates_require_marketing_consent ON customers IS 'compliance-spec.md section 3: birthday/anniversary have no purpose other than marketing benefits, so they are never held without marketing consent.';

-- ============================================================
-- 2. Registration
-- ============================================================
CREATE OR REPLACE FUNCTION fn_register_customer(
  p_name TEXT, p_phone TEXT, p_privacy_notice_version TEXT, p_age_confirmed BOOLEAN
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_confirmed TIMESTAMPTZ;
  v_active_privacy TEXT;
  v_name TEXT := trim(coalesce(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'customer_sign_in_required';
  END IF;
  IF EXISTS (SELECT 1 FROM admins WHERE id = v_uid) THEN
    RAISE EXCEPTION 'customer_sign_in_required'; -- an admin account is never a customer profile
  END IF;
  SELECT email, email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = v_uid;
  IF v_email IS NULL OR v_confirmed IS NULL THEN
    RAISE EXCEPTION 'customer_email_not_confirmed';
  END IF;

  IF EXISTS (SELECT 1 FROM customers WHERE id = v_uid) THEN
    UPDATE auth.users SET raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'yb_registration' WHERE id = v_uid;
    RETURN 'exists';
  END IF;

  IF p_age_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'customer_age_not_confirmed';
  END IF;
  SELECT value #>> '{}' INTO v_active_privacy FROM app_settings WHERE key = 'active_privacy_notice_version';
  IF v_active_privacy IS NULL OR p_privacy_notice_version IS DISTINCT FROM v_active_privacy THEN
    RAISE EXCEPTION 'privacy_notice_version_mismatch';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 80 OR coalesce(p_phone, '') !~ '^\+9725[0-9]{8}$' THEN
    RAISE EXCEPTION 'customer_invalid_input';
  END IF;
  IF EXISTS (SELECT 1 FROM customers WHERE phone = p_phone) THEN
    RAISE EXCEPTION 'customer_phone_taken';
  END IF;

  INSERT INTO customers (id, name, phone, email, age_confirmed_18_at, privacy_notice_version, last_activity_at)
  VALUES (v_uid, v_name, p_phone, v_email, now(), p_privacy_notice_version, now());

  UPDATE auth.users SET raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'yb_registration' WHERE id = v_uid;
  RETURN 'created';
EXCEPTION
  WHEN unique_violation THEN
    -- Two registrations racing for one phone: the loser gets the same answer.
    RAISE EXCEPTION 'customer_phone_taken';
END;
$$;
COMMENT ON FUNCTION fn_register_customer IS 'api-010: creates the customers row for auth.uid() once Auth confirmed the email. Email from auth.users only. Never links guest orders (SEC-003). Marketing consent is NOT part of this: fn_set_marketing_consent only (s.30A, separate act).';

-- ============================================================
-- 3. Own profile edits
-- ============================================================
CREATE OR REPLACE FUNCTION fn_update_my_profile(
  p_name TEXT, p_phone TEXT,
  p_birthday_day SMALLINT, p_birthday_month SMALLINT,
  p_anniversary_day SMALLINT, p_anniversary_month SMALLINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_opted_in BOOLEAN;
  v_name TEXT := trim(coalesce(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'customer_sign_in_required';
  END IF;
  SELECT marketing_opt_in INTO v_opted_in FROM customers WHERE id = v_uid AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_not_registered';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 80 OR coalesce(p_phone, '') !~ '^\+9725[0-9]{8}$' THEN
    RAISE EXCEPTION 'customer_invalid_input';
  END IF;
  IF NOT fn_is_day_of_month(p_birthday_day, p_birthday_month) OR NOT fn_is_day_of_month(p_anniversary_day, p_anniversary_month) THEN
    RAISE EXCEPTION 'customer_invalid_date';
  END IF;
  IF NOT v_opted_in AND num_nonnulls(p_birthday_day, p_birthday_month, p_anniversary_day, p_anniversary_month) > 0 THEN
    RAISE EXCEPTION 'customer_dates_require_marketing_consent';
  END IF;
  IF EXISTS (SELECT 1 FROM customers WHERE phone = p_phone AND id <> v_uid) THEN
    RAISE EXCEPTION 'customer_phone_taken';
  END IF;

  UPDATE customers
  SET name = v_name, phone = p_phone,
      birthday_day = p_birthday_day, birthday_month = p_birthday_month,
      anniversary_day = p_anniversary_day, anniversary_month = p_anniversary_month,
      last_activity_at = now()
  WHERE id = v_uid;
  RETURN true;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'customer_phone_taken';
END;
$$;
COMMENT ON FUNCTION fn_update_my_profile IS 'api-010: the signed-in customer edits their own name, phone and (only with marketing consent) birthday/anniversary. Email changes go through Auth, not here.';

REVOKE UPDATE ON TABLE customers FROM authenticated;

-- ============================================================
-- 5. Consent: customer sources narrowed
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_set_marketing_consent(p_customer_id uuid, p_action text, p_consent_version text, p_source text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT;
  v_active_version TEXT;
  v_is_staff BOOLEAN := is_admin_aal2() OR fn_is_service_role();
BEGIN
  IF p_action NOT IN ('granted', 'withdrawn') THEN
    RAISE EXCEPTION 'invalid_consent_action';
  END IF;

  -- B3a: nobody sets consent for someone else, except an AAL2 admin acting
  -- on a phone request (source admin_on_request), or service_role via the
  -- dedicated unsubscribe path (fn_unsubscribe_by_token, never this
  -- function directly, and only ever to withdraw).
  IF NOT (p_customer_id = auth.uid() OR v_is_staff) THEN
    RAISE EXCEPTION 'consent_not_own';
  END IF;
  IF p_source = 'admin_on_request' AND NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_on_request_requires_admin';
  END IF;
  IF p_source = 'unsubscribe_link' THEN
    RAISE EXCEPTION 'unsubscribe_link_source_is_service_role_only_via_fn_unsubscribe_by_token';
  END IF;
  -- api-010: a customer records only what they did themselves, on the
  -- registration or profile screen.
  IF NOT v_is_staff AND p_source NOT IN ('registration', 'profile') THEN
    RAISE EXCEPTION 'consent_source_not_allowed';
  END IF;
  IF p_action = 'granted' THEN
    -- B3a: consent must be to the notice version actually shown, not any
    -- string the caller supplies.
    SELECT value #>> '{}' INTO v_active_version FROM app_settings WHERE key = 'active_marketing_consent_version';
    IF v_active_version IS NULL OR p_consent_version IS DISTINCT FROM v_active_version THEN
      RAISE EXCEPTION 'consent_version_mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'customer_not_registered';
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
$function$;

-- ============================================================
-- Grants
-- ============================================================
REVOKE EXECUTE ON FUNCTION fn_customer_auth_attempt_begin(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_customer_auth_attempt_finish(BIGINT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_register_customer(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION fn_update_my_profile(TEXT, TEXT, SMALLINT, SMALLINT, SMALLINT, SMALLINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_customer_auth_attempt_begin(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_customer_auth_attempt_finish(BIGINT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION fn_register_customer(TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_update_my_profile(TEXT, TEXT, SMALLINT, SMALLINT, SMALLINT, SMALLINT) TO authenticated;
-- The CHECK constraints call fn_is_day_of_month as the role doing the write.
GRANT EXECUTE ON FUNCTION fn_is_day_of_month(SMALLINT, SMALLINT) TO authenticated, service_role;

COMMIT;
