import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/server/env';

// Service-role client. Bypasses RLS: use ONLY for server-side reads of public
// data and for the functions granted to service_role (cron sweep, retention,
// confirmation PDF bookkeeping). Never for an admin action: those must run as
// the admin's own JWT (createUserClient) so the DB can check aal2.
let cached: SupabaseClient | undefined;

export function serviceClient(): SupabaseClient {
  if (!cached) {
    const env = serverEnv();
    cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

// Anon client for calling the functions granted to anon (guest checkout,
// order lookup). Same privileges a guest has, nothing more.
let anonCached: SupabaseClient | undefined;

export function anonClient(): SupabaseClient {
  if (!anonCached) {
    const env = serverEnv();
    anonCached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return anonCached;
}
