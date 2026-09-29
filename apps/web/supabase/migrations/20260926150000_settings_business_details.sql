-- Migration: 20260926150000_settings_business_details
-- Task: settings-business (wave 3, session N): Yuval edits the s.14C business
-- details (the business_* keys of compliance-002) and the osek status
-- (vat_status) in the admin Settings tab.
-- Lane: 20260926150000..159999.
--
-- 1. app_settings is no longer writable directly. Until now an aal2 admin
--    could UPDATE any row through PostgREST (policy app_settings_admin_write,
--    GRANT UPDATE to authenticated): no validation, no audit row, and it
--    would bypass SEC-009 for the payment links. Every write now goes through
--    a SECURITY DEFINER function that checks aal2, validates and audits
--    (SEC-017). Reads are unchanged (policy app_settings_select_public).
--    No app code wrote the table directly (checked: lib/, app/, components/);
--    tests write it as the superuser, which this does not affect.
--
-- 2. N11 (compliance-schema-review.md, deferred by 20260925121000): a BEFORE
--    INSERT OR UPDATE trigger holds the Yuval-tunable numeric keys between a
--    floor and a ceiling, and a few typed keys to their shape, whoever writes
--    them (a function, a migration, or someone with the service key). Floors
--    and ceilings (the values in place today all pass):
--      guest_pii_months                          6..84  (N11's own example)
--      photo_retention_days                      1..365
--      inactive_profile_months                  12..120
--      payment_pending_expiry_hours_standard     1..72   (PRD US-9)
--      payment_pending_expiry_hours_custom_cake  1..168  (PRD US-9)
--      day_limited_threshold_pct                 1..99   (api-002)
--      vat_status                                "exempt" | "licensed"
--      earliest_slot_time                        "HH:MM" (derived, api-003)
--      business_* and payment_link_*             JSON null or a string of at most 500 characters
--    A value outside them raises setting_out_of_range: <key>.
--
-- 3. fn_admin_set_business_details(p_values JSONB): aal2 admin only. Takes
--    any subset of business_name, business_owner_name,
--    business_registration_number, business_address, business_phone,
--    business_whatsapp, business_email (each a string, or JSON null to unset:
--    the site then shows its visible placeholder again) and vat_status.
--    Validates each value (same rules as lib/shared/contracts/business-settings.ts),
--    writes only the keys whose value changes (and vat_status the first time
--    Yuval confirms it, even to the seeded "exempt"), stamps updated_by =
--    auth.uid(), and writes one audit row with the previous and new values.
--    Business details are published on the site (s.14C), not customer PII,
--    so the audit row carries them in clear.
--    Nothing here seeds a value: every business_* key stays JSON null until
--    Yuval types it.

BEGIN;

-- ------------------------------------------------------------
-- 1. No direct writes to app_settings
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "app_settings_admin_write" ON app_settings;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE app_settings FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. N11: floors, ceilings and shapes, enforced on every write
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_app_settings_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_min INT;
  v_max INT;
  v_int INT;
BEGIN
  SELECT b.min_value, b.max_value INTO v_min, v_max
  FROM (VALUES
    ('guest_pii_months', 6, 84),
    ('photo_retention_days', 1, 365),
    ('inactive_profile_months', 12, 120),
    ('payment_pending_expiry_hours_standard', 1, 72),
    ('payment_pending_expiry_hours_custom_cake', 1, 168),
    ('day_limited_threshold_pct', 1, 99)
  ) AS b(key, min_value, max_value)
  WHERE b.key = NEW.key;

  IF FOUND THEN
    IF jsonb_typeof(NEW.value) <> 'number' OR (NEW.value #>> '{}') !~ '^[0-9]{1,6}$' THEN
      RAISE EXCEPTION 'setting_out_of_range: %', NEW.key;
    END IF;
    v_int := (NEW.value #>> '{}')::int;
    IF v_int < v_min OR v_int > v_max THEN
      RAISE EXCEPTION 'setting_out_of_range: %', NEW.key;
    END IF;
  ELSIF NEW.key = 'vat_status' THEN
    IF NEW.value NOT IN ('"exempt"'::jsonb, '"licensed"'::jsonb) THEN
      RAISE EXCEPTION 'setting_out_of_range: %', NEW.key;
    END IF;
  ELSIF NEW.key = 'earliest_slot_time' THEN
    IF jsonb_typeof(NEW.value) <> 'string' OR (NEW.value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'setting_out_of_range: %', NEW.key;
    END IF;
  ELSIF NEW.key LIKE 'business\_%' OR NEW.key LIKE 'payment\_link\_%' THEN
    IF NOT (jsonb_typeof(NEW.value) = 'null'
            OR (jsonb_typeof(NEW.value) = 'string' AND length(NEW.value #>> '{}') <= 500)) THEN
      RAISE EXCEPTION 'setting_out_of_range: %', NEW.key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION fn_app_settings_guard IS 'N11 (compliance-schema-review.md): floors and ceilings for the Yuval-tunable numeric app_settings keys, and the shape of vat_status, earliest_slot_time, business_* and payment_link_*, on every INSERT/UPDATE whoever writes. Raises setting_out_of_range: <key>.';
REVOKE EXECUTE ON FUNCTION fn_app_settings_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_app_settings_guard
  BEFORE INSERT OR UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION fn_app_settings_guard();

-- ------------------------------------------------------------
-- 3. Business details (s.14C) and osek status
-- ------------------------------------------------------------

-- Israeli ID / osek number check digit (the same rule for a company number).
CREATE OR REPLACE FUNCTION fn_is_valid_israeli_id(p TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_sum INT := 0;
  v_d INT;
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{9}$' OR p = '000000000' THEN
    RETURN false;
  END IF;
  FOR i IN 1..9 LOOP
    v_d := substr(p, i, 1)::int * (CASE WHEN i % 2 = 0 THEN 2 ELSE 1 END);
    v_sum := v_sum + (CASE WHEN v_d > 9 THEN v_d - 9 ELSE v_d END);
  END LOOP;
  RETURN v_sum % 10 = 0;
END;
$$;
COMMENT ON FUNCTION fn_is_valid_israeli_id IS 'settings-business: 9 digits with a valid Israeli ID check digit (osek number = ID number; a company number uses the same rule). Mirrored by isValidIsraeliId() in lib/shared/contracts/business-settings.ts.';
REVOKE EXECUTE ON FUNCTION fn_is_valid_israeli_id(TEXT) FROM PUBLIC, anon, authenticated;

-- One value of the business-details form: true when valid for its key.
-- Strings arrive trimmed with inner whitespace collapsed (the API does it; a
-- value that is not is refused rather than silently changed).
CREATE OR REPLACE FUNCTION fn_business_setting_valid(p_key TEXT, p_value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v TEXT;
BEGIN
  IF p_key = 'vat_status' THEN
    RETURN p_value IN ('"exempt"'::jsonb, '"licensed"'::jsonb);
  END IF;
  IF jsonb_typeof(p_value) = 'null' THEN
    RETURN true; -- unset: the site shows its placeholder
  END IF;
  IF jsonb_typeof(p_value) <> 'string' THEN
    RETURN false;
  END IF;
  v := p_value #>> '{}';
  IF v <> btrim(regexp_replace(v, '\s+', ' ', 'g')) OR v ~ '[[:cntrl:]]' THEN
    RETURN false;
  END IF;
  RETURN CASE p_key
    WHEN 'business_name' THEN length(v) BETWEEN 2 AND 60
    WHEN 'business_owner_name' THEN length(v) BETWEEN 2 AND 60
    WHEN 'business_registration_number' THEN fn_is_valid_israeli_id(v)
    WHEN 'business_address' THEN length(v) BETWEEN 5 AND 150
    WHEN 'business_phone' THEN v ~ '^\+972([57][0-9]{8}|[23489][0-9]{7})$'
    WHEN 'business_whatsapp' THEN v ~ '^\+972([57][0-9]{8}|[23489][0-9]{7})$'
    WHEN 'business_email' THEN length(v) <= 254 AND v ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ELSE false
  END;
END;
$$;
COMMENT ON FUNCTION fn_business_setting_valid IS 'settings-business: validation of one business-details value (same rules as lib/shared/contracts/business-settings.ts). Phones in E.164 (+972...).';
REVOKE EXECUTE ON FUNCTION fn_business_setting_valid(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION fn_admin_set_business_details(p_values JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_allowed CONSTANT TEXT[] := ARRAY['business_name', 'business_owner_name', 'business_registration_number',
    'business_address', 'business_phone', 'business_whatsapp', 'business_email', 'vat_status'];
  v_key TEXT;
  v_new JSONB;
  v_old JSONB;
  v_old_by UUID;
  v_changed JSONB := '{}'::jsonb;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' OR p_values = '{}'::jsonb THEN
    RAISE EXCEPTION 'settings_invalid_input';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT v_key = ANY(v_allowed) THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    IF NOT fn_business_setting_valid(v_key, p_values -> v_key) THEN
      RAISE EXCEPTION 'settings_invalid_value: %', v_key;
    END IF;
  END LOOP;

  -- Lock the rows so two saves at once audit a true before/after.
  PERFORM 1 FROM app_settings WHERE key = ANY(v_allowed) ORDER BY key FOR UPDATE;
  FOR v_key IN SELECT jsonb_object_keys(p_values) ORDER BY 1 LOOP
    v_new := p_values -> v_key;
    SELECT value, updated_by INTO v_old, v_old_by FROM app_settings WHERE key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    -- vat_status is seeded as a default nobody confirmed (updated_by null):
    -- choosing the same value is still a decision, so it is recorded.
    IF v_old IS DISTINCT FROM v_new OR (v_key = 'vat_status' AND v_old_by IS NULL) THEN
      UPDATE app_settings SET value = v_new, updated_by = auth.uid() WHERE key = v_key;
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('from', v_old, 'to', v_new));
    END IF;
  END LOOP;

  IF v_changed <> '{}'::jsonb THEN
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'settings.business_details_updated', 'app_settings', NULL,
      jsonb_build_object('changed', v_changed));
  END IF;

  RETURN (SELECT jsonb_object_agg(key, value) FROM app_settings WHERE key = ANY(v_allowed));
END;
$$;
COMMENT ON FUNCTION fn_admin_set_business_details IS 'settings-business: aal2 admin sets any subset of the business_* keys and vat_status (JSON null unsets a business_* key). Validates, writes only changed keys with updated_by = auth.uid(), one audit row settings.business_details_updated with from/to. Returns every business key with its value.';
REVOKE EXECUTE ON FUNCTION fn_admin_set_business_details(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_set_business_details(JSONB) TO authenticated;

COMMIT;
