import 'server-only';
import { createUserClient } from '@/lib/server/supabase/server';

export type AdminSession = { userId: string };

// Resolves the signed-in admin for an admin page or route, or null.
// Requires: a verified user (getUser hits Auth, never trusts the cookie alone),
// a session at aal2 (TOTP verified), and membership in `admins` (checked by the
// DB's is_admin_aal2(), never by user_metadata, SEC-002). The actor id is never
// taken from the client.
export async function getAdminSession(): Promise<AdminSession | null> {
  const supabase = await createUserClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) return null;

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') return null;

  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin_aal2');
  if (rpcError || isAdmin !== true) return null;

  return { userId: userData.user.id };
}
