// @ts-check
// Regression: public-site SEO baseline (Rule 33, SEO/AEO by default).
// robots.txt and sitemap.xml per APP_ENV, one canonical + Open Graph + Twitter
// card per public route, JSON-LD Bakery on the home page, no JSON-LD or index
// leak on DEV. Uses plain HTTP requests (no browser), against two servers of
// the same build started here: APP_ENV=prod and APP_ENV=dev.
//
// DB: robots, sitemap and every page except `/` render without a database
// (site settings fall back to empty and the failure is logged). `/` fetches
// the catalog, so the JSON-LD test needs the local stack and reports
// DID NOT RUN (by name) when `/` does not answer 200.
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { localEnv } = require('./helpers/env');

const PROD_PORT = Number(process.env.SEO_PROD_PORT || 3103);
const DEV_PORT = Number(process.env.SEO_DEV_PORT || 3104);
const PROD_URL = 'https://yuval-bakery.netlify.app';
const DEV_URL = 'https://yuval-bakery-dev.netlify.app';

function baseEnv() {
  try {
    return localEnv();
  } catch {
    // No local stack: dummy values are enough for the pages that do not read the DB.
    return {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x'.repeat(30),
      SUPABASE_SERVICE_ROLE_KEY: 'y'.repeat(30),
    };
  }
}

/** @type {import('node:child_process').ChildProcess[]} */
const servers = [];

async function start(port, appEnv, siteUrl) {
  const child = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, ...baseEnv(), APP_ENV: appEnv, SITE_URL: siteUrl },
    stdio: 'ignore',
    detached: true,
  });
  servers.push(child);
  let lastError;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://localhost:${port}/robots.txt`)).status < 500) return;
    } catch (err) {
      lastError = err; // not listening yet; reported below if it never starts
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server on ${port} did not start`, { cause: lastError });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await Promise.all([start(PROD_PORT, 'prod', PROD_URL), start(DEV_PORT, 'dev', DEV_URL)]);
});

test.afterAll(() => {
  for (const s of servers) if (s.pid) process.kill(-s.pid, 'SIGTERM');
});

const ROUTES = ['/', '/custom-cake', '/find-order', '/business', '/privacy', '/terms', '/returns', '/accessibility'];
const SITEMAP_PATHS = ['/', '/custom-cake', '/business', '/privacy', '/terms', '/returns', '/accessibility'];

const tag = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const meta = (html, attr, name) =>
  tag(html, new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`, 'g')).concat(tag(html, new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`, 'g')));

test.describe('robots.txt and sitemap.xml', () => {
  test('PROD allows indexing, keeps /admin and /api out, names the sitemap', async ({ request }) => {
    const res = await request.get(`http://localhost:${PROD_PORT}/robots.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/User-Agent: \*/i);
    expect(body).toMatch(/^Allow: \/$/m);
    expect(body).toMatch(/^Disallow: \/admin$/m);
    expect(body).toMatch(/^Disallow: \/api$/m);
    expect(body).not.toMatch(/^Disallow: \/$/m);
    expect(body).toContain(`Sitemap: ${PROD_URL}/sitemap.xml`);
  });

  test('DEV disallows everything so it is never indexed', async ({ request }) => {
    const res = await request.get(`http://localhost:${DEV_PORT}/robots.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^Disallow: \/$/m);
    expect(body).not.toMatch(/^Allow:/m);
    expect(body).not.toMatch(/Sitemap:/);
  });

  test('the sitemap lists every indexable page on SITE_URL and no private one', async ({ request }) => {
    for (const [port, origin] of [[PROD_PORT, PROD_URL], [DEV_PORT, DEV_URL]]) {
      const res = await request.get(`http://localhost:${port}/sitemap.xml`);
      expect(res.status()).toBe(200);
      const locs = tag(await res.text(), /<loc>([^<]*)<\/loc>/g);
      expect(locs).toEqual(SITEMAP_PATHS.map((p) => (p === '/' ? `${origin}/` : `${origin}${p}`)));
      for (const bad of ['/admin', '/checkout', '/order/', '/account', '/register', '/unsubscribe', '/find-order']) {
        expect(locs.some((l) => l.includes(bad)), bad).toBe(false);
      }
    }
  });
});

