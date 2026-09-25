import 'server-only';
import { z } from 'zod';

// Server environment, validated on first use (not at import, so `next build`
// does not need secrets). Secrets come from environment variables only.
const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_ENV: z.enum(['local', 'dev', 'prod']).default('local'),
  SITE_URL: z.url().default('http://localhost:3000'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (!cached) {
    const parsed = serverEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      throw new Error(`server env invalid or missing: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}
