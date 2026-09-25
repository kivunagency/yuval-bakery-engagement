import 'server-only';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { serverEnv } from '@/lib/server/env';
import { clientIp } from '@/lib/server/http/client-ip';
import { checkPwnedPassword } from '@/lib/server/identity/pwned-password';
import {
  PENDING_REGISTRATION_KEY,
  pendingRegistration,
  registerInput,
  signInInput,
  type RegisterErrorCode,
} from '@/lib/shared/contracts/registration';

// Optional customer accounts (api-010, PRD US-4). Supabase Auth, email +
// password, email confirmation ON (SEC-014). Separate from the admin: an admin
// account is never a customer profile, and admin pages keep rejecting anyone
// who is not in `admins` at aal2.
//
//   POST /api/customers -> registerCustomer(): Auth sign-up, name/phone parked
//     in user_metadata.yb_registration, always the same answer.
//   mail link -> /account/confirm -> confirmEmail(): verifies the token_hash,
//     then completeRegistration() creates the customers row through
//     fn_register_customer (email taken from auth.users by the DB).
//   Marketing consent is never part of any of this (s.30A): see account.ts.

type AttemptKind = 'signup' | 'login';

async function beginAttempt(kind: AttemptKind, account: string): Promise<number | 'rate_limited' | 'unavailable'> {
  try {
    const id = await callRpc(serviceClient(), 'fn_customer_auth_attempt_begin', { p_kind: kind, p_ip: await clientIp(), p_account: account }, z.number().int().nullable());
    return id ?? 'rate_limited';
  } catch {
    return 'unavailable'; // fail closed
  }
}

async function finishAttempt(id: number, succeeded: boolean): Promise<void> {
  try {
    await serviceClient().rpc('fn_customer_auth_attempt_finish', { p_attempt_id: id, p_succeeded: succeeded });
  } catch {
    // The attempt stays counted (succeeded IS NULL), which only errs on the safe side.
  }
}

export type RegisterResult = { ok: true } | { ok: false; error: RegisterErrorCode; fields?: string[] };

