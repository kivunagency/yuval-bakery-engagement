import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from '@/lib/server/supabase/rpc';
import { reencodePhoto } from '@/lib/server/custom-cake/image';

// Storage side of the inspiration-photo pipeline (SEC-010, threat-model 3.2).
// The browser never uploads through a Netlify function (body limit): it PUTs
// each file to a signed, single-use upload URL under incoming/<request>/,
// then asks the server to process them. The server reads each incoming file,
// re-encodes it (image.ts), writes requests/<request>/<uuid>.jpg, records the
// path in the DB (fn_attach_custom_cake_photo) and deletes the original.
// Everything here uses the service-role client: the bucket is private, has no
// anon/authenticated policy, and nothing in it is ever served publicly.
// The admin sees a photo only through a short signed URL (signedPhotoUrl).

export const CUSTOM_CAKE_BUCKET = 'custom-cake-inspiration';
/** Seconds a signed view URL stays valid for the admin (threat-model 3.2: at most an hour). */
export const SIGNED_VIEW_SECONDS = 10 * 60;

const incomingDir = (requestId: string) => `incoming/${requestId}`;

/** One signed upload URL per photo the customer announced. */
export async function createUploadUrls(service: SupabaseClient, requestId: string, count: number): Promise<string[]> {
  const bucket = service.storage.from(CUSTOM_CAKE_BUCKET);
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const { data, error } = await bucket.createSignedUploadUrl(`${incomingDir(requestId)}/${i}`);
    if (error || !data) throw new Error('storage_signed_upload_failed');
    urls.push(data.signedUrl);
  }
  return urls;
}

export type ProcessResult = { accepted: number; rejected: number };

/**
 * Re-encode every file waiting under incoming/<requestId>/. Idempotent: a file
 * is deleted after it is handled, so a second call finds nothing. A file the
 * DB refuses (window closed, 4th photo) is deleted and its re-encoded copy too.
 */
export async function processIncomingPhotos(service: SupabaseClient, requestId: string): Promise<ProcessResult> {
  const bucket = service.storage.from(CUSTOM_CAKE_BUCKET);
  const { data: files, error } = await bucket.list(incomingDir(requestId), { limit: 10 });
  if (error) throw new Error('storage_list_failed');
  const result: ProcessResult = { accepted: 0, rejected: 0 };
  for (const file of files ?? []) {
    const source = `${incomingDir(requestId)}/${file.name}`;
    const { data: blob, error: dlError } = await bucket.download(source);
    const encoded = !dlError && blob ? await reencodePhoto(Buffer.from(await blob.arrayBuffer())) : null;
    let stored = false;
    if (encoded?.ok) {
      const target = `requests/${requestId}/${randomUUID()}.jpg`;
      const up = await bucket.upload(target, encoded.jpeg, { contentType: 'image/jpeg', upsert: false });
      if (!up.error) {
        try {
          await callRpc(service, 'fn_attach_custom_cake_photo', { p_request_id: requestId, p_storage_path: target }, z.string());
          stored = true;
        } catch {
          await bucket.remove([target]);
        }
      }
    }
    await bucket.remove([source]);
    if (stored) result.accepted += 1;
    else result.rejected += 1;
  }
  return result;
}

/** Short-lived view URL for the admin queue. Call only after getAdminSession(). */
export async function signedPhotoUrls(service: SupabaseClient, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const { data, error } = await service.storage.from(CUSTOM_CAKE_BUCKET).createSignedUrls(paths, SIGNED_VIEW_SECONDS);
  if (error || !data) return out;
  for (const row of data) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  return out;
}
