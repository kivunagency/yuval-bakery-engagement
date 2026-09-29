# Security gate: the operations registry of YuvalBakery

`agent-ops-registry/SECURITY.md` filled in for THIS system (ops-registry-001,
ADR-001 "Rule 27: operations registry: GO", threat-model.md 2.10 and 3.7,
SEC-004, SEC-017, SEC-027). Each MUST line names its evidence. A line that
reads DID NOT RUN is not met until it runs. `deploy-engineer` blocks PROD
promotion while a MUST is unmet.

## How an agent is authenticated, and what it may do

- **Off by default, everywhere.** The routes exist only when
  `OPS_REGISTRY_ENABLED=true`. Otherwise `POST/GET/DELETE /api/ops/mcp` and
  `POST /api/admin/ops-registry/tokens` answer 404 with an empty body, like a
  route that does not exist. Switched on without `OPS_REGISTRY_TOKEN_SECRET`
  (32+ characters) they answer 503 `ops_registry_misconfigured`: no default
  key, no guest role, no service role.
- **An agent token is a delegated admin session.** An admin, signed in with
  password and TOTP (aal2), calls `POST /api/admin/ops-registry/tokens`
  (same Origin) with `{ "role": "verifier" | "operator" }`. The server wraps
  that admin's own Supabase access token in an encrypted token (JWE, dir +
  A256GCM, key derived from `OPS_REGISTRY_TOKEN_SECRET`) with `aud` = the MCP
  endpoint URL (RFC 8707), a fixed `iss`, `typ ops-agent+jwt`, a `jti`, and a
  lifetime of at most one hour that never runs past the inner access token.
  There is no refresh token inside. The minting is audited before the token
  is returned (`ops_registry.token_minted`).
- **Every call re-checks the admin.** The MCP route accepts
  `Authorization: Bearer <agent token>` only (no cookie, no body field, no
  other header). It decrypts and verifies the token, checks the role is
  allowed in this environment, then runs the same checks as
  `getAdminSession()` on the inner access token: Auth accepts it (a signed-out
  session is refused), aal2, TOTP step at most 12 hours old, and the DB's
  `is_admin_aal2()`, for the same admin the token was minted for. Every DB
  call then runs as that admin's JWT, so the DB checks aal2 again. The agent
  never holds anything it could use against the Data API directly.
- **Roles.** `verifier`: navigation plus `generateDeliveryList`, which an
  agent always gets as counts per city (`redactDeliveryListForAgent`, no
  name, phone, address or notes). `operator`: also `markOrderPaid`,
  `approveCustomCakeRequest`, `declineCustomCakeRequest`,
  `updateDayCapacity`, each behind a server-enforced confirmation.
- **Production (`APP_ENV=prod`): read only.** The mint route refuses
  `operator` (403 `role_not_allowed`), `resolvePrincipal` refuses an operator
  token, and `runOne` refuses every write operation. Three independent
  checks, so an agent cannot mark paid, approve, decline or change capacity
  in production even if the registry is switched on for a live probe.
- **Confirmation.** A write's first call returns `CONFIRMATION_REQUIRED` with
  the exact arguments and a `confirmationToken` (HMAC over operation,
  canonical arguments, agent token id and a 5-minute expiry). Only a second
  call with the same arguments, the same agent token and that token runs.
  The pause is where the MCP client shows the human the call.

## A. The invariant (MUST)

- [x] Every path to a handler goes through `runOne`. The MCP adapter's tool
  callback calls `runOne` (the template's adapter called the handler
  directly; changed on purpose). Evidence: `tests/agent-ops.test.ts`
  "only dispatch.ts calls op.handler" (source scan of `lib/` and `app/`).
- [x] Identity derived server-side from a verified bearer token only.
  Evidence: `principal.ts`; `tests/agent-ops.test.ts` (principal reads only
  the Authorization header); `qa/regression.ops-registry.spec.js` "MCP
  authentication fails closed" (a browser cookie alone is 401).
- [x] No identity field from the body, query or a client-settable header.
  Operation inputs carry ids of orders, requests and days only; the actor is
  `auth.uid()` in every DB function.
- [x] `resolvePrincipal` fails closed. Evidence: regression "MCP
  authentication fails closed": 13 refusals (no bearer, cookie only,
  garbage, raw access token, another key, another audience, over one hour,
  expired, wrong issuer, wrong typ, unknown role, another subject, a
  customer session), each against a positive control forged with the real
  key.
- [x] A low-privilege caller gets `FORBIDDEN` via `invoke` and via a batch.
  Evidence: regression "verifier (RBAC)"; unit "invoke re-authorizes every
  inner call". There is no composite operation.

