import { describe, expect, it } from 'vitest';
import { photoPatch, productCreate, productPatch, publishBlockers, toDbPatch } from '@/lib/shared/contracts/admin-products';

// client-006 contracts: same bounds as the DB functions (migration 20260926140000).
describe('admin products contract', () => {
  const base = { name: 'Cookie', price: 12, costBasis: 'per_unit', ovenMinutes: 5, workMinutes: 8 } as const;

  it('accepts agorot prices, refuses a third decimal, negatives and strings', () => {
    for (const price of [0, 19.99, 0.1, 10000]) expect(productCreate.safeParse({ ...base, price }).success).toBe(true);
    for (const price of [1.005, -1, 10000.01, '12']) expect(productCreate.safeParse({ ...base, price }).success).toBe(false);
  });

  it('minutes are whole 0..1440; unknown keys refused; empty patch refused', () => {
    expect(productCreate.safeParse({ ...base, ovenMinutes: 1.5 }).success).toBe(false);
    expect(productCreate.safeParse({ ...base, workMinutes: 1441 }).success).toBe(false);
    expect(productCreate.safeParse({ ...base, photoAlt: 'x' }).success).toBe(false);
    expect(productPatch.safeParse({}).success).toBe(false);
    expect(photoPatch.safeParse({}).success).toBe(false);
    expect(photoPatch.safeParse({ primary: false }).success).toBe(false);
  });

  it('trims text, empty optional text becomes null, allergen entries normalized and de-duplicated', () => {
    const r = productCreate.parse({ ...base, name: ' Cookie ', description: '  ', allergens: ['gluten', ' gluten', 'wild  strawberry'] });
    expect(r.name).toBe('Cookie');
    expect(r.description).toBeNull();
    expect(r.allergens).toEqual(['gluten', 'wild strawberry']);
  });

  it('maps only the keys sent to the DB names', () => {
    expect(toDbPatch({ isPublished: true, mayContain: ['nuts'], description: null })).toEqual({ is_published: true, may_contain: ['nuts'], description: null });
  });

  it('lists what blocks publishing', () => {
    expect(publishBlockers({ allergensConfirmed: true, photos: [] })).toEqual([]);
    expect(publishBlockers({ allergensConfirmed: false, photos: [{ id: '1', url: null, altText: ' ' }] })).toEqual(['allergens_not_confirmed', 'photo_alt_missing']);
  });
});
