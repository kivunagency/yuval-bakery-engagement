// @ts-check
// Regression: catalog domain (api-001 public catalog, api-002 public day
// states, client-001 catalog screen). Runs against a local production build
// and the local stack (npm run stack:up). Test rows are created with the
// postgres superuser directly (setup only) and removed afterwards; every
// assertion goes through the same path a customer uses (HTTP or the browser).
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { localEnv } = require('./helpers/env');

async function withDb(fn) {
  const db = new Client({ connectionString: localEnv().DATABASE_URL_TEST });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Insert a product (published unless told otherwise) and return its id. */
async function insertProduct(db, over = {}) {
  const p = {
    id: randomUUID(),
    name: `QA product ${randomUUID().slice(0, 8)}`,
    price: 50,
    oven: 10,
    work: 10,
    allergens: ['gluten'],
    mayContain: [],
    available: true,
    published: true,
    deleted: false,
    ...over,
  };
  await db.query(
    `INSERT INTO products (id, name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, ingredients,
       allergens, allergens_may_contain, allergens_confirmed, photo_alt, is_available, is_published, deleted_at)
     VALUES ($1, $2, $3, 'per_unit', $4, $5, 'QA ingredients', $6, $7, true, 'QA alt', $8, $9, CASE WHEN $10 THEN now() END)`,
    [p.id, p.name, p.price, p.oven, p.work, p.allergens, p.mayContain, p.available, p.published, p.deleted],
  );
  return p;
}

async function deleteProducts(db, ids) {
  await db.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [ids]);
}

test.describe('api-001: GET /api/catalog', () => {
  test('published products only; paused shown as unavailable; unpublished and deleted absent', async ({ request }) => {
    const made = await withDb(async (db) => ({
      live: await insertProduct(db),
      paused: await insertProduct(db, { available: false }),
      draft: await insertProduct(db, { published: false }),
      deleted: await insertProduct(db, { deleted: true }),
    }));
    try {
      const res = await request.get('/api/catalog');
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('no-store');
      const body = await res.json();
      const byId = new Map(body.products.map((p) => [p.id, p]));
      expect(byId.get(made.live.id)?.isAvailable).toBe(true);
      expect(byId.get(made.paused.id)?.isAvailable).toBe(false);
      expect(byId.has(made.draft.id)).toBe(false);
      expect(byId.has(made.deleted.id)).toBe(false);
    } finally {
      await withDb((db) => deleteProducts(db, Object.values(made).map((p) => p.id)));
    }
  });

  test('never exposes time cost (oven/work minutes) or internal columns', async ({ request }) => {
    const text = await (await request.get('/api/catalog')).text();
    expect(text).not.toMatch(/minutes|oven|work_|cost_basis|is_published|deleted_at/i);
  });

  test('contains vs may-contain allergens, ingredients and price come through', async ({ request }) => {
    const p = await withDb((db) => insertProduct(db, { price: 123.5, allergens: ['gluten', 'eggs'], mayContain: ['nuts'] }));
    try {
      const body = await (await request.get('/api/catalog')).json();
      const got = body.products.find((x) => x.id === p.id);
      expect(got).toMatchObject({ price: 123.5, allergens: ['gluten', 'eggs'], mayContain: ['nuts'], ingredients: 'QA ingredients' });
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('photo URL is built from storage_path (public product-photos bucket), ordered, alt falls back to photo_alt', async ({ request }) => {
    const env = localEnv();
    const p = await withDb(async (db) => {
      const prod = await insertProduct(db);
      await db.query(
        `INSERT INTO product_photos (product_id, storage_path, alt_text, position) VALUES
           ($1, 'qa/second.webp', 'second photo', 2), ($1, 'qa/first.webp', NULL, 1), ($1, '../escape.webp', 'bad', 3)`,
        [prod.id],
      );
      return prod;
    });
    try {
      const body = await (await request.get('/api/catalog')).json();
      const got = body.products.find((x) => x.id === p.id);
      expect(got.photos).toEqual([
        { url: `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-photos/qa/first.webp`, alt: 'QA alt' },
        { url: `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-photos/qa/second.webp`, alt: 'second photo' },
      ]);
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('vatStatus follows app_settings.vat_status', async ({ request }) => {
    const before = await withDb(async (db) => (await db.query(`SELECT value FROM app_settings WHERE key = 'vat_status'`)).rows[0].value);
    try {
      await withDb((db) => db.query(`UPDATE app_settings SET value = '"licensed"' WHERE key = 'vat_status'`));
      expect((await (await request.get('/api/catalog')).json()).vatStatus).toBe('licensed');
      await withDb((db) => db.query(`UPDATE app_settings SET value = '"exempt"' WHERE key = 'vat_status'`));
      expect((await (await request.get('/api/catalog')).json()).vatStatus).toBe('exempt');
    } finally {
      await withDb((db) => db.query(`UPDATE app_settings SET value = $1 WHERE key = 'vat_status'`, [JSON.stringify(before)]));
    }
  });
});

