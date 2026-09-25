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
| Business details (s.14C) and contact (US-0b) are never invented: an unset `business_*` setting renders a visible placeholder such as `[שם העסק]`; an invalid phone renders a placeholder, never a `tel:`/`wa.me` link | `fn_public_site_settings()` returns JSON null for unset/blank/non-string; `lib/shared/contact/links.ts` returns null for a non-Israeli number | `tests/compliance-helpers.test.ts`, `qa/regression.compliance.spec.js` (footer placeholders, values, invalid phone) | PASSED |
| anon reads `business_*` settings only through `fn_public_site_settings()` (fixed whitelist); an admin at aal2 reads every row; other `app_settings` keys keep their visibility | RLS policy `app_settings_select_public` (migration `20260926030000`), REVOKE on `fn_setting_text` from anon/authenticated | `qa/regression.compliance.spec.js` "DB: public business settings read path" (real PostgREST + real aal2 admin) | PASSED |
| The legal-text version a page shows equals `app_settings.active_*_version` | `lib/shared/compliance/versions.ts` (`TEXT_VERSIONS`), bumped together with a migration | `qa/regression.compliance.spec.js` "versions the pages render" | PASSED |
| Privacy notice at collection (s.11) names the business's courier as a recipient, is a notice not a consent (no checkbox), links `/privacy`, shows `TEXT_VERSIONS.privacy`; `/privacy` quotes retention periods from `app_settings`, never hard-coded | `components/compliance/PrivacyNoticeAtCollection`, `app/(public)/privacy` reading `fn_public_site_settings()` | `tests/compliance-components.test.ts` (3 contexts, server-rendered), `qa/regression.compliance.spec.js` "privacy notice" (incl. a changed `guest_pii_months` changing the page) | PASSED |
| Accessibility statement (Rule 33 items 9-10) has an update date, claims no full conformance, states the IS 5568 exemption as UNVERIFIED, names no coordinator, and gives the owner's contact | `app/(public)/accessibility`, `ACCESSIBILITY_STATEMENT_UPDATED` in `lib/shared/compliance/versions.ts` | `qa/regression.compliance.spec.js` "accessibility statement" (incl. keyboard reaching the footer with a solid focus ring) | PASSED |
| Every public page (route group `app/(public)`) has the site footer: business name, contact block, legal links, all links >= 44px | `app/(public)/layout.tsx` + `components/site-footer` | `qa/regression.compliance.spec.js` + baseline helper `qa/helpers/baseline.js` | PASSED |

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
- Price wording depends on `vat_status` (seeded `exempt`, pending Yuval/accountant): exempt shows "מחיר סופי", licensed shows "כולל מע״מ" (`components/price`, `lib/shared/price/vat.ts`). Wording for rotem/Yuval to confirm. The osek status line on `/business` ("עוסק פטור מס׳") is also derived from `vat_status`, and is shown only once `business_registration_number` is set.
- The cancellation-exemption wording ("לא ניתן לבטל לאחר אישור ההזמנה") treats payment as the moment of confirmation (`/business` says "ההזמנה מאושרת כשהתשלום מתקבל"). rotem to confirm that reading of s.14C(d); legal review before launch.
- Legal pages carry a visible "draft, pending legal review" line (`components/legal-page`). Remove it only after a lawyer has read the text.
- The privacy notice at collection is a component only: checkout, registration and custom-cake screens (other tasks) must place it before the first personal-data field, and pass `TEXT_VERSIONS.privacy` to the order/registration functions. Until they do, no screen shows it at the point of collection except `/privacy` itself (DID NOT RUN for those screens).
- `/privacy` wording is built from compliance-spec.md section 4 and is a draft pending legal review; retention periods are pending the accountant (spec 13 q1).
- The accessibility statement describes the site as built; screen reader and 200% zoom are DID NOT RUN (qa-006 open) and the page says so. Update `ACCESSIBILITY_STATEMENT_UPDATED` and the text when qa-006 or compliance-005 runs. Whether the small-business exemption applies (turnover, spec 13 q4) is for Yuval; the amount is unverified.
- Footer contact block is generic. A page about one order must render its own `<ContactBlock orderNumber=...>` to get the prefilled WhatsApp message; the footer cannot see the order.
- If `fn_public_site_settings()` fails, public pages still render with placeholders (error logged server-side), so a DB outage shows placeholders rather than a crash.
- Local stack keys are minted per run; nothing there resembles DEV or PROD secrets.

## 4. Change log

- 2026-09-25 scaffold: app skeleton, local stack, migration `20260925121200_function_search_path_extensions.sql` (guest checkout failed on Supabase-shaped DB with `function digest(text, unknown) does not exist`; RED reproduced through PostgREST, GREEN after the fix), indexes moved to `20260925121100_indexes.sql`.
- 2026-09-26 compliance-002 + US-0b: migration `20260926030000_public_business_details.sql` (business_* settings as JSON null, `fn_public_site_settings()`, narrowed anon read policy), site footer with contact block on every public page, `/business` page, reusable `BusinessDetails`, `CancellationExemptionNotice`, `PriceWithVat`/`VatLabel`, `ContactBlock`.
- 2026-09-26 compliance-001: `/privacy` (full notice + cookies section), reusable `PrivacyNoticeAtCollection` (checkout / registration / custom_cake) and `NotesFieldHint`, footer link. Vitest now uses the automatic JSX runtime so components render in unit tests.
- 2026-09-26 compliance-003: `/accessibility` statement, footer link.
