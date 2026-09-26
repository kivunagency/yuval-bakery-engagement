import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from '@/lib/server/supabase/rpc';
import { reencodePhoto } from '@/lib/server/custom-cake/image';
import { PRODUCT_PHOTOS_BUCKET } from '@/lib/server/catalog/photo-url';
import { productErrorResult, toAdminProduct, type ProductResult } from '@/lib/server/catalog/admin-products';
import { productRow, type AdminProduct, type PhotoPatch, type PhotoUploadUrl } from '@/lib/shared/contracts/admin-products';

// Catalog photos (client-006, SEC-011). Same pipeline as the custom-cake
// inspiration photos (SEC-010, lib/server/custom-cake/photos.ts), with the
// admin as the uploader:
//   1. the admin's browser PUTs the original to a signed, single-use upload
//      URL in the PRIVATE bucket product-photos-staging (a Netlify function
//      body is too small for a phone photo, so the bytes never pass through
//      a function on the way in);
//   2. the server reads it back, checks the magic bytes and re-encodes it
//      with the one shared re-encoder (reencodePhoto: new JPEG, no EXIF/GPS,
//      at most 2560px, decompression-bomb ceiling), writes the result to the
//      PUBLIC bucket product-photos as products/<product id>/<uuid>.jpg, and
//      records the path with the admin's own JWT (fn_admin_add_product_photo:
//      aal2, audited). The original is deleted whatever happens.
// Every Storage call uses the service-role client: neither bucket has an
// anon/authenticated policy. Callers check getAdminSession() first.

export const PRODUCT_STAGING_BUCKET = 'product-photos-staging';
/** An upload nobody finalized is removed after this long (threat-model 3.2: 24 hours). */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const stagingPath = (uploadId: string) => `incoming/${uploadId}`;

/** Removes staged originals older than a day (an admin who closed the tab mid-upload). Best effort. */
export async function purgeStaleStaging(service: SupabaseClient, now = Date.now()): Promise<number> {
  const bucket = service.storage.from(PRODUCT_STAGING_BUCKET);
  const { data, error } = await bucket.list('incoming', { limit: 100, sortBy: { column: 'created_at', order: 'asc' } });
  if (error || !data) return 0;
  const stale = data
    .filter((f) => f.id && f.created_at && now - new Date(f.created_at).getTime() > STAGING_MAX_AGE_MS)
    .map((f) => `incoming/${f.name}`);
  if (stale.length === 0) return 0;
  const { error: rmError } = await bucket.remove(stale);
  return rmError ? 0 : stale.length;
}

/** A signed upload URL for one original. The id is random; the server derives the path from it. */
export async function createPhotoUploadUrl(service: SupabaseClient): Promise<PhotoUploadUrl> {
  await purgeStaleStaging(service);
  const uploadId = randomUUID();
  const { data, error } = await service.storage.from(PRODUCT_STAGING_BUCKET).createSignedUploadUrl(stagingPath(uploadId));
  if (error || !data) throw new Error('storage_signed_upload_failed');
  return { uploadId, uploadUrl: data.signedUrl };
}

/**
 * Re-encode the staged original and attach it to the product. `client` is the
 * admin's own client (the DB checks aal2 and audits); `service` does Storage.
 */
export async function finalizeProductPhoto(
  client: SupabaseClient,
  service: SupabaseClient,
  productId: string,
  uploadId: string,
  altText: string | undefined,
): Promise<ProductResult<AdminProduct>> {
  const staging = service.storage.from(PRODUCT_STAGING_BUCKET);
  const source = stagingPath(uploadId);
  const { data: blob, error: dlError } = await staging.download(source);
  if (dlError || !blob) return { ok: false, status: 400, body: { error: 'upload_missing' } };
  try {
    const encoded = await reencodePhoto(Buffer.from(await blob.arrayBuffer()));
    if (!encoded.ok) return { ok: false, status: 422, body: { error: 'photo_rejected' } };

    const target = `products/${productId}/${randomUUID()}.jpg`;
    const publicBucket = service.storage.from(PRODUCT_PHOTOS_BUCKET);
    const up = await publicBucket.upload(target, encoded.jpeg, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (up.error) return { ok: false, status: 500, body: { error: 'server_error' } };
    try {
      const row = await callRpc(
        client,
        'fn_admin_add_product_photo',
        { p_product_id: productId, p_storage_path: target, p_alt_text: altText ?? null },
        productRow,
      );
      return { ok: true, value: toAdminProduct(row) };
    } catch (e) {
      // The DB refused (not found, 7th photo, session): the public copy goes too.
      await publicBucket.remove([target]);
      return productErrorResult(e);
    }
  } finally {
    await staging.remove([source]);
  }
}

export async function updateProductPhoto(client: SupabaseClient, productId: string, photoId: string, patch: PhotoPatch): Promise<ProductResult<AdminProduct>> {
  try {
    const row = await callRpc(
      client,
      'fn_admin_update_product_photo',
      { p_product_id: productId, p_photo_id: photoId, p_alt_text: patch.altText ?? null, p_make_primary: patch.primary === true },
      productRow,
    );
    return { ok: true, value: toAdminProduct(row) };
  } catch (e) {
    return productErrorResult(e);
  }
}

const deleted = z.object({ storage_path: z.string(), product: productRow });

/** Deletes the row (audited), then the public object. A failed object delete leaves an orphan file, logged. */
export async function deleteProductPhoto(client: SupabaseClient, service: SupabaseClient, productId: string, photoId: string): Promise<ProductResult<AdminProduct>> {
  let result: z.infer<typeof deleted>;
  try {
    result = await callRpc(client, 'fn_admin_delete_product_photo', { p_product_id: productId, p_photo_id: photoId }, deleted);
  } catch (e) {
    return productErrorResult(e);
  }
  const { error } = await service.storage.from(PRODUCT_PHOTOS_BUCKET).remove([result.storage_path]);
  if (error) console.error('product photo object not removed after its row was deleted');
  return { ok: true, value: toAdminProduct(result.product) };
}
