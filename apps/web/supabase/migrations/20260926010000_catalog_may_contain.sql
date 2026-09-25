-- Migration: 20260926010000_catalog_may_contain
-- DDD context: Catalog (api-001, public catalog read)
-- Description: the design (design-tokens.md, "כרטיס מוצר") shows two kinds of
-- allergen chip: "contains" (solid border) and "may contain" (dashed border,
-- full text "may contain nuts"). products.allergens holds only "contains", so
-- the second list gets its own column instead of a naming convention inside
-- one array. Same closed-list-plus-free-text shape as products.allergens
-- (compliance-spec.md section 10). Default empty: existing rows keep meaning
-- exactly what they meant before.
--
-- No new grant: anon already reads published products through RLS
-- (products_select_published), and the admin product CRUD writes this column
-- through the same products_admin_write policy as every other column.

BEGIN;

ALTER TABLE products
  ADD COLUMN allergens_may_contain TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN products.allergens_may_contain IS
  'Allergen codes the product MAY contain (cross-contact), shown as dashed "may contain" chips. products.allergens stays the "contains" list. Same code list as products.allergens (compliance-spec.md section 10).';

COMMIT;
