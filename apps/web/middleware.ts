import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  ADMIN_ACTIVITY_COOKIE,
  IDLE_REASON,
  activityCookieOptions,
  hardenCookieOptions,
  idleVerdict,
  needsActivityRefresh,
  isAdminPath,
  type CookieOptions,
} from '@/lib/shared/auth/session-policy';

// 1. Content-Security-Policy with a per-request nonce (SEC-019): no
//    'unsafe-inline' and no 'unsafe-eval' for scripts in production.
// 2. Refresh the Supabase auth session cookie, so Server Components see a
//    valid session. Authorization is NOT decided here: every admin page and
//    route calls getAdminSession() itself. Every auth cookie is written
//    HttpOnly, Secure (not on the local stack) and capped at 12 hours.
// 3. Admin idle timeout (SEC-013): an admin request more than 30 minutes after
//    the previous one signs the session out and sends the admin to the login
//    screen. The last-activity time lives in an httpOnly cookie.
export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob: ${supabaseUrl}`,
    `font-src 'self'`,
    `connect-src 'self' ${supabaseUrl}`,
    // client-012: the admin push service worker (/sw.js). With 'strict-dynamic'
    // in script-src, 'self' there is ignored, so workers need their own directive.
    `worker-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    isDev ? '' : 'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const pending: { name: string; value: string; options: CookieOptions }[] = [];

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabase =
    supabaseUrl && anonKey
      ? createServerClient(supabaseUrl, anonKey, {
          cookies: {
            getAll: () => request.cookies.getAll(),
            setAll: (toSet) => {
              response = NextResponse.next({ request: { headers: requestHeaders } });
              for (const { name, value, options } of toSet) {
                const hardened = hardenCookieOptions(options);
                request.cookies.set(name, value);
                pending.push({ name, value, options: hardened });
              }
              for (const c of pending) response.cookies.set(c.name, c.value, c.options);
            },
          },
        })
      : null;

  const { pathname } = request.nextUrl;
  if (supabase && isAdminPath(pathname)) {
    const activity = request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (idleVerdict(activity, nowSeconds) === 'idle') {
      await supabase.auth.signOut({ scope: 'global' });
      const ended = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'unauthorized' }, { status: 401 })
        : NextResponse.redirect(new URL(`/admin/login?reason=${IDLE_REASON}`, request.url), 303);
      for (const c of pending) ended.cookies.set(c.name, c.value, c.options);
      // signOut cannot clear what it could not reach (Auth unreachable, token
      // already expired): expire every auth cookie of the request explicitly.
      for (const { name } of request.cookies.getAll()) {
        if (name.startsWith('sb-')) ended.cookies.set(name, '', hardenCookieOptions({ maxAge: 0 }));
      }
      ended.cookies.set(ADMIN_ACTIVITY_COOKIE, '', { ...activityCookieOptions(), maxAge: 0 });
      ended.headers.set('Content-Security-Policy', csp);
      return ended;
    }
    await supabase.auth.getUser();
    // Only an authenticated browser gets the activity cookie, at most once a minute.
    if (
      needsActivityRefresh(activity, nowSeconds) &&
      (request.cookies.getAll().some((c) => c.name.startsWith('sb-')) || pending.some((c) => c.name.startsWith('sb-') && c.value !== ''))
    ) {
      response.cookies.set(ADMIN_ACTIVITY_COOKIE, String(nowSeconds), activityCookieOptions());
    }
  } else if (supabase) {
    await supabase.auth.getUser();
  }

  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|fonts/).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
};
