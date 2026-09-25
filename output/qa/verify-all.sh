#!/bin/bash
# One command, one verdict. Runs every automated check this repo has and prints
# a table of PASSED / FAILED / DID NOT RUN. Exit 0 only if nothing FAILED.
# DID NOT RUN never counts as passed; it is listed so nobody reads it as green.
#   bash output/qa/verify-all.sh          # everything local
#   SMOKE_BASE_URL=https://... bash output/qa/verify-all.sh   # plus live smoke
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB="$ROOT/apps/web"
declare -a NAMES RESULTS
record() { NAMES+=("$1"); RESULTS+=("$2"); }
run() { # run <name> <command...>
  local name="$1"; shift
  echo "::: $name"
  if "$@"; then record "$name" PASSED; else record "$name" FAILED; fi
}

run "no em/en-dash in apps/, output/qa/, CLAUDE.md" python3 "$WEB/scripts/check-dashes.py" apps output/qa CLAUDE.md
run "DB: migrations on postgres 17 + privilege test" bash "$ROOT/output/db/tests/run.sh"
cd "$WEB" || exit 1
run "lint" npm run -s lint
run "typecheck" npm run -s typecheck
run "unit tests" npm run -s test
run "build" npm run -s build
run "build netlify functions (job-001 bundles)" npm run -s build:functions

if bash scripts/local-stack/up.sh; then
  record "local stack up (pg17 + auth + postgrest)" PASSED
  run "qa-001 capacity race (N concurrent pg connections)" npm run -s test:race
  run "business day + lead time, date and slot (Asia/Jerusalem)" npm run -s test:business-day
  run "regression specs incl. regression.jobs (Playwright)" npx playwright test -c qa/playwright.config.js --project=mobile
  bash scripts/local-stack/down.sh >/dev/null
else
  record "local stack up (pg17 + auth + postgrest)" FAILED
  record "qa-001 capacity race (N concurrent pg connections)" "DID NOT RUN"
  record "business day + lead time, date and slot (Asia/Jerusalem)" "DID NOT RUN"
  record "regression specs incl. regression.jobs (Playwright)" "DID NOT RUN"
fi

if [ -n "${SMOKE_BASE_URL:-}" ]; then
  run "smoke.spec.js against $SMOKE_BASE_URL" env SKIP_WEBSERVER=1 npx playwright test -c qa/playwright.config.js --project=smoke
else
  record "smoke.spec.js (live url)" "DID NOT RUN (SMOKE_BASE_URL not set, nothing deployed yet)"
fi
record "Storage server in the local stack (photo upload E2E)" "DID NOT RUN (supabase/storage not in the local stack yet)"
record "job-001 scheduled on Netlify" "DID NOT RUN (no Netlify site yet, infra-002)"
record "api-010 hosted Auth mail (custom SMTP + template)" "DID NOT RUN (Yuval's Supabase + Resend accounts, infra)"
record "job-002 real email via Resend" "DID NOT RUN (no Resend account yet, Yuval's; capture adapter used)"
record "job-002 real web push to a device" "DID NOT RUN (stand-in push service on 127.0.0.1 only)"

echo; echo "================ verify-all ================"
fail=0
for i in "${!NAMES[@]}"; do
  printf '%-55s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
  [ "${RESULTS[$i]}" = FAILED ] && fail=1
done
[ $fail = 0 ] && echo "VERDICT: no failures (see DID NOT RUN lines)" || echo "VERDICT: FAILED"
exit $fail
