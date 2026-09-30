-- DEV demo data (Ran, 2026-09-29): fake business details, hours, weekly
-- capacity, delivery zones and products, so the DEV site can be seen working.
-- DEV only, never PROD. Every value is invented. Every demo row id starts with
-- 'dddddddd-', and output/db/demo/dev-demo-wipe.sql removes all of it before
-- Yuval enters her real data.
BEGIN;

-- Business details (s.14C) shown in the footer and on /business
UPDATE app_settings SET value = to_jsonb(v.val)
FROM (VALUES
  ('business_name', 'המאפייה של יובל (דמו)'),
  ('business_owner_name', 'יובל ישראלי (דמו)'),
  ('business_registration_number', '000000018'),
  ('business_address', 'רחוב הדוגמה 1, תל אביב (דמו)'),
  ('business_phone', '050-0000000'),
  ('business_whatsapp', '050-0000000'),
  ('business_email', 'demo@example.test'),
  ('payment_link_bit', 'https://example.test/demo-bit'),
  ('payment_link_paybox', 'https://example.test/demo-paybox')
) AS v(key, val)
WHERE app_settings.key = v.key;

-- Time slots (the trigger mirrors the earliest start into earliest_slot_time)
INSERT INTO time_slots (id, start_time, end_time) VALUES
  ('dddddddd-0000-0000-0003-000000000001', '10:00', '12:00'),
  ('dddddddd-0000-0000-0003-000000000002', '12:00', '14:00'),
  ('dddddddd-0000-0000-0003-000000000003', '14:00', '16:00'),
  ('dddddddd-0000-0000-0003-000000000004', '16:00', '18:00')
ON CONFLICT DO NOTHING;

-- Weekly pattern: Sunday to Thursday full days, Friday short, Saturday closed.
-- Sized so a mixed demo cart fits the 35% single-order cap (SEC-005): 35% of 900 = 315 minutes.
INSERT INTO capacity_weekly_pattern (weekday, is_working_day, oven_minutes_total, work_minutes_total) VALUES
  (0, true, 900, 900), (1, true, 900, 900), (2, true, 900, 900), (3, true, 900, 900),
  (4, true, 900, 900), (5, true, 450, 450), (6, false, 0, 0)
ON CONFLICT (weekday) DO UPDATE SET is_working_day = EXCLUDED.is_working_day,
  oven_minutes_total = EXCLUDED.oven_minutes_total, work_minutes_total = EXCLUDED.work_minutes_total;
SELECT fn_materialize_capacity_from_pattern();

-- Delivery zones (flat fee per group of cities)
INSERT INTO delivery_zones (id, name, fee_displayed) VALUES
  ('dddddddd-0000-0000-0002-000000000001', 'מרכז (דמו)', 25.00),
  ('dddddddd-0000-0000-0002-000000000002', 'שרון (דמו)', 35.00)
ON CONFLICT (id) DO NOTHING;
INSERT INTO delivery_zone_cities (id, zone_id, city) VALUES
  ('dddddddd-0000-0000-0004-000000000001', 'dddddddd-0000-0000-0002-000000000001', 'תל אביב'),
  ('dddddddd-0000-0000-0004-000000000002', 'dddddddd-0000-0000-0002-000000000001', 'רמת גן'),
  ('dddddddd-0000-0000-0004-000000000003', 'dddddddd-0000-0000-0002-000000000001', 'גבעתיים'),
  ('dddddddd-0000-0000-0004-000000000004', 'dddddddd-0000-0000-0002-000000000001', 'בני ברק'),
  ('dddddddd-0000-0000-0004-000000000005', 'dddddddd-0000-0000-0002-000000000002', 'רמת השרון'),
  ('dddddddd-0000-0000-0004-000000000006', 'dddddddd-0000-0000-0002-000000000002', 'הרצליה'),
  ('dddddddd-0000-0000-0004-000000000007', 'dddddddd-0000-0000-0002-000000000002', 'רעננה'),
  ('dddddddd-0000-0000-0004-000000000008', 'dddddddd-0000-0000-0002-000000000002', 'כפר סבא')
