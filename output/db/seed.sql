-- seed.sql
-- LOCAL DEV ONLY. Every value below is fake/synthetic (Rule SEC-020: DEV
-- never holds real PII). Do not run against DEV or PROD Supabase projects.
-- Requires an auth.users row to exist for the admin/customer before running
-- (Supabase local stack creates these via `supabase db reset` + the Auth
-- admin API, not via raw SQL insert into auth.users).

BEGIN;

-- Fake admin (Yuval), assumes auth.users id below was created via
-- `supabase auth admin create-user` in the local stack first.
INSERT INTO admins (id, display_name, mfa_enrolled_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'יובל (דמו מקומי)', now())
ON CONFLICT (id) DO NOTHING;

-- Fake registered customer.
INSERT INTO customers (id, name, phone, email, marketing_opt_in, privacy_notice_version)
VALUES ('00000000-0000-0000-0000-000000000002', 'דנה כהן (דמו)', '+972500000001', 'demo-dana@example.test', false, 'privacy-2026-10-v1')
ON CONFLICT (id) DO NOTHING;

-- Delivery zones
INSERT INTO delivery_zones (id, name, fee_displayed) VALUES
  ('10000000-0000-0000-0000-000000000001', 'אזור מרכז (דמו)', 25.00),
  ('10000000-0000-0000-0000-000000000002', 'אזור צפון (דמו)', 40.00)
ON CONFLICT (id) DO NOTHING;

INSERT INTO delivery_zone_cities (zone_id, city) VALUES
  ('10000000-0000-0000-0000-000000000001', 'תל אביב (דמו)'),
  ('10000000-0000-0000-0000-000000000001', 'רמת גן (דמו)'),
  ('10000000-0000-0000-0000-000000000002', 'חיפה (דמו)')
ON CONFLICT (city) DO NOTHING;

-- Products
INSERT INTO products (id, name, description, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost,
                       ingredients, allergens, allergens_confirmed, photo_alt, is_available, is_published) VALUES
  ('20000000-0000-0000-0000-000000000001', 'קרואסון חמאה (דמו)', 'קרואסון צרפתי קלאסי', 14.00, 'per_unit', 2, 3,
   'קמח, חמאה, שמרים, מלח', ARRAY['gluten', 'dairy'], true, 'קרואסון חמאה זהוב על צלחת עץ', true, true),
  ('20000000-0000-0000-0000-000000000002', 'עוגת שוקולד (דמו)', 'עוגת שוקולד עשירה, 8 מנות', 120.00, 'per_batch', 45, 30,
   'קמח, שוקולד, ביצים, סוכר, חמאה', ARRAY['gluten', 'dairy', 'eggs'], true, 'עוגת שוקולד פרוסה על מגש הגשה', true, true)
ON CONFLICT (id) DO NOTHING;

-- Capacity: today and tomorrow, generous pools for local testing of the
-- race/overbooking scenario in db/qa/capacity_invariant_test.sql.
INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total)
VALUES
  (CURRENT_DATE + 2, 240, 240),
  (CURRENT_DATE + 3, 60, 60) -- deliberately small pool, for the concurrency test
ON CONFLICT (day) DO NOTHING;

COMMIT;
