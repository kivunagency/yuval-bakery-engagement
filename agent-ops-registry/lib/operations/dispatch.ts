import { z } from "zod";
import { ok, fail } from "../result";
import type { Result } from "../result";
import { roleSatisfies } from "../auth";
import { auditLog } from "../auditlog";
import { registry } from "./registry";
import type { Operation, OperationContext } from "./types";

/**
 * ============================================================================
 *  THE SECURITY CHOKE POINT. Read this before changing anything in this file.
 * ============================================================================
 *
 * Every path into the system funnels through `runOne`:
 *   - the MCP Streamable HTTP surface
 *   - the in-page WebMCP surface (if enabled)
 *   - the UI's own /api/call route
 *   - composite operations calling their sub-operations
 *   - the `invoke` meta-tool
 *
 * On every single call it re-does, in order: existence check, RBAC check,
 * schema validation, then audit. A composite operation therefore CANNOT be
 * used to reach an operation the caller is not allowed to call, and the
 * generic `invoke` tool CANNOT escalate privilege.
 *
 * This is what makes it safe to let a browser sequence business logic: the
 * browser decides the ORDER of calls, the server decides what is ALLOWED.
 *
 * If you ever add a path that reaches a handler without going through
 * `runOne`, you have broken the model. Don't.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _opByName: Map<string, Operation<any, any>> | undefined;

/**
 * Name -> operation index, built once and reused.
 *
 * NOTE (deviation from the reference implementation): the original rebuilt
 * this map on every dispatch. That is O(n) per call and does not scale to the
 * hundreds/thousands of operations this pattern targets. Here the cache is
 * built lazily and invalidated explicitly by `index.ts` after the registry is
 * populated (and by tests that mutate it).
 */
function getOpByName() {
  if (!_opByName) _opByName = new Map(registry.map((op) => [op.name, op]));
  return _opByName;
}

/** Call after mutating `registry` (wiring at boot, or in tests). */
export function invalidateOpCache() {
  _opByName = undefined;
}

export { getOpByName };

export function effectiveParallelSafe(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  op: Operation<any, any>,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === "read";
}

export async function runOne(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
): Promise<Result<unknown>> {
  const op = getOpByName().get(name);

  if (!op) {
    auditLog.record({ operation: name, input: args, success: false, source: "agent", ctx });
    return fail("UNKNOWN_TOOL", `No operation named '${name}'.`);
  }

  // 1. Authorization, re-checked per call. Never cached, never delegated.
  if (!roleSatisfies(ctx.role, op.roles)) {
    auditLog.record({ operation: name, input: args, success: false, source: "agent", ctx });
    return fail("FORBIDDEN", `Role '${ctx.role}' is not permitted to call '${name}'.`);
  }

  // 2. Input validation, from the operation's own schema.
  const parsed = z
    .object(op.inputSchema as Record<string, z.ZodTypeAny>)
    .safeParse(args);
  if (!parsed.success) {
    auditLog.record({ operation: name, input: args, success: false, source: "agent", ctx });
    return fail(
      "INVALID_ARGS",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  // 3. Execute. The handler is responsible for tenant + ownership scoping
  //    using ctx.tenantId / ctx.userId. It must never trust input for identity.
  try {
    const result = await op.handler(parsed.data, ctx);
    auditLog.record({ operation: name, input: args, success: result.success, source: "agent", ctx });
    return result as Result<unknown>;
  } catch (err) {
    auditLog.record({ operation: name, input: args, success: false, source: "agent", ctx });
    return fail("HANDLER_ERROR", String(err));
  }
}

/**
 * Bind a context to produce a `call(name, args)` function.
 *
 * This is what makes composite operations surface-agnostic: the same
 * orchestration core runs in the browser (where `call` does fetch("/api/call"))
 * and on the server (where `call` dispatches in-process), with identical
 * authorization either way.
 */
export function makeDispatch(ctx: OperationContext) {
  return (name: string, params: Record<string, unknown>) => runOne(name, params, ctx);
}

export { ok };
