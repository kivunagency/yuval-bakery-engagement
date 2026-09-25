-- rls_policies.sql
-- Consolidated reference of every RLS policy in this schema, for audit and
-- for boaz/cyber-iam's Phase 4.6 review. Every policy here is ALSO created
-- inline in its owning context migration; this file is a read-only mirror,
-- do not apply it standalone (it will error on CREATE POLICY IF the policy
-- already exists; migrations are the source of truth, this is the reading
-- copy). Grouped by table, in migration order.

-- ============================================================
-- admins (Identity)
-- ============================================================
-- SELECT: is_admin_aal2()                          -- roster visible to any logged-in admin
-- UPDATE: id = auth.uid() AND is_admin_aal2()       -- self-service profile fields only
-- INSERT/DELETE: none via Data API (console/service-role provisioning only)

-- ============================================================
-- customers (Identity)
-- ============================================================
-- SELECT: id = auth.uid() OR is_admin_aal2()
-- UPDATE: id = auth.uid() [USING] ; id = auth.uid() AND deleted_at IS NULL [WITH CHECK]
-- INSERT: none via Data API (fn_* creates the row server-side alongside auth.users)

-- ============================================================
-- consent_events (Identity, append-only)
-- ============================================================
-- SELECT: customer_id = auth.uid() OR is_admin_aal2()
-- INSERT/UPDATE/DELETE: none via Data API. INSERT only via fn_set_marketing_consent
-- (SECURITY DEFINER). UPDATE/DELETE additionally blocked by trg_consent_events_append_only.

-- ============================================================
-- privacy_requests (Identity)
-- ============================================================
-- ALL: is_admin_aal2() [USING + WITH CHECK]   -- admin-only, guest requests logged on their behalf

-- ============================================================
-- capacity_day_ledger (Capacity)
-- ============================================================
-- SELECT: true                                -- public read, no PII, needed pre-auth for checkout UI
-- INSERT/UPDATE/DELETE: none via Data API at all (SEC-001 names this table
-- explicitly). All writes through fn_admin_set_day_capacity / fn_reserve_capacity /
-- fn_release_order_capacity (all SECURITY DEFINER).

-- ============================================================
-- products, product_photos (Catalog)
-- ============================================================
-- products SELECT:      deleted_at IS NULL AND (is_published OR is_admin_aal2())
-- products ALL (admin):  is_admin_aal2() [USING + WITH CHECK]
-- product_photos SELECT: EXISTS(published product) OR is_admin_aal2() via subquery
-- product_photos ALL (admin): is_admin_aal2()

-- ============================================================
-- delivery_zones, delivery_zone_cities, delivery_list_links (Delivery)
-- ============================================================
-- delivery_zones SELECT: is_active OR is_admin_aal2()
-- delivery_zones ALL (admin): is_admin_aal2()
-- delivery_zone_cities SELECT: true            -- needed to populate the checkout city picker pre-auth
-- delivery_zone_cities ALL (admin): is_admin_aal2()
-- delivery_list_links ALL: is_admin_aal2()      -- no anon/authenticated access at all in MVP (SEC-016)

-- ============================================================
-- orders, order_items, order_attempt_log (Ordering)
-- ============================================================
-- orders SELECT:  customer_id = auth.uid() OR is_admin_aal2()
--   NOTE: guest orders (customer_id IS NULL) are INVISIBLE to this policy by
--   design. Guest access to "my order" is via /api/orders/[token] using the
--   service role (bypasses RLS), which re-implements the SEC-003 token check
--   in application code. This is the one deliberate, documented exception to
--   "RLS is the row layer": guest identity does not exist as a Postgres role.
-- orders UPDATE (admin): is_admin_aal2() [USING + WITH CHECK]
--   BUT status changes are additionally blocked by trg_orders_guard_status_change
--   unless app.allow_status_change is set by a fn_* function, so even an admin's
--   direct UPDATE cannot silently change status without going through the audited path.
-- orders INSERT: none via Data API (fn_create_standard_order / fn_approve_custom_cake_request only)
-- order_items SELECT: via parent order's policy (EXISTS subquery)
-- order_items INSERT/UPDATE/DELETE: none via Data API
-- order_attempt_log: RLS enabled, ZERO policies -> deny-all, even to admin.
--   Internal counter only, read via app_settings-driven admin views in
--   lib/server/, not directly.

-- ============================================================
-- custom_cake_requests, custom_cake_photos (CustomCake)
-- ============================================================
-- custom_cake_requests SELECT: customer_id = auth.uid() OR is_admin_aal2()
-- custom_cake_requests UPDATE (admin): is_admin_aal2()
-- custom_cake_requests INSERT: none via Data API (fn_submit_custom_cake_request
--   in the application layer, rate-limited like standard orders per SEC-005)
-- custom_cake_photos ALL: is_admin_aal2()       -- Yuval's review material only

-- ============================================================
-- push_subscriptions (Notification)
-- ============================================================
-- ALL: is_admin_aal2() [USING] ; is_admin_aal2() AND admin_id = auth.uid() [WITH CHECK]

-- ============================================================
-- audit_log, app_settings, cron_heartbeats (Shared)
-- ============================================================
-- audit_log SELECT: is_admin_aal2()             -- INSERT only via fn_write_audit_log
-- app_settings SELECT: true                      -- some values drive public price wording
-- app_settings UPDATE: is_admin_aal2()
-- cron_heartbeats SELECT: is_admin_aal2()        -- written only by the scheduled function (service role)

-- ============================================================
-- Verification queries boaz/cyber-iam run at Phase 4.6 (SEC-021)
-- ============================================================
-- 1. Direct anon write attempt is rejected:
--    SET ROLE anon; INSERT INTO orders (...) VALUES (...);  -- expect: permission denied for table orders
-- 2. Every table has RLS enabled:
--    SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
--    -- expect: zero rows
-- 3. Every function in public is REVOKEd from PUBLIC/anon/authenticated except the named GRANTs:
--    SELECT p.proname, r.rolname FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace, pg_roles r
--    WHERE n.nspname='public' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
--      AND r.rolname IN ('anon','authenticated');
--    -- expect: only the 7 functions named in the GRANT EXECUTE block of
--    -- 20260925120800_functions_capacity_and_orders.sql
