import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defineOperation } from "./types";
import { ok, fail } from "../result";
import { roleSatisfies } from "../auth";
import { registry } from "./registry";
import { runOne, effectiveParallelSafe, getOpByName } from "./dispatch";
import { addLoaded, removeLoaded } from "../loadedTools";
import type { ExploreNode, ModuleNode, PlatformManifest } from "../modules";

/**
 * ============================================================================
 *  THE NAVIGATION LAYER - the only tools that are always in tools/list
 * ============================================================================
 *
 * These are domain-agnostic. Copy them as-is; you should never need to edit
 * them when adding business operations. They are the fixed cost of the
 * protocol (roughly 180 tokens) that replaces the unbounded cost of
 * advertising every operation.
 *
 * You must supply the tree functions from your project's modules.ts:
 *
 *   import { createModuleTree } from "@/lib/modules";
 *   const tree = createModuleTree(MODULE_DEFS, APP_INFO);
 *   export const navigationOps = createNavigationOps(tree);
 */

export interface ModuleTree {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  platformManifest: (role: any, ops: any[]) => PlatformManifest;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNode: (path: string, role: any, ops: any[]) => ExploreNode | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expandWildcard: (pattern: string, role: any, ops: any[]) => ExploreNode[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  searchTree: (pattern: string, role: any, ops: any[]) => {
    functions: unknown[];
    modules: ModuleNode[];
  };
}

export function createNavigationOps(tree: ModuleTree) {
  /** Walk the module tree. The agent's entry point into the system. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const explore = defineOperation<any, any>({
    name: "explore",
    title: "Explore",
    description:
      "Navigate the platform's module tree. " +
      "No path -> platform overview and top-level modules. " +
      "Dot-path (e.g. 'properties.rent') -> sub-modules and functions. " +
      "'x.*' -> all descendants of x. '*' -> entire tree. " +
      "Array of paths -> fetch multiple nodes in one call.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      path: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Module path(s). Omit for the platform overview. Supports dot-paths, wildcards, or arrays."),
    },
    async handler({ path }, ctx) {
      if (path === undefined || path === null) {
        return ok(tree.platformManifest(ctx.role, registry));
      }
      const one = (p: string) => {
        if (p === "*" || p.endsWith(".*")) {
          return { path: p, nodes: tree.expandWildcard(p, ctx.role, registry) };
        }
        const node = tree.getNode(p, ctx.role, registry);
        return node ?? { path: p, error: `Module '${p}' not found.` };
      };
      if (typeof path === "string") {
        if (path === "*" || path.endsWith(".*")) {
          return ok({ nodes: tree.expandWildcard(path, ctx.role, registry) });
        }
        const node = tree.getNode(path, ctx.role, registry);
        if (!node) return fail("NOT_FOUND", `Module '${path}' not found.`);
        return ok(node);
      }
      return ok({ results: path.map(one) });
    },
  });

  /** Find operations by glob when you know WHAT but not WHERE. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const search = defineOperation<any, any>({
    name: "search",
    title: "Search",
    description:
      "Find functions and modules by path glob, anywhere in the tree. " +
      "A bare keyword ('refund') matches any function whose name contains it. " +
      "Use when you know what you want to do but not which module owns it.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      pattern: z.string().describe("Glob or keyword, e.g. 'refund', '*payment*', 'finance/**'."),
    },
    async handler({ pattern }, ctx) {
      return ok(tree.searchTree(pattern, ctx.role, registry));
    },
  });

  /** Full input schema for named operations. Called right before invoking. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const describeTool = defineOperation<any, any>({
    name: "describe_tool",
    title: "Describe Tool",
    description:
      "Return the full input schema and metadata for one or more functions by name. " +
      "Call this after explore() to get exact parameters before invoking.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      name: z.union([z.string(), z.array(z.string())]).describe("Function name, or array of names."),
    },
    async handler({ name }, ctx) {
      const describeOne = (n: string) => {
        const op = registry.find((o) => o.name === n);
        if (!op) return { name: n, error: "UNKNOWN_TOOL", message: `No operation named '${n}'.` };
        // Do not leak the existence of operations this role cannot reach.
        if (!roleSatisfies(ctx.role, op.roles)) {
          return { name: n, error: "UNKNOWN_TOOL", message: `No operation named '${n}'.` };
        }
        return {
          name: op.name,
          title: op.title,
          description: op.description,
          permission: op.permission,
          module: op.module,
          requiresConfirmation: op.requiresConfirmation ?? false,
          parallelSafe: effectiveParallelSafe(op),
          inputSchema: zodToJsonSchema(
            z.object(op.inputSchema as Record<string, z.ZodTypeAny>),
            { $refStrategy: "none" },
          ),
        };
      };
      if (typeof name === "string") return ok(describeOne(name));
      return ok({ tools: name.map(describeOne) });
    },
  });

  /**
   * Path B: call anything without promoting it to a native tool.
   * Reads in a batch run in parallel; writes run in order.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = defineOperation<any, any>({
    name: "invoke",
    title: "Invoke",
    description:
      "Call a function without loading it first (stateless). " +
      "Single: { name, args }. Batch: { calls: [{ name, args }] } - " +
      "read operations run in parallel, writes run sequentially.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      name: z.string().optional().describe("Function name (single-call form)."),
      args: z.record(z.unknown()).optional().describe("Arguments (single-call form)."),
      calls: z
        .array(
          z.object({
            name: z.string(),
            args: z.record(z.unknown()).default({}),
            parallelSafe: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("Batch form. Use this or name+args, not both."),
    },
    async handler({ name, args, calls }, ctx) {
      // NOTE: runOne re-authorizes every call, so `invoke` cannot be used to
      // reach anything the caller could not reach directly. Do not "optimize"
      // this by calling handlers directly.
      if (name !== undefined) {
        return ok(await runOne(name, (args ?? {}) as Record<string, unknown>, ctx));
      }
      if (calls && calls.length > 0) {
        const results: unknown[] = new Array(calls.length);
        const parallel: number[] = [];
        const sequential: number[] = [];
        for (let i = 0; i < calls.length; i++) {
          const op = getOpByName().get(calls[i].name);
          const safe = op
            ? effectiveParallelSafe(op, calls[i].parallelSafe)
            : false;
          (safe ? parallel : sequential).push(i);
        }
        await Promise.all(
          parallel.map(async (i) => {
            results[i] = await runOne(calls[i].name, calls[i].args as Record<string, unknown>, ctx);
          }),
        );
        for (const i of sequential) {
          results[i] = await runOne(calls[i].name, calls[i].args as Record<string, unknown>, ctx);
        }
        return ok({ results });
      }
      return fail("INVALID_ARGS", "Provide either 'name' (single call) or 'calls' (batch).");
    },
  });

  /** Path A: promote operations into tools/list with full schemas. */
  const loadTools = defineOperation({
    name: "load_tools",
    title: "Load Tools",
    description:
      "Promote functions to native MCP tools so they appear in tools/list with full schemas. " +
      "Worth it when you will call the same functions repeatedly. Re-fetch tools/list afterwards.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      names: z.array(z.string()).min(1).describe("Function names to promote."),
    },
    async handler({ names }, ctx) {
      const results: { name: string; status: string; message?: string }[] = [];
      const toLoad: string[] = [];
      for (const name of names) {
        const op = registry.find((o) => o.name === name);
        if (!op) {
          results.push({ name, status: "UNKNOWN_TOOL", message: `No operation named '${name}'.` });
          continue;
        }
        if (op.alwaysOn) {
          results.push({ name, status: "NO_OP", message: "Already always-on." });
          continue;
        }
        if (!roleSatisfies(ctx.role, op.roles)) {
          results.push({ name, status: "UNKNOWN_TOOL", message: `No operation named '${name}'.` });
          continue;
        }
        toLoad.push(name);
        results.push({ name, status: "LOADED" });
      }
      if (toLoad.length > 0) addLoaded(ctx.token, toLoad);
      return ok({
        results,
        message: toLoad.length
          ? `Loaded ${toLoad.length} tool(s). Re-fetch tools/list to see them.`
          : "No new tools were loaded.",
      });
    },
  });

  const unloadTools = defineOperation({
    name: "unload_tools",
    title: "Unload Tools",
    description:
      "Remove previously promoted functions from tools/list. Re-fetch tools/list to confirm.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {
      names: z.array(z.string()).min(1).describe("Function names to remove."),
    },
    async handler({ names }, ctx) {
      removeLoaded(ctx.token, names);
      return ok({ removed: names, message: `Unloaded ${names.length} tool(s).` });
    },
  });

  /** Who am I and what am I looking at. Cheap orientation call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getContext = defineOperation<any, any>({
    name: "getContext",
    title: "Get Context",
    description: "Current caller context: role and authentication state. Contains no PII.",
    permission: "read",
    roles: ["viewer"],
    alwaysOn: true,
    inputSchema: {},
    async handler(_input, ctx) {
      // Deliberately does NOT return userId or tenantId. The agent does not
      // need them, and anything returned here lands in the model's context.
      return ok({ authenticated: true, role: ctx.role });
    },
  });

  return [explore, search, describeTool, invoke, loadTools, unloadTools, getContext];
}
