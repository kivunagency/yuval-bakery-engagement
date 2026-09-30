import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import he from '@/messages/he.json';
import { EMPTY_SITE_SETTINGS } from '@/lib/shared/contracts/site-settings';
import { bakeryJsonLd, jsonLdScriptText } from '@/lib/shared/seo/json-ld';
import { INDEXABLE_ROUTES } from '@/lib/shared/seo/public-routes';

const ORIGIN = 'https://yuval-bakery-dev.netlify.app';
const site = { ...EMPTY_SITE_SETTINGS, business_name: 'Test Bakery', business_phone: '050-1234567', business_address: '1 Example St, Tel Aviv' };

describe('bakeryJsonLd', () => {
  it('is a Bakery built only from the settings', () => {
    const ld = bakeryJsonLd(site, ORIGIN)!;
    expect(ld['@type']).toBe('Bakery');
    expect(ld.name).toBe('Test Bakery');
    expect(ld.telephone).toBe('050-1234567');
    expect(ld.address).toEqual({ '@type': 'PostalAddress', streetAddress: '1 Example St, Tel Aviv', addressCountry: 'IL' });
    expect(ld.url).toBe(`${ORIGIN}/`);
  });
  it('omits every field that is unset, and emits nothing without a name', () => {
    const ld = bakeryJsonLd({ ...EMPTY_SITE_SETTINGS, business_name: 'Test Bakery', business_phone: '  ' }, ORIGIN)!;
    expect(ld).not.toHaveProperty('telephone');
    expect(ld).not.toHaveProperty('email');
    expect(ld).not.toHaveProperty('address');
    expect(bakeryJsonLd(EMPTY_SITE_SETTINGS, ORIGIN)).toBeNull();
  });
  it('escapes < so data cannot close the script tag', () => {
    const text = jsonLdScriptText({ name: '</script><b>' });
    expect(text).not.toContain('<');
    expect(JSON.parse(text).name).toBe('</script><b>');
  });
});

describe('public routes', () => {
  it('lists exactly the indexable pages, none of the private ones', () => {
    const paths = INDEXABLE_ROUTES.map((r) => r.path);
    expect(paths).toEqual(['/', '/custom-cake', '/business', '/privacy', '/terms', '/returns', '/accessibility']);
    for (const bad of ['/admin', '/checkout', '/order', '/account', '/register', '/unsubscribe', '/find-order']) {
      expect(paths.some((p) => p.startsWith(bad))).toBe(false);
    }
  });
  it('every route has a description in both locales, and they are unique', () => {
    for (const m of [en, he]) {
      const d = m.seo.description as Record<string, string>;
      for (const r of INDEXABLE_ROUTES) expect(d[r.key], r.key).toBeTruthy();
      expect(d.find_order).toBeTruthy();
      expect(new Set(Object.values(d)).size).toBe(Object.values(d).length);
    }
  });
});

describe('robots.txt and sitemap.xml per APP_ENV', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x'.repeat(30),
      SUPABASE_SERVICE_ROLE_KEY: 'y'.repeat(30),
      SITE_URL: 'https://yuval-bakery.netlify.app/',
    });
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('dev and local disallow everything and name no sitemap', async () => {
    for (const env of ['dev', 'local']) {
      vi.resetModules();
      process.env.APP_ENV = env;
      const robots = (await import('@/app/robots')).default();
      expect(robots.rules).toEqual({ userAgent: '*', disallow: ['/'] });
      expect(robots.sitemap).toBeUndefined();
    }
  });
  it('prod allows the site, keeps /admin and /api out, and points at the sitemap', async () => {
    process.env.APP_ENV = 'prod';
    const robots = (await import('@/app/robots')).default();
    expect(robots.rules).toEqual({ userAgent: '*', allow: '/', disallow: ['/admin', '/api'] });
    expect(robots.sitemap).toBe('https://yuval-bakery.netlify.app/sitemap.xml');
  });
  it('the sitemap has absolute URLs on SITE_URL for the indexable routes only', async () => {
    process.env.APP_ENV = 'prod';
    const urls = (await import('@/app/sitemap')).default().map((e) => e.url);
    expect(urls).toEqual(INDEXABLE_ROUTES.map((r) => (r.path === '/' ? 'https://yuval-bakery.netlify.app/' : `https://yuval-bakery.netlify.app${r.path}`)));
  });
});

describe('JsonLd component', () => {
  it('renders one ld+json script with the request nonce and parseable JSON', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({ headers: async () => new Headers({ 'x-nonce': 'abc123' }) }));
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { JsonLd } = await import('@/components/seo/JsonLd');
    const html = renderToStaticMarkup(await JsonLd({ data: bakeryJsonLd(site, ORIGIN)! }));
    expect(html).toMatch(/^<script type="application\/ld\+json" nonce="abc123">/);
    const body = /<script[^>]*>([\s\S]*)<\/script>/i.exec(html)![1]!;
    expect(JSON.parse(body)['@type']).toBe('Bakery');
    vi.doUnmock('next/headers');
  });
});