ON CONFLICT DO NOTHING;

-- Products (prices, oven and work minutes are invented)
INSERT INTO products (id, name, description, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost,
                      ingredients, allergens, allergens_may_contain, allergens_confirmed, photo_alt, is_available, is_published) VALUES
  ('dddddddd-0000-0000-0001-000000000001', 'עוגת שוקולד', 'עוגת שוקולד עשירה עם גנאש ודובדבנים, 10 מנות', 160, 'per_batch', 50, 40,
   'שוקולד מריר, חמאה, ביצים, סוכר, קמח, שמנת, דובדבנים', ARRAY['gluten','eggs','dairy'], ARRAY[]::text[], true, 'עוגת שוקולד עם דובדבנים על צלחת', true, true),
  ('dddddddd-0000-0000-0001-000000000002', 'קרואסון חמאה', 'קרואסון צרפתי בחמאה, נאפה בבוקר', 14, 'per_unit', 2, 3,
   'קמח, חמאה, חלב, שמרים, סוכר, מלח', ARRAY['gluten','dairy'], ARRAY[]::text[], true, 'קרואסון חמאה זהוב', true, true),
  ('dddddddd-0000-0000-0001-000000000003', 'טארט לימון', 'בצק פריך שקדים, קרם לימון ומרנג שרוף', 120, 'per_batch', 35, 45,
   'קמח, חמאה, שקדים, ביצים, סוכר, לימון', ARRAY['gluten','eggs','dairy','almonds'], ARRAY[]::text[], true, 'טארט לימון עם מרנג', true, true),
  ('dddddddd-0000-0000-0001-000000000004', 'פאי תפוחים', 'תפוחים בקינמון ברשת בצק חמאה', 110, 'per_batch', 55, 30,
   'קמח, חמאה, תפוחים, סוכר, קינמון', ARRAY['gluten','dairy'], ARRAY[]::text[], true, 'פאי תפוחים עם רשת בצק', true, true),
  ('dddddddd-0000-0000-0001-000000000005', 'עוגיות חמאה, קופסה של 12', 'עוגיות חמאה עם ריבת פטל', 60, 'per_batch', 20, 25,
   'קמח, חמאה, סוכר, ביצים, ריבת פטל', ARRAY['gluten','eggs','dairy'], ARRAY['nuts'], true, 'עוגיות חמאה עם ריבה', true, true),
  ('dddddddd-0000-0000-0001-000000000006', 'בבקה שוקולד', 'בצק שמרים עם מילוי שוקולד', 65, 'per_batch', 40, 30,
   'קמח, שמרים, חמאה, ביצים, שוקולד, סוכר', ARRAY['gluten','eggs','dairy'], ARRAY['nuts','sesame'], true, 'בבקה שוקולד בתבנית', true, true),
  ('dddddddd-0000-0000-0001-000000000007', 'מקרונים, מארז 6', 'מקרונים בטעמי פטל, פיסטוק ולימון', 54, 'per_batch', 15, 50,
   'אבקת שקדים, חלבון ביצה, סוכר, חמאה', ARRAY['almonds','eggs','dairy'], ARRAY['nuts'], true, 'מקרונים צבעוניים', true, true),
  ('dddddddd-0000-0000-0001-000000000008', 'עוגת גבינה', 'עוגת גבינה אפויה עם רוטב פירות יער', 140, 'per_batch', 70, 30,
   'גבינה לבנה, ביצים, סוכר, שמנת, קמח, חמאה, פירות יער', ARRAY['gluten','eggs','dairy'], ARRAY[]::text[], true, 'עוגת גבינה עם פירות יער', false, true)
ON CONFLICT (id) DO NOTHING;

COMMIT;
