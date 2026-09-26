-- Migration: 20260926150200_settings_slots_and_order_rules
-- Task: settings-slots (wave 3, session N): Yuval edits her delivery/pickup
-- time slots (time_slots, api-003) and the order rules kept in app_settings:
-- payment-pending expiry hours, standard and custom cake (PRD US-9, hers to
-- set), and day_limited_threshold_pct (api-002). earliest_slot_time stays
-- DERIVED from the first active slot (trg_time_slots_sync_earliest, api-003)
-- and is shown, never edited. Needs 20260926150000 (app_settings guard).
-- Lane: 20260926150000..159999.
--
-- 1. time_slots has no direct write path any more (it had: policy
--    time_slots_admin_write + INSERT/UPDATE/DELETE for authenticated, no
--    validation, no audit). fn_admin_set_time_slots(p_slots) makes the ACTIVE
--    list equal to the given one, in one transaction:
--      - a slot with the same start and end keeps its row and id (re-activated
--        if it was off), so a checkout page already open keeps working;
--      - an active slot not in the list is DEACTIVATED, never deleted (orders
--        snapshot their slot, and a customer mid-checkout with its id gets the
--        existing slot_unavailable answer);
--      - a new one is inserted.
--    Rules: 1 to 12 slots, HH:MM whole minutes, end after start, at least 30
--    and at most 720 minutes long, no two overlapping, no duplicates. Empty is
--    refused: no slot at all would stop every checkout, and earliest_slot_time
--    would keep a stale value (closing days is the calendar's job).
--    After the write the statement trigger has set earliest_slot_time to the
--    first start; the function checks that it did (defence against the two
--    ever drifting) and returns both.
-- 2. fn_admin_set_order_rules(p_values): any of
--    payment_pending_expiry_hours_standard (1..72),
--    payment_pending_expiry_hours_custom_cake (1..168),
--    day_limited_threshold_pct (1..99), whole numbers. The bounds are also in
--    trg_app_settings_guard (N11) for every writer. A value equal to the
--    seeded default is still recorded the first time (updated_by was null), so
--    the screen can tell a PRD default from Yuval's decision. Expiry hours
--    apply to orders created after the change (fn_create_standard_order and
--    fn_approve_custom_cake_request read them at creation; those functions are
--    not changed here).
-- Both functions: aal2 admin only, audited with from/to (SEC-017).

BEGIN;

-- ------------------------------------------------------------
-- 1. Time slots
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "time_slots_admin_write" ON time_slots;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE time_slots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION fn_admin_set_time_slots(p_slots JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_item JSONB;
  v_start TIME;
  v_end TIME;
  v_new JSONB := '[]'::jsonb;
  v_before JSONB;
  v_after JSONB;
  v_first TIME;
  v_earliest TEXT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' OR jsonb_array_length(p_slots) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'time_slots_invalid';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_slots) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 2
       OR (v_item ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR (v_item ->> 'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'time_slots_invalid';
    END IF;
    v_start := (v_item ->> 'start')::time;
    v_end := (v_item ->> 'end')::time;
    IF v_end <= v_start OR v_end - v_start < interval '30 minutes' OR v_end - v_start > interval '12 hours' THEN
      RAISE EXCEPTION 'time_slots_invalid';
    END IF;
    v_new := v_new || jsonb_build_object('s', v_start, 'e', v_end);
  END LOOP;
  -- No duplicates and no overlap (touching ends, 10:00-12:00 then 12:00-14:00, are fine).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_new) WITH ORDINALITY AS a(v, i),
         jsonb_array_elements(v_new) WITH ORDINALITY AS b(v, i)
    WHERE a.i <> b.i AND (a.v ->> 's')::time < (b.v ->> 'e')::time AND (b.v ->> 's')::time < (a.v ->> 'e')::time
  ) THEN
    RAISE EXCEPTION 'time_slots_overlap';
  END IF;

  PERFORM 1 FROM time_slots ORDER BY id FOR UPDATE;
  v_before := (SELECT COALESCE(jsonb_agg(jsonb_build_object('start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI')) ORDER BY start_time), '[]'::jsonb)
               FROM time_slots WHERE is_active);

  UPDATE time_slots t SET is_active = false
  WHERE t.is_active AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_new) AS n(s TIME, e TIME) WHERE n.s = t.start_time AND n.e = t.end_time);
  UPDATE time_slots t SET is_active = true
  WHERE NOT t.is_active AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_new) AS n(s TIME, e TIME) WHERE n.s = t.start_time AND n.e = t.end_time);
  INSERT INTO time_slots (start_time, end_time)
  SELECT n.s, n.e FROM jsonb_to_recordset(v_new) AS n(s TIME, e TIME)
  ON CONFLICT (start_time, end_time) DO NOTHING;

  v_after := (SELECT jsonb_agg(jsonb_build_object('id', id, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI')) ORDER BY start_time)
              FROM time_slots WHERE is_active);

  -- api-003's invariant: earliest_slot_time is the first active start.
  v_first := (SELECT min(start_time) FROM time_slots WHERE is_active);
  v_earliest := (SELECT value #>> '{}' FROM app_settings WHERE key = 'earliest_slot_time');
  IF v_earliest IS DISTINCT FROM to_char(v_first, 'HH24:MI') THEN
    RAISE EXCEPTION 'fn_admin_set_time_slots: earliest_slot_time % does not match first slot %', v_earliest, v_first;
  END IF;

  IF v_before IS DISTINCT FROM (SELECT jsonb_agg(e - 'id') FROM jsonb_array_elements(v_after) e) THEN
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'settings.time_slots_updated', 'time_slots', NULL,
      jsonb_build_object('from', v_before, 'to', (SELECT jsonb_agg(e - 'id') FROM jsonb_array_elements(v_after) e)));
  END IF;

  RETURN jsonb_build_object('slots', v_after, 'earliest_slot_time', v_earliest);
END;
$$;
COMMENT ON FUNCTION fn_admin_set_time_slots IS 'settings-slots: aal2 admin makes the active time_slots equal to p_slots ([{start,end}] HH:MM, 1..12, 30 min..12 h, no overlap). Same slot keeps its id; removed ones are deactivated, never deleted. Checks earliest_slot_time = first start after the write. Audited settings.time_slots_updated with from/to.';
REVOKE EXECUTE ON FUNCTION fn_admin_set_time_slots(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_set_time_slots(JSONB) TO authenticated;

-- ------------------------------------------------------------
-- 2. Order rules
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_set_order_rules(p_values JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_allowed CONSTANT TEXT[] := ARRAY['payment_pending_expiry_hours_standard', 'payment_pending_expiry_hours_custom_cake', 'day_limited_threshold_pct'];
  v_key TEXT;
  v_new JSONB;
  v_old JSONB;
  v_old_by UUID;
  v_changed JSONB := '{}'::jsonb;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' OR p_values = '{}'::jsonb THEN
    RAISE EXCEPTION 'settings_invalid_input';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT v_key = ANY(v_allowed) THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    IF jsonb_typeof(p_values -> v_key) <> 'number' OR (p_values ->> v_key) !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'settings_invalid_value: %', v_key;
    END IF;
  END LOOP;

  PERFORM 1 FROM app_settings WHERE key = ANY(v_allowed) ORDER BY key FOR UPDATE;
  FOR v_key IN SELECT jsonb_object_keys(p_values) ORDER BY 1 LOOP
    v_new := p_values -> v_key;
    SELECT value, updated_by INTO v_old, v_old_by FROM app_settings WHERE key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_invalid_input';
    END IF;
    IF v_old IS DISTINCT FROM v_new OR v_old_by IS NULL THEN
      -- trg_app_settings_guard raises setting_out_of_range: <key> outside the bounds.
      UPDATE app_settings SET value = v_new, updated_by = auth.uid() WHERE key = v_key;
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('from', v_old, 'to', v_new));
    END IF;
  END LOOP;

  IF v_changed <> '{}'::jsonb THEN
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'settings.order_rules_updated', 'app_settings', NULL,
      jsonb_build_object('changed', v_changed));
  END IF;
  RETURN (SELECT jsonb_object_agg(key, value) FROM app_settings WHERE key = ANY(v_allowed));
END;
$$;
COMMENT ON FUNCTION fn_admin_set_order_rules IS 'settings-slots: aal2 admin sets payment_pending_expiry_hours_standard (1..72), payment_pending_expiry_hours_custom_cake (1..168), day_limited_threshold_pct (1..99). Records a first confirmation of a default too. Audited settings.order_rules_updated with from/to.';
REVOKE EXECUTE ON FUNCTION fn_admin_set_order_rules(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_set_order_rules(JSONB) TO authenticated;

COMMIT;
