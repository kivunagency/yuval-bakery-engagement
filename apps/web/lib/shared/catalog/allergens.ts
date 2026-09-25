// Allergen codes (compliance-spec.md section 10: closed list plus Yuval's own
// additions). The DB stores the code; the UI label lives in messages under
// catalog.allergen.<code>. A code outside this list is Yuval's free text and
// is shown as she typed it.
export const ALLERGEN_CODES = ['gluten', 'eggs', 'dairy', 'nuts', 'almonds', 'peanuts', 'sesame', 'soy'] as const;
export type AllergenCode = (typeof ALLERGEN_CODES)[number];

export function isKnownAllergen(code: string): code is AllergenCode {
  return (ALLERGEN_CODES as readonly string[]).includes(code);
}
