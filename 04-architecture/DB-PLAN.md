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

## 10. Fix round 2026-09-25 (coordinator review of f2477b2, then rotem's compliance-schema-review.md)

Migration: `db/migrations/20260925121000_capacity_auth_and_compliance_fixes.sql`,
applied atop the original 9 migrations, same unmerged PR (rotem's own
coordination note: apply after the capacity fixes, same PR or the next one).

### 10.1 BUG 1: the unpaid-holds cap wrongly counted paid orders

**Symptom**: once paid orders reached 70% of a day's capacity, EVERY new
order (even a tiny one, even though 30% of the day was still genuinely
free) was rejected with `unpaid_holds_capacity_cap_exceeded`. The last 30%
of every day could never be sold.

**Root cause**: `fn_create_standard_order` compared
`oven_minutes_reserved + new` (paid AND unpaid combined) against
`total * unpaid_holds_capacity_pct / 100`. The 70% cap is meant to bound
**unpaid** holds only (SEC-005's abuse-prevention purpose: a payment_pending
order that might never be paid should not be allowed to lock up the whole
day). A paid order is not an abuse risk; it is realized revenue.

**Second bug in the same code path**: the ledger was read (`SELECT * INTO
v_ledger`) BEFORE calling `fn_reserve_capacity`, with no lock between the
read and the write. Two concurrent unpaid orders could both read the same
"room available" snapshot and both pass the check, even though only one
should fit.

**Fix**: `capacity_day_ledger` gained `oven_minutes_unpaid_reserved` /
`work_minutes_unpaid_reserved`, maintained by `fn_reserve_capacity`
(increment), `fn_mark_order_paid` (decrement: the order stops being an
unpaid hold), and `fn_release_order_capacity` (decrement, only if the order
being released WAS payment_pending). The 70% check itself moved INSIDE
`fn_reserve_capacity`'s single atomic `UPDATE ... WHERE ...`, checked
against `*_unpaid_reserved` only, closing the race in the same fix as the
correctness bug (one atomic statement, no read-then-write gap).

**Invariant, stated so a test can assert it directly**:

```
unpaid_never_exceeds_cap: for every (day, resource), at every moment,
  oven_minutes_unpaid_reserved <= oven_minutes_total * unpaid_holds_capacity_pct / 100
  work_minutes_unpaid_reserved <= work_minutes_total * unpaid_holds_capacity_pct / 100
-- and, unlike the pre-fix version, this bound is evaluated against UNPAID
-- holds only; a day may be up to 100% reserved once orders are paid.
```

```sql
-- Test SQL (executed, see 10.6): mark paid orders up to 80% of a 100/100
-- day, then assert a NEW small unpaid order succeeds; then fill unpaid
-- holds to exactly 70 and assert the next unpaid order is rejected.
```

### 10.2 BUG 2: a paid order could never be cancelled

**Symptom**: `fn_cancel_order` routed through `fn_release_order_capacity`,
which only matched `status = 'payment_pending'`. Once an order was `paid`,
cancelling it returned `false`: the order stayed `paid` forever and its
oven/work minutes stayed held forever, even though Yuval needs to be able
to cancel a paid order (refund handled by her, outside the app) when a
customer cancels after paying, or she can no longer fulfil it.

**Fix**: capacity-holding statuses are now explicitly `payment_pending` AND
`paid` (documented here as the single source of truth). `expired` only ever
applies to `payment_pending` (the timeout is a pre-payment concept, it does
not apply once an order is paid). `cancelled` may apply to `payment_pending`
OR `paid`. `fulfilled` is terminal and does NOT release capacity (the bake
already happened; the time was genuinely spent). If a future
`in_preparation`/`ready` status is ever added to the state machine, it MUST
be added to `fn_release_order_capacity`'s `v_allowed_from` array explicitly;
it is not covered by assumption.

