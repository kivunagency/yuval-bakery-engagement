# SYSTEM-CONTRACT: YuvalBakery

What "working" means for this system, checked by what, and what no check sees.
Updated in the same commit as any behaviour change (CLAUDE.md). One command
runs everything: `bash output/qa/verify-all.sh`.

Every check has three outcomes: PASSED, FAILED, DID NOT RUN. DID NOT RUN is
never reported as passed.

## 1. Invariants (must hold at every moment)

| Invariant | Enforced by | Checked by | Status |
|---|---|---|---|
| `capacity_never_negative`: reserved <= total, both resources, every day, under concurrency | `capacity_day_ledger` CHECK + single conditional UPDATE in `fn_reserve_capacity` (ADR-002) | `qa/db/capacity-race.test.mjs` (qa-001): 24 separate connections released by a barrier for the last 3 slots, exactly 3 win; mixed sizes; a sampler connection asserts every ledger read during the race; end state equals the sum of held orders | PASSED |
| `unpaid_never_exceeds_cap`: unpaid holds <= 70% of total; paid orders do not count | inside `fn_reserve_capacity`'s atomic UPDATE | `qa/db/capacity-race.test.mjs`: 24 racers on an empty day, exactly 7 x 10 held; with 70 paid the last 30 still sells; every read sampled | PASSED |
| `release_exactly_once` (SEC-007) | `fn_release_order_capacity` gated on the order's own status, row lock | `qa/db/capacity-race.test.mjs`: cancel racing expire (12 rounds by default, both winners observed), 5 concurrent sweeps over 10 stale orders, mark-paid racing expire, 24 concurrent cancels of one paid order; ledger equals the held orders and one audit row per order after each. `qa/regression.jobs.spec.js`: sequential retry | PASSED |
| `single_order_cap`: one order may use at most 35% of a day, per resource | pre-check in `fn_create_standard_order` (about the order's own size, no shared state) | `qa/db/capacity-race.test.mjs`: 35 of 100 accepted, 36 refused, work minutes checked on their own, 24 racers at exactly the cap (2 win). Setup guard `assertRaceable` fails the test itself if a day is too small for anything to race (DB-PLAN.md 10.6) | PASSED |
| Ledger equals its orders: `*_reserved` = cost of orders in payment_pending or paid, `*_unpaid_reserved` = cost of payment_pending ones, per day | every writer of the ledger | `assertLedgerMatchesOrders` after every race in `qa/db/capacity-race.test.mjs` | PASSED |
| `expiry_sweep_liveness` (job-001, SEC-007): every sweep run writes `cron_heartbeats` (`expire_payment_pending_orders`), work or not; a failed run leaves `last_error` set and `last_success_at` unchanged | `fn_expire_stale_orders` -> `fn_record_cron_run`; wrapper `lib/server/jobs/expire-orders.ts` records the failure when the call itself fails | `qa/regression.jobs.spec.js` (keep-alive run, poison-order run), `tests/jobs.test.ts` (RPC failure) | PASSED |
| `expiry_is_isolated_per_order` (job-001): one order that cannot be released does not stop other stale orders from expiring; its own status flip rolls back with its release | subtransaction per order in `fn_expire_stale_orders` | `qa/regression.jobs.spec.js` "one order that cannot be released" | PASSED |
| Job and capacity internals are not callable over the public API (`fn_reserve_capacity`, `fn_expire_stale_orders`, `fn_record_cron_run`, retention/purge/anonymize functions) | explicit REVOKE from anon/authenticated in `20260926040000_job001_expiry_sweep_and_job_grants.sql` | `qa/regression.jobs.spec.js` (real PostgREST, anon key and a signed-in customer) | PASSED |
| Daily retention: every step runs even if one fails; the run is a success only if all did; Storage objects are never marked purged by this job | `lib/server/jobs/retention.ts` | `qa/regression.jobs.spec.js`, `tests/jobs.test.ts` | PASSED |
| Admin actions require an admin at aal2, actor from `auth.uid()` only | `is_admin_aal2()` inside every admin function | `output/db/tests/run.sh` (plain postgres, stubbed JWT) AND `qa/regression.spec.js` "auth chain" (real Supabase Auth, real TOTP, real JWT) | PASSED |
| `anon` cannot write any table directly | grants + RLS | `run.sh` T5 (ledger). Other tables: DB-PLAN.md 9 item 4 (manual) | ledger PASSED, rest manual |
| No Hebrew literal in code, en.json keys == he.json keys | ESLint `no-restricted-syntax`, `tests/i18n.test.ts` | lint + unit tests | PASSED |
| No em/en-dash in app code and QA docs | `scripts/check-dashes.py` | verify-all | PASSED (docs outside apps/ have 63 older hits, not in scope of the check yet) |
| Every DB error code is known to the app | `lib/server/supabase/rpc.ts` | `tests/db-error-codes.test.ts` | PASSED |
| Shared enums mirror DB CHECK constraints | `lib/shared/types` | `tests/shared-types.test.ts` | PASSED |

## 2. Layers and what proves each one

| Layer | Proof | Blind spot |
|---|---|---|
| SQL (migrations, functions, RLS) | `run.sh` on plain postgres 17; local stack applies the same files on a Supabase-shaped DB (extensions in schema `extensions`, real `auth` schema from Supabase Auth) | Hosted Supabase itself (DID NOT RUN until infra-001: accounts are Yuval's to create) |
| API (PostgREST RPC) | local stack PostgREST v12.2.3 in regression spec | Hosted PostgREST version may differ |
| Auth (JWT shape, aal2) | Supabase Auth v2.180.0 binary in the local stack, TOTP enrolled and verified in `qa/helpers/admin.js` | Hosted Auth config (MFA enabled flag, rate limits) until infra-001 |
| Next.js server (routes, SSR, CSP) | `next build` + regression spec against `next start` | Netlify runtime (DID NOT RUN until infra-002) |
| Rendering (RTL, fonts, 44px, 390px) | regression spec, screenshot in `apps/web/test-results/screens/` looked at by a person or agent | Screen reader, 200% zoom (qa-006) |
| Live deployment | `qa/smoke.spec.js` with `SMOKE_BASE_URL` | DID NOT RUN: nothing is deployed |
| Scheduled functions (job-001) | built bundles `netlify/functions/*.mjs` invoked in plain Node against the local stack (`regression.jobs.spec.js`); Netlify's own bundler (zip-it-and-ship-it) detected both schedules and the bundle loaded, checked once by hand on 2026-09-25 | DID NOT RUN: Netlify actually firing them on schedule (no site yet, infra-002); the 45-minute staleness alert that reads `cron_heartbeats` (OPS-005) is not built |
| Storage (photo buckets) | none | DID NOT RUN: no Storage in the local stack yet; bucket policies not written (DB-PLAN.md 9) |

## 3. True but worrying

- The 24-hour lead time is NOT enforced by the DB: `fn_create_standard_order` accepts tomorrow-morning dates. The checkout task (api-003) must enforce it server-side in Asia/Jerusalem, ideally inside the DB function. Until then an order can be placed inside the lead time via the RPC.
- `anon` can call `fn_create_standard_order` directly through PostgREST with the public anon key, bypassing the Next.js route (and any Turnstile check there). The DB's own rate limit and caps still apply. api-003 must decide whether to revoke anon EXECUTE and call it only server-side with the service key (CLAUDE.md: writes go through the functions, called server-side).
- Local stack keys are minted per run; nothing there resembles DEV or PROD secrets.

- The race tests prove the mechanism against local PostgreSQL 17 at READ COMMITTED with up to 24 connections. Hosted Supabase goes through a connection pooler (Supavisor); the SQL path is the same, but that exact pooler under contention DID NOT RUN. The tests were checked to fail on purpose: a read-then-write `fn_reserve_capacity` and a release without the row lock and status gate each made them fail (mutation run by hand on 2026-09-26, not part of CI).
- Default privileges on Supabase grant EXECUTE on every NEW function in `public` to anon and authenticated (per role, not via PUBLIC), so `REVOKE ... FROM PUBLIC` alone leaves a new function open over PostgREST. `20260926040000` closes it for the functions that existed; any function added later needs its own explicit `REVOKE ... FROM anon, authenticated`. Changing the default privileges themselves is a cross-branch decision, not taken here.
- Checks of the form `current_user = 'service_role'` inside a SECURITY DEFINER function are never true (there `current_user` is the owner). Reproduced: `fn_unsubscribe_by_token` refuses the service role. Same pattern in `fn_hard_delete_customer`, `fn_set_marketing_consent`, `fn_record_order_confirmation_delivered`, so their service-role paths are dead. Not fixed here (identity and notification scope); the daily retention job does not hard-delete customers for this reason and reports it as DID NOT RUN.
- `fn_run_retention_sweep` still writes its heartbeat inside an EXCEPTION handler that re-raises (the write rolls back); the job wrapper records the failure instead, so the heartbeat is right, but the function body alone is not.

## 4. Change log

- 2026-09-25 scaffold: app skeleton, local stack, migration `20260925121200_function_search_path_extensions.sql` (guest checkout failed on Supabase-shaped DB with `function digest(text, unknown) does not exist`; RED reproduced through PostgREST, GREEN after the fix), indexes moved to `20260925121100_indexes.sql`.
- 2026-09-26 job-001: expiry sweep and daily retention as Netlify Scheduled Functions (`netlify/src/`, bundled by `scripts/build-functions.mjs` because `server-only` throws outside the react-server condition; reproduced with Netlify's bundler). Migration `20260926040000_job001_expiry_sweep_and_job_grants.sql`: RED on the local stack for (1) a failed sweep leaving no trace in `cron_heartbeats`, (2) one unreleasable order stopping every expiry, (3) anon executing `fn_reserve_capacity` (held capacity with no order) and 11 retention/anonymize functions through `/rest/v1/rpc`; GREEN after.
- 2026-09-26 qa-001: `qa/db/capacity-race.test.mjs` (`npm run test:race`), its own check in verify-all and CI. No schema change. Found no capacity bug; one expectation was mine to fix (a 35-minute racer after two winners breaks the physical total too, and the DB names that first).
