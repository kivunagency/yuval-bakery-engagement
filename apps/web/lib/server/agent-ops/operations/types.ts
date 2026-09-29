import 'server-only';
import type { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Result } from '../result';
import type { Role } from '../auth';
import type { AuditSink } from '../auditlog';
import type { ConfirmationSigner } from '../confirmation';

export type { Role };
export type Permission = 'read' | 'write';

/**
 * The identity every operation runs under. Built SERVER-SIDE only, from a
 * verified agent token (principal.ts), never from a request body.
 * `client` acts as the delegating admin's own aal2 JWT: the handlers pass it
 * to the same functions the admin UI uses, so the DB checks aal2 again and
 * writes its own audit row with auth.uid(). Single tenant: no tenantId.
 */
export interface OperationContext {
  /** The delegating admin (auth.uid()). */
  userId: string;
  role: Role;
  /** The agent token id (jti). Keys the rate limit, the audit rows and confirmations. */
  token: string;
  client: SupabaseClient;
  audit: AuditSink;
  confirmations: ConfirmationSigner;
  appEnv: 'local' | 'dev' | 'prod';
}

export interface Operation<TShape extends z.ZodRawShape = z.ZodRawShape, TOut = unknown> {
  /** Stable agent-facing identifier. [A-Za-z0-9_] */
  name: string;
  title: string;
  /** The agent reads THIS to decide whether to call the operation. Write it for a competent stranger. */
  description: string;
  inputSchema: TShape;
  permission: Permission;
  /** Roles allowed to call this. Enforced on EVERY dispatch in runOne. */
  roles: Role[];
  /** Destructive or financial: runOne refuses the call until it carries a valid confirmationToken. */
  requiresConfirmation?: boolean;
  /** Owning module in MODULE_DEFS. */
  module?: string;
  /** Defaults: read = true, write = false. */
  parallelSafe?: boolean;
  /** Always in tools/list. The navigation layer only. */
  alwaysOn?: boolean;
  handler: (input: z.infer<z.ZodObject<TShape>>, ctx: OperationContext) => Promise<Result<TOut>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, any>;

export function defineOperation<TShape extends z.ZodRawShape, TOut>(op: Operation<TShape, TOut>): Operation<TShape, TOut> {
  return op;
}
