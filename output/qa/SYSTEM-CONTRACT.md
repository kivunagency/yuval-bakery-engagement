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
| Admin login = password + TOTP (aal2); first login enrols TOTP (QR + manual key); no other way into `/admin/*` (db-005, SEC-002) | `requireAdminPage()` in the admin layout AND in every admin page (layouts do not re-run on client navigation); `getAdminSession()` in every admin API route | `tests/admin-pages-guarded.test.ts` (static: every page/route calls the guard), `qa/regression.admin.spec.js` (anon and aal1 redirected from every admin path; full enrol and verify through the real UI) | PASSED |
| Admin session ends 12h after its TOTP step (SEC-013 absolute lifetime) | `getAdminSession()` reads the `amr` totp timestamp of the Auth-verified access token | `tests/admin-auth.test.ts` (claim parsing). The 12h expiry itself in a browser: DID NOT RUN (would need a clock 12h ahead) | unit PASSED, E2E DID NOT RUN |
| Login failure is uniform: unknown email, wrong password and a non-admin with a valid password get the same message, and the non-admin session is dropped | `passwordLogin()` in `lib/server/auth/admin-login.ts` | `regression.admin.spec.js` "same error for..." | PASSED |
| Admin login and TOTP are rate limited: 5 failures per IP and 20 per account per 15 min (`app_settings` `admin_auth_*`), fail closed if the DB is unreachable | `fn_admin_auth_attempt_begin/finish` (service_role only, hashes only) | `regression.admin.spec.js` "rate limit"; fail-closed branch: DID NOT RUN | PASSED (limit), DID NOT RUN (DB-down branch) |
| Admin logins, TOTP verify, MFA enrolment and sign-out are in `audit_log`; enrolment stamps `admins.mfa_enrolled_at` (SEC-017) | `fn_admin_record_auth_event` (actor = `auth.uid()`) | `regression.admin.spec.js` "first login" reads `audit_log` | PASSED |
| Sign-out is global (every device) (SEC-013) | `adminSignOut()`: `signOut({ scope: 'global' })` | `regression.admin.spec.js` (session gone after sign-out); other devices: DID NOT RUN | PASSED (this device) |
| `PATCH /api/admin/capacity/[date]` (api-009): aal2 admin only, same-Origin only, Zod contract (`lib/shared/contracts/capacity.ts`: whole minutes 0..1440, strict keys, real date); writes only through `fn_admin_set_day_capacity` as the admin's own JWT | route + `updateDayCapacity()` (`lib/server/capacity/admin-capacity.ts`, the handler the ops registry must reuse) | `regression.admin.spec.js` "PATCH ..." (401 anon and aal1, 403 no/foreign Origin, 400 per bad field, 200 + audit row with actor = the admin), `tests/capacity-contract.test.ts` | PASSED |
| A day's total can never be set below what orders already reserve: 409 `below_reserved` with the reserved minutes, never a raw 500 | `fn_admin_set_day_capacity` locks the day (`FOR UPDATE`) and raises `capacity_total_below_reserved`; the ledger CHECK stays as the second line | `run.sh` T6-T8, `regression.admin.spec.js` (409 body, row unchanged) | PASSED |
| A blackout day keeps its minutes and its existing orders; it only stops new reservations (`fn_reserve_capacity` requires `is_blackout = false`) | `fn_admin_set_day_capacity` | `regression.admin.spec.js` | PASSED |
| Admin capacity screen `/admin/capacity?day=` (client-007) arrives with its data: ledger row, the orders holding the day (`payment_pending`, `paid`, `fulfilled`, the statuses the ledger counts) and the weekly pattern, read server-side as the admin's JWT; the bar is `aria-hidden`, one sentence per resource carries the numbers for screen readers | `loadCapacityDay()` in `lib/server/capacity/admin-capacity-day.ts`; the bar is SVG (a server-rendered `style=` width would be dropped by the CSP) | `regression.admin.spec.js` "day view" (3 segments + dashed free part, exact sentences incl. unpaid minutes, 409 shown in words with nothing saved, Karantina 36px title, arrows) | PASSED |
| Closed-day switch in RTL: knob at inline-start (right) when off, inline-end when on; 52x44; keyboard Space toggles | `.admin-switch` in `styles/admin.css` | `regression.admin.spec.js` (computed `::after` right = 3px / 23px, size, Space) | PASSED |
| Weekly pattern fills the ledger for the next `capacity_pattern_horizon_days` (60) days from today in Asia/Jerusalem, never over a `manual` day, never below reserved, never touching `*_reserved`; idempotent | `fn_materialize_capacity_from_pattern` (service_role + inside `fn_admin_set_weekly_pattern`, aal2, audited); `fn_admin_reset_day_to_pattern` returns a manual day to the pattern | `regression.admin.spec.js` "weekly pattern" (new day filled, manual day kept, busy day kept, reset, second run writes 0, `authenticated` cannot call the fill) | PASSED |
| The window rolls forward every day | a daily service_role call of `fn_materialize_capacity_from_pattern()` | DID NOT RUN: no scheduler exists yet (job-001 owns the Netlify Scheduled Function). Until then the pattern is applied only when Yuval saves it, so days beyond 60 days from that save stay closed | DID NOT RUN |

