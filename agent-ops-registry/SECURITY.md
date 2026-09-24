# Security gate checklist: agent-ops-registry

This encodes the conditions from the security review that cleared this pattern
(boaz, 2026-07-19: `verdict_adopt = PASS_WITH_CONDITIONS`). Full report:
`~/MakeCompany-clients/kivun-agency/cybersec/skillspector/navwebmcp-boaz-review-2026-07-19.md`

**`deploy-engineer` BLOCKS PROD promotion if any MUST item is unmet.**
Verify with evidence, not by reading code and assuming. Rule 12 Phase 4.6 applies.

---

## A. The invariant (MUST, non-negotiable)

- [ ] Every path to a handler goes through `runOne`. No route, composite operation, or helper calls `op.handler` directly.
- [ ] `userId`, `tenantId`, and `role` are derived **server-side** from a verified session cookie or verified bearer token.
- [ ] No identity field is ever read from the request body, query string, or a client-settable header.
- [ ] `resolvePrincipal` fails closed. There is no default or guest role fallback.
- [ ] Verified by test: a low-privilege caller invoking a privileged operation via `invoke` gets `FORBIDDEN`, and via a composite operation also gets `FORBIDDEN`.

Breaking any of these turns the pattern from secure-by-default into trust-the-client. That is an automatic FAIL.

---

## B. Session and authentication (MUST, Rule 12 Part A)

- [ ] Cookies: `httpOnly` + `Secure` + `SameSite`.
- [ ] Idle timeout (default 30 min) **and** absolute session lifetime.
- [ ] Session invalidated on logout; rotated on privilege change.
- [ ] Passwords hashed with bcrypt (cost >= 12) or argon2, compared in constant time. **Never plaintext.**
- [ ] Rate limit + lockout on login. Breach-checked password policy.
- [ ] No user enumeration on login or password reset.
- [ ] MFA mandatory for admin/privileged roles, and for any financial operation.
- [ ] Agent tokens are audience-bound (RFC 8707) and expire.

The reference implementation shipped plaintext demo users. Copying `lib/auth.ts` from it is an automatic FAIL. This template ships a contract only, on purpose.

---

## C. Tenant isolation and data access (MUST for multi-tenant)

- [ ] Every handler scopes reads and writes by `ctx.tenantId`.
- [ ] Per-object ownership is enforced on top of tenant scoping where relevant.
- [ ] Row Level Security is on at the database, not only in application code.
- [ ] Missing row and forbidden row return the **same** error. A distinguishable `FORBIDDEN` leaks that the id exists.
- [ ] Object references are crypto UUIDs, not `Math.random()` or sequential ids.

---

## D. Operation metadata (MUST)

- [ ] Every operation sets `roles` to the least privilege that works.
- [ ] Every destructive or financial operation sets `requiresConfirmation: true`, and that flag is **enforced server-side**, not only stated in agent instruction text.
- [ ] No operation returns more data than the agent needs. Everything returned is re-read by the model on later turns and is both a token cost and a disclosure.
- [ ] Operations a role cannot call are invisible to it, not merely rejected. `explore`, `search`, and `describe_tool` are all role-filtered.

---

## E. Audit (MUST for money, PII, or multi-tenant)

- [ ] A persistent, append-only sink is wired via `setAuditSink`. The in-memory default is dev only.
- [ ] The sink's table has no UPDATE or DELETE grant for the app role.
- [ ] `REDACT_KEYS` in `auditlog.ts` extended with this project's sensitive field names.
- [ ] Any endpoint that reads the audit log is role-gated and tenant-filtered.

The reference implementation exposed `/api/audit` to any authenticated user, including the lowest role. Do not reproduce that.

---

## F. Transport and dependencies (MUST)

- [ ] HTTPS only, with HSTS.
- [ ] CSP without `unsafe-inline` and without `unsafe-eval`.
- [ ] Full security-header baseline.
- [ ] Dependencies pinned to exact versions.
- [ ] `next` and `@modelcontextprotocol/sdk` on current patched releases. Do not copy the reference implementation's `package.json` or lockfile: they pin `next@15.0.0` (10 known CVEs) and `@modelcontextprotocol/sdk@1.12.0` (3 known CVEs).

---

## G. Agent-specific risks (SHOULD, escalate to erez if unclear)

- [ ] Consider what a **prompt-injected** agent could do with the operations you exposed. The agent is a confused-deputy risk: it holds the user's authority and may be steered by untrusted content it reads. Least privilege plus `requiresConfirmation` is the mitigation.
- [ ] Any operation that sends messages, moves money, or writes to an external system of record needs a human in the loop for v1.
- [ ] Rate-limit agent calls per token, independently of UI rate limits.
- [ ] `getContext` returns no PII. Keep it that way.

---

## Sign-off

| Gate | Owner | Evidence required |
|---|---|---|
| Build-time, Phase 4.6 | `boaz` + `cyber-iam` | Section A test output + A-F checked |
| Pre-OPERATE, Phase 6.4 | `boaz` + `erez` | live probe against the deployed surface |
| PROD promotion | `deploy-engineer` | this checklist, complete |
