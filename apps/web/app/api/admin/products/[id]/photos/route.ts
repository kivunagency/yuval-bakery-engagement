import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { isSameOrigin } from '@/lib/server/http/origin';
import { finalizeProductPhoto } from '@/lib/server/catalog/admin-product-photos';
import { fail, json, readJson } from '@/lib/server/catalog/admin-product-route';
import { photoFinalize, productIdParam } from '@/lib/shared/contracts/admin-products';

export const dynamic = 'force-dynamic';

// POST /api/admin/products/[id]/photos (client-006, SEC-011): re-encode the
// original the browser uploaded (magic bytes, new JPEG without EXIF/GPS),
// write it to the public bucket and attach it with its alt text. The body
// names only the upload id; the server derives every path itself.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = productIdParam.safeParse((await params).id);
  const body = photoFinalize.safeParse(await readJson(request));
  if (!id.success || !body.success) return fail('invalid_input', 400);
  try {
    const result = await finalizeProductPhoto(await createUserClient(), serviceClient(), id.data, body.data.uploadId, body.data.altText);
    return result.ok ? json(result.value, 201) : json(result.body, result.status);
  } catch {
    return fail('server_error', 500);
  }
}
