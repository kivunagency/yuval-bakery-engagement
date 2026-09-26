import 'server-only';
// Uniform result envelope (agent-ops-registry template, lib/result.ts). Every
// operation returns one of these, so the agent sees the same success/failure
// shape from every tool. Error codes are part of the agent-facing contract:
// stable SCREAMING_SNAKE codes, the explanation in `message`. `details` is
// optional structured data (a confirmation token, the reserved minutes) and
// never carries personal data.
export type Success<T> = { success: true; data: T };
export type Failure = { success: false; error: { code: string; message: string; details?: Record<string, unknown> } };
export type Result<T> = Success<T> | Failure;

export function ok<T>(data: T): Success<T> {
  return { success: true, data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): Failure {
  return { success: false, error: details ? { code, message, details } : { code, message } };
}
