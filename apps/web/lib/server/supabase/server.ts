import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { serverEnv } from '@/lib/server/env';
import { hardenCookieOptions } from '@/lib/shared/auth/session-policy';

// Request-scoped client that acts as the signed-in user (or anon). Use it for
// admin actions: the DB functions derive the actor from auth.uid() and check
// is_admin_aal2() themselves, so the user's own JWT must be what reaches them.
export async function createUserClient() {
  const env = serverEnv();
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, hardenCookieOptions(options));
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // middleware.ts refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
