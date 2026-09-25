import 'server-only';
import { anonClient } from '@/lib/server/supabase/service';

// One cheap round trip through the same API path the app uses (PostgREST).
export async function checkDatabase(): Promise<'up' | 'down'> {
  try {
    const { error } = await anonClient().rpc('is_admin');
    return error ? 'down' : 'up';
  } catch {
    return 'down';
  }
}
