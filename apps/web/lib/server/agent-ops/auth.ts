import 'server-only';

// Roles of an agent principal, least to most privileged (template lib/auth.ts,
// filled in for this system; see SECURITY.md next to this file).
//   verifier: read only. The only role an agent token can carry when
//             APP_ENV=prod (threat-model 3.7). Reaches generateDeliveryList,
//             redacted to counts per city.
//   operator: also the four write operations, each behind a server-enforced
//             confirmation. Refused in production at every layer (token mint,
//             principal resolution, dispatch).
// Both are always a DELEGATED admin session: the token wraps the admin's own
// aal2 access token, and every DB call runs as that JWT (never service_role).
export const ROLE_ORDER = ['verifier', 'operator'] as const;
export type Role = (typeof ROLE_ORDER)[number];

const ROLE_RANK: Record<string, number> = Object.fromEntries(ROLE_ORDER.map((r, i) => [r, i + 1]));

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_ORDER as readonly string[]).includes(value);
}

/** Hierarchical: a higher rank satisfies a lower requirement. Unknown role: false (fail closed). */
export function roleSatisfies(userRole: Role, allowed: readonly Role[]): boolean {
  const rank = ROLE_RANK[userRole];
  if (rank === undefined) return false;
  return allowed.some((r) => rank >= (ROLE_RANK[r] ?? Infinity));
}

/** Roles an agent token may carry in this environment. Production: read only (SEC-004). */
export function rolesAllowedIn(appEnv: 'local' | 'dev' | 'prod'): readonly Role[] {
  return appEnv === 'prod' ? ['verifier'] : ROLE_ORDER;
}
