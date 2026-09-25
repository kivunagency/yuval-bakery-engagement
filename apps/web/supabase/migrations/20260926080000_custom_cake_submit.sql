-- Migration: 20260926080000_custom_cake_submit
-- DDD context: CustomCake (api-005, PRD US-2, threat-model 2.4 / 3.2)
--
-- The customer side of a custom-cake request. Nothing here touches capacity:
-- a request is `pending_review` and holds no minutes (PRD section 4); only
-- fn_approve_custom_cake_request reserves, as the admin (ADR-002).
--
-- 1. fn_submit_custom_cake_request: creates the request. service_role only:
--    the Next.js route (app/api/custom-cake-requests) validates with Zod and
--    calls it with the service key, so anon cannot skip the route through
--    PostgREST (the gap SYSTEM-CONTRACT section 3 names for fn_create_standard_order).
--    SEC-005: writes the attempt into order_attempt_log, the same evidence
--    table and the same per-IP hourly limit as checkout (one "write attempts
--    per IP" budget), and allows at most N open pending_review requests per
--    phone. The lead time is checked by the existing BEFORE INSERT trigger
--    trg_custom_cake_requests_lead_time (blindspot-002).
-- 2. fn_attach_custom_cake_photo: records a re-encoded photo's private
--    storage path. service_role only, called by the upload pipeline after
--    sharp has re-encoded the file (SEC-010). Refuses: a request that is not
--    pending_review, a request older than the upload window, a 4th photo, a
--    request without the upload-rights confirmation, and any path outside
--    requests/<request id>/<uuid>.jpg.
-- 3. Length limits of SEC-025 as CHECKs, the second line behind Zod.
-- 4. privacy_notice_version on the request: which s.11 notice the customer
--    saw (the same evidence orders keep).

BEGIN;

ALTER TABLE custom_cake_requests ADD COLUMN privacy_notice_version TEXT;
COMMENT ON COLUMN custom_cake_requests.privacy_notice_version IS 'api-005: the privacy notice version (TEXT_VERSIONS.privacy) shown before the first personal field of the request form (s.11 evidence).';

ALTER TABLE custom_cake_requests
  ADD CONSTRAINT custom_cake_requests_text_lengths CHECK (
    (requester_name IS NULL OR char_length(requester_name) <= 60)
    AND (requester_email IS NULL OR char_length(requester_email) <= 254)
    AND (inscription_text IS NULL OR char_length(inscription_text) <= 120)
    AND (notes IS NULL OR char_length(notes) <= 500)
    AND (decline_reason IS NULL OR char_length(decline_reason) <= 300)
  );

INSERT INTO app_settings (key, value, description) VALUES
  ('open_custom_cake_requests_per_phone_max', '2', 'api-005 SEC-005: at most this many pending_review custom-cake requests per phone. Default, pending Yuval.'),
  ('custom_cake_photos_max', '3', 'api-005 SEC-010: inspiration photos per request (threat-model 3.2: up to 3).'),
  ('custom_cake_upload_window_minutes', '60', 'api-005 SEC-010: photos can be attached to a request only this many minutes after it was submitted.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_submit_custom_cake_request(
  p_ip_address TEXT,
  p_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_whatsapp_followup_ok BOOLEAN,
  p_inscription TEXT,
  p_notes TEXT,
  p_desired_date DATE,
  p_upload_rights_confirmed BOOLEAN,
  p_privacy_notice_version TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_ip_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'order_attempts_per_ip_per_hour');
  v_phone_limit INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'open_custom_cake_requests_per_phone_max');
  v_ip_attempts INT;
  v_open INT;
  v_id UUID;
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_phone IS NULL OR p_name IS NULL OR p_ip_address IS NULL THEN
    RAISE EXCEPTION 'guest_phone_or_customer_required';
  END IF;
  IF p_upload_rights_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'upload_rights_not_confirmed';
  END IF;

  INSERT INTO order_attempt_log (ip_address, phone_e164) VALUES (p_ip_address, p_phone);
  SELECT count(*) INTO v_ip_attempts FROM order_attempt_log
  WHERE ip_address = p_ip_address AND created_at > now() - interval '1 hour';
  IF v_ip_attempts > v_ip_limit THEN
    RAISE EXCEPTION 'rate_limit_ip_exceeded';
  END IF;

  SELECT count(*) INTO v_open FROM custom_cake_requests
  WHERE status = 'pending_review' AND requester_phone = p_phone;
  IF v_open >= v_phone_limit THEN
    RAISE EXCEPTION 'rate_limit_open_requests_per_phone_exceeded';
  END IF;

  INSERT INTO custom_cake_requests (
    requester_name, requester_phone, requester_email, whatsapp_followup_ok,
    inscription_text, notes, desired_date, upload_rights_confirmed_at, privacy_notice_version
  ) VALUES (
    p_name, p_phone, NULLIF(p_email, ''), COALESCE(p_whatsapp_followup_ok, false),
    NULLIF(p_inscription, ''), NULLIF(p_notes, ''), p_desired_date, now(), p_privacy_notice_version
  ) RETURNING id INTO v_id;

  -- No IP and no customer text in the undeletable audit_log (B4b).
  PERFORM fn_write_audit_log('system', 'custom_cake:anon', 'custom_cake.submitted', 'custom_cake_request', v_id::text, '{}'::jsonb);
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_submit_custom_cake_request IS 'api-005. Creates a pending_review custom-cake request. Never reserves capacity. service_role only (called by POST /api/custom-cake-requests). SEC-005 limits: order_attempt_log per IP (shared with checkout), open requests per phone.';

CREATE OR REPLACE FUNCTION fn_attach_custom_cake_photo(p_request_id UUID, p_storage_path TEXT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_req custom_cake_requests%ROWTYPE;
  v_max INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'custom_cake_photos_max');
  v_window INT := (SELECT (value)::text::int FROM app_settings WHERE key = 'custom_cake_upload_window_minutes');
  v_count INT;
  v_id UUID;
BEGIN
  IF NOT fn_is_service_role() THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  -- Lock the request so two concurrent attaches cannot both pass the count.
  SELECT * INTO v_req FROM custom_cake_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'pending_review' OR v_req.created_at < now() - make_interval(mins => v_window) THEN
    RAISE EXCEPTION 'custom_cake_upload_closed';
  END IF;
  IF v_req.upload_rights_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'upload_rights_not_confirmed';
  END IF;
  IF p_storage_path IS NULL
     OR p_storage_path !~ ('^requests/' || p_request_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') THEN
    RAISE EXCEPTION 'custom_cake_photo_path_invalid';
  END IF;
  SELECT count(*) INTO v_count FROM custom_cake_photos WHERE custom_cake_request_id = p_request_id;
  IF v_count >= v_max THEN
    RAISE EXCEPTION 'custom_cake_photo_limit_reached';
  END IF;
  INSERT INTO custom_cake_photos (custom_cake_request_id, storage_path) VALUES (p_request_id, p_storage_path)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_attach_custom_cake_photo IS 'api-005 SEC-010. Records the private path of a photo the server re-encoded. service_role only. At most custom_cake_photos_max per request, only while pending_review and within custom_cake_upload_window_minutes of submission.';

-- Callable by nobody by default (20260925121300); only the server's service key.
REVOKE EXECUTE ON FUNCTION fn_submit_custom_cake_request(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, DATE, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_attach_custom_cake_photo(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_submit_custom_cake_request(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, DATE, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_attach_custom_cake_photo(UUID, TEXT) TO service_role;

COMMIT;
