import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { productPhotoUrl } from '@/lib/server/catalog/photo-url';
import {
  adminProduct,
  productRow,
  toDbPatch,
  type AdminProduct,
  type ProductCreate,
  type ProductPatch,
  type ProductRow,
  type ProductsApiErrorBody,
} from '@/lib/shared/contracts/admin-products';

// Admin reads and writes of products (client-006, US-12). `client` is always
// createUserClient(): RLS lets an aal2 admin read unpublished products, and
// the write functions check aal2 again, validate, and audit with auth.uid()
// (SEC-017). The public catalog read is get-catalog.ts, not here. Photos
// (Storage + re-encoding) are in admin-product-photos.ts.

export type ProductResult<T> = { ok: true; value: T } | { ok: false; status: number; body: ProductsApiErrorBody };

export function toAdminProduct(row: ProductRow): AdminProduct {
  return adminProduct.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    costBasis: row.cost_basis,
    ovenMinutes: row.oven_minutes,
    workMinutes: row.work_minutes,
    ingredients: row.ingredients,
    allergens: row.allergens,
    mayContain: row.may_contain,
    allergenNotes: row.allergen_notes,
    allergensConfirmed: row.allergens_confirmed,
    isAvailable: row.is_available,
    isPublished: row.is_published,
    photos: [...row.photos]
      .sort((a, b) => a.position - b.position)
      .map((ph) => ({ id: ph.id, url: productPhotoUrl(ph.storage_path), altText: ph.alt_text })),
  });
}

const COLUMNS =
  'id, name, description, price:price_displayed, cost_basis, oven_minutes:oven_minutes_cost, work_minutes:work_minutes_cost, ingredients, allergens, may_contain:allergens_may_contain, allergen_notes, allergens_confirmed, is_available, is_published, updated_at, photos:product_photos(id, storage_path, alt_text, position)';

/** Every product that is not deleted, published or not, in the order the catalog shows them. */
export async function listProductsForAdmin(client: SupabaseClient): Promise<AdminProduct[]> {
  const { data, error } = await client
    .from('products')
    .select(COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error('products_read_failed');
  return z.array(productRow).parse(data).map(toAdminProduct);
}

/** One product, or null when it does not exist or was deleted. */
export async function getProductForAdmin(client: SupabaseClient, id: string): Promise<AdminProduct | null> {
  const { data, error } = await client.from('products').select(COLUMNS).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw new Error('products_read_failed');
  return data ? toAdminProduct(productRow.parse(data)) : null;
}

/** Maps a DB error from a product function to an HTTP answer. */
export function productErrorResult(e: unknown): ProductResult<never> {
  if (e instanceof DbError) {
    switch (e.code) {
      case 'admin_aal2_required':
        return { ok: false, status: 401, body: { error: 'unauthorized' } };
      case 'product_invalid': {
        // The DB raises 'product_invalid: <field>'.
        const field = e.raw.slice(e.raw.indexOf(':') + 1).trim();
        return { ok: false, status: 400, body: { error: 'invalid_input', ...(field ? { field } : {}) } };
      }
      case 'product_not_found':
      case 'product_photo_not_found':
        return { ok: false, status: 404, body: { error: 'not_found' } };
      case 'product_allergens_not_confirmed':
        return { ok: false, status: 409, body: { error: 'allergens_not_confirmed' } };
      case 'product_photo_alt_required':
        return { ok: false, status: 409, body: { error: 'photo_alt_required' } };
      case 'product_photo_limit_reached':
        return { ok: false, status: 409, body: { error: 'photo_limit_reached' } };
    }
  }
  return { ok: false, status: 500, body: { error: 'server_error' } };
}

export async function createProduct(client: SupabaseClient, input: ProductCreate): Promise<ProductResult<AdminProduct>> {
  try {
    const row = await callRpc(client, 'fn_admin_create_product', { p_product: toDbPatch(input) }, productRow);
    return { ok: true, value: toAdminProduct(row) };
  } catch (e) {
    return productErrorResult(e);
  }
}

export async function updateProduct(client: SupabaseClient, id: string, input: ProductPatch): Promise<ProductResult<AdminProduct>> {
  try {
    const row = await callRpc(client, 'fn_admin_update_product', { p_product_id: id, p_patch: toDbPatch(input) }, productRow);
    return { ok: true, value: toAdminProduct(row) };
  } catch (e) {
    return productErrorResult(e);
  }
}

export async function deleteProduct(client: SupabaseClient, id: string): Promise<ProductResult<{ deleted: true }>> {
  try {
    await callRpc(client, 'fn_admin_delete_product', { p_product_id: id }, z.literal(true));
    return { ok: true, value: { deleted: true } };
  } catch (e) {
    return productErrorResult(e);
  }
}
