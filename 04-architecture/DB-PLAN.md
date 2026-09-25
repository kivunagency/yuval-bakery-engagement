---
client: yuval-bakery
doc: DB-PLAN
owner: dba
status: draft, executed against a throwaway local Postgres (see section 6)
created: 2026-09-25
inputs: compliance-spec.md, threat-model.md, decisions/ADR-002-capacity-ledger.md, domain-map.md, BRIEF.md, 05-prds/PRD-01-ordering-app.md, tasks.json
links: [[agents/dba]] [[agents/rotem]] [[agents/erez]] [[agents/alex]] [[yuval-bakery]]
---

# DB-PLAN: YuvalBakery

Engine: Supabase Postgres (ADR-001). DDD mode: on (domain-map.md exists). Table
naming follows the aggregate roots in domain-map.md section 1.

## 1. Tables per bounded context

| Context | Tables | Aggregate root |
|---|---|---|
| Identity | `admins`, `customers`, `consent_events`, `privacy_requests` | AdminUser, Customer |
| Capacity | `capacity_day_ledger` | DayCapacity |
| Catalog | `products`, `product_photos` | Product |
| Delivery | `delivery_zones`, `delivery_zone_cities`, `delivery_list_links` | DeliveryZone |
| Ordering | `orders`, `order_items`, `order_attempt_log`, `order_lookup_attempts` | Order |
| CustomCake | `custom_cake_requests`, `custom_cake_photos` | CustomCakeRequest |
| Notification | `push_subscriptions` | (Supporting, no own aggregate) |
| Shared (cross-cutting) | `audit_log`, `app_settings`, `cron_heartbeats` | none, named explicitly in compliance-spec.md section 12 and threat-model.md SEC-017 as agency-wide |

Migration files are grouped by context, one file per context, in dependency
order (Identity + RLS helpers first, since every later table's policies call
`is_admin_aal2()`):

```
db/migrations/
  20260925120000_identity_and_helpers.sql
  20260925120100_capacity_context.sql
  20260925120200_catalog_context.sql
  20260925120300_delivery_context.sql
  20260925120400_ordering_context.sql
  20260925120500_customcake_context.sql
  20260925120600_notification_context.sql
  20260925120700_shared_audit_and_settings.sql
  20260925120800_functions_capacity_and_orders.sql
```

Timestamps are provisional (authored 2026-09-25 evening). Per Rule 28, the
dispatcher/git-foreman must re-check these against every unmerged remote
branch at PR-open time and renumber on collision; nothing here is claimed as
final until the PR opens.

## 2. Cross-context references

Per the DDD rule this build runs under: FKs within one context are real FKs
with `ON DELETE CASCADE`; FKs across contexts are plain UUID columns with a
`-- cross-context ref: {Context}` comment, no JOIN-capable constraint. Applied
here:

| Column | Owning context | Points at | Why no FK |
|---|---|---|---|
| `orders.customer_id` | Ordering | Identity | guest orders have no customer_id at all; RLS on `customers` cannot cover a guest row anyway (SEC-003) |
| `orders.delivery_zone_id` | Ordering | Delivery | cross-context, read-only lookup at checkout |
| `orders.custom_cake_request_id` | Ordering | CustomCake | set once, by `fn_approve_custom_cake_request` |
| `order_items.product_id` | Ordering | Catalog | order lines snapshot name/price so a later catalog edit never rewrites history; the FK would create a false dependency anyway |
| `custom_cake_requests.customer_id` | CustomCake | Identity | same guest-order reasoning as orders |
| `custom_cake_requests.order_id` | CustomCake | Ordering | the cross-context write domain-map.md section 2 documents by name |
| `push_subscriptions.admin_id` | Notification | Identity | enforced by RLS + SECURITY DEFINER function, not referential integrity |

No context here is marked ACL in the Context Map (domain-map.md section 4), so
none of these needed to be event/API-only; all are same-database, same-
transaction UUID references, just without a FK constraint.

Within-context FKs (real, `ON DELETE CASCADE`, unlisted above): `order_items
-> orders`, `custom_cake_photos -> custom_cake_requests`, `product_photos ->
products`, `delivery_zone_cities -> delivery_zones`.

## 3. The capacity invariant and the SEC-007 fix

**Invariant `capacity_never_negative`** (ADR-002, named so a test can assert
it directly): for every `(day, resource)` pair, `reserved <= total`, at every
moment, under any concurrency.

