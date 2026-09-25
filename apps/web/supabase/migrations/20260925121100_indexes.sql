-- indexes.sql
-- Additional indexes not already implied by PRIMARY KEY / UNIQUE constraints
-- created inline in the migrations. Rule: FK-shaped columns, filter columns
-- used in WHERE, sort columns used in ORDER BY on tables expected to grow.
-- Run after all migrations. Safe to re-run (IF NOT EXISTS everywhere).

-- Ordering context -----------------------------------------------------

-- Admin order list, filtered by status, newest first (the primary admin screen).
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
  ON orders (status, created_at DESC);

-- job-001 sweep: "every payment_pending order past its expiry", run every 15
-- minutes. Partial index keeps it tiny since most orders are not pending.
CREATE INDEX IF NOT EXISTS idx_orders_payment_pending_expiry
  ON orders (payment_pending_expires_at)
  WHERE status = 'payment_pending';

-- Delivery list generation (US-7): "today's delivery orders".
CREATE INDEX IF NOT EXISTS idx_orders_delivery_date_status
  ON orders (delivery_date, status)
  WHERE fulfillment_type = 'delivery';

-- Registered customer's own order history (RLS-filtered, but still needs the index).
CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON orders (customer_id)
  WHERE customer_id IS NOT NULL;

-- SEC-005: open payment_pending count per phone, checked on every order attempt.
CREATE INDEX IF NOT EXISTS idx_orders_guest_phone_status
  ON orders (guest_phone, status)
  WHERE guest_phone IS NOT NULL;

-- order_items FK.
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);

-- SEC-005 rate-limit reads: "attempts for this IP in the last hour" /
-- "attempts for this phone". Both are range-filtered on created_at.
CREATE INDEX IF NOT EXISTS idx_order_attempt_log_ip_created_at
  ON order_attempt_log (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_attempt_log_phone_created_at
  ON order_attempt_log (phone_e164, created_at DESC)
  WHERE phone_e164 IS NOT NULL;

-- US-0d find-my-order rate-limit reads, same shape as SEC-005 above.
CREATE INDEX IF NOT EXISTS idx_order_lookup_attempts_ip_created_at
  ON order_lookup_attempts (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_lookup_attempts_phone_created_at
  ON order_lookup_attempts (phone_e164, created_at DESC);
-- Purge sweep (fn_purge_old_lookup_attempts) scans by created_at with no
-- other filter; the index above already covers that access path.


-- Catalog context -------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_products_published_available
  ON products (is_published, is_available)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_photos_product_id_position
  ON product_photos (product_id, position);

-- CustomCake context ------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_custom_cake_requests_status_created_at
  ON custom_cake_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_cake_requests_customer_id
  ON custom_cake_requests (customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_cake_photos_request_id
  ON custom_cake_photos (custom_cake_request_id);

-- Delivery context --------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_delivery_zone_cities_zone_id
  ON delivery_zone_cities (zone_id);
-- city already carries a UNIQUE index from the constraint (case-sensitive;
-- the server normalizes city casing before insert/lookup, not the DB).

-- Identity context ----------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_consent_events_customer_id_created_at
  ON consent_events (customer_id, created_at DESC);
-- The s.30A send-query gate (compliance-spec.md section 5) reads "the LATEST
-- event per customer": this composite index supports that DISTINCT ON /
-- window-function query without a full scan.
CREATE INDEX IF NOT EXISTS idx_privacy_requests_due_at
  ON privacy_requests (due_at)
  WHERE completed_at IS NULL;

-- Shared / audit ----------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
