# agent-ops-registry

**A reusable way to give any Kivun-built system a safe, cheap, agent-operable surface.**

You define your business operations once. You get, for free:

* an **MCP Streamable HTTP** endpoint that Claude Code, Claude Desktop, an embedded CS agent, or our own agency agents can drive
* **RBAC enforced on every single call**, with no way to bypass it
* **Zod validation** on every input
* an **audit trail** of everything an agent did, allowed or denied
* **progressive disclosure**, so `tools/list` stays tiny no matter how many operations exist
* optionally, **composite tools** that collapse a multi-step business process into one agent call

Status: internal template. Derived from a security-gated external reference implementation. See `ATTRIBUTION.md`.

---

## Why this exists

Two problems show up the moment an AI agent has to operate a real system.

**1. The agent carries your business logic as tokens.**
If booking a table means "search availability, then create a reservation with the slotId, then verify", the agent has to know that. That knowledge lives in the prompt, gets re-processed on every call, and can be hallucinated. Wrap the sequence in one server-side operation and the agent calls `book()` once and gets a validated result. Fewer round trips, no reasoning gaps, and the sequence is now testable code instead of prompt text.

**2. `tools/list` does not scale.**
Advertising every operation costs tokens on every request, forever, including for capabilities the agent never uses. At 50 operations it is wasteful. At 500 it is fatal. Progressive disclosure fixes this: the agent sees roughly 7 navigation tools, walks a module tree, and pulls in only what it needs.

Both problems are ours too, not just the client's. See "What the agency gets" below.

---

## What you copy

```
lib/
  result.ts                    uniform ok/fail envelope
  auth.ts                      role contract + roleSatisfies   <- YOU implement resolvePrincipal
  auditlog.ts                  redacting audit log             <- YOU wire a persistent sink
  loadedTools.ts               per-caller tool selection
  modules.ts                   module-tree engine (config-injected)
  adapters/mcp.ts              MCP Streamable HTTP adapter (domain-agnostic)
  operations/
    types.ts                   Operation descriptor + defineOperation
    registry.ts                the single source of truth
    dispatch.ts                runOne  <- THE SECURITY CHOKE POINT
    navigation.ts              explore / search / describe_tool / invoke / load / unload / getContext
examples/
  example-operation.ts         one annotated business operation
  wiring-index.ts              how index.ts looks in a real project
```

Only `auth.ts` and `auditlog.ts` need real work per project. Everything else is copy-and-go.

---

## The one invariant you must not break

> **The browser decides the ORDER of calls. The server decides what is ALLOWED.**

Every path into the system funnels through `runOne` in `dispatch.ts`: the MCP surface, the UI's own `/api/call` route, composite operations calling sub-operations, and the generic `invoke` tool. On every call it re-checks existence, then RBAC, then the schema, then audits.

That is what makes it safe to let a browser sequence business logic. A composite operation cannot reach something the caller is not allowed to call, and `invoke` cannot escalate privilege.

If you ever add a path that reaches a handler without going through `runOne`, the model is broken. Do not do it.

---

## Adding an operation

1. Create `lib/operations/<name>.ts` using `defineOperation`. Copy `examples/example-operation.ts`.
2. Set `module:` to a dot-path that exists in `MODULE_DEFS`.
3. Set `roles:` to the least privilege that works.
4. Set `requiresConfirmation: true` for anything destructive or financial.
5. Import it in `index.ts`, push it into `registry`, and call `invalidateOpCache()`.

Write the `description` for a competent stranger. The agent picks tools by reading it, so a vague description is the single most common cause of an agent calling the wrong thing.

---

## How an agent uses it

```
explore()                        -> what domains exist            (~90 tokens)
explore("properties")            -> sub-modules                   (~190 cumulative)
explore("properties.payments")   -> functions + permission flags  (~380 cumulative)
describe_tool("recordRentPayment") -> exact input schema          (only now)
invoke({ name, args })           -> call it, stateless
```

Two execution paths:

* **Path B, `invoke`** is the default. Stateless, nothing to load, works on serverless.
* **Path A, `load_tools`** promotes an operation into `tools/list` with a full schema. Use when the agent will call the same operation repeatedly. Note the caveat in `loadedTools.ts` about multi-instance deploys.

---

## What the agency gets

This is the part that compounds. If every system we ship exposes an operations registry, our own agents stop scraping and start calling a stable, authorized, audited contract:

| Agent | Today | With a registry |
|---|---|---|
| `deploy-engineer` (Rule 5) | Playwright proves a page rendered | calls the real business operation and asserts the result |
| `amit` (Rule 7) | route-level regression | business-flow regression on top of it |
| `cs-agent` | reads code and guesses | reproduces the bug against real dev data |
| `noc-operator` / `sre` | uptime ping | exercises an actual business flow |

The marginal cost is low, because `defineOperation` largely replaces the API route handler you were going to write anyway under Rule 2. You write the same logic once and get MCP, RBAC, validation, and audit with it.

---

## Scope and risk

Adopt in two layers, and keep them separate.

**Stable, adopt freely.** Everything in this template. It rides the official MCP SDK over standard Streamable HTTP. No browser APIs, no polyfills, no emerging-standard exposure.

**Experimental, opt in per project.** The in-page WebMCP surface (`document.modelContext`) from the reference implementation. It needs a polyfill and the standard is still moving. Not included here on purpose. Add it only when a project genuinely needs in-page agents, and re-gate it when the standard changes.

---

## Before you ship

`SECURITY.md` in this folder is a gate checklist, not a suggestion. It encodes the conditions from the security review that cleared this pattern. `deploy-engineer` blocks PROD promotion if it is unmet.

The short version: this template gives you the authorization *choke point*, not an *auth system*. Sessions, password policy, MFA, tenant isolation, and a persistent audit sink are yours to build, per Rule 12.
