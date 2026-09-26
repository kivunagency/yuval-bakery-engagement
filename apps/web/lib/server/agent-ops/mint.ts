import 'server-only';
import { createUserClient } from '@/lib/server/supabase/server';
import { mintAgentToken } from '@/lib/server/agent-ops/token';
import type { Role } from '@/lib/server/agent-ops/auth';

export type MintResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: 'unauthorized' | 'session_expiring' | 'unavailable' };

// Mint an agent token for the signed-in admin (ops-registry-001, SEC-004).
// Wraps the admin's own access token, then writes the audit row as that
// admin; no audit row, no token (SEC-017). The caller has already checked
// getAdminSession(), same Origin and the role allowed in this environment.
export async function mintAgentTokenForAdmin(input: { secret: string; audience: string; adminId: string; role: Role }): Promise<MintResult> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) return { ok: false, error: 'unauthorized' };

  const minted = await mintAgentToken({ ...input, accessToken });
  if (!minted) return { ok: false, error: 'session_expiring' };

  const { error } = await supabase.rpc('fn_ops_registry_token_minted', {
    p_token_id: minted.tokenId,
    p_role: input.role,
    p_expires_at: new Date(minted.expiresAt * 1000).toISOString(),
  });
  if (error) return { ok: false, error: 'unavailable' };
  return { ok: true, token: minted.token, expiresAt: minted.expiresAt };
}
