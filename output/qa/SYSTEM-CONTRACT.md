# SYSTEM-CONTRACT: YuvalBakery

What "working" means for this system, checked by what, and what no check sees.
Updated in the same commit as any behaviour change (CLAUDE.md). One command
runs everything: `bash output/qa/verify-all.sh`.

Every check has three outcomes: PASSED, FAILED, DID NOT RUN. DID NOT RUN is
never reported as passed.

## 1. Invariants (must hold at every moment)

| Invariant | Enforced by | Checked by | Status |
|---|---|---|---|
| `capacity_never_negative`: reserved <= total, both resources, every day, under concurrency | `capacity_day_ledger` CHECK + single conditional UPDATE in `fn_reserve_capacity` (ADR-002) | DB-PLAN.md 10.6 item 12 (manual race, one run). Automated concurrent test: qa-001 | automated: DID NOT RUN (qa-001 open) |
| `unpaid_never_exceeds_cap`: unpaid holds <= 70% of total | inside `fn_reserve_capacity`'s atomic UPDATE | DB-PLAN.md 10.6 items 5-6 (manual) | automated: DID NOT RUN (qa-001 open) |
| `release_exactly_once` (SEC-007) | `fn_release_order_capacity` gated on the order's own status, row lock | DB-PLAN.md 10.6 item 7 (manual) | automated: DID NOT RUN (job-001 / qa-001 open) |
| Admin actions require an admin at aal2, actor from `auth.uid()` only | `is_admin_aal2()` inside every admin function | `output/db/tests/run.sh` (plain postgres, stubbed JWT) AND `qa/regression.spec.js` "auth chain" (real Supabase Auth, real TOTP, real JWT) | PASSED |
| `anon` cannot write any table directly | grants + RLS | `run.sh` T5 (ledger). Other tables: DB-PLAN.md 9 item 4 (manual) | ledger PASSED, rest manual |
| No Hebrew literal in code, en.json keys == he.json keys | ESLint `no-restricted-syntax`, `tests/i18n.test.ts` | lint + unit tests | PASSED |
| No em/en-dash in app code and QA docs | `scripts/check-dashes.py` | verify-all | PASSED (docs outside apps/ have 63 older hits, not in scope of the check yet) |
| Every DB error code is known to the app | `lib/server/supabase/rpc.ts` | `tests/db-error-codes.test.ts` | PASSED |
| Shared enums mirror DB CHECK constraints | `lib/shared/types` | `tests/shared-types.test.ts` | PASSED |
| Public catalog (api-001) returns published, non-deleted products only; a paused product is listed with `isAvailable=false`; no time cost (oven/work minutes) leaves the server | RLS `products_select_published` (read as anon) + explicit column list in `lib/server/catalog/get-catalog.ts` + Zod `catalogResponse` | `qa/regression.catalog.spec.js` "api-001" | PASSED |
| Public day availability (api-002): per day a state word (`too_soon` > `closed` > `full` > `limited` > `open`) and the products of which one unit fits; never minutes | `fn_public_day_availability` (the only capacity read anon may call) | regression.catalog "api-002 state per day" | PASSED |
| One definition of "fits": the public fit answer equals whether a real 1-unit checkout (`fn_create_standard_order` -> `fn_reserve_capacity`) succeeds | `fn_capacity_row_fits` (mirror of reserve's WHERE + the single-order cap) | regression.catalog "fit agrees with the real reservation": 190+ (row, cost) cases in one rolled-back transaction; shown RED by dropping the single-order work cap from the predicate | PASSED |
| Lead time: a day is `too_soon` when its first slot (`app_settings.earliest_slot_time`, Asia/Jerusalem) is less than `lead_time_hours` away | `fn_day_too_soon` | regression.catalog (today and tomorrow are `too_soon` with the default 00:00) | PASSED for the public strip. Checkout does NOT call it yet (section 3) |
| `anon` cannot read `capacity_day_ledger` (it held every total/reserved minute) nor call the internal capacity helpers | `REVOKE SELECT ... FROM anon`, policy `capacity_day_ledger_select_admin`, EXECUTE revoked on `fn_capacity_fits`/`fn_day_too_soon`/`fn_capacity_row_fits` | regression.catalog "anon cannot read the ledger" (through PostgREST) | PASSED |
| A catalog photo URL is built in one place from `product_photos.storage_path` (never stored as a URL); an unsafe path yields no URL (placeholder) | `lib/server/catalog/photo-url.ts` | `tests/catalog-photo-url.test.ts`, regression.catalog "photo URL" | PASSED (URL shape). Real image served by Storage: DID NOT RUN (no Storage in the local stack) |

## 2. Layers and what proves each one

| Layer | Proof | Blind spot |
|---|---|---|
| SQL (migrations, functions, RLS) | `run.sh` on plain postgres 17; local stack applies the same files on a Supabase-shaped DB (extensions in schema `extensions`, real `auth` schema from Supabase Auth) | Hosted Supabase itself (DID NOT RUN until infra-001: accounts are Yuval's to create) |
| API (PostgREST RPC) | local stack PostgREST v12.2.3 in regression spec | Hosted PostgREST version may differ |
| Auth (JWT shape, aal2) | Supabase Auth v2.180.0 binary in the local stack, TOTP enrolled and verified in `qa/helpers/admin.js` | Hosted Auth config (MFA enabled flag, rate limits) until infra-001 |
| Next.js server (routes, SSR, CSP) | `next build` + regression spec against `next start` | Netlify runtime (DID NOT RUN until infra-002) |
| Rendering (RTL, fonts, 44px, 390px) | regression spec, screenshot in `apps/web/test-results/screens/` looked at by a person or agent | Screen reader, 200% zoom (qa-006) |
| Live deployment | `qa/smoke.spec.js` with `SMOKE_BASE_URL` | DID NOT RUN: nothing is deployed |
| Storage (photo buckets) | none. The catalog builds `product-photos` public URLs (unit + regression test the URL shape only) | DID NOT RUN: no Storage in the local stack yet; bucket `product-photos` and its policies not created (DB-PLAN.md 9). A real photo has never been served. |

## 3. True but worrying

- The 24-hour lead time is NOT enforced by the DB: `fn_create_standard_order` accepts tomorrow-morning dates. The checkout task (api-003) must enforce it server-side in Asia/Jerusalem, ideally inside the DB function. Until then an order can be placed inside the lead time via the RPC. The public strip already computes it in the DB (`fn_day_too_soon`, api-002); checkout should call the same function so the strip and the order agree.
- `anon` can call `fn_create_standard_order` directly through PostgREST with the public anon key, bypassing the Next.js route (and any Turnstile check there). The DB's own rate limit and caps still apply. api-003 must decide whether to revoke anon EXECUTE and call it only server-side with the service key (CLAUDE.md: writes go through the functions, called server-side).
- The "limited" threshold (`day_limited_threshold_pct` = 25) and `earliest_slot_time` = 00:00 are api-002 defaults, not Yuval's decisions. With 00:00 a day becomes orderable only when ALL of it is 24h away (at 10:00 Monday, Tuesday is too_soon even for a 16:00 slot); setting her real first slot time opens more days.
- Local stack keys are minted per run; nothing there resembles DEV or PROD secrets.

## 4. Change log

- 2026-09-25 scaffold: app skeleton, local stack, migration `20260925121200_function_search_path_extensions.sql` (guest checkout failed on Supabase-shaped DB with `function digest(text, unknown) does not exist`; RED reproduced through PostgREST, GREEN after the fix), indexes moved to `20260925121100_indexes.sql`.
- 2026-09-26 api-001: `GET /api/catalog` (public catalog, Zod contract `lib/shared/contracts/catalog.ts`), migration `20260926010000_catalog_may_contain.sql` adds `products.allergens_may_contain` (design shows "contains" and "may contain" chips; the schema had only one list). The admin product editor must write this column.
- 2026-09-26 api-002: `GET /api/capacity` (public day states, contract `lib/shared/contracts/capacity.ts`), migration `20260926010100_public_day_availability.sql`: `fn_capacity_row_fits`, `fn_capacity_fits`, `fn_day_too_soon`, `fn_public_day_availability` (anon), three app_settings defaults, and `capacity_day_ledger` is no longer readable by anon (admin aal2 only).
