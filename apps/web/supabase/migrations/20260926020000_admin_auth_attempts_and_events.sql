-- Migration: 20260926020000_admin_auth_attempts_and_events
-- DDD context: Identity (admin login, SEC-002 / SEC-013 / SEC-014 shape, SEC-017)
-- Task: db-005 (admin access).
--
-- 1. admin_auth_attempts + fn_admin_auth_attempt_begin/finish: rate limit on
--    the admin login (password step) and on the TOTP step, per client IP and
--    per account. Fails closed: the Next.js server refuses the login when it
--    cannot reach these functions. Stores only sha256 hashes of the IP and of
--    the account key (lower-cased email, or the user id for TOTP), never the
--    raw values (rotem's N5 applied from the start here).
-- 2. fn_admin_record_auth_event: audit_log rows for admin logins, MFA
--    enrolment and sign-out (SEC-017 names "logins, MFA changes"). The actor
--    is auth.uid(), never a parameter.
--
-- New functions: REVOKE from PUBLIC/anon/authenticated explicitly, because
-- Supabase's default privileges grant EXECUTE on every new function in public
-- to anon and authenticated (the blanket REVOKE in 20260925120800 only
-- covered the functions that existed then).

BEGIN;

CREATE TABLE admin_auth_attempts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('password', 'totp')),
  ip_hash TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  succeeded BOOLEAN, -- NULL while the attempt is in flight; counted as a failure until finished
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin_auth_attempts IS 'DDD context: Identity. Admin login and TOTP attempts for rate limiting (db-005, SEC-002/SEC-014 shape). Hashes only. Written only by fn_admin_auth_attempt_begin/finish (service_role). Rows older than admin_auth_attempts_retention_days are purged by fn_admin_auth_attempt_begin itself.';

CREATE INDEX admin_auth_attempts_ip_idx ON admin_auth_attempts (kind, ip_hash, created_at);
CREATE INDEX admin_auth_attempts_account_idx ON admin_auth_attempts (kind, account_hash, created_at);

ALTER TABLE admin_auth_attempts ENABLE ROW LEVEL SECURITY;
-- No policy and no grant for anon/authenticated: deny-all over the Data API.
REVOKE ALL ON TABLE admin_auth_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE admin_auth_attempts_id_seq FROM anon, authenticated;

INSERT INTO app_settings (key, value, description) VALUES
  ('admin_auth_window_minutes', '15', 'db-005: window for the admin login / TOTP rate limit.'),
  ('admin_auth_failures_per_ip', '5', 'db-005: failed admin login (or TOTP) attempts allowed per client IP per window.'),
  ('admin_auth_failures_per_account', '20', 'db-005: failed attempts allowed per account per window, from all IPs together. Higher than the per-IP limit on purpose: a low per-account limit lets anyone lock Yuval out by guessing wrong on her email (TOTP still guards the account).'),
  ('admin_auth_attempts_retention_days', '30', 'db-005: admin_auth_attempts rows older than this are deleted.')
ON CONFLICT (key) DO NOTHING;

-- Begin an attempt: returns the attempt id, or NULL when the IP or the account
-- is over its limit (nothing is recorded then). The advisory lock serializes
-- attempts on the same account, so two parallel requests cannot both slip
-- under the limit.
CREATE OR REPLACE FUNCTION fn_admin_auth_attempt_begin(p_kind TEXT, p_ip TEXT, p_account TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_window INTERVAL := make_interval(mins => (SELECT value::text::int FROM app_settings WHERE key = 'admin_auth_window_minutes'));
  v_per_ip INT := (SELECT value::text::int FROM app_settings WHERE key = 'admin_auth_failures_per_ip');
  v_per_account INT := (SELECT value::text::int FROM app_settings WHERE key = 'admin_auth_failures_per_account');
  v_retention INT := (SELECT value::text::int FROM app_settings WHERE key = 'admin_auth_attempts_retention_days');
  v_ip_hash TEXT;
  v_account_hash TEXT;
  v_id BIGINT;
BEGIN
  IF p_kind NOT IN ('password', 'totp') THEN
    RAISE EXCEPTION 'fn_admin_auth_attempt_begin: unknown kind %', p_kind;
  END IF;
  IF v_window IS NULL OR v_per_ip IS NULL OR v_per_account IS NULL OR v_retention IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: admin_auth_*';
  END IF;
  v_ip_hash := fn_hash_token(coalesce(p_ip, 'unknown'));
  v_account_hash := fn_hash_token(lower(trim(coalesce(p_account, ''))));

  PERFORM pg_advisory_xact_lock(hashtext('admin_auth:' || v_account_hash));
  PERFORM pg_advisory_xact_lock(hashtext('admin_auth_ip:' || v_ip_hash));

  DELETE FROM admin_auth_attempts WHERE created_at < now() - make_interval(days => v_retention);

  IF (SELECT count(*) FROM admin_auth_attempts
      WHERE kind = p_kind AND ip_hash = v_ip_hash AND succeeded IS DISTINCT FROM true
        AND created_at > now() - v_window) >= v_per_ip
     OR (SELECT count(*) FROM admin_auth_attempts
      WHERE kind = p_kind AND account_hash = v_account_hash AND succeeded IS DISTINCT FROM true
        AND created_at > now() - v_window) >= v_per_account
  THEN
    RETURN NULL;
  END IF;

  INSERT INTO admin_auth_attempts (kind, ip_hash, account_hash)
  VALUES (p_kind, v_ip_hash, v_account_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_admin_auth_attempt_begin IS 'db-005: admin login/TOTP rate limit. NULL = over the limit. service_role only (the caller is not authenticated yet).';

CREATE OR REPLACE FUNCTION fn_admin_auth_attempt_finish(p_attempt_id BIGINT, p_succeeded BOOLEAN)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE admin_auth_attempts SET succeeded = p_succeeded WHERE id = p_attempt_id AND succeeded IS NULL;
$$;

-- Audit row for an admin auth event. Actor = auth.uid(). An admin at aal1 is
-- allowed (the password step and TOTP enrolment happen before aal2), a
-- non-admin is refused. 'admin.mfa_enrolled' requires aal2 (it is recorded
-- right after the first TOTP verify) and stamps admins.mfa_enrolled_at.
CREATE OR REPLACE FUNCTION fn_admin_record_auth_event(p_action TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF p_action NOT IN ('admin.login_password_ok', 'admin.login_totp_ok', 'admin.mfa_enrolled', 'admin.signed_out') THEN
    RAISE EXCEPTION 'fn_admin_record_auth_event: unknown action %', p_action;
  END IF;
  IF p_action = 'admin.mfa_enrolled' THEN
    IF NOT has_aal2() THEN
      RAISE EXCEPTION 'admin_aal2_required';
    END IF;
    UPDATE admins SET mfa_enrolled_at = coalesce(mfa_enrolled_at, now()) WHERE id = auth.uid();
  END IF;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, p_action, 'admin', auth.uid()::text,
    jsonb_build_object('aal', auth.jwt() ->> 'aal'));
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_admin_auth_attempt_begin(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_auth_attempt_finish(BIGINT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_record_auth_event(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_auth_attempt_begin(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_admin_auth_attempt_finish(BIGINT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION fn_admin_record_auth_event(TEXT) TO authenticated;

COMMIT;
