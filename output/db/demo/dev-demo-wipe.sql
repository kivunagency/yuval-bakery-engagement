-- Removes the DEV demo data of dev-demo-data.sql (every row whose id starts
-- with 'dddddddd-', the demo weekly pattern and the capacity days it wrote),
-- and resets the business details to unset. Run before Yuval enters her real
-- data. Orders placed on DEV against demo products must be deleted first
-- (order_items keep a snapshot, but reference the product).
BEGIN;
DELETE FROM product_photos WHERE product_id::text LIKE 'dddddddd-%';
DELETE FROM products WHERE id::text LIKE 'dddddddd-%';
DELETE FROM delivery_zone_cities WHERE id::text LIKE 'dddddddd-%';
DELETE FROM delivery_zones WHERE id::text LIKE 'dddddddd-%';
UPDATE time_slots SET is_active = false WHERE id::text LIKE 'dddddddd-%';
DELETE FROM capacity_day_ledger WHERE source = 'pattern' AND oven_minutes_reserved = 0 AND work_minutes_reserved = 0;
DELETE FROM capacity_weekly_pattern;
UPDATE app_settings SET value = 'null'::jsonb
WHERE key IN ('business_name','business_owner_name','business_registration_number','business_address',
              'business_phone','business_whatsapp','business_email','payment_link_bit','payment_link_paybox');
COMMIT;
