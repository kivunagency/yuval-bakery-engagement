-- 20260926060000_admin_orders_release_unpaid_day.sql
-- Session F lane (0600xx), client-009 / SEC-006 response tool:
-- "release all unpaid orders of a day".
--
-- Why a DB function and not a loop of fn_cancel_order calls from the app:
-- fn_cancel_order also cancels a PAID order (BUG 2 fix, DB-PLAN.md 10.2). A
-- loop over "the unpaid orders I listed a moment ago" would cancel an order
-- Yuval marked paid on her phone in between. Here the day's payment_pending
-- orders are locked FOR UPDATE first, so fn_mark_order_paid on one of them
-- waits for this transaction, and each locked row is still payment_pending
-- when it is released.
--
-- Capacity is released only through fn_release_order_capacity, once per order
-- (SEC-007, release_exactly_once); no ledger arithmetic here. Every release
-- writes its own 'order.cancelled' audit row (actor = auth.uid()), plus one
-- summary row for the bulk action.
--
-- Callers: POST /api/admin/orders/release-unpaid (releaseUnpaidForDay in
-- lib/server/ordering/admin-orders.ts). Changes no existing function.

BEGIN;

CREATE OR REPLACE FUNCTION fn_admin_release_unpaid_for_day(p_day DATE)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_id UUID;
  v_number TEXT;
  v_released TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'day_range_invalid';
  END IF;

  FOR v_id, v_number IN
    SELECT id, order_number FROM orders
    WHERE delivery_date = p_day AND status = 'payment_pending'
    ORDER BY created_at
    FOR UPDATE
  LOOP
    IF fn_release_order_capacity(v_id, 'cancelled', 'admin', auth.uid()::text) THEN
      v_released := v_released || v_number;
    END IF;
  END LOOP;

  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'orders.bulk_released_unpaid', 'capacity_day', p_day::text,
    jsonb_build_object('released', cardinality(v_released), 'order_numbers', to_jsonb(v_released)));

  RETURN jsonb_build_object('day', p_day, 'released', cardinality(v_released), 'order_numbers', to_jsonb(v_released));
END;
$$;
COMMENT ON FUNCTION fn_admin_release_unpaid_for_day IS 'SEC-006 response tool (client-009): cancels every payment_pending order of one day, each through fn_release_order_capacity (exactly once, row locked as payment_pending first, so a paid order is never touched). Admin at aal2, actor auth.uid(). Returns {day, released, order_numbers}.';

REVOKE EXECUTE ON FUNCTION fn_admin_release_unpaid_for_day(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_release_unpaid_for_day(DATE) TO authenticated;

COMMIT;
