#!/bin/bash
# Throwaway PostgreSQL 17 without Docker Hub.
# Source this file, then: pg17_start <data_dir> <port> ; pg17_stop <data_dir>
# Binaries come from the npm package @embedded-postgres/linux-x64 (plain
# upstream PostgreSQL 17 builds), cached outside the repo. Test use only.
PG17_VERSION="${PG17_VERSION:-17.10.0-beta.17}"
if [ "$(id -u)" = 0 ]; then
  PG17_HOME="${PG17_HOME:-/opt/yuval-bakery-pg17}"
else
  PG17_HOME="${PG17_HOME:-$HOME/.cache/yuval-bakery/pg17}"
fi
PG17_BIN="$PG17_HOME/bin"
PG17_RUNAS="${PG17_RUNAS:-pgrunner}"

pg17_install() {
  [ -x "$PG17_BIN/postgres" ] && return 0
  local tmp; tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack --silent "@embedded-postgres/linux-x64@$PG17_VERSION" >/dev/null && tar xzf ./*.tgz) || { echo "pg17: download failed"; return 1; }
  mkdir -p "$PG17_HOME"
  cp -r "$tmp/package/native/." "$PG17_HOME/"
  # the npm tarball stores shared-library symlinks as a JSON list
  (cd "$PG17_HOME" && node -e '
    const fs=require("fs");const l=JSON.parse(fs.readFileSync("pg-symlinks.json","utf8"));
    const p=require("path");const s=x=>x.replace(/^native\//,"");
    for (const e of l){const t=s(e.target);try{fs.unlinkSync(t)}catch{};fs.symlinkSync(p.relative(p.dirname(t),s(e.source)),t)}')
  chmod -R a+rX "$PG17_HOME"
  rm -rf "$tmp"
}

_pg17_as() {
  if [ "$(id -u)" = 0 ]; then
    id "$PG17_RUNAS" >/dev/null 2>&1 || useradd -M -r -s /bin/bash "$PG17_RUNAS"
    su "$PG17_RUNAS" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

pg17_start() {
  local data="$1" port="$2"
  pg17_install || return 1
  rm -rf "$data"; mkdir -p "$data"
  [ "$(id -u)" = 0 ] && { id "$PG17_RUNAS" >/dev/null 2>&1 || useradd -M -r -s /bin/bash "$PG17_RUNAS"; chown "$PG17_RUNAS" "$data"; }
  _pg17_as "LD_LIBRARY_PATH=$PG17_HOME/lib $PG17_BIN/initdb -D $data -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null" || return 1
  _pg17_as "LD_LIBRARY_PATH=$PG17_HOME/lib $PG17_BIN/pg_ctl -D $data -o '-p $port -k /tmp -c listen_addresses=127.0.0.1' -l $data/server.log -w start >/dev/null" || { cat "$data/server.log"; return 1; }
}

pg17_stop() {
  local data="$1"
  [ -d "$data" ] || return 0
  _pg17_as "LD_LIBRARY_PATH=$PG17_HOME/lib $PG17_BIN/pg_ctl -D $data -m fast stop >/dev/null 2>&1"
  rm -rf "$data"
}
