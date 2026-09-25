# apps/web

Next.js 15 App Router, TypeScript strict. Specs live at the repo root (see ../../CLAUDE.md).

## Run it locally

```bash
npm ci
npm run stack:up      # Postgres 17 + Supabase Auth + PostgREST on :54321, writes .env.local
npm run dev           # http://localhost:3000
npm run stack:down
```

No Docker needed: `scripts/local-stack/` fetches PostgreSQL 17 (npm package
`@embedded-postgres/linux-x64`), Supabase Auth and PostgREST (GitHub releases)
into a cache outside the repo. Seed data is `supabase/seed.sql` (synthetic only).

## Checks

| Command | What |
|---|---|
| `npm run lint` | ESLint, includes: no Hebrew literals in code, no `dangerouslySetInnerHTML`, no `lib/server` import from `components/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (`tests/`) |
| `npm run test:e2e` | Playwright: `qa/regression.spec.js` (needs `stack:up` and `npm run build`), `qa/smoke.spec.js` (needs `SMOKE_BASE_URL`, otherwise DID NOT RUN) |
| `npm run build:functions` | bundles the Netlify Scheduled Functions (`netlify/src/*.ts` -> `netlify/functions/*.mjs`, job-001) |
| `bash ../../output/qa/verify-all.sh` | everything, one verdict table |

## Layout

```
app/                 routes (server components by default); app/api/*/route.ts with Zod contracts
lib/server/          DB, auth, secrets. Every file starts with import 'server-only'
  supabase/          createUserClient (acts as the signed-in user), serviceClient, anonClient, callRpc
  auth/admin.ts      getAdminSession(): verified user + aal2 (TOTP within 12h) + admins membership, or null;
                     requireAdminPage(): same, redirecting to /admin/login. Call it in EVERY admin page.
  auth/admin-login.ts  password -> TOTP enrol/verify -> aal2, rate limited in the DB, uniform errors
lib/shared/          no I/O: types (DB enums mirrored and tested), Zod contracts, Asia/Jerusalem time
messages/            en.json (keys, primary) and he.json (UI text)
supabase/migrations  the migrations that ship to Supabase (moved from output/db/)
lib/server/jobs/     scheduled jobs (expiry sweep, daily retention), called by netlify/src/*
netlify/src/         Netlify Scheduled Functions, thin wrappers (built output netlify/functions/ is gitignored)
qa/                  Playwright regression + smoke
qa/                  Playwright regression + smoke (regression.<domain>.spec.js per domain)
app/(admin)/admin/   admin shell (bottom tabs) and its screens; app/(admin-auth)/admin/login/ the login flow
styles/admin.css     admin-only styles
```

## Rules that bite in code review

- Writes go through the DB's SECURITY DEFINER functions (`callRpc`), never `.insert()`/`.update()` on a table.
- Admin actions use `createUserClient()` so the DB sees the admin's own aal2 JWT; never pass an admin id.
- No second "is there room" check in app code: capacity lives in `fn_reserve_capacity`.
- Every new route goes into `qa/regression.spec.js` in the same PR, and every behaviour change updates `output/qa/SYSTEM-CONTRACT.md`.

## Public business settings (compliance-002, US-0b)

Yuval edits these `app_settings` keys (admin screen: a later task). Each is a
JSON string, or JSON `null` while unknown; the site then shows a visible
placeholder such as `[שם העסק]`. anon reads them only via `fn_public_site_settings()`.

| Key | Shown where |
|---|---|
| `business_name` | footer, `/business`, checkout summary |
| `business_owner_name` | `/business` |
| `business_registration_number` | `/business`, checkout summary, order confirmation (status wording from `vat_status`) |
| `business_address` | `/business` (home vs PO box: open legal question) |
| `business_phone` | contact block (tap to call), `/business` |
| `business_whatsapp` | contact block (wa.me) |
| `business_email` | `/business`, privacy notice |

Reusable pieces for other screens: `components/compliance` (`BusinessDetails`,
`CancellationExemptionNotice`), `components/contact-block` (`ContactBlock`, pass
`orderNumber` on order pages), `components/price` (`PriceWithVat`, `VatLabel`),
`lib/shared/compliance/versions.ts` (`TEXT_VERSIONS`: pass these to the order
functions), `lib/server/compliance/site-settings.ts` (`getPublicSiteSettings`).

## Checkout settings (api-003)

| What | Where | Notes |
|---|---|---|
| Delivery/pickup time slots | table `time_slots` (start, end, Asia/Jerusalem) | None ship in the migration (Yuval's hours are open); `seed.sql` has synthetic ones. The first active start is copied into `app_settings.earliest_slot_time` by a trigger: do not edit that key by hand. |
| Bit / PayBox links | `app_settings` `payment_link_bit`, `payment_link_paybox` | JSON null until set; shown only if https on the host allowlist in `lib/shared/payment/links.ts` (UNVERIFIED hosts). Read through `fn_payment_link_settings()` (service role). |
| Order creation | `POST /api/orders` -> `fn_create_standard_order` (service role only) | The client never sends an amount; the DB prices, reserves and checks the slot lead time. |
