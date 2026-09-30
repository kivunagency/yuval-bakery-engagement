// Session cookie hardening and the admin idle window (SEC-013, security
// baseline gate 2026-09-30, blockers 1 and 2). Pure functions and constants:
// no I/O, and deliberately NO `import 'server-only'`, because middleware.ts
// (which does not run under the react-server condition) must import it. It is
// only ever imported by server code (middleware, lib/server, route handlers).

/** Absolute cap for every auth cookie and for an admin session after its TOTP step: 12 hours. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** An admin session with no admin request for this long is ended (SEC-013). */
export const ADMIN_IDLE_TIMEOUT_SECONDS = 30 * 60;

/**
 * The activity cookie is rewritten at most once a minute. Writing it on every
 * request would put a Set-Cookie on every server action response, and Next.js
 * re-renders the page after an action whose response sets cookies (the first
 * TOTP enrolment screen then drew a new secret under the admin's feet).
 */
export const ACTIVITY_REFRESH_SECONDS = 60;

/** httpOnly cookie holding the epoch second of the last admin request. */
export const ADMIN_ACTIVITY_COOKIE = 'yb-admin-activity';

/** Query value the login page turns into the "signed out for inactivity" message. */
export const IDLE_REASON = 'idle';

export type CookieOptions = {
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  domain?: string;
  expires?: Date;
};

/**
 * Secure everywhere except the local stack (plain http://localhost). An unset
 * APP_ENV counts as NOT local, so a misconfigured deploy fails safe.
 */
export function cookiesAreSecure(appEnv: string | undefined = process.env.APP_ENV): boolean {
  return appEnv !== 'local';
}

/**
 * The options every auth cookie is written with. @supabase/ssr 0.12.7 defaults
 * to httpOnly false, no Secure and 400 days, and overwrites cookieOptions.maxAge
 * back to 400 days, so cookieOptions alone is not enough: both setAll wrappers
 * run every cookie through this. A maxAge of 0 (a removal) stays 0.
 */
export function hardenCookieOptions(options: CookieOptions | undefined, secure: boolean = cookiesAreSecure()): CookieOptions {
  const requested = options?.maxAge;
  const maxAge = typeof requested === 'number' && requested <= SESSION_MAX_AGE_SECONDS ? Math.max(requested, 0) : SESSION_MAX_AGE_SECONDS;
  const base: CookieOptions = { ...options, path: options?.path ?? '/', maxAge, httpOnly: true, secure, sameSite: 'lax' };
  // A cookie that carries an `expires` date far in the future would outlive maxAge in old clients.
  if (base.expires && maxAge > 0) delete base.expires;
  return base;
}

export type IdleVerdict = 'none' | 'active' | 'idle';

/**
 * Judges the activity cookie. `none`: no cookie, the clock starts now.
 * `active`: last admin request within the window. `idle`: the window passed, or
 * the value is garbage or from the future (tampered: fail closed).
 */
export function idleVerdict(raw: string | undefined, nowSeconds: number): IdleVerdict {
  if (raw === undefined || raw === '') return 'none';
  if (!/^\d{1,12}$/.test(raw)) return 'idle';
  const last = Number(raw);
  if (last > nowSeconds + 60) return 'idle';
  return nowSeconds - last > ADMIN_IDLE_TIMEOUT_SECONDS ? 'idle' : 'active';
}

/** True when the activity cookie is missing or at least a minute old (and not idle). */
export function needsActivityRefresh(raw: string | undefined, nowSeconds: number): boolean {
  const verdict = idleVerdict(raw, nowSeconds);
  if (verdict === 'none') return true;
  return verdict === 'active' && nowSeconds - Number(raw) >= ACTIVITY_REFRESH_SECONDS;
}

/** Paths whose requests count as admin activity and are subject to the idle window. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/');
}

/** Options of the activity cookie itself. */
export function activityCookieOptions(secure: boolean = cookiesAreSecure()): CookieOptions {
  return { path: '/', maxAge: SESSION_MAX_AGE_SECONDS, httpOnly: true, secure, sameSite: 'lax' };
}
