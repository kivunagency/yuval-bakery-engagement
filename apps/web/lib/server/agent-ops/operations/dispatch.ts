import 'server-only';
import { z } from 'zod';
import { fail } from '../result';
import type { Result } from '../result';
import { roleSatisfies } from '../auth';
import { registry } from './registry';
import type { AnyOperation, OperationContext } from './types';

/**
 * ============================================================================
 *  THE SECURITY CHOKE POINT (template lib/operations/dispatch.ts).
 * ============================================================================
 *
 * Every path into an operation funnels through `runOne`: each MCP tools/call
 * (adapters/mcp.ts), the `invoke` meta-tool, and a batch inside `invoke`.
 * Nothing calls `op.handler` anywhere else (tests/agent-ops-invariant.test.ts
 * reads the sources to prove it). On every single call, in order:
 *   0. audit begin + per-token rate limit (no audit row, no action)
 *   1. existence
 *   2. RBAC for the principal's role
 *   3. production: no write operation, whatever the role (SEC-004)
 *   4. Zod validation, strict (unknown keys are refused)
 *   5. requiresConfirmation, enforced here with a signed confirmation token
 *   6. the handler, which calls the same function the admin UI calls
 *   7. audit finish with the outcome
 * Change the order only with a reason written here.
 */

/** Reserved argument that carries a confirmation; never part of an operation's own schema. */
export const CONFIRMATION_ARG = 'confirmationToken';

let opByName: Map<string, AnyOperation> | undefined;

export function getOpByName(): Map<string, AnyOperation> {
  if (!opByName) opByName = new Map(registry.map((op) => [op.name, op]));
  return opByName;
}

/** Call after mutating `registry` (index.ts at load, or tests). */
export function invalidateOpCache() {
  opByName = undefined;
}

export function effectiveParallelSafe(op: AnyOperation, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === 'read';
}

async function dispatch(op: AnyOperation | undefined, name: string, args: Record<string, unknown>, ctx: OperationContext): Promise<Result<unknown>> {
  if (!op) return fail('UNKNOWN_TOOL', `No operation named '${name}'.`);

  // Same answer as an unknown name: a role never learns what it cannot call.
  if (!roleSatisfies(ctx.role, op.roles)) return fail('FORBIDDEN', `Role '${ctx.role}' is not permitted to call '${name}'.`);

  if (op.permission === 'write' && ctx.appEnv === 'prod') {
    return fail('FORBIDDEN', `'${name}' is not available to agents in production.`);
  }

  const { [CONFIRMATION_ARG]: confirmationToken, ...rest } = args;
  const parsed = z.strictObject(op.inputSchema).safeParse(op.requiresConfirmation ? rest : args);
  if (!parsed.success) {
    return fail('INVALID_ARGS', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }

  if (op.requiresConfirmation && !ctx.confirmations.verify(op.name, parsed.data, confirmationToken)) {
    const issued = ctx.confirmations.issue(op.name, parsed.data);
    return fail(
      'CONFIRMATION_REQUIRED',
      `'${name}' changes business data. Show the human the operation and these exact arguments; if they agree, call it again with the same arguments plus '${CONFIRMATION_ARG}'. Nothing was changed.`,
      { operation: op.name, arguments: parsed.data, [CONFIRMATION_ARG]: issued.confirmationToken, expiresAt: issued.expiresAt },
    );
  }

  try {
    return (await op.handler(parsed.data, ctx)) as Result<unknown>;
  } catch (err) {
    // The detail stays in the server log; the agent gets a code (SEC-026).
    console.error('ops registry handler error', name, err instanceof Error ? err.message : 'unknown');
    return fail('HANDLER_ERROR', `'${name}' failed unexpectedly. Nothing is known to have changed; check before retrying.`);
  }
}

export async function runOne(name: string, args: Record<string, unknown>, ctx: OperationContext): Promise<Result<unknown>> {
  let callId: number | null;
  try {
    callId = await ctx.audit.begin(name, args);
  } catch {
    // Fail closed: an operation that cannot be audited does not run.
    return fail('AUDIT_UNAVAILABLE', 'The call could not be recorded, so it was not run. Try again later.');
  }
  if (callId === null) return fail('RATE_LIMITED', 'Too many calls with this agent token in the last minute. Wait and retry.');

  const result = await dispatch(getOpByName().get(name), name, args, ctx);
  try {
    await ctx.audit.finish(callId, result.success ? 'ok' : result.error.code);
  } catch {
    // The call row exists; a missing result row reads as "crashed mid-way".
    console.error('ops registry audit finish failed', name);
  }
  return result;
}

/** Bind a context: call(name, args) with identical authorization on every call. */
export function makeDispatch(ctx: OperationContext) {
  return (name: string, args: Record<string, unknown>) => runOne(name, args, ctx);
}