**Mechanism** (unchanged from ADR-002): `fn_reserve_capacity` is a single
conditional `UPDATE ... WHERE reserved + cost <= total ... RETURNING`, atomic
without an explicit row lock. If it returns no row, the caller's whole
transaction rolls back (never a partial order).

**SEC-007, the bug erez found in ADR-002's original release mechanism**:
`GREATEST(0, reserved - cost)` stops the ledger going negative but does NOT
stop a double release from happening. A retried sweep, or cancel racing
expire on the same order, could each independently decrement the ledger,
freeing capacity a second order legitimately still holds. Silent overbooking,
not a crash, which is the dangerous kind.

**The fix**: release is gated by the ORDER's own state transition, not by
ledger arithmetic. `fn_release_order_capacity(order_id, new_status)` does:

```sql
UPDATE orders
SET status = :new_status, ...
WHERE id = :order_id AND status = 'payment_pending'
RETURNING *;
```

This `UPDATE` can match at most one time per order, structurally: the first
caller to run it moves the row out of `payment_pending`, so every subsequent
caller's `WHERE status = 'payment_pending'` finds zero rows and does nothing.
Only if this returns a row does the function touch `capacity_day_ledger` at
all, decrementing by the exact `oven_minutes_cost`/`work_minutes_cost`
**snapshotted on the order row at creation time** (not recomputed from
`products`, which may have changed since). No `GREATEST(0, ...)` guard is
needed on the decrement itself: if it somehow went negative under this
scheme, the `CHECK` constraint on `capacity_day_ledger` aborts the whole
transaction loudly, rather than silently clamping to zero (Rule 20).

Both `fn_expire_stale_orders` (job-001, the scheduled sweep) and
`fn_cancel_order` (admin action) call `fn_release_order_capacity`, so a
sweep retry racing a manual cancel on the same order is safe by
construction, not by a "don't run it twice" instruction to whoever wires the
cron job.

**Test that asserts it (executed, see section 6)**: create an order, cancel
it, then call `fn_release_order_capacity` a second time on the same order id
as if a late/retried sweep had fired. Assert: first call returns `true` and
decrements the ledger once; second call returns `false` and the ledger is
byte-identical to after the first call. This reproduces the exact race
threat-model.md section 2.9 describes.

```sql
-- The assertion amit should run in qa-001, worded as SEC-007 states it:
-- release1 = true, release2 = false, ledger unchanged between the two.
```

## 4. Order state machine

```
cart (client-only) -> payment_pending -> paid -> fulfilled
payment_pending -> expired    (auto, fn_expire_stale_orders, job-001)
payment_pending -> cancelled  (fn_cancel_order, admin)
```

Custom cake, precedes the above:
```
pending_review -> approved (fn_approve_custom_cake_request: creates the Order
                             AND reserves Capacity in the SAME transaction)
pending_review -> declined  (terminal, fn_decline_custom_cake_request)
```

`orders.status` can ONLY change through the functions in
`20260925120800_functions_capacity_and_orders.sql`: `trg_orders_guard_status_change`
blocks any other `UPDATE` that touches `status`, even one the admin's own RLS
policy would otherwise allow, unless the function sets
`app.allow_status_change = true` for that statement first (transaction-local
via `set_config(..., true)`, so it never leaks to a later, unrelated
statement in the same session). This exists so SEC-017's audit trail can
never be silently bypassed by a plain admin `UPDATE orders SET status = ...`.

**US-0c addition (2026-09-25, coordinator/Ran)**: a second guard,
`trg_orders_guard_fulfillment`, blocks the `paid -> fulfilled` transition
specifically when the order has no known email (`guest_email` is null AND
either there is no `customer_id` or that customer has no email on file) AND
`confirmation_delivered_at` is still null. The written order confirmation
(s.14C(b)) must reach the customer, by email or by a WhatsApp-delivered link
Yuval confirms manually, before an order can be marked fulfilled. This is
enforced in the trigger, not only in application code, per the instruction
that accompanied the requirement.

## 5. Capacity abuse limits (SEC-005) and where they live

All five layers threat-model.md section 3.1 requires are implemented inside
`fn_create_standard_order`, in one transaction, values read from
`app_settings` (Yuval-tunable, floored/ceilinged at the application layer per
compliance-spec.md section 12):

1. Turnstile: application layer (Next.js), not the DB's concern.
2. Rate limit, fails closed: `order_attempt_log` insert happens BEFORE the
   capacity check, in the same transaction; if the DB is unreachable, order
   creation is unreachable too.