export async function registerCustomer(raw: unknown): Promise<RegisterResult> {
  const parsed = registerInput.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean);
    const onlyPassword = fields.length === 1 && fields[0] === 'password';
    return { ok: false, error: onlyPassword ? 'weak_password' : 'invalid_input', fields };
  }
  const { name, phone, email, password, privacyNoticeVersion } = parsed.data;

  const attempt = await beginAttempt('signup', email);
  if (typeof attempt !== 'number') return { ok: false, error: attempt };

  const pwned = await checkPwnedPassword(password);
  if (pwned === 'pwned') {
    await finishAttempt(attempt, false);
    return { ok: false, error: 'pwned_password', fields: ['password'] };
  }
  if (pwned === 'unknown') console.warn('registration: breached-password check unavailable, continuing (fail open)');

  // A fresh client per call: nothing about this sign-up may land in a shared
  // client or in this visitor's cookies (no session exists before confirmation).
  const env = serverEnv();
  const auth = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await auth.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${env.SITE_URL}/account/confirm`,
      data: { [PENDING_REGISTRATION_KEY]: { name, phone, privacy_notice_version: privacyNoticeVersion, age_confirmed: true } },
    },
  });

  if (error) {
    // Existing address: with confirmation ON, Auth answers like a new sign-up
    // and sends nothing; if it ever says "exists", we still answer the same.
    // Auth refuses to re-send to the same address within a minute ("For
    // security purposes, you can only request this after N seconds"): the
    // mail of the first attempt is on its way, so the answer stays the same.
    // The same code with another message is the project-wide mail quota
    // (hosted: SEC-015), which is a real 429 below.
    const resendTooSoon = error.code === 'over_email_send_rate_limit' && /security purposes/i.test(error.message);
    if (error.code === 'user_already_exists' || error.code === 'email_exists' || resendTooSoon) {
      await finishAttempt(attempt, true);
      return { ok: true };
    }
    await finishAttempt(attempt, false);
    if (error.code === 'weak_password') return { ok: false, error: 'weak_password', fields: ['password'] };
    if (error.code === 'email_address_invalid') return { ok: false, error: 'invalid_input', fields: ['email'] };
    if (error.status === 429 || error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      console.error('registration: Auth rate limit', error.code);
      return { ok: false, error: 'rate_limited' };
    }
    console.error('registration: sign-up failed', error.code ?? error.status);
    return { ok: false, error: 'unavailable' };
  }
  await finishAttempt(attempt, true);
  return { ok: true };
}

export type CompleteResult = 'created' | 'exists' | 'needs_details' | 'phone_taken' | 'signed_out';

/**
 * Creates the customers row for the signed-in, email-confirmed user. Without
 * `details`, uses what sign-up parked in user_metadata; with `details` (the
 * "complete your details" form), uses those. The DB re-validates everything
 * and takes the email from auth.users.
 */
export async function completeRegistration(details?: unknown): Promise<CompleteResult> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return 'signed_out';
  const source = details ?? (data.user.user_metadata?.[PENDING_REGISTRATION_KEY] as unknown);
  const parsed = pendingRegistration.safeParse(source);
  if (!parsed.success) {
    // Nothing usable parked (or a profile already exists): let the DB say which.
    const { data: existing } = await supabase.from('customers').select('id').eq('id', data.user.id).maybeSingle();
    return existing ? 'exists' : 'needs_details';
  }
  try {
    const status = await callRpc(
      supabase,
      'fn_register_customer',
      {
        p_name: parsed.data.name,
        p_phone: parsed.data.phone,
        p_privacy_notice_version: parsed.data.privacy_notice_version,
        p_age_confirmed: parsed.data.age_confirmed,
      },
      z.enum(['created', 'exists']),
    );
    // user_metadata was cleared by the DB; refresh so the cookie JWT stops carrying it.
    await supabase.auth.refreshSession();
    return status;
  } catch (e) {
    if (e instanceof DbError && e.code === 'customer_phone_taken') return 'phone_taken';
    if (e instanceof DbError && (e.code === 'customer_invalid_input' || e.code === 'privacy_notice_version_mismatch' || e.code === 'customer_age_not_confirmed')) {
      return 'needs_details';
    }
    if (e instanceof DbError && (e.code === 'customer_sign_in_required' || e.code === 'customer_email_not_confirmed')) return 'signed_out';
    throw e;
  }
}

export type ConfirmResult = CompleteResult | 'link_invalid';

/** Verifies the mail link (token_hash, any device), then completes the registration. */
export async function confirmEmail(tokenHash: string | null, type: string | null): Promise<ConfirmResult> {
  if (!tokenHash || !/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash) || (type !== 'email' && type !== 'signup')) return 'link_invalid';
  const supabase = await createUserClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (error) return 'link_invalid';
  return completeRegistration();
}

export type SignInError = 'invalid' | 'email_not_confirmed' | 'rate_limited' | 'unavailable';

/** Password sign-in. Unknown email and wrong password get the same answer (SEC-014). */
export async function signInCustomer(raw: unknown): Promise<{ ok: true } | { ok: false; error: SignInError }> {
  const parsed = signInInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { email, password } = parsed.data;

  const attempt = await beginAttempt('login', email);
  if (typeof attempt !== 'number') return { ok: false, error: attempt };

  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    await finishAttempt(attempt, false);
    // Auth says "not confirmed" only after the password matched: telling the
    // account holder is not enumeration.
    if (error?.code === 'email_not_confirmed') return { ok: false, error: 'email_not_confirmed' };
    return { ok: false, error: 'invalid' };
  }
  await finishAttempt(attempt, true);
  return { ok: true };
}

export async function signOutCustomer(): Promise<void> {
  const supabase = await createUserClient();
  await supabase.auth.signOut({ scope: 'local' });
}

/** SEC-013: a customer session ends 14 days after sign-in, whatever the refreshes. */
export const CUSTOMER_SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

type AmrEntry = { method?: string; timestamp?: number };

/** Seconds since epoch of the earliest authentication in the access token (amr claim), or null. */
export function signedInAt(accessToken: string): number | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { amr?: AmrEntry[] };
    const times = (claims.amr ?? []).map((a) => a.timestamp).filter((t): t is number => typeof t === 'number');
    return times.length ? Math.min(...times) : null;
  } catch {
    return null;
  }
}

export type CustomerSession = { userId: string; email: string };

/**
 * The signed-in customer (verified with Auth, never the cookie alone), or
 * null. The id is always the verified user's own, never from the client.
 * Does not require a customers row: a confirmed user without one is asked to
 * complete their details.
 */
export async function getCustomerSession(): Promise<CustomerSession | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || !data.user.email || !data.user.email_confirmed_at) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  const at = sessionData.session ? signedInAt(sessionData.session.access_token) : null;
  if (at === null || Date.now() / 1000 - at > CUSTOMER_SESSION_MAX_AGE_SECONDS) return null;
  // An admin account is never a customer (SEC-002 keeps the two apart).
  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin === true) return null;
  return { userId: data.user.id, email: data.user.email };
}
