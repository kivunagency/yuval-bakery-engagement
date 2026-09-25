-- Migration: 20260925120200_catalog_context
-- DDD context: Catalog
-- Description: products (aggregate root) and product_photos.

BEGIN;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  price_displayed NUMERIC(10,2) NOT NULL CHECK (price_displayed >= 0),
  cost_basis TEXT NOT NULL CHECK (cost_basis IN ('per_unit', 'per_batch')),
  oven_minutes_cost INT NOT NULL CHECK (oven_minutes_cost >= 0),
  work_minutes_cost INT NOT NULL CHECK (work_minutes_cost >= 0),
  ingredients TEXT,
  allergens TEXT[] NOT NULL DEFAULT '{}',
  allergens_confirmed BOOLEAN NOT NULL DEFAULT false,
  allergen_notes TEXT,
  photo_alt TEXT,
  is_available BOOLEAN NOT NULL DEFAULT true, -- out of stock / paused toggle (US-1 AC)
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  -- compliance-spec.md section 12: a product cannot go live without an
  -- explicit allergen confirmation and alt text (Rule 33 item 11-16).
  CHECK (NOT is_published OR (allergens_confirmed AND photo_alt IS NOT NULL AND photo_alt <> ''))
);
COMMENT ON TABLE products IS 'DDD context: Catalog. Product aggregate root.';
COMMENT ON COLUMN products.allergens IS 'Closed list + free text per compliance-spec.md section 10. Empty is a valid explicit choice only via allergens_confirmed, never an implicit "none".';

CREATE TABLE product_photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE, -- same context
  storage_path TEXT NOT NULL,
  alt_text TEXT,
  position SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE product_photos IS 'DDD context: Catalog. Public bucket, admin-write-only (SEC-011). storage_path is a path, never a full URL (SEC-010 pattern reused for consistency).';

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_photos ENABLE ROW LEVEL SECURITY;

-- Public catalog read: only published, non-deleted, available-or-not (the UI
-- shows paused products as visibly disabled per US-1, so is_available is not
-- filtered here, only is_published/deleted_at).
CREATE POLICY "products_select_published" ON products FOR SELECT
  USING (deleted_at IS NULL AND (is_published OR is_admin_aal2()));
CREATE POLICY "products_admin_write" ON products FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

CREATE POLICY "product_photos_select_public" ON product_photos FOR SELECT
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.deleted_at IS NULL AND (p.is_published OR is_admin_aal2())));
CREATE POLICY "product_photos_admin_write" ON product_photos FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

-- Data API exposure. Catalog is genuinely public-read content (no PII), so
-- anon SELECT is the deliberate exception, not the default.
GRANT SELECT ON TABLE products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE products TO authenticated;
GRANT SELECT ON TABLE product_photos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_photos TO authenticated;

COMMIT;
