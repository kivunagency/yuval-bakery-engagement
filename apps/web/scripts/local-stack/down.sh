#!/bin/bash
# Stop the local stack started by up.sh and delete its data.
APP="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$APP/.local-stack"
for s in gateway rest auth smtp; do
  [ -f "$STATE/$s.pid" ] && kill "$(cat "$STATE/$s.pid")" 2>/dev/null
  rm -f "$STATE/$s.pid"
done
if [ -f "$STATE/pgdata.path" ]; then
  # shellcheck source=/dev/null
  . "$APP/scripts/local-stack/pg17.sh"
  pg17_stop "$(cat "$STATE/pgdata.path")"
  rm -f "$STATE/pgdata.path"
fi
echo "local stack down"
