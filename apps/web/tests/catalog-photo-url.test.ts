import { describe, expect, it } from 'vitest';
import { productPhotoUrl } from '@/lib/server/catalog/photo-url';

const BASE = 'https://abc.supabase.co';

describe('productPhotoUrl (the one place a catalog photo URL is built)', () => {
  it('builds the public product-photos URL from a storage path', () => {
    expect(productPhotoUrl('products/2000/cake.webp', BASE)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/product-photos/products/2000/cake.webp',
    );
  });
  it('tolerates a trailing slash on the base URL', () => {
    expect(productPhotoUrl('a.jpg', `${BASE}/`)).toBe(`${BASE}/storage/v1/object/public/product-photos/a.jpg`);
  });
  it.each(['', '/abs.jpg', '../x.jpg', 'a/../b.jpg', 'a//b.jpg', 'https://evil.test/x.jpg', 'a b.jpg', 'a/./b.jpg', 'a?.jpg'])(
    'refuses a path that is not a plain relative object path: %j',
    (p) => {
      expect(productPhotoUrl(p, BASE)).toBeNull();
    },
  );
});
