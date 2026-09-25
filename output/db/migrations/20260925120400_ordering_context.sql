-- Migration: 20260925120400_ordering_context
-- DDD context: Ordering
-- Description: orders (aggregate root), order_items, order_attempt_log
-- (SEC-005 rate-limit evidence), order_lookup_attempts (US-0d find-my-order
-- rate-limit evidence). Cross-context references (customer_id,
-- delivery_zone_id, custom_cake_request_id, order_items.product_id) are
-- plain UUID columns with a comment, no FK, per the DDD cross-context rule:
-- CustomCake/Catalog/Identity/Delivery data integrity for those is enforced
-- by the server-side functions that write orders, not by a JOIN-capable FK.
-- SEC-001 applies in full: anon/authenticated get ZERO direct write access
-- and ZERO SELECT on orders. All access is through SECURITY DEFINER
-- functions and the capability-token route (SEC-003).
--
-- Updated 2026-09-25 (coordinator, approved by Ran, PRD US-0c/US-0d):
-- confirmation delivery tracking + a private confirmation PDF, and
-- find-my-order by phone+order_number (never phone alone).

BEGIN;

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number TEXT NOT NULL UNIQUE, -- random, non-sequential, short, human-typeable (fits in a Bit payment note). Label only, never a lookup key (SEC-003).
  lookup_token_hash TEXT UNIQUE NOT NULL, -- sha256 hex of a >=128-bit random token, the ONLY key /api/orders/[token] accepts
  lookup_token_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('payment_pending', 'paid', 'fulfilled', 'expired', 'cancelled')),
  customer_id UUID, -- cross-context ref: Identity. NULL for guest orders (no FK: RLS on customers cannot cover guest rows anyway, SEC-003).
  guest_name TEXT, -- PII, guest orders only
  guest_phone TEXT, -- PII, mandatory for guest orders, E.164 normalized server-side
  guest_email TEXT, -- PII, optional (compliance-spec.md section 8, s.14C written-confirmation gap)
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('delivery', 'pickup')),
  delivery_date DATE NOT NULL, -- matches a capacity_day_ledger.day, no FK (cross-context, Capacity)
  delivery_time_window TEXT,
  delivery_zone_id UUID, -- cross-context ref: Delivery. NULL for pickup.
  delivery_address TEXT, -- PII
  delivery_city TEXT,
  delivery_notes TEXT, -- PII (may contain access instructions)
  order_source TEXT NOT NULL DEFAULT 'standard' CHECK (order_source IN ('standard', 'custom_cake')),
  custom_cake_request_id UUID, -- cross-context ref: CustomCake. Set when order_source = 'custom_cake'.
  subtotal_displayed NUMERIC(10,2) NOT NULL CHECK (subtotal_displayed >= 0),
  delivery_fee_displayed NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee_displayed >= 0),
  total_displayed NUMERIC(10,2) NOT NULL CHECK (total_displayed >= 0),
  -- Snapshots of the exact minute-costs reserved at creation time. SEC-007 fix
  -- depends on these: release always decrements by what THIS order actually
  -- reserved, never by a value recomputed later from products (which may have
  -- changed since).
  oven_minutes_cost INT NOT NULL DEFAULT 0 CHECK (oven_minutes_cost >= 0),
  work_minutes_cost INT NOT NULL DEFAULT 0 CHECK (work_minutes_cost >= 0),
  privacy_notice_version TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  cancellation_notice_version TEXT NOT NULL,
  -- US-0c: written order confirmation (s.14C(b)). A PDF generated once,
  -- stored in a private bucket, immutable, served only via a signed/tokened
  -- link valid at least 24 months (the same span as the guest-PII retention
  -- default in app_settings, so the link outlives the data it points to only
  -- by policy choice, never the other way round).
  confirmation_channel TEXT CHECK (confirmation_channel IN ('email', 'whatsapp_manual')),
  confirmation_delivered_at TIMESTAMPTZ,
  confirmation_pdf_path TEXT, -- private bucket path, never a public URL (same pattern as SEC-010)
  confirmation_pdf_sha256 TEXT, -- content hash, proves the PDF served later is the one actually sent
  confirmation_link_token_hash TEXT UNIQUE, -- sha256(token) for the signed/tokened link, separate from lookup_token_hash (different lifetime: >=24 months vs 30 days)
  confirmation_link_expires_at TIMESTAMPTZ,
  payment_pending_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  pii_purged_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- an order is either a guest order (name+phone, no customer_id) or a
  -- registered-customer order (customer_id set); never neither.
  CHECK (customer_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL)),
  CHECK (fulfillment_type = 'pickup' OR (delivery_address IS NOT NULL AND delivery_city IS NOT NULL)),
  CHECK (confirmation_link_expires_at IS NULL OR confirmation_link_expires_at >= created_at + interval '24 months')
);
COMMENT ON TABLE orders IS 'DDD context: Ordering. Order aggregate root. State machine per PRD-01 section 5 and DB-PLAN.md. SEC-001/SEC-003: no anon/authenticated direct access at all. US-0c: fulfilled is blocked at the DB layer (fn_guard_order_fulfillment trigger, 20260925120800) for any order with no known email until confirmation_delivered_at is set.';
COMMENT ON COLUMN orders.order_number IS 'Label only, e.g. A248-style. Never accepted as a lookup key (SEC-003, IDOR finding in threat-model.md section 2.3). Find-my-order requires it TOGETHER WITH the phone (US-0d), never alone.';
COMMENT ON COLUMN orders.lookup_token_hash IS 'sha256(token). The raw token is shown to the customer once and never stored. See fn_hash_token in 20260925120800_functions_capacity_and_orders.sql.';
COMMENT ON COLUMN orders.confirmation_pdf_sha256 IS 'Content hash of the immutable confirmation PDF, so a later request for the same order always serves byte-identical content, provably.';

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE, -- same context
  product_id UUID, -- cross-context ref: Catalog. No FK; product may be edited/deleted after the order ships, hence the snapshot columns below.
  product_name_snapshot TEXT NOT NULL,
  unit_price_displayed NUMERIC(10,2) NOT NULL CHECK (unit_price_displayed >= 0),
  quantity INT NOT NULL CHECK (quantity > 0),
  line_total_displayed NUMERIC(10,2) NOT NULL CHECK (line_total_displayed >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE order_items IS 'DDD context: Ordering. Order lines. Snapshots product name/price at order time so a later catalog edit never rewrites history.';

-- SEC-005: fail-closed rate-limit evidence, checked inside the same
-- transaction as order creation by fn_create_standard_order /
-- fn_approve_custom_cake_request. No separate rate-limit service: if this
-- DB is unreachable, order creation itself is unreachable (fails closed).
CREATE TABLE order_attempt_log (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  phone_e164 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE order_attempt_log IS 'DDD context: Ordering. Append-only evidence for SEC-005 abuse limits (3/IP/hour, 2 open payment_pending/phone). Written by fn_create_standard_order before the capacity check.';

-- US-0d: find-my-order rate-limit evidence. Separate table from
-- order_attempt_log on purpose: different abuse shape (enumeration, not
-- capacity exhaustion) and its own retention/purge schedule.
CREATE TABLE order_lookup_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  phone_e164 TEXT NOT NULL, -- PII, purged by fn_purge_old_lookup_attempts after retention window
  order_number_tried TEXT NOT NULL,
  matched BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE order_lookup_attempts IS 'DDD context: Ordering. US-0d fail-closed rate-limit evidence for find-my-order. Retention: purged after 90 days by fn_purge_old_lookup_attempts (called from the same daily job as SEC-028), since this is abuse evidence, not a customer-facing record, and does not need the 24-month order-confirmation retention window.';

CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_attempt_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lookup_attempts ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon at all: guest orders have no customer_id, so RLS
-- cannot scope them by auth.uid() (threat-model.md section 3.3). Guest
-- access is exclusively via the server-side /api/orders/[token] route and
-- the fn_lookup_order_by_phone_and_number function (SEC-003, US-0d), both
-- using the service role / SECURITY DEFINER to bypass RLS by design and
-- re-implement the identity check in application/function code.
CREATE POLICY "orders_select_own_registered" ON orders FOR SELECT
  USING (customer_id = auth.uid() OR is_admin_aal2());
CREATE POLICY "orders_admin_write" ON orders FOR UPDATE
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());
-- Deliberately NO INSERT policy for anon or authenticated (SEC-001, SEC-005):
-- every order is created by fn_create_standard_order / custom-cake approval,
-- both SECURITY DEFINER, so the row exists before RLS is ever consulted for
-- a write from the caller's own session.

CREATE POLICY "order_items_select_via_order" ON order_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND (o.customer_id = auth.uid() OR is_admin_aal2())));
-- No direct INSERT/UPDATE/DELETE policy: items are written only inside
-- fn_create_standard_order's transaction.

-- order_attempt_log, order_lookup_attempts: nobody reads or writes either
-- directly. Both exist only for their owning SECURITY DEFINER function to
-- insert into and query within its own transaction; RLS enabled with zero
-- policies means even is_admin() gets nothing via the Data API, which is
-- correct (internal counters, not UI-facing tables).
-- (No CREATE POLICY on either table, on purpose: RLS enabled + zero policies = deny-all.)

GRANT SELECT ON TABLE orders TO authenticated;
GRANT UPDATE ON TABLE orders TO authenticated; -- restricted to admin rows by the policy above, and to non-status columns by trg_orders_guard_status_change
GRANT SELECT ON TABLE order_items TO authenticated;
-- No GRANT of any kind to anon on orders/order_items/order_attempt_log/
-- order_lookup_attempts (SEC-001). No INSERT/DELETE grant to authenticated
-- either: creation and deletion both happen inside SECURITY DEFINER
-- functions running as the function owner, which does not need table-level
-- grants from the caller's role to write.

COMMIT;
