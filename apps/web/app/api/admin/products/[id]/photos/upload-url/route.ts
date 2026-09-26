import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { isSameOrigin } from '@/lib/server/http/origin';
import { getProductForAdmin } from '@/lib/server/catalog/admin-products';
import { createPhotoUploadUrl } from '@/lib/server/catalog/admin-product-photos';
import { fail, json } from '@/lib/server/catalog/admin-product-route';
import { productIdParam, type PhotoUploadUrl } from '@/lib/shared/contracts/admin-products';

export const dynamic = 'force-dynamic';

// POST /api/admin/products/[id]/photos/upload-url (client-006, SEC-011): one
// signed, single-use upload URL into the PRIVATE staging bucket. The browser
// PUTs the original there (no function body limit), then calls
// POST .../photos to have it re-encoded into the public bucket.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = productIdParam.safeParse((await params).id);
  if (!id.success) return fail('invalid_input', 400);
  try {
    if (!(await getProductForAdmin(await createUserClient(), id.data))) return fail('not_found', 404);
    return json((await createPhotoUploadUrl(serviceClient())) satisfies PhotoUploadUrl, 200);
  } catch {
    return fail('server_error', 500);
  }
}
