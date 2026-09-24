/**
 * Measures the actual token cost of progressive disclosure on a realistic
 * registry, so we quote OUR numbers rather than the upstream README's.
 * Token model: 1 token ~= 4 characters (same as upstream, for comparability).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registry } from "../lib/operations/registry";
import { invalidateOpCache, runOne } from "../lib/operations/dispatch";
import { defineOperation, type OperationContext } from "../lib/operations/types";
import { createModuleTree, type ModuleNode, type AppInfo } from "../lib/modules";
import { createNavigationOps } from "../lib/operations/navigation";
import { ok } from "../lib/result";

const tok = (s: unknown) => Math.ceil(JSON.stringify(s).length / 4);

// A realistic mid-size client system: 6 domains, 18 leaf modules, 54 operations.
const DOMAINS = ["properties", "tenants", "maintenance", "finance", "reports", "support"];
const LEAVES = ["search", "manage", "admin"];

const MODULE_DEFS: ModuleNode[] = [];
for (const d of DOMAINS) {
  MODULE_DEFS.push({ path: d, title: d, description: `The ${d} domain: day-to-day operations, lookups, and reporting for ${d}.` });
  for (const l of LEAVES) {
    MODULE_DEFS.push({ path: `${d}.${l}`, title: l, description: `${l} operations within ${d}. Write operations require confirmation where destructive.` });
  }
}
const APP_INFO: AppInfo = {
  app: "Mid-size Client Ops",
  description: "Operations platform. Navigate the module tree with explore() to discover functions before invoking them.",
};
const tree = createModuleTree(MODULE_DEFS, APP_INFO);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: Array<import("../lib/operations/types").Operation<any, any>> = [];
for (const d of DOMAINS) {
  for (const l of LEAVES) {
    for (let i = 0; i < 3; i++) {
      ops.push(
        defineOperation({
          name: `${d}_${l}_op${i}`,
          title: `${d} ${l} operation ${i}`,
          description: `Perform ${l} action ${i} on ${d}. Requires the entity id and the acting parameters. Returns the updated record and a status flag.`,
          permission: i === 0 ? "read" : "write",
          roles: ["viewer"],
          module: `${d}.${l}`,
          inputSchema: {
            entityId: z.string().min(1).describe("Identifier of the target entity."),
            amount: z.number().int().optional().describe("Optional numeric parameter."),
            note: z.string().max(500).optional().describe("Optional free-text note for the audit trail."),
            effectiveDate: z.string().optional().describe("ISO date the change takes effect."),
          },
          async handler() { return ok({ done: true }); },
        }),
      );
    }
  }
}

const ctx: OperationContext = { userId: "u", tenantId: "t", role: "viewer", token: "tok" };

describe("token cost", () => {
  it("progressive disclosure beats loading everything upfront", async () => {
    registry.length = 0;
    registry.push(...createNavigationOps(tree), ...ops);
    invalidateOpCache();

    // Cost A: what a conventional MCP server advertises on connect.
    const fullCatalog = ops.map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: zodToJsonSchema(z.object(o.inputSchema as any), { $refStrategy: "none" }),
    }));
    const upfront = tok(fullCatalog);

    // Cost B: what this template advertises on connect (navigation only).
    const navOnly = registry
      .filter((o) => o.alwaysOn)
      .map((o) => ({
        name: o.name,
        description: o.description,
        inputSchema: zodToJsonSchema(z.object(o.inputSchema as any), { $refStrategy: "none" }),
      }));
    const always = tok(navOnly);

    // Cost C: a realistic navigation to one operation.
    const step1 = await runOne("explore", {}, ctx);
    const step2 = await runOne("explore", { path: "finance" }, ctx);
    const step3 = await runOne("explore", { path: "finance.manage" }, ctx);
    const step4 = await runOne("describe_tool", { name: "finance_manage_op1" }, ctx);
    const walk = tok((step1 as any).data) + tok((step2 as any).data) + tok((step3 as any).data) + tok((step4 as any).data);

    // Cost D: the search shortcut when you know what, not where.
    const s = await runOne("search", { pattern: "finance_manage_op1" }, ctx);
    const searchCost = tok((s as any).data);

    const firstTask = always + walk;

    console.log(`
  operations in registry ......... ${ops.length}
  modules ....................... ${MODULE_DEFS.length}

  A. upfront full catalog ....... ${upfront} tokens  (paid on EVERY request, forever)
  B. navigation tools only ...... ${always} tokens  (paid on every request)
  C. explore walk to one op ..... ${walk} tokens  (paid ONCE, only if needed)
  D. search shortcut ............ ${searchCost} tokens

  first task total (B+C) ........ ${firstTask} tokens
  vs upfront .................... ${upfront} tokens
  saving on first task .......... ${(((upfront - firstTask) / upfront) * 100).toFixed(1)}%
  saving on every later request .. ${(((upfront - always) / upfront) * 100).toFixed(1)}%
`);

    // The claim that matters: the recurring per-request cost collapses.
    expect(always).toBeLessThan(upfront * 0.2);
    // And even including a full navigation walk, the first task is cheaper.
    expect(firstTask).toBeLessThan(upfront);
  });
});
