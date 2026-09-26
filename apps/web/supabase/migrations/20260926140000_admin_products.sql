-- Migration: 20260926140000_admin_products
-- DDD context: Catalog. Task: client-006 (admin products), US-12, US-1,
-- SEC-011 (catalog photos), SEC-017 (audit), compliance-spec.md section 10
-- (allergens) and Rule 33 items 11-16 (alt text for every product photo).
--
-- Admin writes to the catalog go through SECURITY DEFINER functions that check
-- aal2, validate, and write an audit row in the same transaction:
--   fn_admin_create_product(p_product JSONB)
--   fn_admin_update_product(p_product_id, p_patch JSONB)   key present = set it
--   fn_admin_delete_product(p_product_id)                  soft delete
--   fn_admin_add_product_photo(p_product_id, p_storage_path, p_alt_text)
--   fn_admin_update_product_photo(p_product_id, p_photo_id, p_alt_text, p_make_primary)
--   fn_admin_delete_product_photo(p_product_id, p_photo_id)
-- Direct INSERT/UPDATE/DELETE on products and product_photos by
-- `authenticated` is revoked (the policies that allowed an aal2 admin to
-- write are dropped), so no catalog change can skip the audit log. SELECT
-- stays as it was: the public catalog reads published rows as anon (RLS).
--
-- Money and capacity. These functions write products.price_displayed and the
-- minute costs; they compute nothing. The readers of those columns are
-- fn_create_standard_order (price and minutes x quantity, snapshotted onto
-- the order and its lines) and fn_public_day_availability (does one unit fit
-- on a day). An existing order keeps its own snapshot: order_items
-- (product_name_snapshot, unit_price_displayed, line_total_displayed) and
-- orders (oven_minutes_cost, work_minutes_cost, the ledger amounts
-- fn_release_order_capacity gives back). So a later edit of a product never
-- changes an order already placed; regression.products checks it.
--
-- Alt text (the accessibility statement says "a product cannot be published
-- without it"). The alt text now lives on each photo (product_photos.alt_text)
-- instead of the single products.photo_alt, and the DB refuses:
--   * publishing a product while any of its photos has no alt text,
--   * adding a photo without alt text to a published product, or clearing it.
-- Both are triggers, so they hold for every writer, not only these functions.
-- products.photo_alt stays (the catalog falls back to it for old rows) but is
-- no longer required to publish. A product with no photo may be published;
-- the catalog then shows its neutral placeholder.
--
-- Allergens: when an edit changes the ingredients or any allergen field and
-- does not confirm again in the same call, allergens_confirmed turns false.
-- A published product must stay confirmed (the existing CHECK), so such an
-- edit on a published product is refused until Yuval ticks the box again.
--
-- Photos (SEC-011) never reach the DB as bytes: the server re-encodes the
-- upload and writes the public object with the service key, then records its
-- path here with the admin's own JWT. The path must be
-- products/<product id>/<uuid>.jpg, the only shape the server writes.
--
-- Also: the private bucket `product-photos-staging` where the admin's browser
-- PUTs the original through a signed upload URL (Netlify function bodies are
-- too small for phone photos). Nothing in it is ever public.

BEGIN;

-- ------------------------------------------------------------
-- table rules
-- ------------------------------------------------------------
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_check;
ALTER TABLE products ADD CONSTRAINT products_published_requires_allergens_confirmed
  CHECK (NOT is_published OR allergens_confirmed);
ALTER TABLE products ADD CONSTRAINT products_deleted_not_published
  CHECK (deleted_at IS NULL OR NOT is_published);

COMMENT ON COLUMN products.photo_alt IS
  'Legacy product-level alt text, used by the catalog only as a fallback. Since 20260926140000 each photo carries its own alt text (product_photos.alt_text), required to publish.';

-- A published product: every photo has alt text. Raised from both sides.
CREATE OR REPLACE FUNCTION fn_products_publish_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_published AND EXISTS (
    SELECT 1 FROM product_photos ph
    WHERE ph.product_id = NEW.id AND (ph.alt_text IS NULL OR btrim(ph.alt_text) = '')
  ) THEN
    RAISE EXCEPTION 'product_photo_alt_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fn_product_photos_alt_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.alt_text IS NULL OR btrim(NEW.alt_text) = '')
     AND EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.is_published) THEN
    RAISE EXCEPTION 'product_photo_alt_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_publish_guard BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION fn_products_publish_guard();
CREATE TRIGGER trg_product_photos_alt_guard BEFORE INSERT OR UPDATE ON product_photos
  FOR EACH ROW EXECUTE FUNCTION fn_product_photos_alt_guard();

