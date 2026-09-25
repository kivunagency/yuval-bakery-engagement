#!/bin/bash
# Apply all migrations to a throwaway postgres:17 and run the privilege test.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
C=yuval-db-test-$$
docker run -d --rm --name $C -e POSTGRES_PASSWORD=x postgres:17 >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1' EXIT
until docker exec $C pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
P="docker exec -i $C psql -U postgres -q -v ON_ERROR_STOP=1"
$P < "$DIR/tests/00_auth_stub.sql" || { echo "STUB FAILED"; exit 1; }
for f in "$DIR"/migrations/*.sql "$DIR/indexes.sql"; do
  $P < "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }
  echo "applied $(basename "$f")"
done
docker exec -i $C psql -U postgres < "$DIR/tests/privilege_test.sql" 2>&1
