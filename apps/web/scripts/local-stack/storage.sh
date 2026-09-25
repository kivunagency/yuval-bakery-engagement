#!/bin/bash
# Supabase Storage (open-source supabase/storage) for the local stack.
# Source this file; storage_install builds it once into the cache, then
# storage_start runs it with the file backend. Local and CI only.
# It needs Node >= 24; Node comes from the npm package node-linux-x64 (npm
# is reachable where nodejs.org and Docker Hub are not), and its bundled
# headers let node-gyp compile the one native module (fs-xattr) offline.
STORAGE_VERSION="${STORAGE_VERSION:-v1.79.20}"
NODE24_VERSION="${NODE24_VERSION:-24.21.0}"

storage_install() { # storage_install <cache_dir>
  local cache="$1" src="$1/storage-$STORAGE_VERSION" node="$1/node-$NODE24_VERSION"
  if [ ! -x "$node/bin/node" ]; then
    local tmp; tmp="$(mktemp -d)"
    (cd "$tmp" && npm pack --silent "node-linux-x64@$NODE24_VERSION" >/dev/null && tar xzf ./*.tgz) || return 1
    rm -rf "$node" && mv "$tmp/package" "$node" && rm -rf "$tmp"
  fi
  if [ ! -f "$src/.built" ]; then
    rm -rf "$src"
    git clone -q --depth 1 --branch "$STORAGE_VERSION" https://github.com/supabase/storage "$src" 2>/dev/null || return 1
    local npmcli; npmcli="$(dirname "$(readlink -f "$(command -v npm)")")/npm-cli.js"
    (cd "$src" \
      && npm ci --ignore-scripts --no-audit --no-fund --engine-strict=false --force >/dev/null 2>&1 \
      && PATH="$node/bin:$PATH" npm_config_nodedir="$node" "$node/bin/node" "$npmcli" rebuild fs-xattr --engine-strict=false >/dev/null 2>&1 \
      && "$node/bin/node" ./build.js >/dev/null \
      && "$node/bin/node" node_modules/.bin/resolve-tspaths >/dev/null \
      && touch .built) || { echo "storage: build failed"; return 1; }
  fi
  STORAGE_NODE="$node/bin/node"; STORAGE_SRC="$src"
}

storage_start() { # storage_start <port> <db_port> <jwt_secret> <anon> <service> <files_dir> <log> <pidfile>
  mkdir -p "$6"
  (
    cd "$STORAGE_SRC" || exit 1
    export SERVER_PORT="$1" AUTH_JWT_SECRET="$3" AUTH_JWT_ALGORITHM=HS256 ANON_KEY="$4" SERVICE_KEY="$5" \
      DATABASE_URL="postgres://postgres@127.0.0.1:$2/postgres" DB_INSTALL_ROLES=true \
      STORAGE_BACKEND=file FILE_STORAGE_BACKEND_PATH="$6" GLOBAL_S3_BUCKET=local TENANT_ID=local REGION=local \
      UPLOAD_FILE_SIZE_LIMIT=52428800 UPLOAD_SIGNED_URL_EXPIRATION_TIME=120 IMAGE_TRANSFORMATION_ENABLED=false NODE_ENV=production
    exec nohup "$STORAGE_NODE" dist/start/server.js >"$7" 2>&1 </dev/null
  ) &
  echo $! > "$8"
}
