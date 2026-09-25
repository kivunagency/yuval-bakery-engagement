import 'server-only';
import { join } from 'node:path';
import { z } from 'zod';

// Notification settings from the environment (secrets only from env, never
// committed). Read on first use, like serverEnv().
//
// Email provider:
//   EMAIL_PROVIDER=resend   needs RESEND_API_KEY and EMAIL_FROM (Yuval's Resend
//                           account and verified domain: not created yet)
//   EMAIL_PROVIDER=capture  writes each message as JSON to EMAIL_CAPTURE_DIR
//                           (local stack and tests only; refused when APP_ENV=prod)
//   EMAIL_PROVIDER=none     sends nothing; every email is recorded as skipped
// Default: capture on the local stack, resend when a key exists, else none.
//
// Web push (VAPID): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// (mailto: or https:). Missing keys: push is recorded as skipped. The private
// key never leaves the server (SEC-018); the public key is handed to the admin
// settings page as a prop.
const schema = z.object({
  APP_ENV: z.enum(['local', 'dev', 'prod']).default('local'),
  SITE_URL: z.url().default('http://localhost:3000'),
  EMAIL_PROVIDER: z.enum(['resend', 'capture', 'none']).optional(),
  RESEND_API_KEY: z.string().min(10).optional(),
  EMAIL_FROM: z.string().min(3).max(200).optional(),
  EMAIL_CAPTURE_DIR: z.string().min(1).optional(),
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/).optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/).optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:)/).optional(),
  PUSH_ALLOW_LOCAL_ENDPOINTS: z.enum(['0', '1']).optional(),
});

export type EmailConfig =
  | { provider: 'resend'; apiKey: string; from: string }
  | { provider: 'capture'; dir: string; from: string }
  | { provider: 'none'; reason: string };

export type PushConfig =
  | { enabled: true; publicKey: string; privateKey: string; subject: string; allowLocalEndpoints: boolean }
  | { enabled: false; reason: string; allowLocalEndpoints: boolean };

export type NotificationConfig = { appEnv: 'local' | 'dev' | 'prod'; siteUrl: string; email: EmailConfig; push: PushConfig };

export function readNotificationConfig(env: Record<string, string | undefined> = process.env): NotificationConfig {
  // Blank values count as unset (Netlify UI can hold empty variables).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const e = schema.parse(cleaned);
  const siteUrl = e.SITE_URL.replace(/\/+$/, '');
  const allowLocalEndpoints = e.APP_ENV === 'local' && e.PUSH_ALLOW_LOCAL_ENDPOINTS === '1';

  const wanted = e.EMAIL_PROVIDER ?? (e.APP_ENV === 'local' ? 'capture' : e.RESEND_API_KEY ? 'resend' : 'none');
  let email: EmailConfig;
  if (wanted === 'resend') {
    email = !e.RESEND_API_KEY
      ? { provider: 'none', reason: 'email_provider_not_configured' }
      : !e.EMAIL_FROM
        ? { provider: 'none', reason: 'email_from_not_configured' }
        : { provider: 'resend', apiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM };
  } else if (wanted === 'capture') {
    email =
      e.APP_ENV === 'prod'
        ? { provider: 'none', reason: 'email_capture_refused_in_prod' }
        : { provider: 'capture', dir: e.EMAIL_CAPTURE_DIR ?? join(process.cwd(), '.local-stack', 'outbox'), from: e.EMAIL_FROM ?? 'orders@example.test' };
  } else {
    email = { provider: 'none', reason: 'email_provider_not_configured' };
  }

  const push: PushConfig =
    e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY && e.VAPID_SUBJECT
      ? { enabled: true, publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT, allowLocalEndpoints }
      : { enabled: false, reason: 'push_not_configured', allowLocalEndpoints };

  return { appEnv: e.APP_ENV, siteUrl, email, push };
}

/** The VAPID public key for the admin settings page, or null when push is not configured. */
export function vapidPublicKey(): string | null {
  const c = readNotificationConfig();
  return c.push.enabled ? c.push.publicKey : null;
}
