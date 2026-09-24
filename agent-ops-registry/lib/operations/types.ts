import { z } from "zod";
import type { Result } from "../result";
import type { Role } from "../auth";

export type { Role };
export type Permission = "read" | "write";

/**
 * The identity every operation runs under. Derived SERVER-SIDE only
 * (session cookie or bearer token). NEVER populated from a request body.
 *
 * `tenantId` is mandatory in Kivun builds: every multi-tenant client system
 * must scope reads and writes by it, on top of per-object ownership.
 */
export interface OperationContext {
  userId: string;
  tenantId: string;
  role: Role;
  token: string;
}

export interface Operation<
  TShape extends z.ZodRawShape = z.ZodRawShape,
  TOut = unknown,
> {
  /** Stable agent-facing identifier. [A-Za-z0-9_.-] */
  name: string;
  /** Human-readable label shown in tool listings. */
  title: string;
  /**
   * The agent reads THIS to decide whether to call the operation.
   * Write it for a competent stranger: what it does, what it needs,
   * and what it returns. Vague descriptions are the #1 cause of
   * agents picking the wrong tool.
   */
  description: string;
  inputSchema: TShape;
  permission: Permission;
  /** Roles allowed to call this. Enforced on EVERY dispatch, no exceptions. */
  roles: Role[];
  /** Destructive or financial? Set true. Enforced server-side, not by prompt text. */
  requiresConfirmation?: boolean;
  tags?: string[];
  /** Dot-path of the owning leaf module, e.g. "properties.payments". */
  module?: string;
  /** Defaults: read = true, write = false. */
  parallelSafe?: boolean;
  /** Always present in tools/list. Reserve for the navigation layer only. */
  alwaysOn?: boolean;
  handler: (
    input: z.infer<z.ZodObject<TShape>>,
    ctx: OperationContext,
  ) => Promise<Result<TOut>>;
}

export function defineOperation<TShape extends z.ZodRawShape, TOut>(
  op: Operation<TShape, TOut>,
): Operation<TShape, TOut> {
  return op;
}
