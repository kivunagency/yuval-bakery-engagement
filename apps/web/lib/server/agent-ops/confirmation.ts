import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Server-enforced confirmation for destructive or financial operations
// (SECURITY.md D, threat-model 3.7). The first call of such an operation is
// refused with CONFIRMATION_REQUIRED and a token; only a second call with the
// SAME arguments, the same agent token and that confirmation token, within
// five minutes, runs. The token is an HMAC over (operation, canonical
// arguments, agent token id, expiry), so it cannot be reused for other
// arguments or by another agent token. Stateless: nothing to store, works
// on serverless. The pause is where the MCP client shows the human the call
// and its arguments before the second, executing one.

export const CONFIRMATION_TTL_SECONDS = 5 * 60;

export interface ConfirmationSigner {
  issue(operation: string, args: Record<string, unknown>): { confirmationToken: string; expiresAt: string };
  verify(operation: string, args: Record<string, unknown>, token: unknown): boolean;
}

/** JSON with object keys sorted at every level, so the same arguments always sign the same way. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function confirmationSigner(secret: string, agentTokenId: string, now: () => number = Date.now): ConfirmationSigner {
  const key = createHash('sha256').update(`ops-registry-confirmation:v1\0${secret}`).digest();
  const sign = (operation: string, args: Record<string, unknown>, exp: number) =>
    createHmac('sha256', key).update(`${operation}\n${canonicalJson(args)}\n${agentTokenId}\n${exp}`).digest('base64url');
  return {
    issue(operation, args) {
      const exp = Math.floor(now() / 1000) + CONFIRMATION_TTL_SECONDS;
      return { confirmationToken: `${exp}.${sign(operation, args, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    verify(operation, args, token) {
      if (typeof token !== 'string') return false;
      const m = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
      const [, expText, sig] = m ?? [];
      if (!expText || !sig) return false;
      const exp = Number(expText);
      if (exp < Math.floor(now() / 1000)) return false;
      const expected = Buffer.from(sign(operation, args, exp));
      const given = Buffer.from(sig);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}
