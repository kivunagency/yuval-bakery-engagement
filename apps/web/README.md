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
| `bash ../../output/qa/verify-all.sh` | everything, one verdict table |

## Layout

```
app/                 routes (server components by default); app/api/*/route.ts with Zod contracts
lib/server/          DB, auth, secrets. Every file starts with import 'server-only'
  supabase/          createUserClient (acts as the signed-in user), serviceClient, anonClient, callRpc
  auth/admin.ts      getAdminSession(): verified user + aal2 + admins membership, or null
lib/shared/          no I/O: types (DB enums mirrored and tested), Zod contracts, Asia/Jerusalem time
messages/            en.json (keys, primary) and he.json (UI text)
supabase/migrations  the migrations that ship to Supabase (moved from output/db/)
qa/                  Playwright regression + smoke
```

## Rules that bite in code review

- Writes go through the DB's SECURITY DEFINER functions (`callRpc`), never `.insert()`/`.update()` on a table.
- Admin actions use `createUserClient()` so the DB sees the admin's own aal2 JWT; never pass an admin id.
- No second "is there room" check in app code: capacity lives in `fn_reserve_capacity`.
- Every new route goes into `qa/regression.spec.js` in the same PR, and every behaviour change updates `output/qa/SYSTEM-CONTRACT.md`.
