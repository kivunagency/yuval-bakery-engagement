-- Migration: 20260926070000_delivery_zones_admin
-- DDD context: Delivery. Task: api-007 (admin part), US-6, SEC-017.
--
-- Admin writes to delivery zones go through three SECURITY DEFINER functions
-- that check aal2, validate, and write an audit row in the same transaction:
--   fn_admin_create_delivery_zone(name, fee, cities[])
--   fn_admin_update_delivery_zone(zone_id, name?, fee?, is_active?, cities[]?)
--   fn_admin_delete_delivery_zone(zone_id)
-- Direct INSERT/UPDATE/DELETE by `authenticated` is revoked, so no zone
-- change can skip the audit log (SEC-017 lists zones). SELECT grants stay:
-- checkout reads zones and cities (public read, api-007 public part).
--
-- Money: the zone fee is read by fn_create_standard_order (the only SQL
-- caller of delivery_zones.fee_displayed), which snapshots it onto the order
-- as delivery_fee_displayed. These functions only write the zone; they do not
-- change how any order total is computed, and an order keeps the fee it was
-- created with. The fee is whole shekels 0..1000 (Zod checks the same).
--
-- "A city belongs to at most one zone" stays the UNIQUE(city) constraint on
-- delivery_zone_cities. These functions check it first so the caller gets
-- delivery_city_in_other_zone: <city> instead of a raw unique violation.
-- City names are trimmed and inner whitespace collapsed before storing, so
-- "רמת  גן " and "רמת גן" are the same city.

BEGIN;

-- Zone names are unique, ignoring case and outer spaces.
CREATE UNIQUE INDEX delivery_zones_name_unique ON delivery_zones (lower(btrim(name)));

-- No direct writes from the Data API: every change is audited by the functions below.
DROP POLICY IF EXISTS "delivery_zones_admin_write" ON delivery_zones;
DROP POLICY IF EXISTS "delivery_zone_cities_admin_write" ON delivery_zone_cities;
REVOKE INSERT, UPDATE, DELETE ON TABLE delivery_zones FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE delivery_zone_cities FROM authenticated, anon;