## B. Session and authentication (MUST)

- [x] Cookies, idle timeout, logout, passwords, login rate limit, MFA: the
  admin login's own (db-005, SEC-002, SEC-013); the registry adds no login.
  An agent token needs an aal2 admin session to exist. SEC-013's 30-minute
  idle timeout is still not built (SYSTEM-CONTRACT section 3), the 12-hour
  absolute limit is.
- [x] Session invalidated on logout: signing the admin out ends the agent
  tokens that carry that session. Evidence: regression "signing the admin
  out".
- [x] Agent tokens are audience-bound (RFC 8707) and expire (at most one
  hour). Evidence: `tests/agent-ops.test.ts` "agent token", regression
  "minting" and "fails closed".

## C. Tenant isolation (MUST for multi-tenant)

- [x] Not applicable: one business, one tenant. Row access is the DB's
  (RLS and SECURITY DEFINER functions with `is_admin_aal2()`).
- [x] Missing row and forbidden row: an agent can only act as an aal2 admin,
  who may see every row; missing ids answer `NOT_FOUND`.
- [x] Object references are UUIDs.

## D. Operation metadata (MUST)

- [x] Least privilege: writes `['operator']`, the delivery summary
  `['verifier']`. Evidence: unit "every write is operator-only".
- [x] `requiresConfirmation: true` on the four writes, enforced in `runOne`.
  Evidence: regression "operator markOrderPaid" (refused until confirmed;
  confirmation bound to its arguments and to its agent token; tampered
  refused); unit "confirmation".
- [x] Minimal returns: no capability link (SEC-003), no WhatsApp link (it
  carries the phone), no customer text. The decline takes no reason text
  (only Yuval writes one, threat-model 3.5). Evidence: regression "approve /
  decline" and "generateDeliveryList for an agent".
- [x] Invisible, not merely rejected: `tools/list`, `explore`, `search` and
  `describe_tool` are role-filtered. Evidence: regression "verifier (RBAC)".

## E. Audit (MUST: money and PII)

- [x] Persistent append-only sink: `audit_log` through
  `fn_ops_registry_call_begin` / `_finish` (migration
  `20260926160000_ops_registry_audit_and_rate_limit.sql`). A call whose
  begin row cannot be written does not run (`AUDIT_UNAVAILABLE`). The
  business functions still write their own rows with the admin as actor.
- [x] No UPDATE or DELETE for the app roles, and a trigger refuses both for
  everyone. Evidence: `output/db/tests/run.sh` T16d, T16e; regression
  "audit trail is append-only".
- [x] `REDACT_KEYS` extended with phone, address, name, email, notes,
  inscription, reason. Evidence: unit "audit redaction"; regression "bad
  input" (a phone sent by the agent is stored as `[REDACTED]`).
- [x] Reading the audit log: RLS `audit_log_select_admin_only` (aal2). The
  registry exposes no audit read.

## F. Transport and dependencies (MUST)

- [ ] HTTPS with HSTS: Netlify's (infra-002). DID NOT RUN: nothing deployed.
- [x] CSP without `unsafe-inline` / `unsafe-eval`: the site-wide middleware.
- [x] `@modelcontextprotocol/sdk` pinned at 1.30.1 (current), `jose`
  6.2.12, both exact; not the reference implementation's lockfile (SEC-027).
  `npm audit --omit=dev` adds no finding for either.
- [x] MCP transport rules: a request with a foreign `Origin` is 403 (DNS
  rebinding), body over 64 KB is 413, stateless JSON mode (no session, GET
  and DELETE 405). Evidence: regression "transport".

## G. Agent-specific risks (SHOULD)

- [x] Prompt injection (confused deputy, threat-model 2.10): an injected
  instruction in customer text never reaches the agent through the registry
  (no operation returns customer text), writes need a confirmation, and in
  production there are no writes.
- [x] Human in the loop for money and messages: the confirmation step, and
  no writes in production. No operation sends a message to a customer.
- [x] Rate limit per agent token, independent of the UI:
  `ops_registry_calls_per_token_per_minute` (60) in `app_settings`, enforced
  in the same DB call that writes the audit row. Evidence: regression "rate
  limit", `run.sh` T16.
- [x] `getContext` returns role and environment only, no user id.

## Sign-off

| Gate | Evidence | Status |
|---|---|---|
| Build time (A to F) | `tests/agent-ops.test.ts`, `qa/regression.ops-registry.spec.js`, `output/db/tests/run.sh` T15 to T17b | PASSED locally |
| Pre-OPERATE live probe | against the deployed surface | DID NOT RUN: nothing deployed (infra-002) |
| PROD promotion | this checklist complete, F's HTTPS line included | open |
