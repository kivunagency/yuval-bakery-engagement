import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { deleteProduct, updateProduct } from '@/lib/server/catalog/admin-products';
import { fail, json, readJson } from '@/lib/server/catalog/admin-product-route';
import { productIdParam, productPatch } from '@/lib/shared/contracts/admin-products';

export const dynamic = 'force-dynamic';

// PATCH /api/admin/products/[id] (client-006): change any field, including
// availability and publishing. Publishing is refused (409) while the allergens
// are not confirmed or a photo has no alt text; the DB decides both. An edit of
// the price or minutes applies to new orders only: orders keep their snapshot.
// DELETE: soft delete (the product leaves the catalog and this screen).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = productIdParam.safeParse((await params).id);
  const body = productPatch.safeParse(await readJson(request));
  if (!id.success || !body.success) return fail('invalid_input', 400);
  const result = await updateProduct(await createUserClient(), id.data, body.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const id = productIdParam.safeParse((await params).id);
  if (!id.success) return fail('invalid_input', 400);
  const result = await deleteProduct(await createUserClient(), id.data);
  return result.ok ? json(result.value, 200) : json(result.body, result.status);
}