REVOKE EXECUTE ON FUNCTION fn_products_publish_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_product_photos_alt_guard() FROM PUBLIC, anon, authenticated;

-- No direct writes from the Data API: every change is audited by the functions below.
DROP POLICY IF EXISTS "products_admin_write" ON products;
DROP POLICY IF EXISTS "product_photos_admin_write" ON product_photos;
REVOKE INSERT, UPDATE, DELETE ON TABLE products FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE product_photos FROM authenticated, anon;

-- ------------------------------------------------------------
-- helpers (not granted to anyone)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_product_json(p_product_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'description', p.description,
    'price', p.price_displayed,
    'cost_basis', p.cost_basis,
    'oven_minutes', p.oven_minutes_cost,
    'work_minutes', p.work_minutes_cost,
    'ingredients', p.ingredients,
    'allergens', to_jsonb(p.allergens),
    'may_contain', to_jsonb(p.allergens_may_contain),
    'allergen_notes', p.allergen_notes,
    'allergens_confirmed', p.allergens_confirmed,
    'is_available', p.is_available,
    'is_published', p.is_published,
    'updated_at', p.updated_at,
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', ph.id, 'storage_path', ph.storage_path, 'alt_text', ph.alt_text, 'position', ph.position)
                       ORDER BY ph.position, ph.created_at)
      FROM product_photos ph WHERE ph.product_id = p.id), '[]'::jsonb))
  FROM products p WHERE p.id = p_product_id AND p.deleted_at IS NULL
$$;

