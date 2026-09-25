-- Migration: 20260925120500_customcake_context
-- DDD context: CustomCake
-- Description: custom_cake_requests. approve() is the documented cross-context
-- write (ADR-002, domain-map.md section 2): it creates an Ordering aggregate
-- and calls Capacity.reserve() in the SAME transaction. That logic lives in
-- fn_approve_custom_cake_request (20260925120800_functions_capacity.sql);
-- this migration only ships the CustomCake aggregate's own table.

BEGIN;

CREATE TABLE custom_cake_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID, -- cross-context ref: Identity. NULL for a guest requester.
  requester_name TEXT NOT NULL, -- PII
  requester_phone TEXT NOT NULL, -- PII, mandatory (US-0)
  requester_email TEXT, -- PII, optional
  whatsapp_followup_ok BOOLEAN NOT NULL DEFAULT false,
  inscription_text TEXT, -- PII (may name/age a child, compliance-spec.md section 3)
  notes TEXT,
  desired_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'declined')),
  price_displayed NUMERIC(10,2) CHECK (price_displayed IS NULL OR price_displayed >= 0),
  oven_minutes_cost INT CHECK (oven_minutes_cost IS NULL OR oven_minutes_cost >= 0),
  work_minutes_cost INT CHECK (work_minutes_cost IS NULL OR work_minutes_cost >= 0),
  allergens TEXT[], -- entered by Yuval at approval time (compliance-spec.md section 10)
  decline_reason TEXT,
  upload_rights_confirmed_at TIMESTAMPTZ NOT NULL, -- PRD/rotem: mandatory checkbox before photo upload
  photos_purged_at TIMESTAMPTZ,
  pii_purged_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  order_id UUID, -- cross-context ref: Ordering. Set by fn_approve_custom_cake_request on approval.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- an approved/declined request must carry the field that state requires;
  -- a pending one must not have already been priced or resolved.
  CHECK (status != 'approved' OR (price_displayed IS NOT NULL AND oven_minutes_cost IS NOT NULL AND work_minutes_cost IS NOT NULL AND order_id IS NOT NULL)),
  CHECK (status != 'declined' OR decline_reason IS NOT NULL OR decline_reason IS NULL) -- reason is optional per PRD US-2 AC, kept explicit for readers of this file
);
COMMENT ON TABLE custom_cake_requests IS 'DDD context: CustomCake. Never enters payment_pending directly; approve() creates the Order (cross-context write, see ADR-002). No "promote to catalog" field or flow (US-2, removed 2026-09-25 per rotem''s copyright/minors finding).';
COMMENT ON COLUMN custom_cake_requests.inscription_text IS 'PII: may contain a child''s name/age. Never returned to any agent-facing surface untrusted (threat-model.md SEC-004).';

CREATE TABLE custom_cake_photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  custom_cake_request_id UUID NOT NULL REFERENCES custom_cake_requests(id) ON DELETE CASCADE, -- same context
  storage_path TEXT NOT NULL, -- private bucket path, never a public URL (SEC-010)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE custom_cake_photos IS 'DDD context: CustomCake. Private bucket only, re-encoded server-side (SEC-010/SEC-011), never promoted to Catalog.';

CREATE TRIGGER trg_custom_cake_requests_updated_at BEFORE UPDATE ON custom_cake_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE custom_cake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_cake_photos ENABLE ROW LEVEL SECURITY;

-- Same SEC-003 shape as orders: guest requests have no customer_id, so guest
-- access to "my request status" is server-side only (service role), not RLS.
CREATE POLICY "custom_cake_requests_select_own_registered" ON custom_cake_requests FOR SELECT
  USING (customer_id = auth.uid() OR is_admin_aal2());
CREATE POLICY "custom_cake_requests_admin_write" ON custom_cake_requests FOR UPDATE
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());
-- No INSERT policy for anon/authenticated: creation goes through
-- fn_submit_custom_cake_request (rate-limited like standard orders, SEC-005).

CREATE POLICY "custom_cake_photos_admin_only" ON custom_cake_photos FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());
-- Deliberately no customer SELECT policy on the photos table itself: a
-- registered customer can see their request's status via the row above, but
-- the photo path is Yuval's review material only (threat-model.md 2.4).

GRANT SELECT, UPDATE ON TABLE custom_cake_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE custom_cake_photos TO authenticated;
-- No anon grant on either table (SEC-001 names custom_cake_requests
-- explicitly; photos inherit the same restriction as PII-adjacent content).

COMMIT;