**SEC-007 idempotency, re-verified under the generalized transition**:
`fn_release_order_capacity` now takes a row lock (`SELECT ... FOR UPDATE`)
before deciding whether the order is in an allowed source status, both to
read the OLD status reliably (needed for the unpaid-bookkeeping decision:
was this order's capacity counted as "unpaid" or not) and so a concurrent
second caller (retried sweep, cancel racing expire on the SAME order) blocks
on the lock, then sees the already-updated status and returns `false`.
Cancelling a paid order, then cancelling it again, releases capacity exactly
once (tested, see 10.6).

### 10.3 CRITICAL: admin functions trusted a caller-supplied admin id

**Found by the coordinator reading the grants directly, not by a test.**
`fn_mark_order_paid`, `fn_mark_order_fulfilled`, `fn_cancel_order`,
`fn_approve_custom_cake_request`, `fn_decline_custom_cake_request`, and
`fn_admin_set_day_capacity` all took a `p_admin_id UUID` parameter, checked
only that the id existed in `admins`, and were `GRANT`ed to `authenticated`.
Every registered customer holds `authenticated`. Any customer who learned
Yuval's admin UUID (visible in `audit_log.actor_id`, `privacy_requests.
handled_by`, etc.) could call any of these AS IF they were Yuval: mark
orders paid, cancel orders, decline custom cakes, or zero a day's capacity.
`fn_set_marketing_consent` had the identical shape with `p_customer_id`.

**Fix**: every one of these functions now takes NO actor-identifying
parameter. The actor is always `auth.uid()` (the caller's own verified JWT
subject, which `SECURITY DEFINER` does not change: the JWT-derived session
GUCs are per-connection/request, not per-role), checked against
`is_admin_aal2()` (admin-role membership AND AAL2). `fn_set_marketing_consent`
keeps a `p_customer_id` parameter (an admin legitimately needs to record
consent on a GUEST's behalf when Yuval processes a phone request, so
"derive everything from auth.uid(), no parameter at all" does not fit this
one case) but now requires `p_customer_id = auth.uid() OR is_admin_aal2() OR
current_user = 'service_role'`, checked inside the function before any write.

**A second, related bug found only by actually testing this as a
non-superuser role** (not in any review; found while writing the RED/GREEN
test below): the blanket `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public
FROM PUBLIC/anon/authenticated` in the original functions migration ran
AFTER `is_admin()`/`has_aal2()`/`is_admin_aal2()` were created, and nothing
ever re-granted them. Every RLS policy that calls `is_admin_aal2()` (most of
them) would raise `permission denied for function is_admin_aal2` for a REAL
`anon`/`authenticated` caller, not only an attacker. Running every earlier
test as the `postgres` superuser never surfaced this, because superuser
bypasses function-execute checks entirely. Fixed by granting `EXECUTE` on
all three helper functions to `anon, authenticated`.

### 10.4 rotem's compliance-schema-review.md: B1-B5

Full detail lives in that document; summarized here as the schema-level
contract each fix now provides.

- **B1 (retention/deletion were not executable)**: `orders`' two identity/
  address CHECK constraints gained a `pii_purged_at IS NOT NULL OR ...`
  escape hatch (previously, anonymizing ANY order with a delivery address,
  or ANY guest order, violated a CHECK and rolled the whole deletion back).
  `fn_anonymize_order` / `fn_anonymize_custom_cake_request` are the one
  canonical definition (Rule 19) of "scrub PII off X", called both by
  `fn_anonymize_customer` (registered path) and directly by
  `fn_run_retention_sweep` for GUEST orders/requests, which have no
  `customer_id` and were previously unreachable by any deletion path at all.
  `retention_until` is now populated by trigger on the transition into a
  terminal state (`fulfilled` gets `guest_pii_months`, `expired`/`cancelled`/
  `declined` get the new, shorter `unconsummated_order_pii_days`, since an
  order that never became a real transaction has a weaker purpose-limitation
  case for 24-month retention). `custom_cake_photos` gets a two-step purge
  (`fn_photos_due_for_purge` lists candidates, `fn_mark_photos_purged`
  deletes the DB rows only after the caller confirms Storage deletion,
  Rule 20).
- **B2 (registered-customer deletion always failed if they had ever touched
  consent)**: reproduced directly (see 10.6) before fixing. The FK from
  `consent_events.customer_id` to `customers(id) ON DELETE SET NULL` made
  Postgres run an `UPDATE` on every referencing row when a customer was
  deleted, and the append-only trigger rejected that `UPDATE` outright. Fix:
  no FK at all (an evidence reference, exactly what the compliance spec
  asked for: "an identifier + email stays as evidence" -- the FK's `SET
  NULL` would have destroyed the identifier anyway even without the trigger
  conflict). `fn_hard_delete_customer` is now the one correct order of
  operations: anonymize first, delete `auth.users` second (the reverse order
  would delete the customer row while their orders still carry live PII with
  nothing left to anonymize through).
- **B3 (consent evidence was forgeable)**: `fn_set_marketing_consent` now
  checks ownership/role as above, requires `admin_on_request` source to
  actually come from an admin, rejects `unsubscribe_link` as a source
  entirely (that path is `fn_unsubscribe_by_token`, `service_role` only, the
  unauthenticated `/unsubscribe` route), and requires a `granted` action's
  version to exactly match `app_settings.active_marketing_consent_version`
  (no consenting to a notice version that was never shown). `customers` lost
  its blanket `GRANT UPDATE` in favor of a column-level grant excluding the
  marketing/consent-evidence columns.
- **B4 (phone/IP retained with no purge; audit_log carried a raw IP)**:
  `fn_purge_old_order_attempts` (new) and `fn_purge_old_lookup_attempts`
  (existing, now also raises rather than silently deleting zero rows when
  its retention setting is missing) both exist. `fn_create_standard_order`
  no longer writes the raw checkout IP into `audit_log` (which is
  permanently undeletable by app-role UPDATE/DELETE); the IP already lives
  in `order_attempt_log`, which now has a retention/purge path.
  `audit_log`'s own trigger now allows `DELETE` only under an explicit
  `app.retention_purge` flag set solely by the new `fn_purge_old_audit_log`,
  so a real 7-year purge is possible without opening the table to any app
  role.
- **B5 (the US-0c confirmation gate was itself unguarded, and the link
  could never be revoked)**: `fn_record_order_confirmation_delivered` now
  requires `is_admin_aal2() OR current_user = 'service_role'` (previously
  ANY authenticated customer could call it and open `trg_orders_guard_
  fulfillment`'s gate on someone else's order) and writes at most once
  (`WHERE confirmation_delivered_at IS NULL`), so the stored hash stays
  proof of what was actually sent. `orders` gained
  `confirmation_link_revoked_at` / `confirmation_pdf_purged_at`;
  `fn_anonymize_order` sets the former, `fn_mark_confirmation_pdf_purged`
  (service_role, called only after Storage deletion is confirmed) sets the
  latter. The route serving the confirmation link/PDF MUST check both are
  NULL (and `pii_purged_at IS NULL`) before serving anything -- an
  application-layer contract this column pair exists to support.

Deferred, with reasons, at the end of the migration file: N2 (inactivity
notice flow), N3/N4 (two more retention purges pending legal-confirmed
periods; their `app_settings` keys ARE seeded), N5 (hashing IP/phone in the
rate-limit tables), N8/N9 (delivery_list_links rename + Phase 2 serving
function, pending maya/erez's MVP-vs-Phase-2 call on US-7 vs SEC-016), N11
(app_settings floor/ceiling trigger).

### 10.5 New invariants, stated for the test suite

```
capacity_never_negative (ADR-002, unchanged):
  reserved <= total, for both resources, at every moment, under any concurrency.

unpaid_never_exceeds_cap (new, section 10.1):
  unpaid_reserved <= total * unpaid_holds_capacity_pct / 100,
  for both resources, at every moment. Distinct from capacity_never_negative:
  reserved (paid + unpaid) may legitimately reach 100% of total; only the
  UNPAID share is capped.

release_exactly_once (SEC-007, generalized in section 10.2):
  for any order, across its entire lifetime, fn_release_order_capacity's
  guarded transition (payment_pending|paid -> expired|cancelled) succeeds
  at most once. A second call, from any source, at any time, returns false
  and changes nothing.

admin_actions_require_the_caller_to_be_admin (new, section 10.3):
  every admin-only function derives its actor from auth.uid(), never a
  parameter, and raises before any read or write if is_admin_aal2() is false.
```

### 10.6 What was executed for this round (Rule 20)

All against throwaway `postgres:17` containers (destroyed after each run),
same auth-schema stub as section 9. Three containers were used across this
round (`yuval_bakery_dbtest2` for the RED-then-GREEN sequence against an
already-seeded database, `yuval_bakery_dbtest3` for a from-scratch full
10-migration run plus the real concurrency test); all destroyed, nothing
persisted anywhere.

**RED, executed against the pre-fix schema (all 9 original migrations, no
fix migration applied), confirmed failing exactly as the coordinator/rotem
described, before any fix was written:**
1. BUG 1: 8 orders marked paid on a 100/100 day (reaching 80/80 paid) raised
   `unpaid_holds_capacity_cap_exceeded` on the 8th order itself (paid orders
   alone exceeded the mis-scoped 70% check), rather than on a subsequent
   unpaid order as originally scripted -- an even starker confirmation of
   the bug (legitimate PAID business could not even complete past ~70%).
2. BUG 2: paid an order, called `fn_cancel_order`, got `false`; capacity
   stayed at 10/10 reserved (unreleased) after the "successful" cancel
   attempt.
3. B2: created a customer, granted marketing consent, `DELETE FROM
   customers` failed with `append_only_table: UPDATE on consent_events is
   not permitted`.
4. B1a: created a customer with one DELIVERY order, `fn_anonymize_customer`
   failed with `new row for relation "orders" violates check constraint
   "orders_check1"`.

**GREEN, executed against the fix migration applied on top:**
5. BUG 1a: with 80/100 minutes PAID (verified via a clean, isolated setup --
   8 separate order+pay calls, each in its own exception-scoped block so a
   later failure could not roll back earlier successes, the mistake in the
   RED run above), a new small UNPAID order SUCCEEDED (previously
   impossible). Ledger: `reserved=90, unpaid=10`.
6. BUG 1b: on a fresh 100/100 day, 7 unpaid orders of 10 minutes each
   brought unpaid holds to exactly 70/100 (the cap); an 8th unpaid order was
   correctly rejected with `unpaid_holds_capacity_cap_exceeded`.
7. BUG 2a/2b: paid an order, cancelled it (`true`, capacity returned to
   before-order level), cancelled it again (`false`, ledger byte-identical
   to after the first cancel). SEC-007 idempotency holds under the
   generalized payment_pending-or-paid release path.
8. Privilege escalation: as `SET ROLE authenticated` with a real (non-admin)
   customer's JWT claims, calling `fn_mark_order_paid`, `fn_cancel_order`,
   `fn_admin_set_day_capacity`, and `fn_decline_custom_cake_request` against
   a REAL order id (obtained out of band, not from a failed lookup) all
   raised `admin_aal2_required`; `fn_set_marketing_consent` targeting a
   DIFFERENT customer raised `consent_not_own`. The real admin, same
   session shape, same order id, succeeded (`fn_mark_order_paid` returned
   `true`, order status became `paid`).
9. B2 green: a customer with a consent event was hard-deleted via
   `fn_hard_delete_customer`; `auth.users` row gone; the `consent_events`
   evidence row SURVIVED (as required).
10. B1a green: a customer with a DELIVERY order (address + city) was
    anonymized successfully; PII columns null, `total_displayed` (financial/
    accounting data) retained.
11. Full-suite regression: all 10 migration files (the original 9 plus the
    fix migration) plus `indexes.sql` applied cleanly, zero errors, on a
    completely FRESH container from scratch (not just incrementally on the
    already-patched session), proving the final artifact is self-consistent
    end to end.
12. **Real concurrent race** (the item explicitly marked DID NOT RUN in
    section 9, now executed): pre-reserved 65/100 minutes as PAID (two
    separate paid orders, each within the 35% single-order cap), leaving
    exactly 35 minutes of physical room -- exactly one order's worth. Two
    genuinely separate OS processes (`docker exec ... psql` launched via
    bash `&`, not sequential calls in one session) each attempted a 35-minute
    order for the SAME day at the same time. Result: exactly one succeeded
    (`capacity_reservation_failed` for the other), and the ledger read back
    afterward was `reserved=100, total=100`, never exceeding total. This is
    the actual concurrent-session version of ADR-002's own acceptance test,
    not the sequential-call simulation section 9 relied on.

**DID NOT RUN / inconclusive by my own error, reported rather than hidden**:
a follow-up batch of 5 more concurrent-race rounds used a day total (35/100)
smaller than the single-order cap could accommodate for the product used (35
minutes needs `total >= 35/0.35 = 100`), so both racers in every round were
rejected by the single-order cap before the concurrency mechanism was ever
exercised. This is a test-setup arithmetic error on my part, not a finding
about the schema; the one correctly-set-up race in item 12 above is the
valid evidence for this invariant.

**Still DID NOT RUN, same reasons as section 9**: the real Supabase local
stack; Storage bucket policies.

[[agents/dba]] [[agents/rotem]] [[agents/erez]] [[yuval-bakery]] [[compliance-schema-review]]
