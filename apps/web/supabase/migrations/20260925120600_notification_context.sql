-- Migration: 20260925120600_notification_context
-- DDD context: Notification
-- Description: push_subscriptions. Email/WhatsApp are stateless (Resend API
-- call, wa.me link) and need no table; web push needs a subscription record.

BEGIN;

CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID, -- cross-context ref: Identity (AdminUser). No FK; SEC-018 requires this to be admin-only at AAL2, enforced by the policy below, not by referential integrity.
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
COMMENT ON TABLE push_subscriptions IS 'DDD context: Notification. SEC-018: registration only for an authenticated admin at AAL2. Payload sent to these endpoints is order-number-only, never PII (enforced in lib/server/notification/, not here).';

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_subscriptions_admin_only" ON push_subscriptions FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2() AND admin_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE push_subscriptions TO authenticated;
-- No anon grant: SEC-018 requires AAL2 admin registration only.

COMMIT;
