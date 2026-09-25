import { describe, expect, it } from 'vitest';
import { normalizeCity, toAdminDeliveryZone, zoneCreate, zonePatch } from '@/lib/shared/contracts/delivery-zones';

describe('admin delivery-zones contract (api-007)', () => {
  it('create: trims the name, normalizes and de-duplicates cities, cities default to none', () => {
    expect(zoneCreate.parse({ name: ' Center ', fee: 35, cities: [' Ramat  Gan ', 'Ramat Gan', 'Givatayim'] })).toEqual({
      name: 'Center',
      fee: 35,
      cities: ['Ramat Gan', 'Givatayim'],
    });
    expect(zoneCreate.parse({ name: 'North', fee: 0 })).toEqual({ name: 'North', fee: 0, cities: [] });
  });

  it('fee is whole shekels 0..1000; name 1..40; city 1..60; at most 100 cities; unknown keys rejected', () => {
    const bad = [
      { name: 'A', fee: -1 },
      { name: 'A', fee: 1001 },
      { name: 'A', fee: 35.5 },
      { name: 'A', fee: '35' },
      { name: '   ', fee: 1 },
      { name: 'x'.repeat(41), fee: 1 },
      { name: 'A', fee: 1, cities: ['  '] },
      { name: 'A', fee: 1, cities: ['x'.repeat(61)] },
      { name: 'A', fee: 1, cities: Array.from({ length: 101 }, (_, i) => `c${i}`) },
      { name: 'A', fee: 1, isActive: true },
    ];
    for (const b of bad) expect(zoneCreate.safeParse(b).success, JSON.stringify(b).slice(0, 60)).toBe(false);
  });

  it('patch: any subset, never empty, strict', () => {
    expect(zonePatch.parse({ fee: 40 })).toEqual({ fee: 40 });
    expect(zonePatch.parse({ isActive: false })).toEqual({ isActive: false });
    expect(zonePatch.parse({ cities: [] })).toEqual({ cities: [] });
    expect(zonePatch.safeParse({}).success).toBe(false);
    expect(zonePatch.safeParse({ fee: 40, id: 'x' }).success).toBe(false);
  });

  it('normalizeCity matches the DB rule (trim + collapse inner whitespace)', () => {
    expect(normalizeCity('  Tel   Aviv\tYafo ')).toBe('Tel Aviv Yafo');
  });

  it('maps a DB row to the API shape', () => {
    expect(
      toAdminDeliveryZone({ id: '6f1c1f53-6f0e-4d52-9d3a-6c2b0b9d6a11', name: 'Center', fee: 35, is_active: true, cities: ['A'] }),
    ).toEqual({ id: '6f1c1f53-6f0e-4d52-9d3a-6c2b0b9d6a11', name: 'Center', fee: 35, isActive: true, cities: ['A'] });
  });
});
