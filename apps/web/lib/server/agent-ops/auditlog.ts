import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from '@/lib/server/supabase/rpc';

// Audit sink for the operations registry (template lib/auditlog.ts, SECURITY.md
// section E). Every dispatch is recorded BEFORE it runs (begin, which also
// enforces the per-token rate limit) and its outcome after (finish), in
// audit_log, which is append-only (trg_audit_log_append_only, no UPDATE or
// DELETE grant). runOne refuses to run an operation whose begin row could not
// be written: no audit, no action (SEC-017).

export interface AuditSink {
  /** Records the call. Returns its id, or null when the token is over its rate limit (the refusal is recorded). */
  begin(operation: string, input: Record<string, unknown>): Promise<number | null>;
  finish(callId: number, outcome: string): Promise<void>;
}

/**
 * Keys whose values never reach the audit trail. The template list plus this
 * system's personal data (threat-model 3.7: phone, address, name, email,
 * notes, inscription). Matched as a case-insensitive substring of the key.
 */
export const REDACT_KEYS = [
  'password', 'pass', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'creditcard', 'card', 'cvv', 'iban', 'ssn',
  'nationalid', 'teudatzehut',
  'phone', 'address', 'name', 'email', 'notes', 'inscription', 'reason',
];

export function redact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r))) out[k] = '[REDACTED]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? redact(x as Record<string, unknown>) : x));
    else out[k] = v;
  }
  return out;
}

/**
 * The production sink: audit_log through fn_ops_registry_call_begin/finish,
 * called as the delegating admin's own JWT (the DB derives the actor from
 * auth.uid() and requires aal2).
 */
export function dbAuditSink(client: SupabaseClient, tokenId: string, role: string): AuditSink {
  return {
    async begin(operation, input) {
      return callRpc(
        client,
        'fn_ops_registry_call_begin',
        { p_token_id: tokenId, p_operation: operation.slice(0, 64), p_role: role, p_input: redact(input) },
        z.number().int().nullable(),
      );
    },
    async finish(callId, outcome) {
      await callRpc(client, 'fn_ops_registry_call_finish', { p_call_id: callId, p_token_id: tokenId, p_outcome: outcome }, z.unknown());
    },
  };
}