-- Trimmed text of length min..max, or NULL when empty and p_nullable.
-- Raises product_invalid: <field>.
CREATE OR REPLACE FUNCTION fn_product_text(p_value JSONB, p_field TEXT, p_max INT, p_nullable BOOLEAN) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    IF p_nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'product_invalid: %', p_field;
  END IF;
  IF jsonb_typeof(p_value) <> 'string' THEN
    RAISE EXCEPTION 'product_invalid: %', p_field;
  END IF;
  v := btrim(p_value #>> '{}');
  IF v = '' THEN
    IF p_nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'product_invalid: %', p_field;
  END IF;
  IF char_length(v) > p_max THEN
    RAISE EXCEPTION 'product_invalid: %', p_field;
  END IF;
  RETURN v;
END;
$$;

-- Allergen list: array of 0..20 strings, each 1..40 after trimming, no
-- duplicates kept, in the order given. Known codes (lib/shared/catalog/allergens.ts)
-- or Yuval's own words; the DB does not tell them apart.
CREATE OR REPLACE FUNCTION fn_product_allergen_list(p_value JSONB, p_field TEXT) RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_out TEXT[] := '{}';
  v_el JSONB;
  v TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 20 THEN
    RAISE EXCEPTION 'product_invalid: %', p_field;
  END IF;
  FOR v_el IN SELECT e FROM jsonb_array_elements(p_value) AS e LOOP
    IF jsonb_typeof(v_el) <> 'string' THEN
      RAISE EXCEPTION 'product_invalid: %', p_field;
    END IF;
    v := regexp_replace(btrim(v_el #>> '{}'), '\s+', ' ', 'g');
    IF char_length(v) NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'product_invalid: %', p_field;
    END IF;
    IF NOT v = ANY (v_out) THEN
      v_out := v_out || v;
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- Applies a patch to a product row. Only the keys present change; an unknown
-- key is refused, so a typo never silently does nothing.
CREATE OR REPLACE FUNCTION fn_product_apply_patch(p_row products, p_patch JSONB) RETURNS products
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r products := p_row;
  v_key TEXT;
  v_num NUMERIC;
  v_allergens_touched BOOLEAN := false;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'product_invalid: body';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key NOT IN ('name', 'description', 'price', 'cost_basis', 'oven_minutes', 'work_minutes', 'ingredients',
                     'allergens', 'may_contain', 'allergen_notes', 'allergens_confirmed', 'is_available', 'is_published') THEN
      RAISE EXCEPTION 'product_invalid: %', v_key;
    END IF;
  END LOOP;

  IF p_patch ? 'name' THEN r.name := fn_product_text(p_patch->'name', 'name', 80, false); END IF;
  IF p_patch ? 'description' THEN r.description := fn_product_text(p_patch->'description', 'description', 1000, true); END IF;
  IF p_patch ? 'price' THEN
    IF jsonb_typeof(p_patch->'price') <> 'number' THEN RAISE EXCEPTION 'product_invalid: price'; END IF;
    v_num := (p_patch->>'price')::numeric;
    IF v_num < 0 OR v_num > 10000 OR v_num <> round(v_num, 2) THEN RAISE EXCEPTION 'product_invalid: price'; END IF;
    r.price_displayed := v_num;
  END IF;
  IF p_patch ? 'cost_basis' THEN
    IF p_patch->>'cost_basis' IS NULL OR p_patch->>'cost_basis' NOT IN ('per_unit', 'per_batch') THEN
      RAISE EXCEPTION 'product_invalid: cost_basis';
    END IF;
    r.cost_basis := p_patch->>'cost_basis';
  END IF;
  IF p_patch ? 'oven_minutes' THEN
    IF jsonb_typeof(p_patch->'oven_minutes') <> 'number' THEN RAISE EXCEPTION 'product_invalid: oven_minutes'; END IF;
    v_num := (p_patch->>'oven_minutes')::numeric;
    IF v_num < 0 OR v_num > 1440 OR v_num <> trunc(v_num) THEN RAISE EXCEPTION 'product_invalid: oven_minutes'; END IF;
    r.oven_minutes_cost := v_num::int;
  END IF;
  IF p_patch ? 'work_minutes' THEN
    IF jsonb_typeof(p_patch->'work_minutes') <> 'number' THEN RAISE EXCEPTION 'product_invalid: work_minutes'; END IF;
    v_num := (p_patch->>'work_minutes')::numeric;
    IF v_num < 0 OR v_num > 1440 OR v_num <> trunc(v_num) THEN RAISE EXCEPTION 'product_invalid: work_minutes'; END IF;
    r.work_minutes_cost := v_num::int;
  END IF;
  IF p_patch ? 'ingredients' THEN
    r.ingredients := fn_product_text(p_patch->'ingredients', 'ingredients', 2000, true);
    v_allergens_touched := v_allergens_touched OR r.ingredients IS DISTINCT FROM p_row.ingredients;
  END IF;
  IF p_patch ? 'allergens' THEN
    r.allergens := fn_product_allergen_list(p_patch->'allergens', 'allergens');
    v_allergens_touched := v_allergens_touched OR r.allergens IS DISTINCT FROM p_row.allergens;
  END IF;
  IF p_patch ? 'may_contain' THEN
    r.allergens_may_contain := fn_product_allergen_list(p_patch->'may_contain', 'may_contain');
    v_allergens_touched := v_allergens_touched OR r.allergens_may_contain IS DISTINCT FROM p_row.allergens_may_contain;
  END IF;
  IF p_patch ? 'allergen_notes' THEN
    r.allergen_notes := fn_product_text(p_patch->'allergen_notes', 'allergen_notes', 500, true);
    v_allergens_touched := v_allergens_touched OR r.allergen_notes IS DISTINCT FROM p_row.allergen_notes;
  END IF;
  IF p_patch ? 'allergens_confirmed' THEN
    IF jsonb_typeof(p_patch->'allergens_confirmed') <> 'boolean' THEN RAISE EXCEPTION 'product_invalid: allergens_confirmed'; END IF;
    r.allergens_confirmed := (p_patch->>'allergens_confirmed')::boolean;
  ELSIF v_allergens_touched THEN
    -- The allergen information changed and nobody confirmed the new version.
    r.allergens_confirmed := false;
  END IF;
  IF p_patch ? 'is_available' THEN
    IF jsonb_typeof(p_patch->'is_available') <> 'boolean' THEN RAISE EXCEPTION 'product_invalid: is_available'; END IF;
    r.is_available := (p_patch->>'is_available')::boolean;
  END IF;
  IF p_patch ? 'is_published' THEN
    IF jsonb_typeof(p_patch->'is_published') <> 'boolean' THEN RAISE EXCEPTION 'product_invalid: is_published'; END IF;
    r.is_published := (p_patch->>'is_published')::boolean;
  END IF;

  -- Named errors before the table constraints would raise raw ones.
  IF r.is_published AND NOT r.allergens_confirmed THEN
    RAISE EXCEPTION 'product_allergens_not_confirmed';
  END IF;
  RETURN r;
END;
$$;

-- Only the fields that changed, as {field: {from, to}}, for the audit row.
CREATE OR REPLACE FUNCTION fn_product_audit_diff(p_before JSONB, p_after JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(k, jsonb_build_object('from', p_before->k, 'to', p_after->k)), '{}'::jsonb)
  FROM jsonb_object_keys(p_after) AS k
  WHERE k NOT IN ('photos', 'updated_at') AND (p_before->k) IS DISTINCT FROM (p_after->k)
$$;

REVOKE EXECUTE ON FUNCTION fn_admin_product_json(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_product_text(JSONB, TEXT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_product_allergen_list(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_product_apply_patch(products, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_product_audit_diff(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- products: create, update, soft delete
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_admin_create_product(p_product JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  r products;
  v_after JSONB;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_product IS NULL OR jsonb_typeof(p_product) <> 'object'
     OR NOT (p_product ?& ARRAY['name', 'price', 'cost_basis', 'oven_minutes', 'work_minutes']) THEN
    RAISE EXCEPTION 'product_invalid: required';
  END IF;
  -- Defaults of a new row, then the patch on top of them.
  r.id := uuid_generate_v4();
  r.allergens := '{}';
  r.allergens_may_contain := '{}';
  r.allergens_confirmed := false;
  r.is_available := true;
  r.is_published := false;
  r := fn_product_apply_patch(r, p_product);

  INSERT INTO products (id, name, description, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost,
                        ingredients, allergens, allergens_may_contain, allergen_notes, allergens_confirmed,
                        is_available, is_published)
  VALUES (r.id, r.name, r.description, r.price_displayed, r.cost_basis, r.oven_minutes_cost, r.work_minutes_cost,
          r.ingredients, r.allergens, r.allergens_may_contain, r.allergen_notes, r.allergens_confirmed,
          r.is_available, r.is_published);

  v_after := fn_admin_product_json(r.id);
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product.created', 'product', r.id::text,
    v_after - 'photos' - 'updated_at');
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION fn_admin_update_product(p_product_id UUID, p_patch JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_old products;
  r products;
  v_before JSONB;
  v_after JSONB;
  v_diff JSONB;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  SELECT * INTO v_old FROM products WHERE id = p_product_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  v_before := fn_admin_product_json(p_product_id);
  r := fn_product_apply_patch(v_old, p_patch);

  UPDATE products
  SET name = r.name, description = r.description, price_displayed = r.price_displayed, cost_basis = r.cost_basis,
      oven_minutes_cost = r.oven_minutes_cost, work_minutes_cost = r.work_minutes_cost, ingredients = r.ingredients,
      allergens = r.allergens, allergens_may_contain = r.allergens_may_contain, allergen_notes = r.allergen_notes,
      allergens_confirmed = r.allergens_confirmed, is_available = r.is_available, is_published = r.is_published
  WHERE id = p_product_id;

  v_after := fn_admin_product_json(p_product_id);
  v_diff := fn_product_audit_diff(v_before, v_after);
  IF v_diff <> '{}'::jsonb THEN
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product.updated', 'product', p_product_id::text,
      jsonb_build_object('changes', v_diff));
  END IF;
  RETURN v_after;
END;
$$;

-- Soft delete: the row stays for history (order lines keep their own
-- snapshot and a plain product_id, no FK). Unpublished in the same write.
-- Photos stay in the bucket and in product_photos with the row.
CREATE OR REPLACE FUNCTION fn_admin_delete_product(p_product_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_before JSONB;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  PERFORM 1 FROM products WHERE id = p_product_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  v_before := fn_admin_product_json(p_product_id);
  UPDATE products SET deleted_at = now(), is_published = false WHERE id = p_product_id;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product.deleted', 'product', p_product_id::text,
    jsonb_build_object('name', v_before->'name', 'was_published', v_before->'is_published'));
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- photos
-- ------------------------------------------------------------
-- The server wrote products/<product id>/<uuid>.jpg to the public bucket
-- (re-encoded, no EXIF) before calling this. At most 6 photos a product.
CREATE OR REPLACE FUNCTION fn_admin_add_product_photo(p_product_id UUID, p_storage_path TEXT, p_alt_text TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_alt TEXT := NULLIF(btrim(COALESCE(p_alt_text, '')), '');
  v_id UUID;
  v_position SMALLINT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  PERFORM 1 FROM products WHERE id = p_product_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  IF p_storage_path IS NULL
     OR p_storage_path !~ ('^products/' || p_product_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') THEN
    RAISE EXCEPTION 'product_photo_path_invalid';
  END IF;
  IF v_alt IS NOT NULL AND char_length(v_alt) > 200 THEN
    RAISE EXCEPTION 'product_invalid: alt_text';
  END IF;
  IF (SELECT count(*) FROM product_photos WHERE product_id = p_product_id) >= 6 THEN
    RAISE EXCEPTION 'product_photo_limit_reached';
  END IF;
  SELECT COALESCE(max(position) + 1, 0) INTO v_position FROM product_photos WHERE product_id = p_product_id;
  INSERT INTO product_photos (product_id, storage_path, alt_text, position)
  VALUES (p_product_id, p_storage_path, v_alt, v_position)
  RETURNING id INTO v_id;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product_photo.added', 'product', p_product_id::text,
    jsonb_build_object('photo_id', v_id, 'storage_path', p_storage_path, 'alt_text', v_alt));
  RETURN fn_admin_product_json(p_product_id);
END;
$$;

-- p_alt_text NULL = unchanged, '' = clear (refused on a published product).
-- p_make_primary moves the photo first; the catalog card shows the first photo.
CREATE OR REPLACE FUNCTION fn_admin_update_product_photo(p_product_id UUID, p_photo_id UUID, p_alt_text TEXT DEFAULT NULL, p_make_primary BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_photo product_photos;
  v_alt TEXT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  SELECT ph.* INTO v_photo FROM product_photos ph JOIN products p ON p.id = ph.product_id
  WHERE ph.id = p_photo_id AND ph.product_id = p_product_id AND p.deleted_at IS NULL
  FOR UPDATE OF ph;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_photo_not_found';
  END IF;
  IF p_alt_text IS NOT NULL THEN
    v_alt := NULLIF(btrim(p_alt_text), '');
    IF v_alt IS NOT NULL AND char_length(v_alt) > 200 THEN
      RAISE EXCEPTION 'product_invalid: alt_text';
    END IF;
    IF v_alt IS DISTINCT FROM v_photo.alt_text THEN
      UPDATE product_photos SET alt_text = v_alt WHERE id = p_photo_id;
      PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product_photo.updated', 'product', v_photo.product_id::text,
        jsonb_build_object('photo_id', p_photo_id, 'alt_text', jsonb_build_object('from', v_photo.alt_text, 'to', v_alt)));
    END IF;
  END IF;
  IF COALESCE(p_make_primary, false) THEN
    WITH ordered AS (
      SELECT id, (row_number() OVER (ORDER BY (id = p_photo_id) DESC, position, created_at) - 1)::smallint AS pos
      FROM product_photos WHERE product_id = v_photo.product_id
    )
    UPDATE product_photos ph SET position = o.pos FROM ordered o WHERE ph.id = o.id AND ph.position IS DISTINCT FROM o.pos;
    PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product_photo.made_primary', 'product', v_photo.product_id::text,
      jsonb_build_object('photo_id', p_photo_id));
  END IF;
  RETURN fn_admin_product_json(v_photo.product_id);
END;
$$;

-- Returns the storage path so the server can delete the public object too.
CREATE OR REPLACE FUNCTION fn_admin_delete_product_photo(p_product_id UUID, p_photo_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_photo product_photos;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  SELECT ph.* INTO v_photo FROM product_photos ph JOIN products p ON p.id = ph.product_id
  WHERE ph.id = p_photo_id AND ph.product_id = p_product_id AND p.deleted_at IS NULL
  FOR UPDATE OF ph;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_photo_not_found';
  END IF;
  DELETE FROM product_photos WHERE id = p_photo_id;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'product_photo.deleted', 'product', v_photo.product_id::text,
    jsonb_build_object('photo_id', p_photo_id, 'storage_path', v_photo.storage_path));
  RETURN jsonb_build_object('storage_path', v_photo.storage_path, 'product', fn_admin_product_json(v_photo.product_id));
END;
$$;

-- Callable by nobody by default (20260925121300); the explicit REVOKE is a
-- second line of defence. Grant only `authenticated`: the admin API calls them
-- with the admin's own JWT, and each function checks aal2 itself.
REVOKE EXECUTE ON FUNCTION fn_admin_create_product(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_update_product(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_delete_product(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_add_product_photo(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_update_product_photo(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_admin_delete_product_photo(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_create_product(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_update_product(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_delete_product(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_add_product_photo(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_update_product_photo(UUID, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_admin_delete_product_photo(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------
-- staging bucket for the admin's original uploads (SEC-011)
-- ------------------------------------------------------------
-- Private, same limits as the other two buckets. Only the server touches it,
-- with the service key: it issues a signed upload URL, reads the upload back,
-- re-encodes it into product-photos and deletes the original. No
-- storage.objects policy exists for anon or authenticated. On a plain
-- postgres (output/db/tests/run.sh) there is no storage schema: skipped.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema not present (plain postgres): staging bucket skipped';
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('product-photos-staging', 'product-photos-staging', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
END $$;

COMMIT;
