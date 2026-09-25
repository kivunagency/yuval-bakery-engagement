import { z } from 'zod';

// Web push subscription contract (client-012, SEC-018). The server later POSTs
// to the endpoint, so an endpoint is accepted only on a known browser push
// service over https. Anything else would let a stored subscription make the
// server call an arbitrary URL (SSRF).

/** Hosts of the push services browsers use: Chrome/Android (FCM), Firefox (Mozilla autopush), Safari/iOS (Apple), Edge (WNS). */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'] as const;
export const PUSH_SERVICE_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

/**
 * True when the server may send to this endpoint. allowLocal (local stack
 * tests only, never DEV/PROD) also accepts http://127.0.0.1 and http://localhost.
 */
export function isAllowedPushEndpoint(endpoint: string, { allowLocal = false }: { allowLocal?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (allowLocal && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return true;
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return (PUSH_SERVICE_HOSTS as readonly string[]).includes(host) || PUSH_SERVICE_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** POST /api/admin/push-subscriptions body: PushSubscription.toJSON() minus expirationTime. */
export const pushSubscriptionBody = z
  .object({
    endpoint: z.string().max(1024),
    keys: z.object({ p256dh: base64url(80, 100), auth: base64url(16, 32) }).strict(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict();
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBody>;

/** DELETE /api/admin/push-subscriptions body. */
export const pushUnsubscribeBody = z.object({ endpoint: z.string().max(1024) }).strict();

export type PushApiErrorBody = { error: 'unauthorized' | 'forbidden_origin' | 'invalid_input' | 'endpoint_not_allowed' | 'unavailable' };

/**
 * What the service worker receives. Order number and a link only: no customer
 * name, phone or address, because it shows on a lock screen (SEC-018).
 */
export const pushPayload = z
  .object({
    title: z.string().max(80),
    body: z.string().max(160),
    url: z.string().max(300),
    tag: z.string().max(80),
  })
  .strict();
export type PushPayload = z.infer<typeof pushPayload>;