## 2. Layers and what proves each one

| Layer | Proof | Blind spot |
|---|---|---|
| SQL (migrations, functions, RLS) | `run.sh` on plain postgres 17; local stack applies the same files on a Supabase-shaped DB (extensions in schema `extensions`, real `auth` schema from Supabase Auth) | Hosted Supabase itself (DID NOT RUN until infra-001: accounts are Yuval's to create) |
| API (PostgREST RPC) | local stack PostgREST v12.2.3 in regression spec | Hosted PostgREST version may differ |
| Auth (JWT shape, aal2) | Supabase Auth v2.180.0 binary in the local stack, TOTP enrolled and verified in `qa/helpers/admin.js` | Hosted Auth config (MFA enabled flag, rate limits) until infra-001 |
| Next.js server (routes, SSR, CSP) | `next build` + regression spec against `next start` | Netlify runtime (DID NOT RUN until infra-002) |
| Rendering (RTL, fonts, 44px, 390px) | regression spec, screenshot in `apps/web/test-results/screens/` looked at by a person or agent | Screen reader, 200% zoom (qa-006) |
| Live deployment | `qa/smoke.spec.js` with `SMOKE_BASE_URL` | DID NOT RUN: nothing is deployed |
| Storage (photo buckets) | none | DID NOT RUN: no Storage in the local stack yet; bucket policies not written (DB-PLAN.md 9) |

## 3. True but worrying

- The 24-hour lead time is NOT enforced by the DB: `fn_create_standard_order` accepts tomorrow-morning dates. The checkout task (api-003) must enforce it server-side in Asia/Jerusalem, ideally inside the DB function. Until then an order can be placed inside the lead time via the RPC.
- `anon` can call `fn_create_standard_order` directly through PostgREST with the public anon key, bypassing the Next.js route (and any Turnstile check there). The DB's own rate limit and caps still apply. api-003 must decide whether to revoke anon EXECUTE and call it only server-side with the service key (CLAUDE.md: writes go through the functions, called server-side).
- **Admin recovery is not built** (db-005). Supabase Auth has no GA recovery codes. Written path, pending Ran: Ran enrols a second TOTP factor on his own phone while Yuval is signed in (the verify step already accepts a code from any verified factor of the account; the screen to add it is not built), and break-glass is Ran deleting the lost factor through the Supabase dashboard / Auth admin API after a video identity check (threat-model.md 3.4). auth-js 2.117 has an EXPERIMENTAL `mfa.recoveryCodes` API and the Auth v2.180 binary contains recovery-code strings; hosted availability UNVERIFIED.
- **SEC-013 not done here**: 30-minute idle timeout (needs Supabase Pro inactivity timeout or an app-level last-seen cookie); `SameSite=Strict` on the auth cookie (it is shared with customer sessions, so Strict would drop customers arriving from Instagram links). CSRF on admin writes relies on Next.js server actions' own Origin check and, for `/api/admin/*`, an explicit Origin check (api-009).
- The per-IP login limit trusts `x-nf-client-connection-ip`. That Netlify overwrites a client-supplied value is UNVERIFIED; the per-account limit applies regardless.
- Supabase Auth v2.180 accepted the same TOTP code twice inside one 30-second step (seen on the local stack). Replay needs the password too, and the login flow is rate limited, but it is not RFC 6238 "one use per step".
- Local stack keys are minted per run; nothing there resembles DEV or PROD secrets.

## 4. Change log

- 2026-09-26 client-007: admin capacity screen, weekly pattern. Migration `20260926020200_capacity_weekly_pattern.sql` (`capacity_weekly_pattern`, `fn_admin_set_weekly_pattern`, `fn_materialize_capacity_from_pattern`, `fn_admin_reset_day_to_pattern`, `app_settings.capacity_pattern_horizon_days`). Routes `PUT /api/admin/capacity/pattern`, `POST /api/admin/capacity/[date]/reset`. The pattern starts empty (working days are Yuval's open decision, PRD 10.1).

- 2026-09-26 api-009: `PATCH /api/admin/capacity/[date]`. Migration `20260926020100_admin_set_day_capacity_errors.sql`: `fn_admin_set_day_capacity` (same signature and grants) raises `capacity_total_below_reserved` / `capacity_invalid_minutes` instead of a raw CHECK violation, marks the day `source = 'manual'` (new column, existing rows default to manual), audits previous values. Callers: the new route (via `updateDayCapacity`), `run.sh`, `qa/regression.spec.js`.

- 2026-09-26 db-005 admin access: `/admin/login` (password, server action), `/admin/login/enroll` (first TOTP: QR + manual key), `/admin/login/verify`, global sign-out, admin shell with 4 bottom tabs and placeholder pages. Migration `20260926020000_admin_auth_attempts_and_events.sql` (rate limit table and functions, auth audit events).

- 2026-09-25 scaffold: app skeleton, local stack, migration `20260925121200_function_search_path_extensions.sql` (guest checkout failed on Supabase-shaped DB with `function digest(text, unknown) does not exist`; RED reproduced through PostgREST, GREEN after the fix), indexes moved to `20260925121100_indexes.sql`.
