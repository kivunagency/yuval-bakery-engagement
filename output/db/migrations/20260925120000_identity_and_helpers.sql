-- Migration: 20260925120000_identity_and_helpers
-- DDD context: Identity
-- Description: extensions, admins/customers aggregates, append-only consent_events
-- and privacy_requests, plus the two RLS helper functions (is_admin, has_aal2)
-- every later migration's policies depend on.
-- Numbering note (Rule 28): timestamps here are provisional, claimed at authoring
-- time. The dispatcher/PR-open step must re-check them against every unmerged
-- remote branch before the PR opens and renumber if a collision exists.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- digest()/gen_random_bytes() for token hashing

-- ============================================================
-- admins (Identity aggregate: AdminUser)
-- ============================================================
-- SEC-002: role lives ONLY here (or app_metadata), never in user_metadata.
-- id = the Supabase auth.users id of the admin (1:1, Yuval today, extensible).
CREATE TABLE admins (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  mfa_enrolled_at TIMESTAMPTZ,
  backup_factor_registered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE admins IS 'DDD context: Identity. AdminUser aggregate. SEC-002: sole source of admin role, never user_metadata.';

-- ============================================================
-- customers (Identity aggregate: Customer)
-- ============================================================
CREATE TABLE customers (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- PII
  phone TEXT NOT NULL UNIQUE, -- PII, E.164 normalized by the server before insert
  email TEXT UNIQUE, -- PII, optional
  birthday_day SMALLINT CHECK (birthday_day BETWEEN 1 AND 31),
  birthday_month SMALLINT CHECK (birthday_month BETWEEN 1 AND 12),
  anniversary_day SMALLINT CHECK (anniversary_day BETWEEN 1 AND 31),
  anniversary_month SMALLINT CHECK (anniversary_month BETWEEN 1 AND 12),
  marketing_opt_in BOOLEAN NOT NULL DEFAULT false, -- derived; only fn_set_marketing_consent may write this
  marketing_consent_version TEXT,
  marketing_opt_in_at TIMESTAMPTZ,
  marketing_opt_out_at TIMESTAMPTZ,
  unsubscribe_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  age_confirmed_18_at TIMESTAMPTZ,
  privacy_notice_version TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  data_export_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'DDD context: Identity. Customer aggregate root. Guest orders carry no customer_id (see Ordering context).';
COMMENT ON COLUMN customers.phone IS 'PII. compliance-spec.md section 3.';
COMMENT ON COLUMN customers.email IS 'PII, optional per BRIEF 2026-09-25.';
COMMENT ON COLUMN customers.birthday_day IS 'Day+month only, no year, per compliance-spec.md section 3 and rotem.';

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admins_updated_at BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- consent_events (Identity, append-only, s.30A evidence)
-- ============================================================
CREATE TABLE consent_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL, -- within Identity context
  customer_email_snapshot TEXT, -- PII, evidence kept even after the customer row is anonymized
  purpose TEXT NOT NULL CHECK (purpose IN ('marketing')),
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  consent_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('registration', 'profile', 'unsubscribe_link', 'admin_on_request')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE consent_events IS 'DDD context: Identity. Append-only, s.30A proof of consent per compliance-spec.md section 5. No UPDATE/DELETE grant to any app role (rls_policies.sql).';

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: % on % is not permitted', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_events_append_only
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ============================================================
-- privacy_requests (Identity, single-operator rights mechanism)
-- ============================================================
CREATE TABLE privacy_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_type TEXT NOT NULL CHECK (request_type IN ('access', 'export', 'correction', 'deletion', 'marketing_removal')),
  requester_contact TEXT NOT NULL, -- PII, free text (phone/email as given)
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  handled_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE privacy_requests IS 'DDD context: Identity. s.13/s.14 rights handling per compliance-spec.md section 6.';

-- ============================================================
-- RLS helper functions (used by every subsequent migration's policies)
-- ============================================================
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM admins WHERE id = auth.uid());
$$;
COMMENT ON FUNCTION is_admin() IS 'SEC-002: role membership check, source of truth is the admins table, never user_metadata.';

CREATE OR REPLACE FUNCTION has_aal2() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((auth.jwt() ->> 'aal') = 'aal2', false);
$$;
COMMENT ON FUNCTION has_aal2() IS 'SEC-002/SEC-013: AAL2 gate for every admin-facing policy and route.';

CREATE OR REPLACE FUNCTION is_admin_aal2() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT is_admin() AND has_aal2();
$$;

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;

-- admins: an admin can read the roster (needed for the UI to show "logged in as"),
-- nobody but the row owner can update their own display fields, no INSERT/DELETE
-- via the Data API at all (admin provisioning is a service-role/console action).
CREATE POLICY "admins_select_self_or_admin" ON admins FOR SELECT
  USING (is_admin_aal2());
CREATE POLICY "admins_update_self" ON admins FOR UPDATE
  USING (id = auth.uid() AND is_admin_aal2())
  WITH CHECK (id = auth.uid() AND is_admin_aal2());

-- customers: a registered customer reads/updates only their own row. Admin (AAL2)
-- can read all for order support. No direct INSERT via Data API: the profile row
-- is created by a server-side function alongside the auth.users row (SEC-001).
CREATE POLICY "customers_select_own" ON customers FOR SELECT
  USING (id = auth.uid() OR is_admin_aal2());
CREATE POLICY "customers_update_own" ON customers FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND deleted_at IS NULL);

-- consent_events: customer reads their own consent history, admin reads all.
-- INSERT only via SECURITY DEFINER function (fn_set_marketing_consent), never
-- direct, so no INSERT policy is granted to authenticated here.
CREATE POLICY "consent_events_select_own_or_admin" ON consent_events FOR SELECT
  USING (customer_id = auth.uid() OR is_admin_aal2());

-- privacy_requests: admin only, guest requests are logged by Yuval on the
-- customer's behalf per compliance-spec.md section 6.
CREATE POLICY "privacy_requests_admin_only" ON privacy_requests FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

-- Data API exposure (required since 2026-05-30). No anon grant anywhere here:
-- every one of these tables holds PII or admin identity.
GRANT SELECT, UPDATE ON TABLE admins TO authenticated;
GRANT SELECT, UPDATE ON TABLE customers TO authenticated;
GRANT SELECT ON TABLE consent_events TO authenticated;
GRANT SELECT ON TABLE privacy_requests TO authenticated;

COMMIT;
