-- Migration: 20260925120100_capacity_context
-- DDD context: Capacity (the correctness-critical one, ADR-002)
-- Description: capacity_day_ledger, exactly as specified in ADR-002-capacity-ledger.md.
-- SEC-001 names this table explicitly: anon and authenticated get ZERO direct
-- write access, even for the admin. All writes go through SECURITY DEFINER
-- functions (fn_admin_set_day_capacity, fn_reserve_capacity,
-- fn_release_order_capacity) shipped in 20260925120800_functions_capacity.sql.

BEGIN;

CREATE TABLE capacity_day_ledger (
  day DATE PRIMARY KEY,
  oven_minutes_total INT NOT NULL CHECK (oven_minutes_total >= 0),
  oven_minutes_reserved INT NOT NULL DEFAULT 0,
  work_minutes_total INT NOT NULL CHECK (work_minutes_total >= 0),
  work_minutes_reserved INT NOT NULL DEFAULT 0,
  is_blackout BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (oven_minutes_reserved >= 0 AND oven_minutes_reserved <= oven_minutes_total),
  CHECK (work_minutes_reserved >= 0 AND work_minutes_reserved <= work_minutes_total)
);
COMMENT ON TABLE capacity_day_ledger IS
  'DDD context: Capacity. Invariant capacity_never_negative (ADR-002): reserved <= total for both resources at every moment under any concurrency. SEC-007: release is idempotent via fn_release_order_capacity, guarded by the orders.status transition itself, not by GREATEST() alone. See DB-PLAN.md.';
COMMENT ON COLUMN capacity_day_ledger.oven_minutes_reserved IS 'Sum of oven-minute cost of every order/approved custom cake currently holding this day. Written ONLY by fn_reserve_capacity / fn_release_order_capacity (SECURITY DEFINER). Never by direct UPDATE, not even from the admin UI.';

CREATE TRIGGER trg_capacity_day_ledger_updated_at BEFORE UPDATE ON capacity_day_ledger
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE capacity_day_ledger ENABLE ROW LEVEL SECURITY;

-- Public read is needed so the checkout UI can show which days are open before
-- the customer is authenticated at all (US-5). No PII is exposed by this row.
CREATE POLICY "capacity_day_ledger_select_public" ON capacity_day_ledger FOR SELECT
  USING (true);

-- No INSERT/UPDATE/DELETE policy for anon or authenticated at all (SEC-001).
-- The admin capacity screen (client-007) calls fn_admin_set_day_capacity via
-- RPC; that function is SECURITY DEFINER, checks is_admin_aal2() internally,
-- and is the only writer of *_total / is_blackout. Reservation and release
-- are internal-only (called from other SECURITY DEFINER functions, never
-- granted to authenticated directly).

-- Data API exposure (required since 2026-05-30). Read-only for both roles;
-- genuinely public-read data (no PII), so the anon grant is deliberate here.
GRANT SELECT ON TABLE capacity_day_ledger TO anon;
GRANT SELECT ON TABLE capacity_day_ledger TO authenticated;

COMMIT;
