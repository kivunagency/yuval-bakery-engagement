import 'server-only';
import { z } from 'zod';
import { anonClient } from '@/lib/server/supabase/service';
import { productPhotoUrl } from '@/lib/server/catalog/photo-url';
import { catalogResponse, vatStatus, type CatalogResponse } from '@/lib/shared/contracts/catalog';

// Public catalog read (api-001), shared by GET /api/catalog and the catalog
// page (server component), so both return exactly the same thing.
// Runs as anon: RLS (products_select_published) decides what is public, not
// this code. The column list is explicit so the time cost (oven/work minutes)
// never leaves the DB on this path.

const row = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price_displayed: z.coerce.number(),
  ingredients: z.string().nullable(),
  allergens: z.array(z.string()),
  allergens_may_contain: z.array(z.string()),
  allergen_notes: z.string().nullable(),
  photo_alt: z.string().nullable(),
  is_available: z.boolean(),
  product_photos: z.array(
    z.object({ storage_path: z.string(), alt_text: z.string().nullable(), position: z.number() }),
  ),
});

const COLUMNS =
  'id, name, description, price_displayed, ingredients, allergens, allergens_may_contain, allergen_notes, photo_alt, is_available, created_at, product_photos(storage_path, alt_text, position)';

export class CatalogUnavailableError extends Error {}

export async function getCatalog(): Promise<CatalogResponse> {
  const db = anonClient();
  const [products, setting] = await Promise.all([
    db.from('products').select(COLUMNS).order('created_at', { ascending: true }).order('name', { ascending: true }),
    db.from('app_settings').select('value').eq('key', 'vat_status').maybeSingle(),
  ]);
  if (products.error || setting.error) {
    throw new CatalogUnavailableError(products.error?.message ?? setting.error?.message);
  }

  const rows = z.array(row).parse(products.data);
  // Unknown or missing vat_status: the stricter wording ("final price") is
  // never misleading, "incl. VAT" is when the dealer is exempt.
  const vat = vatStatus.safeParse(setting.data?.value);

  return catalogResponse.parse({
    vatStatus: vat.success ? vat.data : 'exempt',
    products: rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price_displayed,
      ingredients: p.ingredients,
      allergens: p.allergens,
      mayContain: p.allergens_may_contain,
      allergenNotes: p.allergen_notes,
      isAvailable: p.is_available,
      photos: [...p.product_photos]
        .sort((a, b) => a.position - b.position)
        .flatMap((ph) => {
          const url = productPhotoUrl(ph.storage_path);
          return url ? [{ url, alt: ph.alt_text || p.photo_alt || p.name }] : [];
        }),
    })),
  });
}
