/**
 * ============================================================================
 *  AUTHORIZATION CONTRACT (project-supplied)
 * ============================================================================
 *
 * This file deliberately contains NO users, NO passwords, and NO token store.
 *
 * The reference implementation this template is derived from shipped an
 * in-memory demo auth with plaintext passwords. That was correct for a demo
 * and is FORBIDDEN in a Kivun build. Wire your real identity provider
 * (Supabase Auth / NextAuth / the client's IdP) behind `resolvePrincipal`.
 *
 * Rule 12 requirements that this file does NOT implement for you, and that you
 * must satisfy in your auth layer before shipping:
 *   - idle timeout (default 30 min) + absolute session lifetime
 *   - session invalidation on logout, rotation on privilege change
 *   - cookies: httpOnly + Secure + SameSite
 *   - rate limit + lockout on login, breach-checked password policy
 *   - no user enumeration on login or reset
 *   - MFA mandatory for admin/privileged roles and financial operations
 */

/**
 * Roles, ordered least to most privileged.
 *
 * Override per project. Keep it SHORT: a role explosion makes the RBAC matrix
 * unreviewable, which is how privilege bugs hide. If you need finer control,
 * scope by tenant/ownership inside the handler, not by inventing roles.
 */
export const ROLE_ORDER = ["viewer", "operator", "admin"] as const;
export type Role = (typeof ROLE_ORDER)[number];

const ROLE_RANK: Record<string, number> = Object.fromEntries(
  ROLE_ORDER.map((r, i) => [r, i + 1]),
);

/**
 * Hierarchical role check: a higher rank satisfies a lower requirement.
 *
 * If your project needs NON-hierarchical roles (e.g. "auditor" who may read
 * everything but write nothing, and is not an admin), replace this with an
 * explicit set-membership check. Do not fake it with ranks.
 */
export function roleSatisfies(userRole: Role, allowed: Role[]): boolean {
  const rank = ROLE_RANK[userRole];
  if (rank === undefined) return false;
  return allowed.some((r) => rank >= ROLE_RANK[r]);
}

export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
  /** Opaque token for the caller's session. Used to key loaded-tool selections. */
  token: string;
}

/**
 * Resolve the caller's identity from the incoming request.
 *
 * IMPLEMENT THIS PER PROJECT. Non-negotiable rules:
 *   1. Derive identity ONLY from a verified session cookie or verified bearer
 *      token. Never from the request body, query string, or a custom header
 *      the client can set freely.
 *   2. Return null on any doubt. Fail closed.
 *   3. Bind tokens to an audience (RFC 8707) and enforce expiry.
 */
export type ResolvePrincipal = (req: Request) => Promise<Principal | null>;

/**
 * Guard used by route handlers. Throwing here is intentional: a route that
 * forgets to check the result cannot accidentally proceed unauthenticated.
 */
export async function requirePrincipal(
  req: Request,
  resolve: ResolvePrincipal,
): Promise<Principal> {
  const principal = await resolve(req);
  if (!principal) throw new Response("Unauthorized", { status: 401 });
  return principal;
}
