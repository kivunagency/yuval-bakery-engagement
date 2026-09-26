import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { isSameOrigin } from '@/lib/server/http/origin';
import { deleteProductPhoto, updateProductPhoto } from '@/lib/server/catalog/admin-product-photos';
import { fail, json, readJson } from '@/lib/server/catalog/admin-product-route';
import { photoPatch, productIdParam } from '@/lib/shared/contracts/admin-products';

export const dynamic = 'force-dynamic';

// PATCH /api/admin/products/[id]/photos/[photoId] (client-006): change the alt
// text ('' clears it, refused while the product is published) and/or make it
// the first photo. DELETE: remove the photo row (audited) and its public file.
// A photo of another product answers 404, like a missing one.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const { id, photoId } = await params;
  const productId = productIdParam.safeParse(id);
  const photo = productIdParam.safeParse(photoId);
  const body = photoPatch.safeParse(await readJson(request));
  if (!productId.success || !photo.success || !body.success) return fail('invalid_input', 400);
  const result = await updateProductPhoto(await createUserClient(), productId.data, photo.data, body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const { id, photoId } = await params;
  const productId = productIdParam.safeParse(id);
  const photo = productIdParam.safeParse(photoId);
  if (!productId.success || !photo.success) return fail('invalid_input', 400);
  const result = await deleteProductPhoto(await createUserClient(), serviceClient(), productId.data, photo.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
