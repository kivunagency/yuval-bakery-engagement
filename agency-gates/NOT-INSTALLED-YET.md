Installed on 2026-09-26 (branch feature/agency-gates), adapted to this layout:

- scripts: `apps/web/scripts/gates/` (plus `selftest.sh` and `check-baselines-reproducible.mjs`)
- baselines: `apps/web/qa/gates/*.baseline.json`, taken from develop at c9a63ae (ratchet)
- CI: `.github/workflows/agency-gates.yml`; locally: `bash output/qa/verify-all.sh`

This folder stays as the pristine copy that arrived at bootstrap. The installed copy is the
one that runs; the differences are marked "YuvalBakery adaptation" or "YuvalBakery fix" in
each script. Not installed: `check-proof-of-execution.mjs` (Rule 17), see SYSTEM-CONTRACT.md.
