-- Independent check (dispatcher, 2026-09-25): admin functions reject a
-- non-admin caller and an admin without aal2, and accept an admin with aal2.
\set ON_ERROR_STOP 0
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-00000000000a','admin@test'),('00000000-0000-0000-0000-00000000000c','cust@test');
INSERT INTO admins (id, display_name) VALUES ('00000000-0000-0000-0000-00000000000a','Test Admin');
SET ROLE authenticated;
-- 1. customer with aal2 tries to set capacity: must fail
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000c","aal":"aal2","role":"authenticated"}',false);
SELECT 'T1_customer_set_capacity' AS t, fn_admin_set_day_capacity('2026-10-01',300,420,false);
-- 2. admin without aal2: must fail
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal1","role":"authenticated"}',false);
SELECT 'T2_admin_aal1_set_capacity' AS t, fn_admin_set_day_capacity('2026-10-01',300,420,false);
-- 3. admin with aal2: must succeed
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal2","role":"authenticated"}',false);
SELECT 'T3_admin_aal2_set_capacity' AS t, (fn_admin_set_day_capacity('2026-10-01',300,420,false)).day;
-- 4. customer tries mark paid on any id: must fail with admin_aal2_required
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000c","aal":"aal2","role":"authenticated"}',false);
SELECT 'T4_customer_mark_paid' AS t, fn_mark_order_paid(gen_random_uuid());
-- 5. anon direct write to ledger: must fail
RESET ROLE; SET ROLE anon;
UPDATE capacity_day_ledger SET oven_minutes_total = 0;
RESET ROLE;
-- 6-8 (api-009): clear error codes instead of a raw CHECK violation, and anon cannot call it.
UPDATE capacity_day_ledger SET oven_minutes_reserved = 100 WHERE day = '2026-10-01';
SET ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal2","role":"authenticated"}',false);
SELECT 'T6_total_below_reserved' AS t, fn_admin_set_day_capacity('2026-10-01',50,420,false);
SELECT 'T7_invalid_minutes' AS t, fn_admin_set_day_capacity('2026-10-02',-1,420,false);
SELECT 'T7b_manual_source' AS t, (fn_admin_set_day_capacity('2026-10-01',100,420,true)).source;
RESET ROLE; SET ROLE anon;
SELECT 'T8_anon_set_capacity' AS t, fn_admin_set_day_capacity('2026-10-03',1,1,false);
RESET ROLE;
-- 9-12 (api-007): delivery zones are written only through the audited functions.
SET ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal2","role":"authenticated"}',false);
SELECT 'T9_admin_create_zone' AS t, fn_admin_create_delivery_zone('T9 zone', 35, ARRAY['T9 city']) ->> 'name';
SELECT 'T10_city_in_other_zone' AS t, fn_admin_create_delivery_zone('T10 zone', 35, ARRAY['T9 city']);
INSERT INTO delivery_zones (name) VALUES ('T11 direct');
RESET ROLE; SET ROLE anon;
SELECT 'T12_anon_create_zone' AS t, fn_admin_create_delivery_zone('T12', 1, '{}');
RESET ROLE;
SELECT 'T12b_zone_audited=' || count(*) AS t FROM audit_log WHERE action = 'delivery_zone.created' AND actor_id = '00000000-0000-0000-0000-00000000000a';
