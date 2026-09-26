import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/server/env';
import { getAdminFromAccessToken } from '@/lib/server/auth/admin';
import { rolesAllowedIn } from './auth';
import { verifyAgentToken } from './token';
import { dbAuditSink } from './auditlog';
import { confirmationSigner } from './confirmation';
import type { OperationContext } from './operations/types';
import type { OpsRegistryConfig } from './config';

/**
 * resolvePrincipal (template lib/auth.ts contract, SECURITY.md A):
 *  1. Identity ONLY from `Authorization: Bearer <agent token>`. Never from the
 *     body, the query string or any other header; no cookie either (an agent
 *     is not a browser, and a cookie would let a page drive the endpoint).
 *  2. null on any doubt. No default role, no guest, no service role.
 *  3. The token is verified (key, audience, issuer, expiry, max one hour), its
 *     role must be allowed in this environment (production: verifier only),
 *     and the admin session inside it must pass the same checks as
 *     getAdminSession(): Auth accepts it, aal2, TOTP step at most 12 hours
 *     old, and the DB's own is_admin_aal2(). The admin must be the one the
 *     token was minted for.
 */
export async function resolvePrincipal(req: Request, cfg: Extract<OpsRegistryConfig, { state: 'on' }>): Promise<OperationContext | null> {
  const header = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1];
  if (!bearer) return null;

  const claims = await verifyAgentToken(bearer, cfg.secret, cfg.audience);
  if (!claims || !rolesAllowedIn(cfg.appEnv).includes(claims.role)) return null;

  const env = serverEnv();
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${claims.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const admin = await getAdminFromAccessToken(client, claims.accessToken);
  if (!admin || admin.userId !== claims.adminId) return null;

  return {
    userId: admin.userId,
    role: claims.role,
    token: claims.tokenId,
    client,
    audit: dbAuditSink(client, claims.tokenId, claims.role),
    confirmations: confirmationSigner(cfg.secret, claims.tokenId),
    appEnv: cfg.appEnv,
  };
}
