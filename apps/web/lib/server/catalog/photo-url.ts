import 'server-only';
import { serverEnv } from '@/lib/server/env';

// The ONE place a product photo URL is built (client-001, SEC-010 pattern:
// the DB stores a Storage path, never a URL). Public bucket `product-photos`
// (DB-PLAN.md section 9). Returns null for a path that is not a plain relative
// object path, so a bad row renders the placeholder instead of an odd URL.
export const PRODUCT_PHOTOS_BUCKET = 'product-photos';

const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,512}$/;

export function productPhotoUrl(storagePath: string, baseUrl: string = serverEnv().NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!SAFE_PATH.test(storagePath)) return null;
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${PRODUCT_PHOTOS_BUCKET}/${encoded}`;
}
