import { describe, expect, it } from 'vitest';
import {
  ADMIN_IDLE_TIMEOUT_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  cookiesAreSecure,
  hardenCookieOptions,
  idleVerdict,
  isAdminPath,
  needsActivityRefresh,
} from '@/lib/shared/auth/session-policy';

describe('hardenCookieOptions (gate blockers B1, B2, G5)', () => {
  // @supabase/ssr 0.12.7 DEFAULT_COOKIE_OPTIONS plus its 400-day maxAge override.
  const library = { path: '/', sameSite: 'lax' as const, httpOnly: false, maxAge: 400 * 24 * 60 * 60 };

  it('forces HttpOnly, Secure, SameSite=Lax and a 12 hour maxAge over the library defaults', () => {
    expect(hardenCookieOptions(library, true)).toEqual({ path: '/', sameSite: 'lax', httpOnly: true, secure: true, maxAge: 43200 });
    expect(SESSION_MAX_AGE_SECONDS).toBe(43200);
  });
  it('overrides an attempt to loosen any flag', () => {
    const out = hardenCookieOptions({ httpOnly: false, secure: false, sameSite: 'none', maxAge: 99999999 }, true);
    expect(out).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 43200 });
  });
  it('keeps a removal (maxAge 0) and a shorter lifetime, and works with no options at all', () => {
    expect(hardenCookieOptions({ maxAge: 0 }, true).maxAge).toBe(0);
    expect(hardenCookieOptions({ maxAge: 600 }, true).maxAge).toBe(600);
    expect(hardenCookieOptions(undefined, true)).toMatchObject({ path: '/', maxAge: 43200, httpOnly: true, secure: true });
  });
  it('drops a far-future expires on a live cookie', () => {
    expect(hardenCookieOptions({ expires: new Date('2030-01-01'), maxAge: 400 * 86400 }, true).expires).toBeUndefined();
  });
  it('Secure except on the local stack; unset APP_ENV fails safe to Secure', () => {
    expect(cookiesAreSecure('local')).toBe(false);
    expect(cookiesAreSecure('dev')).toBe(true);
    expect(cookiesAreSecure('prod')).toBe(true);
    expect(cookiesAreSecure(undefined)).toBe(true);
    expect(hardenCookieOptions(library, false).secure).toBe(false);
  });
});

describe('idleVerdict (SEC-013, 30 minute admin idle window)', () => {
  const now = 1_800_000_000;
  it('is 30 minutes', () => expect(ADMIN_IDLE_TIMEOUT_SECONDS).toBe(1800));
  it('no cookie: the clock starts now', () => {
    expect(idleVerdict(undefined, now)).toBe('none');
    expect(idleVerdict('', now)).toBe('none');
  });
  it('active up to and including 30 minutes, idle one second after', () => {
    expect(idleVerdict(String(now - 10), now)).toBe('active');
    expect(idleVerdict(String(now - 1800), now)).toBe('active');
    expect(idleVerdict(String(now - 1801), now)).toBe('idle');
    expect(idleVerdict(String(now - 40 * 60), now)).toBe('idle');
  });
  it('garbage or a future timestamp is treated as idle (fail closed)', () => {
    expect(idleVerdict('abc', now)).toBe('idle');
    expect(idleVerdict('-5', now)).toBe('idle');
    expect(idleVerdict('1.5e9', now)).toBe('idle');
    expect(idleVerdict(String(now + 3600), now)).toBe('idle');
  });
  it('small clock skew into the future is tolerated', () => {
    expect(idleVerdict(String(now + 30), now)).toBe('active');
  });
});

describe('isAdminPath', () => {
  it('covers admin pages and admin API, not public pages', () => {
    for (const p of ['/admin', '/admin/login', '/admin/orders', '/api/admin/orders/x/cancel']) expect(isAdminPath(p), p).toBe(true);
    for (const p of ['/', '/checkout', '/api/checkout/fit', '/administrator', '/api/administrator', '/account']) expect(isAdminPath(p), p).toBe(false);
  });
});

describe('needsActivityRefresh (one Set-Cookie a minute at most)', () => {
  const now = 1_800_000_000;
  it('writes when missing, and when a minute old; not when fresher; never revives an idle one', () => {
    expect(needsActivityRefresh(undefined, now)).toBe(true);
    expect(needsActivityRefresh(String(now - 60), now)).toBe(true);
    expect(needsActivityRefresh(String(now - 59), now)).toBe(false);
    expect(needsActivityRefresh(String(now), now)).toBe(false);
    expect(needsActivityRefresh(String(now - 1801), now)).toBe(false);
    expect(needsActivityRefresh('junk', now)).toBe(false);
  });
});
