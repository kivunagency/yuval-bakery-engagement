#!/bin/bash
# Apply every migration to a throwaway PostgreSQL 17 and run the privilege test.
# Engine: docker postgres:17 when Docker can pull it, otherwise a local
# PostgreSQL 17 from apps/web/scripts/local-stack/pg17.sh (cloud sessions have
# no Docker Hub access). Force one with DB_TEST_ENGINE=docker|local.
# Exit code: 0 = all expectations met, 1 = a migration failed or an expectation
# was not met. Output ends with PASSED or FAILED, never silence.
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TESTS="$ROOT/output/db/tests"
MIG="$ROOT/apps/web/supabase/migrations"
ENGINE="${DB_TEST_ENGINE:-auto}"

if [ "$ENGINE" = auto ]; then
  if docker info >/dev/null 2>&1 && timeout 120 docker pull -q postgres:17 >/dev/null 2>&1; then ENGINE=docker; else ENGINE=local; fi
fi
echo "engine: $ENGINE"

if [ "$ENGINE" = docker ]; then
  C=yuval-db-test-$$
  docker run -d --rm --name $C -e POSTGRES_PASSWORD=x postgres:17 >/dev/null || exit 1
  trap 'docker rm -f $C >/dev/null 2>&1' EXIT
  until docker exec $C pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
  PSQL="docker exec -i $C psql -U postgres"
else
  command -v psql >/dev/null || { echo "psql client not found on PATH"; exit 1; }
  # shellcheck source=/dev/null
  . "$ROOT/apps/web/scripts/local-stack/pg17.sh"
  PORT="${DB_TEST_PORT:-55499}"
  DATA="${TMPDIR:-/tmp}/yuval-db-test-$$"
  pg17_start "$DATA" "$PORT" || { echo "could not start local postgres 17"; exit 1; }
  trap 'pg17_stop "$DATA"' EXIT
  PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -d postgres"
fi

$PSQL -Atc "select version()"
P="$PSQL -q -v ON_ERROR_STOP=1"
$P < "$TESTS/00_auth_stub.sql" || { echo "STUB FAILED"; echo FAILED; exit 1; }
for f in "$MIG"/*.sql; do
  $P < "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; echo FAILED; exit 1; }
  echo "applied $(basename "$f")"
done

OUT="$($PSQL < "$TESTS/privilege_test.sql" 2>&1)"
echo "$OUT"

fail=0
expect() { # expect <label> <count> <pattern>
  local n; n=$(printf '%s\n' "$OUT" | grep -c -- "$3")
  if [ "$n" = "$2" ]; then echo "PASS $1"; else echo "FAIL $1 (expected $2 match(es) of '$3', got $n)"; fail=1; fi
}
expect "T1,T2,T4 non-admin or aal1 callers rejected" 3 "ERROR:  admin_aal2_required"
expect "T3 admin with aal2 sets capacity" 1 "T3_admin_aal2_set_capacity | 2026-10-01"
expect "T5 anon cannot write capacity_day_ledger" 1 "permission denied for table capacity_day_ledger"
expect "T6 total below reserved -> capacity_total_below_reserved" 1 "ERROR:  capacity_total_below_reserved: oven 100 work 0"
expect "T7 minutes outside 0..1440 -> capacity_invalid_minutes" 1 "ERROR:  capacity_invalid_minutes"
expect "T7b a hand-set day is source=manual" 1 "T7b_manual_source | manual"
expect "T8 anon cannot call fn_admin_set_day_capacity" 1 "permission denied for function fn_admin_set_day_capacity"
expect "T9 admin with aal2 creates a delivery zone" 1 "T9_admin_create_zone | T9 zone"
expect "T10 a city already in a zone -> delivery_city_in_other_zone" 1 "ERROR:  delivery_city_in_other_zone: T9 city"
expect "T11 authenticated cannot write delivery_zones directly" 1 "permission denied for table delivery_zones"
expect "T12 anon cannot call fn_admin_create_delivery_zone" 1 "permission denied for function fn_admin_create_delivery_zone"
expect "T12b zone creation is audited" 1 "T12b_zone_audited=1"
[ $fail = 0 ] && echo PASSED || echo FAILED
exit $fail
