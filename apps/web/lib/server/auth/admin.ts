import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/server/supabase/server';
import { ADMIN_ACTIVITY_COOKIE, SESSION_MAX_AGE_SECONDS, idleVerdict } from '@/lib/shared/auth/session-policy';

export type AdminSession = { userId: string };

/** SEC-013: an admin session ends 12 hours after its TOTP step, whatever the refreshes. */
export const ADMIN_SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;

type AmrEntry = { method?: string; timestamp?: number };

/** Seconds since epoch of the TOTP step recorded in the access token (amr claim), or null. */
export function totpVerifiedAt(accessToken: string): number | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { amr?: AmrEntry[] };
    const totp = claims.amr?.find((a) => a.method === 'totp');
    return typeof totp?.timestamp === 'number' ? totp.timestamp : null;
  } catch {
    return null;
  }
}

// Resolves the signed-in admin for an admin page or route, or null.
// Requires: a verified user (getUser hits Auth, never trusts the cookie alone),
// a session at aal2 (TOTP verified) no older than 12 hours since the TOTP
// step, not idle for more than 30 minutes (SEC-013), and membership in
// `admins` (checked by the DB's is_admin_aal2(), never by user_metadata, SEC-002). The actor id is never taken from the client.
export async function getAdminSession(): Promise<AdminSession | null> {
  // SEC-013 idle window. middleware.ts signs an idle admin out and refreshes
  // the activity cookie; this is the second line, so a path the middleware
  // matcher ever misses still refuses a session idle for more than 30 minutes.
  // It reads the REQUEST cookie (the value before middleware's refresh).
  const activity = (await cookies()).get(ADMIN_ACTIVITY_COOKIE)?.value;
  if (idleVerdict(activity, Date.now() / 1000) === 'idle') return null;

  const supabase = await createUserClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) return null;

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') return null;

  // getUser() above validated this same access token with Auth, so its claims
  // can be read here.
  const { data: sessionData } = await supabase.auth.getSession();
  const verifiedAt = sessionData.session ? totpVerifiedAt(sessionData.session.access_token) : null;
  if (verifiedAt === null || Date.now() / 1000 - verifiedAt > ADMIN_SESSION_MAX_AGE_SECONDS) return null;

  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin_aal2');
  if (rpcError || isAdmin !== true) return null;

  return { userId: userData.user.id };
}

/**
 * The same checks as getAdminSession(), for an access token that arrives
 * wrapped in an agent token (lib/server/agent-ops/principal.ts) instead of a
 * cookie. `supabase` must be a client that sends exactly this token, so
 * is_admin_aal2() is answered by the DB for this JWT.
 */
export async function getAdminFromAccessToken(supabase: SupabaseClient, accessToken: string): Promise<AdminSession | null> {
  const { data: userData, error } = await supabase.auth.getUser(accessToken);
  if (error || !userData.user) return null;

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(accessToken);
  if (aal?.currentLevel !== 'aal2') return null;

  const verifiedAt = totpVerifiedAt(accessToken);
  if (verifiedAt === null || Date.now() / 1000 - verifiedAt > ADMIN_SESSION_MAX_AGE_SECONDS) return null;

  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin_aal2');
  if (rpcError || isAdmin !== true) return null;

  return { userId: userData.user.id };
}

/**
 * For admin pages: the admin session, or a redirect to the login flow. Call it
 * in EVERY admin page, not only in the layout: Next.js does not re-run a
 * layout on client-side navigation between its pages.
 */
export async function requireAdminPage(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  return session;
}
