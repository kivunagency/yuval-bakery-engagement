import { z } from 'zod';

// Admin product contracts (client-006, US-12). The DB functions
// (fn_admin_*_product*, migration 20260926140000) enforce the same bounds
// again: name 1..80, description 1000, ingredients 2000, allergen notes 500,
// price 0..10000 in agorot steps, minutes whole 0..1440, up to 20 allergen
// entries of 1..40 characters, alt text 1..200, at most 6 photos.

export const PRODUCT_LIMITS = {
  name: 80,
  description: 1000,
  ingredients: 2000,
  allergenNotes: 500,
  allergenEntry: 40,
  allergenEntries: 20,
  priceMax: 10000,
  minutesMax: 1440,
  altText: 200,
  photos: 6,
  /** Same cap as the storage buckets and the shared re-encoder (lib/server/custom-cake/image.ts). */
  photoBytes: 10 * 1024 * 1024,
} as const;

export const COST_BASES = ['per_unit', 'per_batch'] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** Optional text: trimmed, empty becomes null (clears the field). */
const optionalText = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(max))
    .transform((s) => (s === '' ? null : s))
    .nullable();

const allergenEntry = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(PRODUCT_LIMITS.allergenEntry));
const allergenList = z
  .array(allergenEntry)
  .max(PRODUCT_LIMITS.allergenEntries)
  .transform((list) => [...new Set(list)]);

/** Shekels with at most two decimals (agorot). */
export const productPrice = z
  .number()
  .min(0)
  .max(PRODUCT_LIMITS.priceMax)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'agorot');
export const productMinutes = z.number().int().min(0).max(PRODUCT_LIMITS.minutesMax);

const fields = {
  name: z.string().trim().min(1).max(PRODUCT_LIMITS.name),
  description: optionalText(PRODUCT_LIMITS.description),
  price: productPrice,
  costBasis: z.enum(COST_BASES),
  ovenMinutes: productMinutes,
  workMinutes: productMinutes,
  ingredients: optionalText(PRODUCT_LIMITS.ingredients),
  allergens: allergenList,
  mayContain: allergenList,
  allergenNotes: optionalText(PRODUCT_LIMITS.allergenNotes),
  allergensConfirmed: z.boolean(),
  isAvailable: z.boolean(),
  isPublished: z.boolean(),
};

/** POST /api/admin/products body. */
export const productCreate = z
  .object({
    ...fields,
    description: fields.description.optional(),
    ingredients: fields.ingredients.optional(),
    allergens: fields.allergens.optional(),
    mayContain: fields.mayContain.optional(),
    allergenNotes: fields.allergenNotes.optional(),
    allergensConfirmed: fields.allergensConfirmed.optional(),
    isAvailable: fields.isAvailable.optional(),
    isPublished: fields.isPublished.optional(),
  })
  .strict();
export type ProductCreate = z.infer<typeof productCreate>;

/** PATCH /api/admin/products/[id] body. Omitted = unchanged; null clears an optional text. */
export const productPatch = z
  .object({
    name: fields.name.optional(),
    description: fields.description.optional(),
    price: fields.price.optional(),
    costBasis: fields.costBasis.optional(),
    ovenMinutes: fields.ovenMinutes.optional(),
    workMinutes: fields.workMinutes.optional(),
    ingredients: fields.ingredients.optional(),
    allergens: fields.allergens.optional(),
    mayContain: fields.mayContain.optional(),
    allergenNotes: fields.allergenNotes.optional(),
    allergensConfirmed: fields.allergensConfirmed.optional(),
    isAvailable: fields.isAvailable.optional(),
    isPublished: fields.isPublished.optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'empty_patch');
export type ProductPatch = z.infer<typeof productPatch>;

const DB_KEYS: Record<keyof ProductPatch, string> = {
  name: 'name',
  description: 'description',
  price: 'price',
  costBasis: 'cost_basis',
  ovenMinutes: 'oven_minutes',
  workMinutes: 'work_minutes',
  ingredients: 'ingredients',
  allergens: 'allergens',
  mayContain: 'may_contain',
  allergenNotes: 'allergen_notes',
  allergensConfirmed: 'allergens_confirmed',
  isAvailable: 'is_available',
  isPublished: 'is_published',
};

/** The JSONB the fn_admin_*_product functions take: only the keys the caller sent. */
export function toDbPatch(p: Partial<ProductPatch>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined) out[DB_KEYS[k as keyof ProductPatch]] = v;
  }
  return out;
}

