/**
 * Uniform result envelope. Every operation returns one of these, so the agent
 * sees the same success/failure shape from every tool and never has to guess
 * whether a response is an error.
 *
 * Error codes are part of the agent-facing contract. Use stable SCREAMING_SNAKE
 * codes and put the human explanation in `message`.
 */
export type Success<T> = { success: true; data: T };
export type Failure = { success: false; error: { code: string; message: string } };
export type Result<T> = Success<T> | Failure;

export function ok<T>(data: T): Success<T> {
  return { success: true, data };
}

export function fail(code: string, message: string): Failure {
  return { success: false, error: { code, message } };
}

export function isOk<T>(r: Result<T>): r is Success<T> {
  return r.success;
}
