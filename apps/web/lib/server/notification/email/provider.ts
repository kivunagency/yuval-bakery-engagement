import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EmailConfig } from '@/lib/server/notification/config';

// Provider interface: the rest of the notification code never knows which
// service sends the mail. Resend is the production adapter (ADR-001); the
// capture adapter writes JSON files for the local stack and tests.

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Uint8Array }[];
};

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export interface EmailProvider {
  readonly name: 'resend' | 'capture';
  send(message: EmailMessage): Promise<SendResult>;
}

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 8000;

export function resendProvider(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    name: 'resend',
    async send(m) {
      try {
        const res = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [m.to],
            subject: m.subject,
            html: m.html,
            text: m.text,
            attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Only the status reaches the record: a provider error body may echo the address.
        if (!res.ok) return { ok: false, error: `resend_http_${res.status}` };
        const body = (await res.json().catch(() => ({}))) as { id?: unknown };
        return typeof body.id === 'string' ? { ok: true, id: body.id } : { ok: false, error: 'resend_no_id' };
      } catch (e) {
        return { ok: false, error: e instanceof Error && e.name === 'TimeoutError' ? 'resend_timeout' : 'resend_network_error' };
      }
    },
  };
}

/** Local stack and tests only (config refuses it in prod): one JSON file per message. */
export function captureProvider(dir: string, from: string): EmailProvider {
  return {
    name: 'capture',
    async send(m) {
      const id = `capture-${Date.now()}-${randomUUID()}`;
      try {
        await mkdir(dir, { recursive: true });
        const attachments = m.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.byteLength }));
        await writeFile(join(dir, `${id}.json`), JSON.stringify({ id, from, ...m, attachments }, null, 2));
        return { ok: true, id };
      } catch {
        return { ok: false, error: 'capture_write_failed' };
      }
    },
  };
}

export function emailProviderFor(config: EmailConfig): EmailProvider | null {
  if (config.provider === 'resend') return resendProvider(config.apiKey, config.from);
  if (config.provider === 'capture') return captureProvider(config.dir, config.from);
  return null;
}
