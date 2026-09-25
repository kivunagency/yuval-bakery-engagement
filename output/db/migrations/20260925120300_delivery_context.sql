-- Migration: 20260925120300_delivery_context
-- DDD context: Delivery
-- Description: delivery_zones, delivery_zone_cities (a city in at most one
-- zone), delivery_list_links (Phase 2 token-scoped share, built now so no
-- later migration is needed per compliance-spec.md section 12).

BEGIN;

CREATE TABLE delivery_zones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  fee_displayed NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee_displayed >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE delivery_zones IS 'DDD context: Delivery. DeliveryZone aggregate root. Flat fee by city group, no geocoding (US-6).';

CREATE TABLE delivery_zone_cities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zone_id UUID NOT NULL REFERENCES delivery_zones(id) ON DELETE CASCADE, -- same context
  city TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city) -- a city belongs to at most one zone, globally, per US-6 AC
);
COMMENT ON TABLE delivery_zone_cities IS 'DDD context: Delivery. UNIQUE(city) across ALL zones (not per zone) enforces "a city belongs to at most one zone" at the database level.';

CREATE TABLE delivery_list_links (
  token TEXT PRIMARY KEY, -- stored as a hash, generated server-side (SEC-016 pattern)
  delivery_date DATE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE delivery_list_links IS 'DDD context: Delivery. Phase 2 (phase2-005): a day-scoped, revocable, expiring link for the uncle-driver view. Not used by MVP (no public link ships in MVP per SEC-016), table exists now so Phase 2 needs no migration. The list itself is built at view time, never cached here (compliance-spec.md section 12).';

CREATE TRIGGER trg_delivery_zones_updated_at BEFORE UPDATE ON delivery_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_zone_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_list_links ENABLE ROW LEVEL SECURITY;

-- Public read needed at checkout to list zones/cities and show the fee before
-- payment (US-5 AC, rotem's pricing-transparency requirement). No PII here.
CREATE POLICY "delivery_zones_select_public" ON delivery_zones FOR SELECT
  USING (is_active OR is_admin_aal2());
CREATE POLICY "delivery_zones_admin_write" ON delivery_zones FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

CREATE POLICY "delivery_zone_cities_select_public" ON delivery_zone_cities FOR SELECT
  USING (true);
CREATE POLICY "delivery_zone_cities_admin_write" ON delivery_zone_cities FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

-- delivery_list_links: admin only, no anon/authenticated access at all in
-- MVP (SEC-016: no public link ships until Phase 2, and even then the token
-- is checked server-side, not via the Data API).
CREATE POLICY "delivery_list_links_admin_only" ON delivery_list_links FOR ALL
  USING (is_admin_aal2())
  WITH CHECK (is_admin_aal2());

GRANT SELECT ON TABLE delivery_zones TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE delivery_zones TO authenticated;
GRANT SELECT ON TABLE delivery_zone_cities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE delivery_zone_cities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE delivery_list_links TO authenticated;
-- no anon grant on delivery_list_links: PII-adjacent, admin/service only.

COMMIT;