/** Any 8-4-4-4-12 hex id (z.guid): seed rows use ids that are not RFC 4122 v1-v8. */
export const productIdParam = z.guid();

export const altText = z.string().trim().max(PRODUCT_LIMITS.altText);

/** POST /api/admin/products/[id]/photos: the upload the browser PUT to the signed URL, and its alt text. */
export const photoFinalize = z
  .object({
    uploadId: z.uuid(),
    altText: altText.optional(),
  })
  .strict();
export type PhotoFinalize = z.infer<typeof photoFinalize>;

/** POST /api/admin/products/[id]/photos/upload-url answer. */
export const photoUploadUrl = z.object({ uploadId: z.uuid(), uploadUrl: z.string().url() });
export type PhotoUploadUrl = z.infer<typeof photoUploadUrl>;

/** PATCH /api/admin/products/[id]/photos/[photoId]: new alt text ('' clears it) and/or make it the first photo. */
export const photoPatch = z
  .object({
    altText: altText.optional(),
    primary: z.literal(true).optional(),
  })
  .strict()
  .refine((p) => p.altText !== undefined || p.primary !== undefined, 'empty_patch');
export type PhotoPatch = z.infer<typeof photoPatch>;

/** What fn_admin_product_json returns. */
export const productRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.coerce.number(),
  cost_basis: z.enum(COST_BASES),
  oven_minutes: z.number().int(),
  work_minutes: z.number().int(),
  ingredients: z.string().nullable(),
  allergens: z.array(z.string()),
  may_contain: z.array(z.string()),
  allergen_notes: z.string().nullable(),
  allergens_confirmed: z.boolean(),
  is_available: z.boolean(),
  is_published: z.boolean(),
  updated_at: z.string(),
  photos: z.array(
    z.object({ id: z.string(), storage_path: z.string(), alt_text: z.string().nullable(), position: z.number().int() }),
  ),
});
export type ProductRow = z.infer<typeof productRow>;

export const adminProductPhoto = z.object({
  id: z.guid(),
  /** Public URL, null when the stored path is not a safe object path (placeholder). */
  url: z.string().nullable(),
  altText: z.string().nullable(),
});
export type AdminProductPhoto = z.infer<typeof adminProductPhoto>;

export const adminProduct = z.object({
  id: z.guid(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  costBasis: z.enum(COST_BASES),
  ovenMinutes: z.number().int(),
  workMinutes: z.number().int(),
  ingredients: z.string().nullable(),
  allergens: z.array(z.string()),
  mayContain: z.array(z.string()),
  allergenNotes: z.string().nullable(),
  allergensConfirmed: z.boolean(),
  isAvailable: z.boolean(),
  isPublished: z.boolean(),
  photos: z.array(adminProductPhoto),
});
export type AdminProduct = z.infer<typeof adminProduct>;

/** Why a product cannot be published yet, in the order the screen lists them. */
export type PublishBlocker = 'allergens_not_confirmed' | 'photo_alt_missing';

export function publishBlockers(p: Pick<AdminProduct, 'allergensConfirmed' | 'photos'>): PublishBlocker[] {
  const out: PublishBlocker[] = [];
  if (!p.allergensConfirmed) out.push('allergens_not_confirmed');
  if (p.photos.some((ph) => !ph.altText || ph.altText.trim() === '')) out.push('photo_alt_missing');
  return out;
}

/** Error body of the admin products API. */
export const PRODUCTS_API_ERRORS = [
  'unauthorized',
  'forbidden_origin',
  'invalid_input',
  'not_found',
  'allergens_not_confirmed',
  'photo_alt_required',
  'photo_limit_reached',
  'photo_rejected',
  'upload_missing',
  'server_error',
] as const;
export type ProductsApiError = (typeof PRODUCTS_API_ERRORS)[number];
export const productsApiError = z.object({
  error: z.enum(PRODUCTS_API_ERRORS),
  /** For invalid_input from the DB: the field it refused. */
  field: z.string().optional(),
});
export type ProductsApiErrorBody = z.infer<typeof productsApiError>;
