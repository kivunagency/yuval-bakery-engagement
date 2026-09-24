/**
 * Proves the security invariants from SECURITY.md section A, plus the
 * behaviour the pattern claims. If any of these fail, the template is unsafe
 * to hand to a client build.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import { registry } from "../lib/operations/registry";
import { runOne, invalidateOpCache, makeDispatch } from "../lib/operations/dispatch";
import { defineOperation, type OperationContext } from "../lib/operations/types";
import { createModuleTree, type ModuleNode, type AppInfo } from "../lib/modules";
import { createNavigationOps } from "../lib/operations/navigation";
import { ok, fail } from "../lib/result";
import { memorySink, auditLog } from "../lib/auditlog";
import { roleSatisfies } from "../lib/auth";

// ── Fixture domain ───────────────────────────────────────────────────────────
const MODULE_DEFS: ModuleNode[] = [
  { path: "properties", title: "Properties", description: "Portfolio." },
  { path: "properties.search", title: "Search", description: "Find properties." },
  { path: "properties.payments", title: "Payments", description: "Record rent." },
  { path: "finance", title: "Finance", description: "Admin only money ops." },
  { path: "finance.adjustments", title: "Adjustments", description: "Refunds." },
];
const APP_INFO: AppInfo = { app: "Test Ops", description: "Fixture." };
const tree = createModuleTree(MODULE_DEFS, APP_INFO);

/** Records what identity the handler actually received. */
let lastCtx: OperationContext | undefined;

const searchProperties = defineOperation({
  name: "searchProperties",
  title: "Search Properties",
  description: "Find properties by query.",
  permission: "read",
  roles: ["viewer"],
  module: "properties.search",
  inputSchema: { q: z.string().min(1) },
  async handler(input, ctx) {
    lastCtx = ctx;
    // Tenant scoping is the handler's job; assert it has what it needs.
    return ok({ found: [`${ctx.tenantId}:${input.q}`] });
  },
});

const recordPayment = defineOperation({
  name: "recordPayment",
  title: "Record Payment",
  description: "Record a rent payment.",
  permission: "write",
  roles: ["operator", "admin"],
  requiresConfirmation: true,
  module: "properties.payments",
  inputSchema: { propertyId: z.string(), amountAgorot: z.number().int().positive() },
  async handler(input, ctx) {
    lastCtx = ctx;
    return ok({ paid: input.amountAgorot, by: ctx.userId });
  },
});

const issueRefund = defineOperation({
  name: "issueRefund",
  title: "Issue Refund",
  description: "Refund money. Admin only.",
  permission: "write",
  roles: ["admin"],
  requiresConfirmation: true,
  module: "finance.adjustments",
  inputSchema: { paymentId: z.string() },
  async handler(input, ctx) {
    lastCtx = ctx;
    return ok({ refunded: input.paymentId });
  },
});

/** Composite: orchestrates sub-operations through the injected dispatcher. */
const settleAndRefund = defineOperation({
  name: "settleAndRefund",
  title: "Settle And Refund",
  description: "Composite that internally calls the admin-only issueRefund.",
  permission: "write",
  roles: ["operator", "admin"], // NOTE: weaker than issueRefund on purpose
  module: "properties.payments",
  inputSchema: { paymentId: z.string() },
  async handler(input, ctx) {
    const call = makeDispatch(ctx);
    const r = await call("issueRefund", { paymentId: input.paymentId });
    if (!r.success) return fail("SUB_CALL_FAILED", r.error.message);
    return ok({ viaComposite: true });
  },
});

const ctxFor = (role: "viewer" | "operator" | "admin"): OperationContext => ({
  userId: `u_${role}`,
  tenantId: "tenant_A",
  role,
  token: `tok_${role}`,
});

beforeEach(() => {
  registry.length = 0;
  registry.push(
    ...createNavigationOps(tree),
    searchProperties,
    recordPayment,
    issueRefund,
    settleAndRefund,
  );
  invalidateOpCache();
  lastCtx = undefined;
});

