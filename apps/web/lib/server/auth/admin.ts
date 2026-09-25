import 'server-only';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/server/supabase/server';

export type AdminSession = { userId: string };

/** SEC-013: an admin session ends 12 hours after its TOTP step, whatever the refreshes. */
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

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
// step, and membership in `admins` (checked by the DB's is_admin_aal2(), never
// by user_metadata, SEC-002). The actor id is never taken from the client.
export async function getAdminSession(): Promise<AdminSession | null> {
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
 * For admin pages: the admin session, or a redirect to the login flow. Call it
 * in EVERY admin page, not only in the layout: Next.js does not re-run a
 * layout on client-side navigation between its pages.
 */
export async function requireAdminPage(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  return session;
}
