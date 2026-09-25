---
client: yuval-bakery
stage: client
created: 2026-09-25
source: bootstrap-client.py
---

# YuvalBakery — Engagement History

## 2026-09-25 — Bootstrap

Engagement workspace created via standard bootstrap. Folder structure, .gitignore, and base docs in place.

Status: **client**

Next steps:
- Fill in PROSPECT-BRIEF.md (or BRIEF.md for signed client)
- Begin research (Phase 1 of /prep-first-meeting if prospect)

---

- 2026-09-25: PRD-01 approved by Ran with one change: delivery pricing by city zones instead of distance ranges. Loyalty stays Phase 2 (maya recommendation, not objected). Next: design + architecture.
- 2026-09-25: build-pipeline phases 1-3 done (design, architecture, threat model, compliance, infra). Stopped before DB design pending Ran decisions.
- 2026-09-25: DB fixes (unpaid cap, cancel paid, admin privilege escalation, rotem B1-B5). Dispatcher re-ran all 10 migrations on fresh postgres:17 + privilege test: 5/5 as expected (output/db/tests/run.sh).
- 2026-09-25: apps/web scaffolded (Next.js 15). Migrations moved to apps/web/supabase/migrations. Local Supabase-shaped stack (pg17 + Auth + PostgREST) found a PROD bug: every SECURITY DEFINER function pinned search_path=public while pgcrypto lives in schema extensions on Supabase, so guest checkout failed. Fixed in migration 20260925121200.