// ── A. The invariant ─────────────────────────────────────────────────────────
describe("A. authorization choke point", () => {
  it("allows an in-role call", async () => {
    const r = await runOne("recordPayment", { propertyId: "p1", amountAgorot: 5000 }, ctxFor("operator"));
    expect(r.success).toBe(true);
  });

  it("denies an out-of-role call", async () => {
    const r = await runOne("recordPayment", { propertyId: "p1", amountAgorot: 5000 }, ctxFor("viewer"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("invoke CANNOT escalate privilege", async () => {
    const r = await runOne("invoke", { name: "issueRefund", args: { paymentId: "pay1" } }, ctxFor("operator"));
    // invoke itself succeeds, but the inner result must be FORBIDDEN
    expect(r.success).toBe(true);
    const inner = (r as { data: any }).data;
    expect(inner.success).toBe(false);
    expect(inner.error.code).toBe("FORBIDDEN");
  });

  it("a composite operation CANNOT escalate privilege", async () => {
    // operator may call settleAndRefund, but NOT the issueRefund inside it
    const r = await runOne("settleAndRefund", { paymentId: "pay1" }, ctxFor("operator"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("SUB_CALL_FAILED");
  });

  it("the same composite works for an admin", async () => {
    const r = await runOne("settleAndRefund", { paymentId: "pay1" }, ctxFor("admin"));
    expect(r.success).toBe(true);
  });

  it("rejects invalid input before the handler runs", async () => {
    const r = await runOne("recordPayment", { propertyId: "p1", amountAgorot: -5 }, ctxFor("admin"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("INVALID_ARGS");
    expect(lastCtx).toBeUndefined(); // handler never reached
  });

  it("rejects an unknown operation", async () => {
    const r = await runOne("nope", {}, ctxFor("admin"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("UNKNOWN_TOOL");
  });

  it("identity reaches the handler from ctx, never from input", async () => {
    await runOne(
      "searchProperties",
      { q: "x", userId: "u_attacker", tenantId: "tenant_B", role: "admin" } as any,
      ctxFor("viewer"),
    );
    expect(lastCtx?.userId).toBe("u_viewer");
    expect(lastCtx?.tenantId).toBe("tenant_A");
    expect(lastCtx?.role).toBe("viewer");
  });
});

// ── D. Discovery is role-filtered ────────────────────────────────────────────
describe("D. role-filtered discovery", () => {
  it("explore() hides top-level modules a role cannot reach", async () => {
    const asViewer = await runOne("explore", {}, ctxFor("viewer"));
    const asAdmin = await runOne("explore", {}, ctxFor("admin"));
    const vPaths = (asViewer as any).data.modules.map((m: any) => m.path);
    const aPaths = (asAdmin as any).data.modules.map((m: any) => m.path);
    expect(vPaths).toContain("properties");
    expect(vPaths).not.toContain("finance");
    expect(aPaths).toContain("finance");
  });

  it("explore(node) hides functions a role cannot call", async () => {
    const r = await runOne("explore", { path: "properties.payments" }, ctxFor("viewer"));
    const names = (r as any).data.functions.map((f: any) => f.name);
    expect(names).not.toContain("recordPayment");
  });

  it("explore exposes requiresConfirmation so the agent must ask first", async () => {
    const r = await runOne("explore", { path: "finance.adjustments" }, ctxFor("admin"));
    const fn = (r as any).data.functions.find((f: any) => f.name === "issueRefund");
    expect(fn.requiresConfirmation).toBe(true);
    expect(fn.permission).toBe("write");
  });

  it("describe_tool does not confirm the existence of out-of-role operations", async () => {
    const r = await runOne("describe_tool", { name: "issueRefund" }, ctxFor("viewer"));
    expect((r as any).data.error).toBe("UNKNOWN_TOOL");
  });

  it("describe_tool returns a real JSON schema in-role", async () => {
    const r = await runOne("describe_tool", { name: "issueRefund" }, ctxFor("admin"));
    expect((r as any).data.inputSchema.properties.paymentId).toBeDefined();
  });

  it("search is role-filtered", async () => {
    const v = await runOne("search", { pattern: "refund" }, ctxFor("viewer"));
    const a = await runOne("search", { pattern: "refund" }, ctxFor("admin"));
    expect((v as any).data.functions).toHaveLength(0);
    expect((a as any).data.functions.map((f: any) => f.name)).toContain("issueRefund");
  });

  it("navigation tools stay tiny: only alwaysOn ops are unconditionally present", () => {
    const alwaysOn = registry.filter((o) => o.alwaysOn).map((o) => o.name);
    expect(alwaysOn.sort()).toEqual(
      ["describe_tool", "explore", "getContext", "invoke", "load_tools", "search", "unload_tools"].sort(),
    );
  });

  it("getContext leaks no PII", async () => {
    const r = await runOne("getContext", {}, ctxFor("admin"));
    expect((r as any).data).toEqual({ authenticated: true, role: "admin" });
  });
});

// ── Batch semantics ──────────────────────────────────────────────────────────
describe("invoke batching", () => {
  it("runs a batch and returns one result per call", async () => {
    const r = await runOne(
      "invoke",
      { calls: [
        { name: "searchProperties", args: { q: "a" } },
        { name: "searchProperties", args: { q: "b" } },
        { name: "recordPayment", args: { propertyId: "p", amountAgorot: 10 } },
      ] },
      ctxFor("admin"),
    );
    const results = (r as any).data.results;
    expect(results).toHaveLength(3);
    expect(results.every((x: any) => x.success)).toBe(true);
  });
});

// ── Tool loading ─────────────────────────────────────────────────────────────
describe("load_tools", () => {
  it("refuses to load an out-of-role tool without confirming it exists", async () => {
    const r = await runOne("load_tools", { names: ["issueRefund"] }, ctxFor("viewer"));
    expect((r as any).data.results[0].status).toBe("UNKNOWN_TOOL");
  });

  it("loads an in-role tool", async () => {
    const r = await runOne("load_tools", { names: ["issueRefund"] }, ctxFor("admin"));
    expect((r as any).data.results[0].status).toBe("LOADED");
  });
});

// ── E. Audit ─────────────────────────────────────────────────────────────────
describe("E. audit", () => {
  it("records denials, not just successes", async () => {
    await runOne("issueRefund", { paymentId: "p" }, ctxFor("viewer"));
    const e = memorySink.getEntries()[0];
    expect(e.operation).toBe("issueRefund");
    expect(e.success).toBe(false);
    expect(e.userId).toBe("u_viewer");
    expect(e.tenantId).toBe("tenant_A");
  });

  it("redacts sensitive keys", () => {
    auditLog.record({
      operation: "x",
      input: { password: "hunter2", nested: { apiKey: "sk-live-1" }, safe: "keep" },
      success: true,
      source: "agent",
    });
    const e = memorySink.getEntries()[0];
    expect(e.input.password).toBe("[REDACTED]");
    expect((e.input.nested as any).apiKey).toBe("[REDACTED]");
    expect(e.input.safe).toBe("keep");
  });

  it("uses non-guessable ids", () => {
    auditLog.record({ operation: "y", input: {}, success: true, source: "ui" });
    expect(memorySink.getEntries()[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── Role helper ──────────────────────────────────────────────────────────────
describe("roleSatisfies", () => {
  it("is hierarchical and rejects unknown roles", () => {
    expect(roleSatisfies("admin", ["viewer"])).toBe(true);
    expect(roleSatisfies("viewer", ["admin"])).toBe(false);
    expect(roleSatisfies("nope" as any, ["viewer"])).toBe(false);
  });
});
