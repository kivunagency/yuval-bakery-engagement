import 'server-only';
import { z } from 'zod';

// Features that depend on a verified sending domain (none yet, 2026-09-29).
// Without a domain, Resend delivers only to the account owner's own address
// and Supabase's built-in mail only to the project team, so a customer would
// never receive an order confirmation or a sign-up link.
//
//   CUSTOMER_EMAIL_ENABLED     true | false. Off: no email field in checkout or
//                              the custom-cake form, and every customer email is
//                              recorded as skipped (customer_email_disabled).
//                              The written confirmation goes by WhatsApp (US-0c).
//   CUSTOMER_ACCOUNTS_ENABLED  true | false. Off: /register, /account/* and
//                              POST /api/customers answer 404 and the footer
//                              has no account link.
//
// Unset: on for the local stack (its mail sink receives everything), off in
// dev and prod. Turning either on is a deliberate act once the domain exists.
// Any other value counts as off: a typo in the Netlify UI must not take the
// public layout down, and "off" is the side that never sends a mail nobody gets.
const schema = z.object({ APP_ENV: z.enum(['local', 'dev', 'prod']).catch('prod') });

export type Features = { customerEmail: boolean; customerAccounts: boolean };

export function readFeatures(env: Record<string, string | undefined> = process.env): Features {
  const appEnv = schema.parse({ APP_ENV: env.APP_ENV || 'local' }).APP_ENV;
  const on = (v: string | undefined) => (v === undefined || v === '' ? appEnv === 'local' : v === 'true');
  return { customerEmail: on(env.CUSTOMER_EMAIL_ENABLED), customerAccounts: on(env.CUSTOMER_ACCOUNTS_ENABLED) };
}
