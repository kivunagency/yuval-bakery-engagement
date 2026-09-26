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

/** Insert a product (published unless told otherwise; a deleted one is never published, CHECK products_deleted_not_published) and return its id. */
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
     VALUES ($1, $2, $3, 'per_unit', $4, $5, 'QA ingredients', $6, $7, true, 'QA alt', $8, $9 AND NOT $10, CASE WHEN $10 THEN now() END)`,
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

  test('photo URL is built from storage_path (public product-photos bucket), ordered, each photo with its own alt text', async ({ request }) => {
    const env = localEnv();
    const p = await withDb(async (db) => {
      const prod = await insertProduct(db);
      await db.query(
        `INSERT INTO product_photos (product_id, storage_path, alt_text, position) VALUES
           ($1, 'qa/second.webp', 'second photo', 2), ($1, 'qa/first.webp', 'first photo', 1), ($1, '../escape.webp', 'bad', 3)`,
        [prod.id],
      );
      return prod;
    });
    try {
      const body = await (await request.get('/api/catalog')).json();
      const got = body.products.find((x) => x.id === p.id);
      expect(got.photos).toEqual([
        { url: `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-photos/qa/first.webp`, alt: 'first photo' },
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
      // Today is always too_soon. Tomorrow is too_soon while its first slot
      // (earliest_slot_time, kept equal to the first active time slot by
      // api-003) is less than 24h away, so the expectation depends on the clock.
      const tomorrowTooSoon = await withDb(async (db) => (await db.query(
        `SELECT (($1::date + (SELECT value #>> '{}' FROM app_settings WHERE key = 'earliest_slot_time')::time)
                  AT TIME ZONE 'Asia/Jerusalem') < now() + interval '24 hours' AS s`, [plusDays(today, 1)])).rows[0].s);
      const near = await (await request.get(`/api/capacity?from=${today}&to=${plusDays(today, 1)}`)).json();
      expect(near.days[0].state).toBe('too_soon');
      if (tomorrowTooSoon) expect(near.days[1].state).toBe('too_soon');
      else expect(near.days[1].state).not.toBe('too_soon');

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
                `SELECT fn_create_standard_order($1, NULL, 'QA', $2, NULL, 'pickup', $3,
                   (SELECT id FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1), NULL, NULL, NULL,
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

// ---------------------------------------------------------------------------
// client-001: the catalog screen at `/`. Days inside the 14-day strip are
// changed for a test and restored afterwards.
// ---------------------------------------------------------------------------

const { join } = require('node:path');
const SCREENS = join(__dirname, '..', 'test-results', 'screens');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Run fn with some strip days reshaped; the ledger rows are restored after. */
async function withDays(offsets, shape, fn) {
  const { days, saved } = await withDb(async (db) => {
    const today = await jerusalemToday(db);
    const ds = offsets.map((o) => plusDays(today, o));
    const rows = (await db.query('SELECT * FROM capacity_day_ledger WHERE day = ANY($1::date[])', [ds])).rows;
    for (const [i, d] of ds.entries()) await setDay(db, d, shape[i]);
    return { days: ds, saved: rows };
  });
  try {
    return await fn(days);
  } finally {
    await withDb(async (db) => {
      await db.query('DELETE FROM capacity_day_ledger WHERE day = ANY($1::date[])', [days]);
      for (const r of saved)
        await setDay(db, r.day, {
          oven: r.oven_minutes_total, work: r.work_minutes_total, ovenRes: r.oven_minutes_reserved, workRes: r.work_minutes_reserved,
          ovenUnpaid: r.oven_minutes_unpaid_reserved, workUnpaid: r.work_minutes_unpaid_reserved, blackout: r.is_blackout,
        });
    });
  }
}

test.describe('client-001: catalog screen', () => {
  test('first frame is server-rendered with products and day states (no client fetch needed)', async ({ request }) => {
    const p = await withDb((db) => insertProduct(db));
    try {
      const html = await (await request.get('/')).text();
      expect(html).toContain(p.name);
      expect(html).toMatch(/role="radiogroup"/);
      expect(html).toMatch(/data-state="too_soon"/);
      expect(html).not.toMatch(/minutes|oven_|work_/);
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('the page makes no request to /api/* or PostgREST from the browser', async ({ page }) => {
    const calls = [];
    page.on('request', (r) => {
      if (/\/api\/|\/rest\/v1\//.test(r.url())) calls.push(r.url());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(calls).toEqual([]);
  });

  test('full and closed days differ in word, colour and texture, and are not selectable', async ({ page }) => {
    await withDays([9, 10], [{ ovenRes: 100, workRes: 10 }, { blackout: true }], async ([fullDay, closedDay]) => {
      await page.goto('/');
      const full = page.locator(`[data-day="${fullDay}"]`);
      const closed = page.locator(`[data-day="${closedDay}"]`);
      await expect(full).toHaveAttribute('data-state', 'full');
      await expect(closed).toHaveAttribute('data-state', 'closed');
      await expect(full).toContainText('מלא');
      await expect(closed).toContainText('סגור');
      await expect(full).toHaveAttribute('aria-disabled', 'true');
      await expect(closed).toHaveAttribute('aria-disabled', 'true');
      await expect(full).toHaveAttribute('aria-label', /אין מקום בתנור/);
      await expect(closed).toHaveAttribute('aria-label', /יום חופש/);
      const bg = (l) => l.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage]);
      const [fullColor, fullImage] = await bg(full);
      const [, closedImage] = await bg(closed);
      expect(fullImage).toBe('none');
      expect(closedImage).toContain('repeating-linear-gradient');
      expect(fullColor).not.toBe('rgba(0, 0, 0, 0)');
      await full.click({ force: true });
      await expect(full).toHaveAttribute('aria-checked', 'false');
    });
  });

  test('picking a day marks what does not fit (DB answer), says from when it fits, and keeps it in the URL', async ({ page }) => {
    const big = await withDb((db) => insertProduct(db, { oven: 50, work: 50 }));
    try {
      // day 11: 60/60, so a 50-minute product breaks the 35% single-order cap; day 12: roomy.
      await withDays([11, 12], [{ oven: 60, work: 60 }, { oven: 300, work: 300 }], async ([small, roomy]) => {
        await page.goto('/');
        await page.locator(`[data-day="${small}"]`).click();
        await expect(page.locator(`[data-day="${small}"]`)).toHaveAttribute('aria-checked', 'true');
        await expect(page).toHaveURL(new RegExp(`day=${small}`));
        const card = page.locator(`[data-product-id="${big.id}"]`);
        await expect(card).toHaveAttribute('data-blocked', 'does_not_fit');
        const [, m, d] = roomy.split('-').map(Number);
        await expect(card.locator('p').first()).toContainText(`לא נכנס ביום`);
        await expect(card.locator('p').first()).toContainText(`פנוי מיום`);
        await expect(card.locator('p').first()).toContainText(`${d}.${m}`);
        await expect(card.getByRole('button')).toBeDisabled();
        await expect(card.getByRole('button')).toHaveText('לא זמין');
        await expect(page.getByTestId('filterline')).toContainText('מוצג מה שנכנס לתנור של');
        await page.screenshot({ path: join(SCREENS, 'catalog-day-selected.png'), fullPage: true });

        await page.locator(`[data-day="${roomy}"]`).click();
        await expect(card).toHaveAttribute('data-blocked', 'none');

        await page.goto(`/?day=${small}`);
        await expect(page.locator(`[data-day="${small}"]`)).toHaveAttribute('aria-checked', 'true');
        await expect(card).toHaveAttribute('data-blocked', 'does_not_fit');
      });
    } finally {
      await withDb((db) => deleteProducts(db, [big.id]));
    }
  });

  test('sold-out product stays listed, greyed, with a disabled button', async ({ page }) => {
    const p = await withDb((db) => insertProduct(db, { available: false }));
    try {
      await page.goto('/');
      const card = page.locator(`[data-product-id="${p.id}"]`);
      await expect(card).toHaveAttribute('data-blocked', 'out_of_stock');
      await expect(card).toContainText('אזל השבוע');
      await expect(card.getByRole('button')).toBeDisabled();
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('allergens always visible: solid "contains" chips and dashed "may contain" chips', async ({ page }) => {
    const p = await withDb((db) => insertProduct(db, { allergens: ['gluten', 'eggs'], mayContain: ['nuts'] }));
    try {
      await page.goto('/');
      const chips = page.locator(`[data-product-id="${p.id}"]`).getByRole('list', { name: 'אלרגנים' }).getByRole('listitem');
      await expect(chips).toHaveText(['גלוטן', 'ביצים', 'עלול להכיל אגוזים']);
      await expect(chips.nth(2)).toBeVisible();
      expect(await chips.nth(0).evaluate((el) => getComputedStyle(el).borderStyle)).toBe('solid');
      expect(await chips.nth(2).evaluate((el) => getComputedStyle(el).borderStyle)).toBe('dashed');
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('add needs a day first; then the cart holds the line and its day (sessionStorage)', async ({ page }) => {
    const p = await withDb((db) => insertProduct(db));
    try {
      await withDays([12], [{ oven: 300, work: 300 }], async ([day]) => {
        await page.goto('/');
        const add = page.locator(`[data-product-id="${p.id}"]`).getByRole('button', { name: /הוספה/ });
        await add.click();
        await expect(page.getByTestId('need-day')).toHaveText('קודם בוחרים יום, ואז מוסיפים לסל.');
        await page.locator(`[data-day="${day}"]`).click();
        await expect(page.getByTestId('need-day')).toHaveCount(0);
        await add.click();
        await add.click();
        await expect(page.getByTestId('cart-button')).toHaveAttribute('aria-label', 'סל, 2 פריטים');
        await expect(page.locator('main [role="status"]')).toHaveText(`${p.name} נוסף לסל`);
        const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('yb.cart.v1') ?? 'null'));
        expect(stored).toEqual({ day, lines: [{ productId: p.id, quantity: 2 }] });
      });
    } finally {
      await withDb((db) => deleteProducts(db, [p.id]));
    }
  });

  test('keyboard: the strip is one tab stop and the arrow keys move between selectable days', async ({ page }) => {
    await page.goto('/');
    const radios = page.getByRole('radio');
    const enabled = await radios.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-disabled') !== 'true').map((e) => e.dataset.day));
    expect(enabled.length).toBeGreaterThan(1);
    await page.locator(`[data-day="${enabled[0]}"]`).focus();
    await page.keyboard.press('ArrowLeft'); // RTL: next day is to the left
    await expect(page.locator(`[data-day="${enabled[1]}"]`)).toBeFocused();
    await expect(page.locator(`[data-day="${enabled[1]}"]`)).toHaveAttribute('aria-checked', 'true');
    expect(await radios.evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length)).toBe(1);
  });

  test('product photo: rendered from the server-built Storage URL with Yuval alt text; placeholder when none', async ({ page }) => {
    // Storage is not in the local stack: the browser request is answered here.
    // Real serving from the product-photos bucket is DID NOT RUN.
    const p = await withDb(async (db) => {
      const prod = await insertProduct(db);
      await db.query(`INSERT INTO product_photos (product_id, storage_path, alt_text, position) VALUES ($1, 'qa/p.png', 'עוגה לבדיקה', 0)`, [prod.id]);
      return prod;
    });
    const bare = await withDb((db) => insertProduct(db));
    try {
      await page.route('**/storage/v1/object/public/product-photos/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG_1PX }));
      await page.goto('/');
      const img = page.locator(`[data-product-id="${p.id}"] img`);
      await expect(img).toHaveAttribute('alt', 'עוגה לבדיקה');
      await expect(img).toHaveAttribute('src', /\/storage\/v1\/object\/public\/product-photos\/qa\/p\.png$/);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(1);
      await expect(page.locator(`[data-product-id="${bare.id}"]`)).toContainText('תמונה תגיע בקרוב');
    } finally {
      await withDb((db) => deleteProducts(db, [p.id, bare.id]));
    }
  });

  test('390px screenshots, light and dark, for the rendered-Hebrew check', async ({ page }) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(SCREENS, `catalog-${scheme}.png`), fullPage: true });
    }
  });
});