test.describe('per-route metadata', () => {
  for (const path of ROUTES.filter((p) => p !== '/')) {
    test(`${path}: one canonical, og:title, og:description, twitter:card, unique description`, async ({ request }) => {
      const res = await request.get(`http://localhost:${PROD_PORT}${path}`);
      expect(res.status()).toBe(200);
      const html = await res.text();
      const canonicals = tag(html, /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/g);
      expect(canonicals).toEqual([`${PROD_URL}${path}`]);
      expect(meta(html, 'property', 'og:title')).toHaveLength(1);
      expect(meta(html, 'property', 'og:title')[0]).toBe(tag(html, /<title>([^<]*)<\/title>/g)[0]);
      expect(meta(html, 'property', 'og:description')[0]).toBeTruthy();
      expect(meta(html, 'property', 'og:url')).toEqual([`${PROD_URL}${path}`]);
      expect(meta(html, 'name', 'twitter:card')).toEqual(['summary']);
      expect(meta(html, 'name', 'twitter:title')).toHaveLength(1);
      expect(meta(html, 'name', 'description')).toHaveLength(1);
      expect(html).not.toContain('application/ld+json');
    });
  }

  test('descriptions are unique across public routes', async ({ request }) => {
    const seen = new Map();
    for (const path of ROUTES.filter((p) => p !== '/')) {
      const d = meta(await (await request.get(`http://localhost:${PROD_PORT}${path}`)).text(), 'name', 'description')[0];
      expect(seen.get(d), `${path} repeats the description of ${seen.get(d)}`).toBeUndefined();
      seen.set(d, path);
    }
  });

  test('/find-order stays noindex (its sitemap absence is deliberate)', async ({ request }) => {
    const html = await (await request.get(`http://localhost:${PROD_PORT}/find-order`)).text();
    expect(meta(html, 'name', 'robots')[0]).toMatch(/noindex/);
  });

  test('PROD pages carry no noindex; DEV pages carry noindex', async ({ request }) => {
    const prod = await (await request.get(`http://localhost:${PROD_PORT}/privacy`)).text();
    expect(meta(prod, 'name', 'robots')).toEqual([]);
    const dev = await (await request.get(`http://localhost:${DEV_PORT}/privacy`)).text();
    expect(meta(dev, 'name', 'robots')[0]).toMatch(/noindex/);
  });
});

test.describe('home page', () => {
  test('canonical, social cards and a valid JSON-LD Bakery built from the business settings', async ({ request }) => {
    const res = await request.get(`http://localhost:${PROD_PORT}/`);
    test.skip(res.status() !== 200, `DID NOT RUN: "/" answered ${res.status()}; it reads the catalog, so it needs the local stack (npm run stack:up)`);
    const html = await res.text();
    expect(tag(html, /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/g)).toEqual([`${PROD_URL}/`]);
    expect(meta(html, 'property', 'og:title')).toHaveLength(1);
    expect(meta(html, 'name', 'twitter:card')).toEqual(['summary']);
    const blocks = tag(html, /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
    expect(blocks).toHaveLength(1);
    const ld = JSON.parse(blocks[0]);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Bakery');
    expect(ld.name).toBeTruthy();
    expect(ld.name).not.toMatch(/^\[/); // never the unset placeholder
    expect(ld.url).toBe(`${PROD_URL}/`);
    // the script carries the CSP nonce of this very response
    const nonce = /<script[^>]*nonce="([^"]+)"[^>]*type="application\/ld\+json"|<script[^>]*type="application\/ld\+json"[^>]*nonce="([^"]+)"/.exec(html);
    expect(nonce?.[1] ?? nonce?.[2]).toBeTruthy();
    expect(res.headers()['content-security-policy']).toContain(`'nonce-${nonce?.[1] ?? nonce?.[2]}'`);
  });
});
