#!/bin/bash
# Local Supabase-shaped stack for dev and tests, no Docker needed:
#   PostgreSQL 17 (pg17.sh) + Supabase Auth (GoTrue) + PostgREST + a small
#   gateway on :54321 that serves /auth/v1 and /rest/v1 like the hosted API.
# Writes apps/web/.env.local (gitignored) with a per-run JWT secret and
# locally minted anon/service keys. Nothing here touches DEV or PROD.
# Usage: npm run stack:up   (then npm run dev)   ; npm run stack:down
set -euo pipefail
APP="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$APP/.local-stack"
AUTH_VERSION="${AUTH_VERSION:-v2.180.0}"
POSTGREST_VERSION="${POSTGREST_VERSION:-v12.2.3}"
PG_PORT=54322; REST_PORT=54330; AUTH_PORT=54340; GW_PORT=54321; SMTP_PORT=54325
SITE_URL="${SITE_URL:-http://localhost:3000}"

# shellcheck source=/dev/null
. "$APP/scripts/local-stack/pg17.sh"
BIN_CACHE="$(dirname "$PG17_HOME")/stack-bin"
mkdir -p "$STATE" "$BIN_CACHE"

bash "$APP/scripts/local-stack/down.sh" >/dev/null 2>&1 || true

# ---- binaries -------------------------------------------------------------
if [ ! -x "$BIN_CACHE/auth-$AUTH_VERSION/auth" ]; then
  mkdir -p "$BIN_CACHE/auth-$AUTH_VERSION"
  curl -fsSL "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/auth-$AUTH_VERSION-x86.tar.gz" \
    | tar xz -C "$BIN_CACHE/auth-$AUTH_VERSION"
fi
if [ ! -x "$BIN_CACHE/postgrest-$POSTGREST_VERSION" ]; then
  curl -fsSL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x64.tar.xz" \
    | tar xJ -C "$BIN_CACHE" && mv "$BIN_CACHE/postgrest" "$BIN_CACHE/postgrest-$POSTGREST_VERSION"
fi

# ---- postgres + supabase roles/schemas ------------------------------------
pg17_start "$STATE/pgdata" "$PG_PORT"
echo "$STATE/pgdata" > "$STATE/pgdata.path"
PSQL="psql -h 127.0.0.1 -p $PG_PORT -U postgres -d postgres -q -v ON_ERROR_STOP=1"
$PSQL -f "$APP/scripts/local-stack/bootstrap.sql" >/dev/null

JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
mint() { node -e '
  const c=require("crypto"),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const h=b({alg:"HS256",typ:"JWT"}),p=b({iss:"supabase-local",role:process.argv[1],iat:1758758400,exp:4914432000});
  console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[2]).update(h+"."+p).digest("base64url"))' "$1" "$JWT_SECRET"; }
ANON_KEY="$(mint anon)"; SERVICE_KEY="$(mint service_role)"

# ---- mail sink (Auth sends its confirmation mails here, api-010) ---------
rm -rf "$STATE/mail"
MAIL_DIR="$STATE/mail" SMTP_PORT=$SMTP_PORT \
  nohup node "$APP/scripts/local-stack/smtp-sink.mjs" >"$STATE/smtp.log" 2>&1 & echo $! > "$STATE/smtp.pid"

# ---- gateway (also serves supabase/templates/ for Auth's mail templates) ---
GW_PORT=$GW_PORT AUTH_PORT=$AUTH_PORT REST_PORT=$REST_PORT TEMPLATES_DIR="$APP/supabase/templates" \
  nohup node "$APP/scripts/local-stack/gateway.mjs" >"$STATE/gateway.log" 2>&1 & echo $! > "$STATE/gateway.pid"