3. Single-order cap (35% default, `single_order_capacity_pct`).
4. Unpaid-holds cap (70% default, `unpaid_holds_capacity_pct`), checked
   against the LIVE ledger row read inside the same transaction, never a
   frozen snapshot (the 2026-08-14 learned rule this engagement inherits:
   never use a snapshot sum as an allocation ceiling in a financial/capacity
   migration).
5. Yuval's response tools (release-all-unpaid-for-day, block phone/IP,
   holds-percentage indicator): `client-007`/`client-009`, read `app_settings`
   and `orders`/`capacity_day_ledger` directly; no new table needed beyond
   what already exists.

## 6. US-0d: find-my-order (phone + order_number, never phone alone)

`fn_lookup_order_by_phone_and_number(ip, phone, order_number)`:
- Rate-limited per IP and per phone (`order_lookup_attempts`, fails closed,
  same pattern as SEC-005's `order_attempt_log`).
- Matches ONLY when both the phone AND the order_number are correct together.
  A wrong phone with the right number, or the right phone with a wrong
  number, both return the identical empty result as "neither exists" (SEC-003's
  uniform-response principle, extended from token access to this lookup).
- Returns a masked view only: order_number, status, delivery_date,
  fulfillment_type, and `masked_address` (city plus the first character of
  the street only, never the full address or delivery notes).
- `order_lookup_attempts` rows are purged after 90 days by
  `fn_purge_old_lookup_attempts` (`order_lookup_attempts_retention_days` in
  `app_settings`), run from the same daily job as SEC-028's retention sweep.

## 7. Confirmation PDF and 24-month link (US-0c)

`orders` carries: `confirmation_channel` (`email` | `whatsapp_manual`),
`confirmation_delivered_at`, `confirmation_pdf_path` (private bucket path,
never a public URL, same pattern as SEC-010's inspiration-photo pipeline),
`confirmation_pdf_sha256` (content hash, so a later request for the same
order always serves byte-identical content, provably), and
`confirmation_link_token_hash` + `confirmation_link_expires_at` (a
signed/tokened link separate from the order's own `lookup_token_hash`,
because the two have different required lifetimes: the confirmation link
must stay valid at least 24 months, `lookup_token_hash` is scoped to 30 days
after fulfillment). A `CHECK` constraint on `orders` enforces the 24-month
floor at the schema level, not only in the function that sets it.
`fn_record_order_confirmation_delivered` is the sole writer of all five
columns, called once, right after the PDF is generated and sent.

## 8. Security posture summary (SEC-001 verified, see section 9)

- Zero direct write access for `anon`/`authenticated` on `orders`,
  `order_items`, `capacity_day_ledger`, `custom_cake_requests`,
  `custom_cake_photos`, `order_attempt_log`, `order_lookup_attempts`. All
  mutation goes through the 9 functions granted `EXECUTE` in
  `20260925120800_functions_capacity_and_orders.sql`; every other function in
  `public` is `REVOKE`d from `PUBLIC`/`anon`/`authenticated` by default, then
  the exceptions are named explicitly.
- Guest identity does not exist as a Postgres role, so guest access to "my
  order" and "find my order" is exclusively through SECURITY DEFINER
  functions / the service-role-backed `/api/orders/[token]` route, never
  through an RLS policy keyed on `auth.uid()`. This is the one deliberate,
  documented departure from "RLS is the row layer for everything" in this
  schema, and it is documented everywhere it appears (this file,
  `rls_policies.sql`, the migration comments), not left implicit.
- Two admin-facing tables (`admins`, `customers`) and every admin-write policy
  require `is_admin_aal2()`, i.e. both admin-role membership (from the
  `admins` table, never `user_metadata`, per SEC-002) AND `aal2` on the JWT.
- Cron entry points (`fn_expire_stale_orders`, `fn_purge_old_lookup_attempts`)
  are granted to `service_role` explicitly: the blanket
  `REVOKE EXECUTE ... FROM PUBLIC` at the top of the lockdown section also
  revokes the default-for-everyone execute right `service_role` would
  otherwise have inherited, and that gap is closed in the same migration
  rather than left for someone to discover when the scheduled job 403s.

## 9. What was executed and what was not (Rule 20)

Executed against a throwaway `postgres:17` Docker container (not the
project's real Supabase local stack, which was busy running another
client's instance on this Mac at the time; a minimal `auth` schema stub
providing `auth.users`, `auth.uid()`, `auth.jwt()` and the `anon` /
`authenticated` / `service_role` roles was created first, since a plain
Postgres image has none of Supabase's GoTrue scaffolding). Container
destroyed after the run; nothing here reached any persistent environment.

Ran and PASSED:
1. All 9 migration files, in order, `ON_ERROR_STOP=1`, zero errors.
2. `indexes.sql`, zero errors.
3. `seed.sql` (after seeding two `auth.users` rows by hand, since
   `supabase auth admin create-user` is not part of a bare Postgres image),
   zero errors.
4. `SET ROLE anon` direct `INSERT` on `orders` rejected with
   `insufficient_privilege` (SEC-001).
5. `SET ROLE anon` direct `UPDATE` on `capacity_day_ledger` rejected with
   `insufficient_privilege` (SEC-001, the table SEC-001 names explicitly).
6. `capacity_never_negative`: two sequential `fn_reserve_capacity` calls that
   together exceed a 60/60 pool; first succeeds, second is rejected, ledger
   never exceeds total.
7. `fn_create_standard_order` end to end: rate-limit log write, server-side
   price/minute-cost computation from `products` (never from caller input),
   atomic reservation, order + order_items insert, all in one transaction.
   Verified the returned order's `oven_minutes_cost`/`work_minutes_cost`
   match the product's declared cost x quantity, and the ledger's
   `*_reserved` moved by exactly that amount.
8. **SEC-007, the fix this task exists to verify**: cancelled an order, then
   called `fn_release_order_capacity` a second time on the same order as a
   simulated late/retried sweep. First call returned `true` and decremented
   the ledger once; second call returned `false`; the ledger was
   byte-identical before and after the second call. Overbooking via double
   release is not possible by construction.
9. US-0c fulfillment guard: `fn_mark_order_fulfilled` raised
   `order_cannot_be_fulfilled_without_confirmation` for a no-email order
   with `confirmation_delivered_at` still null; succeeded immediately after
   `fn_record_order_confirmation_delivered` was called.
10. US-0d lookup: correct phone + correct order_number matched; correct
    phone + wrong order_number did not match; wrong phone + correct
    order_number did not match (uniform empty result in both failure cases);
    rate limit fired within the configured 10-per-hour window from one IP.
11. Verification queries from `rls_policies.sql` section "Verification
    queries": zero tables in `public` without RLS enabled; exactly the 9
    intended functions are `EXECUTE`-granted to `anon`/`authenticated`
    (listed in section 8 above), nothing else.

DID NOT RUN (explicitly, per Rule 20, not implied as passed):
- The real Supabase local stack (`supabase start` / `supabase db reset`)
  against this project's own config, since none exists yet in
  `output/` for this client (no `supabase/config.toml` has been generated by
  a prior phase). The throwaway-Postgres run above validates the SQL is
  correct Postgres and the invariants hold; it does NOT validate
  Supabase-specific behavior (PostgREST's actual RPC exposure of the granted
  functions, GoTrue's real JWT shape for `aal2`, Storage bucket policies for
  `product_photos`/`custom_cake_photos`). That validation belongs to
  whichever phase first runs `supabase init` for this client and should
  re-run this same set of assertions against it before Phase 4.6.
- True concurrent-session race testing (two simultaneous transactions
  racing for the last slot, as ADR-002's own acceptance test describes: "run
  N concurrent reservation attempts, verify exactly the number that fit
  succeed"). What was executed above is a sequential-call proof that the
  conditional `UPDATE` rejects a second reservation that would exceed the
  pool, which demonstrates the same SQL-level mechanism, but amit's qa-001
  should still run the actual concurrent-session version (e.g. two
  `psql` sessions or a Playwright-driven double-click) before Phase 4.6,
  since a sequential call cannot rule out every driver-level surprise a true
  race could.
- Storage bucket policies (`product-photos` public bucket,
  `custom-cake-inspiration` private bucket) are referenced in comments but
  not created here: bucket creation and Storage RLS are typically done via
  the Supabase dashboard or a separate `storage` migration once a project
  exists, not raw `public` schema SQL. Flagged so this is not silently
  assumed done.

[[agents/dba]] [[agents/rotem]] [[agents/erez]] [[agents/alex]] [[yuval-bakery]] [[ADR-002-capacity-ledger]] [[yuval-bakery/domain-map]]
