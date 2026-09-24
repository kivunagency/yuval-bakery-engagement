import type { OperationContext } from "./operations/types";

/**
 * ============================================================================
 *  AUDIT LOG
 * ============================================================================
 *
 * Every dispatch is recorded here, allowed or denied. For any client system
 * that touches money, PII, or multi-tenant data this is not optional: it is
 * the record of what an agent did on a user's behalf.
 *
 * The reference implementation kept the last 100 entries in memory with
 * Math.random() ids. That is a dev convenience and is NOT acceptable in
 * production. Wire a persistent, append-only sink (Postgres table with no
 * UPDATE/DELETE grant, or the client's SIEM) via `setAuditSink`.
 */

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation: string;
  input: Record<string, unknown>;
  success: boolean;
  source: "ui" | "agent";
  userId?: string;
  tenantId?: string;
  role?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
}

export interface RecordArgs {
  operation: string;
  input: Record<string, unknown>;
  success: boolean;
  source: "ui" | "agent";
  ctx?: Pick<OperationContext, "userId" | "tenantId" | "role">;
}

/**
 * Redact before writing. Extend REDACT_KEYS per project.
 *
 * Operation inputs routinely carry exactly the data you must not persist in
 * clear text. Redaction happens here, once, rather than in every handler.
 */
const REDACT_KEYS = [
  "password", "pass", "secret", "token", "apiKey", "api_key",
  "authorization", "creditCard", "card", "cvv", "iban", "ssn",
  "nationalId", "teudatZehut",
];

function redact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r.toLowerCase()))) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Dev-only default sink. Bounded in-memory ring buffer. */
class MemorySink implements AuditSink {
  private entries: AuditEntry[] = [];
  private listeners: Array<(e: AuditEntry) => void> = [];

  write(entry: AuditEntry) {
    this.entries.unshift(entry);
    if (this.entries.length > 200) this.entries.pop();
    for (const l of this.listeners) l(entry);
  }
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }
  onChange(cb: (e: AuditEntry) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }
}

export const memorySink = new MemorySink();
let sink: AuditSink = memorySink;

/** Call once at boot in production with a persistent append-only sink. */
export function setAuditSink(s: AuditSink) {
  sink = s;
}

export const auditLog = {
  record({ operation, input, success, source, ctx }: RecordArgs): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      input: redact(input),
      success,
      source,
      userId: ctx?.userId,
      tenantId: ctx?.tenantId,
      role: ctx?.role,
    };
    void sink.write(entry);
    return entry;
  },
};
