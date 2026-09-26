// @ts-check
// docs-001: the screenshots in docs/guide-yuval/, taken from the local stack
// with synthetic data (no real customer). Not a regression test: run it by hand
// when a screen in the guide changes, then look at every picture.
//   npm run stack:up && npm run build
//   npx playwright test -c qa/playwright.config.js --project=docs
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');
const { randomIp, totp } = require('./helpers/admin-ui');

const OUT = join(__dirname, '..', '..', '..', 'docs', 'guide-yuval', 'img');
const ORIGIN = 'http://localhost:3100';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
/** Scroll so `locator` sits just under the top bar (full-page shots put the fixed tab bar mid-page). */
async function top(page, locator, offset = 90) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate((o) => window.scrollBy(0, -o), offset);
}

test('guide screenshots', async ({ page, request }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const env = localEnv();
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // synthetic data: a day three days out with room, two products, a zone, two orders, a cake request
  const setup = await db.withClient(async (c) => {
    const today = (await c.query(`SELECT fn_business_date(now())::text AS d`)).rows[0].d;
    const plus = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const day = plus(3);
    await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 480, 360)
                   ON CONFLICT (day) DO UPDATE SET oven_minutes_total = capacity_day_ledger.oven_minutes_reserved + 480,
                                                   work_minutes_total = capacity_day_ledger.work_minutes_reserved + 360`, [day]);
    const cakeDay = plus(6);
    await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 480, 360)
                   ON CONFLICT (day) DO UPDATE SET oven_minutes_total = capacity_day_ledger.oven_minutes_reserved + 480,
                                                   work_minutes_total = capacity_day_ledger.work_minutes_reserved + 360`, [cakeDay]);
    await c.query(`DELETE FROM custom_cake_requests WHERE requester_name = 'מיכל אברהם' AND status = 'pending_review'`);
    const product = async (name, price, oven, work) => (await c.query(
      `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_confirmed, photo_alt, is_available, is_published)
       VALUES ($1, $2, 'per_unit', $3, $4, ARRAY['gluten','eggs','milk'], true, $1, true, true) RETURNING id`, [name, price, oven, work])).rows[0].id;
    const cake = await product('עוגת שוקולד', 120, 60, 30);
    const pie = await product('פאי תפוחים', 85, 45, 20);
    // a city name without a test tag, so the picture reads naturally (local DB only)
    const city = 'רמת השרון';
    await c.query(`DELETE FROM delivery_zone_cities WHERE city = $1`, [city]);
    await c.query(`DELETE FROM delivery_zones z WHERE z.name = 'אזור מרכז' AND NOT EXISTS (SELECT 1 FROM delivery_zone_cities c WHERE c.zone_id = z.id)`);
    const zone = (await c.query(`INSERT INTO delivery_zones (name, fee_displayed) VALUES ('אזור מרכז', 25) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO delivery_zone_cities (zone_id, city) VALUES ($1, $2)`, [zone, city]);
    const slot = (await c.query(`SELECT id::text FROM time_slots WHERE is_active ORDER BY start_time DESC LIMIT 1`)).rows[0].id;
    return { day, cakeDay, cake, pie, zone, city, slot };
  });

  const order = async (over) => {
    const res = await request.post('/api/orders', {
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-nf-client-connection-ip': randomIp() },
      data: { day: setup.day, slotId: setup.slot, phone: `05${crypto.randomInt(20000000, 99999999)}`, ...over },
    });
    expect(res.status(), await res.text()).toBe(201);
    const { token } = await res.json();
    return db.withClient(async (c) => (await c.query(`SELECT id, order_number FROM orders WHERE lookup_token_hash = $1`, [sha256(token)])).rows[0]);
  };
  const delivery = await order({ items: [{ productId: setup.cake, quantity: 1 }], fulfillment: 'delivery', city: setup.city, address: 'הרימונים 12', name: 'דנה לוי' });
  await order({ items: [{ productId: setup.pie, quantity: 2 }], fulfillment: 'pickup', name: 'יוסי כהן' });
  const cakeRes = await request.post('/api/custom-cake-requests', {
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-nf-client-connection-ip': randomIp() },
    data: { name: 'מיכל אברהם', phone: `05${crypto.randomInt(20000000, 99999999)}`, inscription: 'מזל טוב נועה', notes: 'שכבות שוקולד ותות', desiredDate: setup.cakeDay, uploadRightsConfirmed: true, whatsappFollowupOk: true, photos: [] },
  });
  expect(cakeRes.status(), await cakeRes.text()).toBe(201);

  // Yuval's admin, with a known address so the login picture reads naturally
  const email = 'yuval@example.test';
  await db.withClient(async (c) => {
    for (const r of (await c.query('SELECT id FROM auth.users WHERE email = $1', [email])).rows) {
      await c.query('DELETE FROM admins WHERE id = $1', [r.id]);
      await service.auth.admin.deleteUser(r.id);
    }
  });
  const password = crypto.randomBytes(18).toString('base64url');
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  await db.withClient((c) => c.query('INSERT INTO admins (id, display_name) VALUES ($1, $2)', [created.data.user?.id, 'יובל']));
  const enrolClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await enrolClient.auth.signInWithPassword({ email, password });
  const factor = (await enrolClient.auth.mfa.enroll({ factorType: 'totp' })).data;
  await enrolClient.auth.mfa.challengeAndVerify({ factorId: factor?.id ?? '', code: totp(factor?.totp.secret ?? '') });

  // 1. login
  await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
  await page.goto('/admin/login');
  await page.getByLabel('אימייל').fill(email);
  await page.getByLabel('סיסמה').fill('xxxxxxxxxxxx');
  await shot(page, '01-login');
  await page.getByLabel('סיסמה').fill(password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await page.waitForURL('**/admin/login/verify');
  await page.getByLabel('קוד בן 6 ספרות').fill('123456');
  await shot(page, '02-code');
  await page.getByLabel('קוד בן 6 ספרות').fill(totp(factor?.totp.secret ?? ''));
  await page.getByRole('button', { name: 'אישור' }).click();
  await page.waitForURL('**/admin/orders');

  // 2. products (not built yet)
  await page.goto('/admin/catalog');
  await shot(page, '03-products');

  // 3. capacity of one day, 4. weekly pattern
  await page.goto(`/admin/capacity?day=${setup.day}`);
  await shot(page, '04-day');
  await top(page, page.getByRole('heading', { name: 'דפוס שבועי' }), 20);
  await shot(page, '05-weekly-pattern');

  // 5. orders: the list, mark paid, WhatsApp
  await page.goto('/admin/orders');
  const card = page.locator('article, li').filter({ hasText: delivery.order_number }).first();
  await top(page, card, 20);
  await shot(page, '06-orders');
  await card.getByRole('button', { name: 'סימון כשולמה' }).click();
  await top(page, page.getByText('לפני שמסמנים כשולמה'), 60);
  await shot(page, '07-mark-paid');
  await page.getByRole('button', { name: 'כן, התשלום הגיע' }).click();
  const done = page.getByText('סומנה כשולמה').first();
  await expect(done).toBeVisible();
  await top(page, done, 120);
  await shot(page, '08-paid');

  // 6. custom cake request: price and minutes, approve, WhatsApp
  await page.goto('/admin/custom-cakes');
  const cakeCard = page.locator('article').filter({ hasText: 'מיכל אברהם' }).first();
  await shot(page, '09-cake-request');
  await cakeCard.getByLabel('מחיר (₪)').fill('350');
  await cakeCard.getByLabel('דקות תנור').fill('90');
  await cakeCard.getByLabel('דקות עבודה').fill('60');
  await expect(cakeCard.getByText('נכנס.')).toBeVisible();
  await top(page, cakeCard.getByLabel('מחיר (₪)'), 120);
  await shot(page, '10-cake-price');
  await cakeCard.getByRole('button', { name: 'אישור ויצירת הזמנה' }).click();
  await expect(page.getByText('אושר.').first()).toBeVisible();
  await top(page, page.getByText('אושר.').first(), 60);
  await shot(page, '11-cake-approved');

  // 7. delivery list of the day and printing
  await page.goto(`/admin/delivery?day=${setup.day}`);
  await shot(page, '12-delivery-list');

  // leave the local catalog as it was
  await db.withClient((c) => c.query('UPDATE products SET is_published = false WHERE id = ANY($1::uuid[])', [[setup.cake, setup.pie]]));
});
