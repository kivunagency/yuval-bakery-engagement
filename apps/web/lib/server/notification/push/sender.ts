import 'server-only';
import webpush from 'web-push';
import type { PushConfig } from '@/lib/server/notification/config';
import { isAllowedPushEndpoint, type PushPayload } from '@/lib/shared/contracts/push';

export type PushTarget = { id: string; endpoint: string; p256dh: string; auth_key: string };
/** gone: the push service says this subscription no longer exists (404/410). */
export type PushResult = { ok: true } | { ok: false; error: string; gone: boolean };

export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

const TIMEOUT_MS = 8000;

export function webPushSender(config: Extract<PushConfig, { enabled: true }>, fetchImpl: typeof fetch = fetch): PushSender {
  return {
    async send(target, payload) {
      // Checked at registration too; checked again because the row is what we POST to.
      if (!isAllowedPushEndpoint(target.endpoint, { allowLocal: config.allowLocalEndpoints })) {
        return { ok: false, error: 'endpoint_not_allowed', gone: false };
      }
      try {
        // web-push encrypts the payload (aes128gcm) and signs the VAPID JWT;
        // the request itself goes out with fetch (web-push's own transport is https-only).
        const req = webpush.generateRequestDetails(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth_key } },
          JSON.stringify(payload),
          {
            vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
            TTL: 24 * 60 * 60,
            urgency: 'high',
          },
        );
        // fetch sets Content-Length itself from the body.
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-length').map(([k, v]) => [k, String(v)]),
        );
        const res = await fetchImpl(req.endpoint, {
          method: req.method,
          headers,
          body: req.body ? new Uint8Array(req.body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) return { ok: true };
        return { ok: false, error: `push_http_${res.status}`, gone: res.status === 404 || res.status === 410 };
      } catch (e) {
        return { ok: false, error: e instanceof Error && e.name === 'TimeoutError' ? 'push_timeout' : 'push_network_error', gone: false };
      }
    },
  };
}
