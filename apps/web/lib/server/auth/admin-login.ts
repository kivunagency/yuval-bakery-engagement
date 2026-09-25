import 'server-only';
import { z } from 'zod';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { getAdminSession } from '@/lib/server/auth/admin';
import { clientIp } from '@/lib/server/http/client-ip';
import { adminLoginInput, adminTotpInput } from '@/lib/shared/contracts/admin-auth';

// Admin login flow (db-005, SEC-002, SEC-013):
//   password (Supabase Auth, server-side) -> aal1
//   -> first time: enrol a TOTP factor (QR + manual key) and verify it -> aal2
//   -> later: verify a code from an enrolled factor -> aal2
// Every failure of the password step returns the same error, whether the
// email is unknown, the password is wrong, or the account is not an admin.
// Both steps are rate limited per client IP and per account in the DB
// (fn_admin_auth_attempt_begin), and fail closed when the DB is unreachable.

export type AdminLoginStep = 'password' | 'enrol' | 'totp' | 'done';
export type AdminAuthError = 'invalid' | 'rate_limited' | 'unavailable' | 'invalid_code' | 'session_expired';
export type AdminAuthResult = { ok: true; next: AdminLoginStep } | { ok: false; error: AdminAuthError };

/** Where the signed-in user (if any) stands in the admin login flow. */
export async function adminLoginStep(): Promise<AdminLoginStep> {
  if (await getAdminSession()) return 'done';
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return 'password';
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // An aal2 session that getAdminSession() refused is too old (12h cap) or
  // not an admin: start again from the password.
  if (aal?.currentLevel === 'aal2') return 'password';
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) return 'password';
  const { data: factors } = await supabase.auth.mfa.listFactors();
  return factors && factors.totp.length > 0 ? 'totp' : 'enrol';
}

async function beginAttempt(kind: 'password' | 'totp', account: string): Promise<number | 'rate_limited' | 'unavailable'> {
  try {
    const id = await callRpc(serviceClient(), 'fn_admin_auth_attempt_begin', { p_kind: kind, p_ip: await clientIp(), p_account: account }, z.number().int().nullable());
    return id ?? 'rate_limited';
  } catch {
    return 'unavailable';
  }
}

async function finishAttempt(id: number, succeeded: boolean): Promise<void> {
  try {
    await serviceClient().rpc('fn_admin_auth_attempt_finish', { p_attempt_id: id, p_succeeded: succeeded });
  } catch {
    // The attempt stays counted as a failure (succeeded IS NULL), which only errs on the safe side.
  }
}

export async function passwordLogin(raw: unknown): Promise<AdminAuthResult> {
  const parsed = adminLoginInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { email, password } = parsed.data;

  const attempt = await beginAttempt('password', email);
  if (typeof attempt !== 'number') return { ok: false, error: attempt };

  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    await finishAttempt(attempt, false);
    return { ok: false, error: 'invalid' };
  }
  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || isAdmin !== true) {
    // A customer (or anyone else) with a valid password: same answer as a wrong password.
    await supabase.auth.signOut({ scope: 'local' });
    await finishAttempt(attempt, false);
    return { ok: false, error: 'invalid' };
  }
  await finishAttempt(attempt, true);
  await supabase.rpc('fn_admin_record_auth_event', { p_action: 'admin.login_password_ok' });
  const { data: factors } = await supabase.auth.mfa.listFactors();
  return { ok: true, next: factors && factors.totp.length > 0 ? 'totp' : 'enrol' };
}

export type TotpEnrolment = { factorId: string; qrCode: string; secret: string };

/**
 * Starts first-time TOTP enrolment for a signed-in admin at aal1 with no
 * verified factor. Removes earlier unverified factors first (an abandoned
 * enrolment, or a reload of the page), so only the code on screen is valid.
 * Returns null when the user is not in that state.
 */
export async function startTotpEnrolment(): Promise<TotpEnrolment | null> {
  if ((await adminLoginStep()) !== 'enrol') return null;
  const supabase = await createUserClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error || !data) return null;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/**
 * Verifies a TOTP code. With `factorId` (first-time enrolment) only that
 * unverified factor of this user is tried; without it, every verified TOTP
 * factor of this user is tried (Yuval's phone, and a backup factor if Ran
 * enrols one). The factor id is only a pointer: it must belong to the user.
 */
export async function verifyTotp(raw: unknown): Promise<AdminAuthResult> {
  const parsed = adminTotpInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid_code' };
  const { code, factorId } = parsed.data;

  const supabase = await createUserClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: 'session_expired' };
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) return { ok: false, error: 'session_expired' };

  const attempt = await beginAttempt('totp', userData.user.id);
  if (typeof attempt !== 'number') return { ok: false, error: attempt };

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const candidates = factorId
    ? (factors?.all ?? []).filter((f) => f.id === factorId && f.factor_type === 'totp' && f.status === 'unverified')
    : (factors?.totp ?? []);

  let verified = false;
  for (const f of candidates) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: f.id, code });
    if (!error) {
      verified = true;
      break;
    }
  }
  await finishAttempt(attempt, verified);
  if (!verified) return { ok: false, error: 'invalid_code' };

  await supabase.rpc('fn_admin_record_auth_event', { p_action: factorId ? 'admin.mfa_enrolled' : 'admin.login_totp_ok' });
  return { ok: true, next: 'done' };
}

/** Signs the admin out on every device (SEC-013: global sign-out). */
export async function adminSignOut(): Promise<void> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.rpc('fn_admin_record_auth_event', { p_action: 'admin.signed_out' });
  await supabase.auth.signOut({ scope: 'global' });
}