-- ------------------------------------------------------------
-- helpers (not granted to anyone)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_normalize_city(p_city TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT regexp_replace(btrim(p_city), '\s+', ' ', 'g')
$$;

CREATE OR REPLACE FUNCTION fn_delivery_zone_json(p_zone_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', z.id,
    'name', z.name,
    'fee', z.fee_displayed,
    'is_active', z.is_active,
    'cities', COALESCE((SELECT jsonb_agg(c.city ORDER BY c.city) FROM delivery_zone_cities c WHERE c.zone_id = z.id), '[]'::jsonb))
  FROM delivery_zones z WHERE z.id = p_zone_id
$$;

-- Validates name, fee and cities. Returns the normalized city list.
-- Raises delivery_zone_invalid: <field> or delivery_city_in_other_zone: <city>.
CREATE OR REPLACE FUNCTION fn_delivery_zone_check(p_zone_id UUID, p_name TEXT, p_fee NUMERIC, p_cities TEXT[]) RETURNS TEXT[]
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_cities TEXT[];
  v_taken TEXT;
BEGIN
  IF p_name IS NOT NULL AND char_length(btrim(p_name)) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'delivery_zone_invalid: name';
  END IF;
  IF p_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM delivery_zones WHERE lower(btrim(name)) = lower(btrim(p_name)) AND id IS DISTINCT FROM p_zone_id
  ) THEN
    RAISE EXCEPTION 'delivery_zone_name_taken';
  END IF;
  IF p_fee IS NOT NULL AND (p_fee < 0 OR p_fee > 1000 OR p_fee <> trunc(p_fee)) THEN
    RAISE EXCEPTION 'delivery_zone_invalid: fee';
  END IF;
  IF p_cities IS NULL THEN
    RETURN NULL;
  END IF;
  IF cardinality(p_cities) > 100 THEN
    RAISE EXCEPTION 'delivery_zone_invalid: cities';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT fn_normalize_city(c)), '{}') INTO v_cities FROM unnest(p_cities) AS c;
  IF EXISTS (SELECT 1 FROM unnest(v_cities) AS c WHERE c IS NULL OR char_length(c) NOT BETWEEN 1 AND 60) THEN
    RAISE EXCEPTION 'delivery_zone_invalid: cities';
  END IF;
  SELECT c.city INTO v_taken FROM delivery_zone_cities c
  WHERE c.city = ANY (v_cities) AND c.zone_id IS DISTINCT FROM p_zone_id
  ORDER BY c.city LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'delivery_city_in_other_zone: %', v_taken;
  END IF;
  RETURN v_cities;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_normalize_city(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_delivery_zone_json(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_delivery_zone_check(UUID, TEXT, NUMERIC, TEXT[]) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- create
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_create_delivery_zone(p_name TEXT, p_fee NUMERIC, p_cities TEXT[] DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_cities TEXT[];
  v_id UUID;
  v_zone JSONB;
  v_constraint TEXT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_name IS NULL OR p_fee IS NULL THEN
    RAISE EXCEPTION 'delivery_zone_invalid: required';
  END IF;
  v_cities := fn_delivery_zone_check(NULL, p_name, p_fee, COALESCE(p_cities, '{}'));

  BEGIN
    INSERT INTO delivery_zones (name, fee_displayed) VALUES (btrim(p_name), p_fee) RETURNING id INTO v_id;
    INSERT INTO delivery_zone_cities (zone_id, city) SELECT v_id, c FROM unnest(v_cities) AS c;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent write took the name or a city between the check and the insert.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'delivery_zones_name_unique' THEN
      RAISE EXCEPTION 'delivery_zone_name_taken';
    END IF;
    RAISE EXCEPTION 'delivery_city_in_other_zone: %', (SELECT c.city FROM delivery_zone_cities c WHERE c.city = ANY (v_cities) ORDER BY c.city LIMIT 1);
  END;

  v_zone := fn_delivery_zone_json(v_id);
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'delivery_zone.created', 'delivery_zone', v_id::text,
    jsonb_build_object('name', v_zone->'name', 'fee', v_zone->'fee', 'cities', v_zone->'cities'));
  RETURN v_zone;
END;
$$;

-- ------------------------------------------------------------
-- update: NULL argument = leave unchanged. p_cities replaces the whole list.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_update_delivery_zone(
  p_zone_id UUID, p_name TEXT DEFAULT NULL, p_fee NUMERIC DEFAULT NULL, p_is_active BOOLEAN DEFAULT NULL, p_cities TEXT[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_before JSONB;
  v_after JSONB;
  v_cities TEXT[];
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  PERFORM 1 FROM delivery_zones WHERE id = p_zone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_zone_not_found';
  END IF;
  v_before := fn_delivery_zone_json(p_zone_id);
  v_cities := fn_delivery_zone_check(p_zone_id, p_name, p_fee, p_cities);

  BEGIN
    UPDATE delivery_zones
    SET name = COALESCE(btrim(p_name), name),
        fee_displayed = COALESCE(p_fee, fee_displayed),
        is_active = COALESCE(p_is_active, is_active)
    WHERE id = p_zone_id;
    IF v_cities IS NOT NULL THEN
      DELETE FROM delivery_zone_cities WHERE zone_id = p_zone_id AND city <> ALL (v_cities);
      INSERT INTO delivery_zone_cities (zone_id, city)
      SELECT p_zone_id, c FROM unnest(v_cities) AS c
      ON CONFLICT (city) DO NOTHING;
      -- ON CONFLICT hid a city a concurrent write gave to another zone: refuse.
      IF EXISTS (SELECT 1 FROM unnest(v_cities) AS c WHERE NOT EXISTS (
        SELECT 1 FROM delivery_zone_cities x WHERE x.city = c AND x.zone_id = p_zone_id)) THEN
        RAISE EXCEPTION 'delivery_city_in_other_zone: %', (SELECT c FROM unnest(v_cities) AS c WHERE NOT EXISTS (
          SELECT 1 FROM delivery_zone_cities x WHERE x.city = c AND x.zone_id = p_zone_id) LIMIT 1);
      END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'delivery_zone_name_taken';
  END;

  v_after := fn_delivery_zone_json(p_zone_id);
  IF v_after IS DISTINCT FROM v_before THEN
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'delivery_zone.updated', 'delivery_zone', p_zone_id::text,
      jsonb_build_object(
        'name', v_after->'name', 'fee', v_after->'fee', 'is_active', v_after->'is_active', 'cities', v_after->'cities',
        'previous', jsonb_build_object('name', v_before->'name', 'fee', v_before->'fee', 'is_active', v_before->'is_active', 'cities', v_before->'cities')));
  END IF;
  RETURN v_after;
END;
$$;

-- ------------------------------------------------------------
-- delete: orders keep their own snapshot of the fee (delivery_fee_displayed)
-- and their delivery_zone_id as a plain reference (no FK, cross-context).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_delete_delivery_zone(p_zone_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_before JSONB;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  v_before := fn_delivery_zone_json(p_zone_id);
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'delivery_zone_not_found';
  END IF;
  DELETE FROM delivery_zones WHERE id = p_zone_id;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'delivery_zone.deleted', 'delivery_zone', p_zone_id::text,
    jsonb_build_object('previous', jsonb_build_object('name', v_before->'name', 'fee', v_before->'fee', 'is_active', v_before->'is_active', 'cities', v_before->'cities')));
  RETURN true;
END;
$$;

-- This file sorts before 20260926090000 (default privileges), so on a fresh
-- database these functions are created while the old defaults still grant
-- EXECUTE to PUBLIC/anon/authenticated. Revoke explicitly, then grant only
-- `authenticated`: the admin API calls them with the admin's own JWT, and each
-- function checks aal2 itself.
REVOKE EXECUTE ON FUNCTION fn_admin_create_delivery_zone(TEXT, NUMERIC, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_update_delivery_zone(UUID, TEXT, NUMERIC, BOOLEAN, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_delete_delivery_zone(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_create_delivery_zone(TEXT, NUMERIC, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_update_delivery_zone(UUID, TEXT, NUMERIC, BOOLEAN, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_delete_delivery_zone(UUID) TO authenticated;

COMMIT;
