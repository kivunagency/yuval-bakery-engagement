# YuvalBakery: instructions for any Claude session on this repo

This repo is the whole project: specs, decisions, DB, and (from now on) the app code.
Sessions may run in the cloud, where the Kivun agency agents, skills and laws under
`~/.claude/` are NOT available. Everything a cloud session needs is in this repo.

## Read first, in this order
1. `BRIEF.md` (all of Ran's decisions, dated). Decisions there are final; do not reopen them.
2. `05-prds/PRD-01-ordering-app.md` (approved scope, MVP vs Phase 2).
3. `decisions/ADR-001-stack.md`, `decisions/ADR-002-capacity-ledger.md`, `domain-map.md`.
4. `04-architecture/DB-PLAN.md` and `apps/web/supabase/migrations/` (schema, verified on postgres:17; test harness in `output/db/tests/`).
5. `threat-model.md` (SEC-NNN tasks), `compliance-spec.md`, `compliance-schema-review.md`, `infra-plan.md` (OPS-NNN).
6. `06-mockups/design-tokens.md` and `06-mockups/mockup.html` (visual direction).
7. `tasks.json` (task ids, layers, fetch location per screen).

## Where things go
- App code: `apps/web/` (Next.js 15 App Router, TypeScript strict).
- DB migrations: `apps/web/supabase/migrations/` (moved from `output/db/` at scaffold, numbering kept). New migration = next free timestamp; check open PRs for a collision before opening yours. `output/db/tests/run.sh` applies every migration to a throwaway postgres:17 (Docker, or a local PostgreSQL 17 when Docker Hub is unreachable, as in cloud sessions) and asserts the privilege test.
- Local dev and E2E: `cd apps/web && npm run stack:up` (PostgreSQL 17 + Supabase Auth + PostgREST, no Docker). See `apps/web/README.md`.
- One command for every check: `bash output/qa/verify-all.sh`.
- Business operations registry (Rule 27): `agent-ops-registry/` is the template, GO per ADR-001, off in production by default (threat model).

## Branches (Rule 6, Rule 23)
- `main` = PROD, `develop` = DEV. Never commit app code to `main` directly.
- One branch per task: `feature/<task-id>-<slug>` from `origin/develop`, PR into `develop`.
- Commit and push early. Promotion `develop` to `main` only with Ran's explicit approval.
- Docs-only changes to specs may go to `main` (as they have until now).

## Parallel sessions (several cloud sessions build tasks at once)
- Branch from the latest `origin/develop`; before opening a PR and whenever asked, `git merge origin/develop` (never rebase or force-push a pushed branch).
- Migrations: use only the timestamp lane your session prompt assigns (for example `20260926_03xxxx`), so parallel PRs never pick the same number.
- Regression tests: one file per domain, `apps/web/qa/regression.<domain>.spec.js`. `qa/regression.spec.js` is the shared baseline; add to it only for cross-cutting checks.
- `messages/*.json` and `SYSTEM-CONTRACT.md` are shared: add your keys under your own namespace, and expect to resolve small merge conflicts there.
- Do not merge your own PR. The orchestrating session merges into `develop` after CI is green. Nobody merges into `main`.

## Rules that bind this project (short form of the Kivun laws)
- **English-first i18n**: English keys, `en.json` primary, Hebrew in `he.json`. No Hebrew string literal in code. UI is RTL (`dir="rtl"`, logical CSS properties).
- **Server/client separation**: `app/api/*/route.ts` with Zod contracts; DB and secrets only in `lib/server/` with `import 'server-only'`. The anon key never writes to tables: every write goes through the SECURITY DEFINER functions in the schema, called server-side.
- **Screens arrive with their data**: first render is server-side; client fetch only for what changes after render.
- **Capacity is enforced in the DB only** (`fn_reserve_capacity`, `fn_release_order_capacity`). Never add a second "is there room" check in app code. Before changing a function that computes money or capacity, list every caller.
- **Admin actions** derive the actor from `auth.uid()` and require aal2. Never accept an admin id from the client.
- **New DB functions are callable by nobody by default** (migration 20260926090000). GRANT EXECUTE explicitly to the role that needs it; granting to `anon` also means adding it to the allowlist in `apps/web/qa/regression.security.spec.js`. Inside SECURITY DEFINER, check the service role with `fn_is_service_role()`, never `current_user`.
- **A check has three outcomes**: passed, failed, DID NOT RUN. Never report an unrun check as passed. "Done" names the artefact (the row written, the screen seen).
- **Regression + smoke**: `qa/regression.spec.js` and `qa/smoke.spec.js` (Playwright) must exist and pass before a task is done. No "deployed" claim without a browser hit on the live URL.
- **SYSTEM-CONTRACT**: `output/qa/SYSTEM-CONTRACT.md` + `output/qa/verify-all.sh`, updated in the same commit as behaviour changes.
- **Hebrew is verified rendered** (screenshot), never by reading source. Fix bidi with direction, never by moving characters.
- **No em-dash or en-dash** (U+2014, U+2013) anywhere. Count them in Python before finishing a file.
- **Public site baseline**: privacy notice (s.11), marketing opt-in unticked and separate (s.30A), business details (s.14C), cancellation exemption text, allergens per product, accessibility statement, AA contrast, 44px targets, keyboard focus, reduced motion.
- **Spend caps**: every metered account gets a cap and an alert to a human before first use. No metered API is planned (no SMS, no geocoding); adding one needs Ran.
- **Accounts** (Netlify, Supabase, Resend, domain) are owned by Yuval, created by her. Never create accounts or type credentials. Secrets come from environment variables only; never commit them.

## Status (2026-09-25)
Specs, design, architecture, threat model, compliance and DB are done and committed. `apps/web` is scaffolded (Next.js 15, i18n, tokens, CSP, Supabase clients, admin aal2 session helper, local stack, Playwright, CI). Next: MVP tasks from `tasks.json` in dependency order, one branch and PR each into `develop`. Waiting on Yuval: accounts, business name, עוסק status and number, working days, allergens, product photos, payment-expiry windows.
