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


// ---------------------------------------------------------------------------
// api-002: public day availability. Days far ahead (+300 and later) so they
// never meet the seed (+1..+14) or regression.spec.js (+40).
// ---------------------------------------------------------------------------

async function jerusalemToday(db) {
  return (await db.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Jerusalem')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
}
function plusDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function setDay(db, day, { oven = 100, work = 100, ovenRes = 0, workRes = 0, ovenUnpaid = 0, workUnpaid = 0, blackout = false } = {}) {
  await db.query(
    `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, oven_minutes_reserved, work_minutes_reserved,
       oven_minutes_unpaid_reserved, work_minutes_unpaid_reserved, is_blackout)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (day) DO UPDATE SET oven_minutes_total = $2, work_minutes_total = $3, oven_minutes_reserved = $4,
       work_minutes_reserved = $5, oven_minutes_unpaid_reserved = $6, work_minutes_unpaid_reserved = $7, is_blackout = $8`,
    [day, oven, work, ovenRes, workRes, ovenUnpaid, workUnpaid, blackout],
  );
}

test.describe('api-002: GET /api/capacity (public day states)', () => {
  test('state per day: too_soon, closed (no row / blackout / zero total), full, limited, open', async ({ request }) => {
    const { today, base } = await withDb(async (db) => {
      const t = await jerusalemToday(db);
      const b = plusDays(t, 300);
      await db.query('DELETE FROM capacity_day_ledger WHERE day BETWEEN $1::date AND $1::date + 9', [b]);
      await setDay(db, plusDays(b, 1), { blackout: true });
      await setDay(db, plusDays(b, 2), { oven: 0 });
      await setDay(db, plusDays(b, 3), { ovenRes: 100, workRes: 40 }); // oven used up
      await setDay(db, plusDays(b, 4), { ovenRes: 30, workRes: 80 }); // 20% work left < 25%
      await setDay(db, plusDays(b, 5), {}); // untouched
      await setDay(db, plusDays(b, 6), { ovenRes: 70, workRes: 70, ovenUnpaid: 70, workUnpaid: 70 }); // unpaid cap reached: nothing fits
      await setDay(db, plusDays(b, 7), { ovenRes: 75, workRes: 0 }); // exactly 25% left: not limited
      return { today: t, base: b };
    });
    try {
      const near = await (await request.get(`/api/capacity?from=${today}&to=${plusDays(today, 1)}`)).json();
      expect(near.days.map((d) => d.state)).toEqual(['too_soon', 'too_soon']);

      const res = await request.get(`/api/capacity?from=${base}&to=${plusDays(base, 7)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.days.map((d) => [d.day, d.state])).toEqual([
        [base, 'closed'],
        [plusDays(base, 1), 'closed'],
        [plusDays(base, 2), 'closed'],
        [plusDays(base, 3), 'full'],
        [plusDays(base, 4), 'limited'],
        [plusDays(base, 5), 'open'],
        [plusDays(base, 6), 'full'],
        [plusDays(base, 7), 'open'],
      ]);
      for (const d of body.days) expect(Object.keys(d).sort()).toEqual(['day', 'fittingProductIds', 'state']);
      expect(JSON.stringify(body)).not.toMatch(/minutes|oven|work|reserved|total/i);
    } finally {
      await withDb((db) => db.query('DELETE FROM capacity_day_ledger WHERE day BETWEEN $1::date AND $1::date + 9', [base]));
    }
  });

  test('?date= gives one day, default is 14 days from today (Asia/Jerusalem), bad input is 400', async ({ request }) => {
    const today = await withDb(jerusalemToday);
    const one = await (await request.get(`/api/capacity?date=${plusDays(today, 5)}`)).json();
    expect(one.days).toHaveLength(1);
    expect(one.days[0].day).toBe(plusDays(today, 5));

    const def = await (await request.get('/api/capacity')).json();
    expect(def.days).toHaveLength(14);
    expect(def.days[0].day).toBe(today);

    for (const q of ['date=2026-02-30', 'from=nope', `date=${today}&from=${today}`]) {
      const r = await request.get(`/api/capacity?${q}`);
      expect(r.status(), q).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_query' });
    }
    const tooLong = await request.get(`/api/capacity?from=${today}&to=${plusDays(today, 63)}`);
    expect(tooLong.status()).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'day_range_invalid' });
    const reversed = await request.get(`/api/capacity?from=${plusDays(today, 3)}&to=${today}`);
    expect(reversed.status()).toBe(400);
  });

  test('anon cannot read the ledger minutes or call the internal helpers through PostgREST', async ({ request }) => {
    const env = localEnv();
    const headers = { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` };
    const table = await request.get(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/capacity_day_ledger?select=*`, { headers });
    expect(table.ok()).toBe(false);
    expect(await table.text()).toContain('permission denied');
    for (const [fn, args] of [
      ['fn_capacity_fits', { p_day: '2027-01-01', p_oven: 1, p_work: 1 }],
      ['fn_day_too_soon', { p_day: '2027-01-01' }],
    ]) {
      const r = await request.post(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${fn}`, { headers, data: args });
      expect(r.ok(), fn).toBe(false);
    }
    const pub = await request.post(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/fn_public_day_availability`, {
      headers,
      data: { p_from: '2027-01-01', p_to: '2027-01-02' },
    });
    expect(pub.ok()).toBe(true);
  });

  test('fit agrees with the real reservation (fn_create_standard_order) over a matrix of days and costs', async () => {
    // One transaction, rolled back: for every (ledger row, product cost) the
    // DB's public answer "fits" must equal whether a 1-unit checkout succeeds.
    const disagreements = await withDb(async (db) => {
      await db.query('BEGIN');
      try {
        const day = plusDays(await jerusalemToday(db), 320);
        const costs = [[0, 0], [10, 10], [35, 5], [36, 5], [5, 36], [30, 0], [0, 31]];
        const products = [];
        for (const [o, w] of costs) products.push({ ...(await insertProduct(db, { oven: o, work: w })), o, w });
        const rows = [];
        for (const blackout of [false, true])
          for (const r of [0, 40, 69, 70, 95, 100])
            for (const unpaid of [...new Set([0, Math.min(r, 40), Math.min(r, 69), r])])
              rows.push({ ovenRes: r, workRes: Math.max(0, r - 10), ovenUnpaid: unpaid, workUnpaid: Math.min(unpaid, Math.max(0, r - 10)), blackout });
        const out = [];
        let n = 0;
        for (const row of rows) {
          for (const p of products) {
            await setDay(db, day, row);
            const pub = (await db.query('SELECT fitting_product_ids FROM fn_public_day_availability($1, $1)', [day])).rows[0];
            const fits = (await db.query('SELECT fn_capacity_fits($1, $2, $3) AS f', [day, p.o, p.w])).rows[0].f;
            await db.query('SAVEPOINT try_order');
            let ordered = true;
            let reason = '';
            try {
              n += 1;
              await db.query(
                `SELECT fn_create_standard_order($1, NULL, 'QA', $2, NULL, 'pickup', $3, NULL, NULL, NULL, NULL, NULL,
                   $4::jsonb, $5, 'p', 't', 'c')`,
                [`10.9.${Math.floor(n / 250)}.${n % 250}`, `+97250${String(1000000 + n).slice(-7)}`, day,
                  JSON.stringify([{ product_id: p.id, quantity: 1 }]), randomUUID()],
              );
            } catch (e) {
              ordered = false;
              reason = e.message;
            }
            await db.query('ROLLBACK TO SAVEPOINT try_order');
            if (ordered === false && !/day_unavailable|capacity|single_order/.test(reason)) throw new Error(`unexpected refusal: ${reason}`);
            const listed = pub.fitting_product_ids.includes(p.id);
            if (fits !== ordered || listed !== ordered) out.push({ row, cost: [p.o, p.w], fits, listed, ordered, reason });
          }
        }
        expect(n).toBeGreaterThan(100);
        return out;
      } finally {
        await db.query('ROLLBACK');
      }
    });
    expect(disagreements).toEqual([]);
  });
});