# ---- auth (runs its own migrations into schema auth) ----------------------
AUTH_DIR="$BIN_CACHE/auth-$AUTH_VERSION"
export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:$PG_PORT/postgres?search_path=auth"
export GOTRUE_DB_MIGRATIONS_PATH="$AUTH_DIR/migrations"
export GOTRUE_API_HOST=127.0.0.1 PORT=$AUTH_PORT
export API_EXTERNAL_URL="http://127.0.0.1:$GW_PORT/auth/v1"
export GOTRUE_SITE_URL="$SITE_URL" GOTRUE_URI_ALLOW_LIST="$SITE_URL/**"
export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
# Email confirmation ON, as on hosted Supabase (SEC-014). Mail goes to the
# local sink; the confirmation mail uses the repo's template, whose link carries
# a token_hash that /account/confirm verifies (works on any device).
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT=$SMTP_PORT GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.test GOTRUE_SMTP_SENDER_NAME=YuvalBakery-local
export GOTRUE_MAILER_TEMPLATES_CONFIRMATION="http://127.0.0.1:$GW_PORT/templates/confirmation.html"
export GOTRUE_PASSWORD_MIN_LENGTH=12
export GOTRUE_EXTERNAL_PHONE_ENABLED=false
export GOTRUE_MFA_TOTP_ENROLL_ENABLED=true GOTRUE_MFA_TOTP_VERIFY_ENABLED=true GOTRUE_MFA_MAX_ENROLLED_FACTORS=10
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_RATE_LIMIT_VERIFY=1000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=1000
export GOTRUE_LOG_LEVEL=warn
"$AUTH_DIR/auth" migrate >"$STATE/auth-migrate.log" 2>&1 || { cat "$STATE/auth-migrate.log"; exit 1; }
nohup "$AUTH_DIR/auth" serve >"$STATE/auth.log" 2>&1 & echo $! > "$STATE/auth.pid"

# ---- app migrations (same files that ship to Supabase) --------------------
for f in "$APP"/supabase/migrations/*.sql; do
  $PSQL -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }
done
[ "${SEED:-1}" = 1 ] && $PSQL -f "$APP/supabase/seed.sql" >/dev/null

# ---- postgrest ------------------------------------------------------------
PGRST_DB_URI="postgres://authenticator:postgres@127.0.0.1:$PG_PORT/postgres" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_DB_EXTRA_SEARCH_PATH=public,extensions \
PGRST_JWT_SECRET="$JWT_SECRET" PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT=$REST_PORT \
PGRST_DB_CHANNEL_ENABLED=true PGRST_LOG_LEVEL=warn \
  nohup "$BIN_CACHE/postgrest-$POSTGREST_VERSION" >"$STATE/rest.log" 2>&1 & echo $! > "$STATE/rest.pid"


for i in $(seq 1 60); do
  a=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GW_PORT/auth/v1/health" || true)
  r=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON_KEY" "http://127.0.0.1:$GW_PORT/rest/v1/" || true)
  [ "$a" = 200 ] && [ "$r" = 200 ] && break
  sleep 0.5
  [ "$i" = 60 ] && { echo "stack did not become healthy (auth=$a rest=$r)"; tail -20 "$STATE"/*.log; exit 1; }
done

# job-002: web push test keys (VAPID, P-256), minted per run like the JWT
# secret. Never committed; DEV/PROD keys come from Netlify env (Yuval's).
read -r VAPID_PUBLIC VAPID_PRIVATE < <(node -e '
  const e=require("crypto").createECDH("prime256v1");e.generateKeys();
  console.log(e.getPublicKey().toString("base64url")+" "+e.getPrivateKey().toString("base64url"))')

cat > "$APP/.env.local" <<ENV
# Written by scripts/local-stack/up.sh. Local stack only, regenerated every run.
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$GW_PORT
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
SUPABASE_JWT_SECRET=$JWT_SECRET
DATABASE_URL_TEST=postgres://postgres@127.0.0.1:$PG_PORT/postgres
APP_ENV=local
SITE_URL=$SITE_URL
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:qa@example.test
EMAIL_PROVIDER=capture
EMAIL_CAPTURE_DIR=$STATE/outbox
PUSH_ALLOW_LOCAL_ENDPOINTS=1
ENV
echo "local stack up: api http://127.0.0.1:$GW_PORT  db 127.0.0.1:$PG_PORT  (.env.local written)"
