-- Migration: 20260925120700_shared_audit_and_settings
-- DDD context: Shared (cross-cutting, not an aggregate of its own; compliance-
-- spec.md section 12 and threat-model.md SEC-017 both name these as agency-
-- wide/system-wide, not owned by one bounded context).
-- Description: audit_log (append-only), app_settings (key-value config so
-- Yuval-tunable values never need a migration to change), cron_heartbeats
-- (SEC-007 job-001 liveness).

BEGIN;

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'system', 'agent')),
  actor_id TEXT, -- admin.id as text, 'cron:job-001', or an agent token id
  action TEXT NOT NULL, -- e.g. 'order.marked_paid', 'custom_cake.approved', 'capacity.day_updated'
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, -- REDACT_KEYS applied by the app before insert; DB enforces append-only, not redaction
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_log IS 'Shared/cross-cutting. Append-only per SEC-017 and Rule 27''s audit sink requirement. No UPDATE/DELETE grant to any application role.';

CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES admins(id) ON DELETE SET NULL, -- same "Shared" scope, admins already exists
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_settings IS 'Shared/cross-cutting. Every Yuval-tunable numeric/policy value the PRD and threat-model require to be configurable without a code change: capacity abuse caps (SEC-005), expiry windows (US-9), retention periods (compliance-spec.md section 12), active document versions, vat_status.';

CREATE TRIGGER trg_app_settings_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed defaults. Values match threat-model.md section 3.1 and PRD-01 section
-- 3.7; each is flagged in PRD-01 section 10 as pending Yuval's confirmation,
-- so these are defaults, not final decisions.
INSERT INTO app_settings (key, value, description) VALUES
  ('single_order_capacity_pct', '35', 'Max % of a day''s capacity (either resource) one order may consume. SEC-005.'),
  ('unpaid_holds_capacity_pct', '70', 'Max % of a day''s capacity that may be held by unpaid (payment_pending) orders combined. SEC-005.'),
  ('payment_pending_expiry_hours_standard', '4', 'Hours before a standard payment_pending order auto-expires. PRD-01 US-9, pending Yuval.'),
  ('payment_pending_expiry_hours_custom_cake', '24', 'Hours before an approved custom-cake payment_pending order auto-expires. PRD-01 US-9, pending Yuval.'),
  ('order_attempts_per_ip_per_hour', '3', 'SEC-005 rate limit.'),
  ('open_payment_pending_per_phone_max', '2', 'SEC-005 rate limit.'),
  ('guest_pii_months', '24', 'Retention for guest PII fields on orders/custom_cake_requests before anonymization. compliance-spec.md section 3, pending accountant confirmation.'),
  ('photo_retention_days', '30', 'Inspiration photo retention after fulfilled/declined/expired. compliance-spec.md section 3.'),
  ('inactive_profile_months', '36', 'Registered profile deletion after inactivity, with 30-day advance notice per compliance-spec.md section 3.'),
  ('vat_status', '"exempt"', 'Drives catalog.price_incl_vat / checkout.total_incl_vat wording (compliance-spec.md section 8). Pending Yuval/accountant, PRD-01 open question 2.'),
  ('active_privacy_notice_version', '"privacy-2026-10-v1"', 'compliance-spec.md section 4.'),
  ('active_terms_version', '"terms-2026-10-v1"', 'Terms of service version shown at checkout.'),
  ('active_cancellation_notice_version', '"cancellation-2026-10-v1"', 'compliance-spec.md section 9.'),
  ('order_lookup_attempts_per_ip_per_hour', '10', 'US-0d find-my-order rate limit, per IP.'),
  ('order_lookup_attempts_per_phone_per_hour', '5', 'US-0d find-my-order rate limit, per phone.'),
  ('order_lookup_attempts_retention_days', '90', 'US-0d: order_lookup_attempts rows older than this are purged by fn_purge_old_lookup_attempts.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE cron_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT
);
COMMENT ON TABLE cron_heartbeats IS 'Shared/cross-cutting. SEC-007: job-001 (payment_pending expiry sweep) writes here every run; an alert fires if last_run_at is older than 45 minutes (threat-model.md section 2.9).';
INSERT INTO cron_heartbeats (job_name) VALUES ('expire_payment_pending_orders') ON CONFLICT DO NOTHING;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_select_admin_only" ON audit_log FOR SELECT
  USING (is_admin_aal2());
-- No INSERT policy for anon/authenticated: written only via fn_write_audit_log
-- (SECURITY DEFINER) called from the other functions in this schema.

-- app_settings: readable by anyone (some values, like vat_status wording,
-- drive public-facing price labels), writable only by an AAL2 admin.
CREATE POLICY "app_settings_select_public" ON app_settings FOR SELECT
  USING (true);
CREATE POLICY "app_settings_admin_write" ON app_settings FOR UPDATE
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

CREATE POLICY "cron_heartbeats_select_admin_only" ON cron_heartbeats FOR SELECT
  USING (is_admin_aal2());
-- No app-role write policy: only the scheduled function (service role) writes here.

GRANT SELECT ON TABLE audit_log TO authenticated;
GRANT SELECT ON TABLE app_settings TO anon;
GRANT SELECT, UPDATE ON TABLE app_settings TO authenticated;
GRANT SELECT ON TABLE cron_heartbeats TO authenticated;
-- No anon grant on audit_log or cron_heartbeats (operational/PII-adjacent).

COMMIT;
