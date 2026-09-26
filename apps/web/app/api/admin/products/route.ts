import { getAdminSession } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { createProduct } from '@/lib/server/catalog/admin-products';
import { fail, json, readJson } from '@/lib/server/catalog/admin-product-route';
import { productCreate } from '@/lib/shared/contracts/admin-products';

export const dynamic = 'force-dynamic';

// POST /api/admin/products (client-006, US-12): create a product. Admin at
// aal2 only; the DB checks it again with the admin's own JWT, validates the
// same bounds, and audits (fn_admin_create_product). The list itself arrives
// with the admin catalog page (server component), so there is no GET here.
export async function POST(request: Request) {
  if (!(await getAdminSession())) return fail('unauthorized', 401);
  if (!isSameOrigin(request)) return fail('forbidden_origin', 403);
  const body = productCreate.safeParse(await readJson(request));
  if (!body.success) return fail('invalid_input', 400);
  const result = await createProduct(await createUserClient(), body.data);
  return result.ok ? json(result.value, 201) : json(result.body, result.status);
}
