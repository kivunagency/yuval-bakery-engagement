import { z } from 'zod';

// GET /api/catalog (api-001). The public catalog: published products only,
// paused ones included with isAvailable=false (PRD US-1: visibly disabled,
// not hidden). No time cost (oven/work minutes) ever leaves the server on a
// public surface (design-tokens.md: the customer sees states, never minutes).

export const catalogPhoto = z.object({
  url: z.string().max(2048),
  alt: z.string().max(500),
});

export const catalogProduct = z.object({
  /** DB id: any 8-4-4-4-12 hex (seed and legacy ids are not RFC 4122 versioned). */
  id: z.guid(),
  name: z.string().max(200),
  description: z.string().max(4000).nullable(),
  price: z.number().nonnegative(),
  ingredients: z.string().max(4000).nullable(),
  /** "contains" allergen codes (solid chip). */
  allergens: z.array(z.string().max(80)),
  /** "may contain" allergen codes (dashed chip). */
  mayContain: z.array(z.string().max(80)),
  allergenNotes: z.string().max(2000).nullable(),
  isAvailable: z.boolean(),
  /** In display order; empty means "render the neutral placeholder". */
  photos: z.array(catalogPhoto),
});
export type CatalogProduct = z.infer<typeof catalogProduct>;

/** Drives the price label: exempt dealer shows "final price", licensed shows "incl. VAT" (compliance-spec.md section 8). */
export const vatStatus = z.enum(['exempt', 'licensed']);
export type VatStatus = z.infer<typeof vatStatus>;

export const catalogResponse = z.object({
  products: z.array(catalogProduct),
  vatStatus,
});
export type CatalogResponse = z.infer<typeof catalogResponse>;
