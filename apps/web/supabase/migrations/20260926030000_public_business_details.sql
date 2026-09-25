-- 20260926030000_public_business_details.sql
-- compliance-002 + US-0b (contact block on every page).
--
-- Consumer Protection Law s.14C needs the business details shown before
-- payment, and US-0b needs Yuval's phone and WhatsApp on every page. None of
-- these values are known yet (waiting on Yuval: business name, osek number,
-- address, phone). They are Yuval-editable settings, seeded as JSON null; the
-- app renders a visible placeholder such as [business name] while a value is
-- null. Nothing here invents a value.
--
-- Keys (all JSON string or JSON null). The admin screen that edits them is a
-- later task; it writes these exact keys:
--   business_name                 trade name shown in the footer and /business
--   business_owner_name           Yuval's full name (s.14C: "name of the dealer")
--   business_registration_number  osek number (same as her ID number); the
--                                 status wording (osek patur / murshe) is
--                                 derived from the existing vat_status key
--   business_address              address for s.14C (home vs PO box is an
--                                 open legal question, compliance-spec 13 q3)
--   business_phone                Israeli number, tap-to-call (E.164 preferred)
--   business_whatsapp             Israeli mobile for wa.me (E.164 preferred)
--   business_email                contact email
--
-- Read path: anon and authenticated no longer read business_* rows from the
-- table directly (the old "select everything" policy is narrowed); they call
-- fn_public_site_settings(), which returns a fixed whitelist of public fields.
-- An admin at aal2 still reads every row. Every other key keeps its current
-- visibility, so no existing caller changes behaviour.

BEGIN;

INSERT INTO app_settings (key, value, description) VALUES
  ('business_name', 'null', 'Trade name. s.14C. Set by Yuval; null renders a visible placeholder.'),
  ('business_owner_name', 'null', 'Owner full name. s.14C. Set by Yuval.'),
  ('business_registration_number', 'null', 'Osek number. s.14C. Status wording comes from vat_status. Set by Yuval.'),
  ('business_address', 'null', 'Address shown on /business. Home vs PO box: legal question, compliance-spec.md 13 q3.'),
  ('business_phone', 'null', 'Contact phone, tap-to-call (US-0b). Israeli number, E.164 preferred.'),
  ('business_whatsapp', 'null', 'WhatsApp number for wa.me links (US-0b). Israeli mobile, E.164 preferred.'),
  ('business_email', 'null', 'Contact email. s.14C, privacy notice section 4 item 1.')
ON CONFLICT (key) DO NOTHING;

DROP POLICY IF EXISTS "app_settings_select_public" ON app_settings;
CREATE POLICY "app_settings_select_public" ON app_settings FOR SELECT
  USING (key NOT LIKE 'business\_%' OR is_admin_aal2());

-- A text setting as SQL text, or NULL when it is JSON null, not a string, or
-- blank. Keeps a malformed value from reaching the page.
CREATE OR REPLACE FUNCTION fn_setting_text(p_key TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT NULLIF(btrim(value #>> '{}'), '')
  FROM app_settings
  WHERE key = p_key AND jsonb_typeof(value) = 'string';
$$;
-- Supabase default privileges grant EXECUTE on new public functions to anon
-- and authenticated, so revoking from PUBLIC alone is not enough.
REVOKE ALL ON FUNCTION fn_setting_text(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION fn_public_site_settings() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'business_name', fn_setting_text('business_name'),
    'business_owner_name', fn_setting_text('business_owner_name'),
    'business_registration_number', fn_setting_text('business_registration_number'),
    'business_address', fn_setting_text('business_address'),
    'business_phone', fn_setting_text('business_phone'),
    'business_whatsapp', fn_setting_text('business_whatsapp'),
    'business_email', fn_setting_text('business_email'),
    'vat_status', fn_setting_text('vat_status'),
    'active_privacy_notice_version', fn_setting_text('active_privacy_notice_version'),
    'active_terms_version', fn_setting_text('active_terms_version'),
    'active_cancellation_notice_version', fn_setting_text('active_cancellation_notice_version'),
    'guest_pii_months', (SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::int END FROM app_settings WHERE key = 'guest_pii_months'),
    'photo_retention_days', (SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::int END FROM app_settings WHERE key = 'photo_retention_days'),
    'inactive_profile_months', (SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::int END FROM app_settings WHERE key = 'inactive_profile_months')
  );
$$;
COMMENT ON FUNCTION fn_public_site_settings() IS 'compliance-002/US-0b: the only anon read path for business_* settings. Fixed whitelist of public fields: business details (s.14C), vat_status (price wording), active document versions, retention periods quoted in the privacy notice.';
REVOKE ALL ON FUNCTION fn_public_site_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_public_site_settings() TO anon, authenticated, service_role;

COMMIT;
