import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { serviceClient } from '@/lib/server/supabase/service';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { parsePublicOrder, publicOrderRow } from '@/lib/server/ordering/order-by-token';
import { buildConfirmationDocument, confirmationFilename } from '@/lib/server/confirmation/content';
import { renderConfirmationPdf } from '@/lib/server/confirmation/pdf';
import { confirmationLinkToken, confirmationPath, linkMatchesStored, orderIdFromLinkToken } from '@/lib/server/confirmation/link';

// The confirmation document's life (US-0c, DB-PLAN.md 7, B5):
//   ensureConfirmation(orderId)  issue once: build from the order view, render,
//                                sha256, store in the private bucket, record
//                                with fn_issue_order_confirmation (write-once).
//                                Called at checkout (after the response), and
//                                lazily wherever the link is needed first.
//   readConfirmation(token)      serve: the link's order, only if the DB says
//                                the link is live (fn_confirmation_by_link_token),
//                                the stored bytes, and only if their sha256 is
//                                still the recorded one.
// Everything here runs with the service role: the bucket has no anon or
// authenticated policy, and both functions are service_role only. Recording
// the WhatsApp delivery is the admin's own act (admin-delivery.ts, admin JWT).

export const CONFIRMATION_BUCKET = 'order-confirmations';

const sourceRow = z
  .object({
    view: publicOrderRow.nullable(),
    pdf_path: z.string().nullable(),
    pdf_sha256: z.string().nullable(),
    link_token_hash: z.string().nullable(),
    link_live: z.boolean(),
    delivered_at: z.string().nullable(),
    channel: z.string().nullable(),
    has_email: z.boolean(),
  })
  .nullable();
type SourceRow = NonNullable<z.infer<typeof sourceRow>>;

export type IssuedConfirmation = {
  orderId: string;
  orderNumber: string;
  /** "/confirmation/<token>" (no host). */
  path: string;
  filename: string;
  sha256: string;
  storagePath: string;
  hasEmail: boolean;
  deliveredAt: string | null;
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function readSource(service: SupabaseClient, orderId: string): Promise<SourceRow | null> {
  return callRpc(service, 'fn_order_confirmation_source', { p_order_id: orderId }, sourceRow);
}

function issued(orderId: string, s: SourceRow, token: string): IssuedConfirmation | null {
  if (!s.view || !s.pdf_path || !s.pdf_sha256 || !s.link_live) return null;
  // A link built with a changed secret would not match the stored hash: never hand it out.
  if (!linkMatchesStored(token, s.link_token_hash)) return null;
  return {
    orderId,
    orderNumber: s.view.order_number,
    path: confirmationPath(token),
    filename: confirmationFilename(s.view.order_number),
    sha256: s.pdf_sha256,
    storagePath: s.pdf_path,
    hasEmail: s.has_email,
    deliveredAt: s.delivered_at,
  };
}

/**
 * The order's confirmation, issuing it first if it does not exist yet.
 * null: the order is unknown, purged or revoked, or cannot get a first
 * document (expired or cancelled before it was issued). Throws on
 * infrastructure errors (storage or DB unreachable, secret missing).
 * `pdf` is set when this call rendered and stored the file (the checkout email attaches it).
 */
export async function ensureConfirmation(
  orderId: string,
  siteUrl: string,
  service: SupabaseClient = serviceClient(),
): Promise<(IssuedConfirmation & { pdf?: Buffer }) | null> {
  const token = confirmationLinkToken(orderId);
  const source = await readSource(service, orderId);
  if (!source?.view) return null;
  if (source.pdf_path) return issued(orderId, source, token);
  if (!['payment_pending', 'paid', 'fulfilled'].includes(source.view.status)) return null;

  const order = parsePublicOrder(source.view);
  const pdf = await renderConfirmationPdf(buildConfirmationDocument(order, await getPublicSiteSettings(), siteUrl));
  const hash = sha256(pdf);
  const storagePath = `orders/${orderId}/${hash}.pdf`;
  const up = await service.storage.from(CONFIRMATION_BUCKET).upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false });
  // Same bytes already stored by a concurrent call (deterministic render): fine.
  if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error('confirmation_storage_upload_failed');

  let won: boolean;
  try {
    won = await callRpc(service, 'fn_issue_order_confirmation', { p_order_id: orderId, p_pdf_path: storagePath, p_pdf_sha256: hash, p_link_token: token }, z.boolean());
  } catch (e) {
    if (e instanceof DbError && e.code === 'confirmation_order_not_available') {
      await service.storage.from(CONFIRMATION_BUCKET).remove([storagePath]);
      return null;
    }
    throw e;
  }
  const after = await readSource(service, orderId);
  if (!won && after?.pdf_path !== storagePath) {
    // Another call issued a different file first (e.g. the business details
    // changed in between): that one is the record; ours is an orphan.
    await service.storage.from(CONFIRMATION_BUCKET).remove([storagePath]);
  }
  if (!after) return null;
  const result = issued(orderId, after, token);
  return result && won ? { ...result, pdf } : result;
}

/** The confirmation link path for an order, issuing the document if needed; null when there is none. Never throws. */
export async function confirmationPathFor(orderId: string, siteUrl: string): Promise<string | null> {
  try {
    return (await ensureConfirmation(orderId, siteUrl))?.path ?? null;
  } catch (e) {
    console.error('confirmation link unavailable', e instanceof Error ? e.message : 'unknown');
    return null;
  }
}

const servedRow = z.object({ order_id: z.string(), order_number: z.string(), pdf_path: z.string(), pdf_sha256: z.string() }).nullable();

export type ServedConfirmation = { filename: string; bytes: Buffer };

/**
 * The stored PDF for a link token, or null (one answer for every refusal).
 * A token that is signed correctly but not issued yet (the WhatsApp link sent
 * before anyone opened it) issues the document first.
 */
export async function readConfirmation(token: string, siteUrl: string): Promise<ServedConfirmation | null> {
  const orderId = orderIdFromLinkToken(token);
  if (!orderId) return null;
  const service = serviceClient();
  let row = await callRpc(service, 'fn_confirmation_by_link_token', { p_token: token }, servedRow);
  if (!row) {
    if (!(await ensureConfirmation(orderId, siteUrl, service))) return null;
    row = await callRpc(service, 'fn_confirmation_by_link_token', { p_token: token }, servedRow);
    if (!row) return null;
  }
  if (row.order_id !== orderId) return null;
  const { data, error } = await service.storage.from(CONFIRMATION_BUCKET).download(row.pdf_path);
  if (error || !data) {
    console.error('confirmation pdf missing from storage', row.order_id);
    return null;
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (sha256(bytes) !== row.pdf_sha256) {
    // The file is not the one recorded: never serve it (immutability, DB-PLAN.md 7).
    console.error('confirmation pdf hash mismatch', row.order_id);
    return null;
  }
  return { filename: confirmationFilename(row.order_number), bytes };
}
