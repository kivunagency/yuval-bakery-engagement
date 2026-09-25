// @ts-check
// Delivery domain regression (api-007 admin zones, client-010, api-008, client-011).
// Real chain: browser session (password + TOTP) -> Next.js route -> PostgREST
// as the admin's own aal2 JWT -> SECURITY DEFINER functions -> audit_log.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { join } = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { createUser, db, uiLogin } = require('./helpers/admin-ui');
const { localEnv } = require('./helpers/env');
const { SCREENS } = require('./helpers/baseline');

/** A short random tag so parallel or repeated runs never share a zone name or a city. */
const tag = () => crypto.randomUUID().slice(0, 6);
/** FSI..PDI: the screen isolates user-typed names inside a sentence. */
const iso = (s) => `\u2068${s}\u2069`;

test.describe('admin delivery zones API (api-007)', () => {
  test('anonymous visitor gets 401 on every verb', async ({ request }) => {
    const id = crypto.randomUUID();
    for (const res of [
      await request.get('/api/admin/delivery-zones'),
      await request.post('/api/admin/delivery-zones', { data: { name: 'x', fee: 1 } }),
      await request.patch(`/api/admin/delivery-zones/${id}`, { data: { fee: 1 } }),
      await request.delete(`/api/admin/delivery-zones/${id}`),
    ]) {
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  test('admin at aal2: create, validate, one zone per city (409 names both), rename clash, patch, deactivate, delete, audited', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const t = tag();
    const [cityA, cityB, cityC] = [`QA עיר א ${t}`, `QA עיר ב ${t}`, `QA עיר ג ${t}`];

    // CSRF: no Origin, or a foreign one.
    expect((await api.post('/api/admin/delivery-zones', { data: { name: `QA ${t}`, fee: 35 } })).status()).toBe(403);
    expect((await api.post('/api/admin/delivery-zones', { headers: { origin: 'https://evil.example' }, data: { name: `QA ${t}`, fee: 35 } })).status()).toBe(403);

    // Zod: fee not whole shekels, negative, over 1000, string; empty name; blank city; unknown key.
    for (const data of [
      { name: `QA ${t}`, fee: 35.5 },
      { name: `QA ${t}`, fee: -1 },
      { name: `QA ${t}`, fee: 1001 },
      { name: `QA ${t}`, fee: '35' },
      { name: '  ', fee: 35 },
      { name: `QA ${t}`, fee: 35, cities: ['   '] },
      { name: `QA ${t}`, fee: 35, isActive: true },
    ]) {
      const r = await api.post('/api/admin/delivery-zones', { headers, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }

    // Create: cities trimmed, inner spaces collapsed, duplicates dropped.
    const created = await api.post('/api/admin/delivery-zones', { headers, data: { name: ` QA מרכז ${t} `, fee: 35, cities: [`  ${cityA.replace(' ', '   ')} `, cityA, cityB] } });
    expect(created.status()).toBe(201);
    const zone = await created.json();
    expect(zone).toEqual({ id: expect.any(String), name: `QA מרכז ${t}`, fee: 35, isActive: true, cities: [cityA, cityB].sort() });

    // A city belongs to at most one zone: 409 that names the city and the zone that has it.
    const clash = await api.post('/api/admin/delivery-zones', { headers, data: { name: `QA צפון ${t}`, fee: 40, cities: [cityC, cityB] } });
    expect(clash.status()).toBe(409);
    expect(await clash.json()).toEqual({ error: 'city_in_other_zone', city: cityB, zoneName: `QA מרכז ${t}` });
    expect(await db('SELECT 1 FROM delivery_zones WHERE name = $1', [`QA צפון ${t}`])).toHaveLength(0); // nothing half-written

    const north = await (await api.post('/api/admin/delivery-zones', { headers, data: { name: `QA צפון ${t}`, fee: 40, cities: [cityC] } })).json();
    const moveInto = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { cities: [cityC, cityA] } });
    expect(moveInto.status()).toBe(409);
    expect(await moveInto.json()).toEqual({ error: 'city_in_other_zone', city: cityA, zoneName: `QA מרכז ${t}` });

    // Zone names are unique, ignoring case and outer spaces.
    const rename = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { name: ` QA מרכז ${t}` } });
    expect(rename.status()).toBe(409);
    expect(await rename.json()).toEqual({ error: 'name_taken' });

    // Patch: fee, then the whole city list (remove B, add C is refused as C is North's; add a new one).
    const fee = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { fee: 45 } });
    expect(fee.status()).toBe(200);
    expect((await fee.json()).fee).toBe(45);
    const cities = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { cities: [cityA, `QA עיר ד ${t}`] } });
    expect((await cities.json()).cities).toEqual([cityA, `QA עיר ד ${t}`].sort());
    expect((await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: {} })).status()).toBe(400);
    expect((await api.patch('/api/admin/delivery-zones/not-a-uuid', { headers, data: { fee: 1 } })).status()).toBe(400);
    const missing = await api.patch(`/api/admin/delivery-zones/${crypto.randomUUID()}`, { headers, data: { fee: 1 } });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    // Deactivate: stays listed for the admin, with its cities.
    const off = await api.patch(`/api/admin/delivery-zones/${zone.id}`, { headers, data: { isActive: false } });
    expect((await off.json()).isActive).toBe(false);
    const list = await (await api.get('/api/admin/delivery-zones')).json();
    expect(list.zones.find((z) => z.id === zone.id)).toEqual({ id: zone.id, name: `QA מרכז ${t}`, fee: 45, isActive: false, cities: [cityA, `QA עיר ד ${t}`].sort() });

    // Delete: the cities go with it and are free for another zone.
    expect((await api.delete(`/api/admin/delivery-zones/${zone.id}`, { headers })).status()).toBe(200);
    expect((await api.delete(`/api/admin/delivery-zones/${zone.id}`, { headers })).status()).toBe(404);
    const freed = await api.patch(`/api/admin/delivery-zones/${north.id}`, { headers, data: { cities: [cityC, cityA] } });
    expect((await freed.json()).cities).toEqual([cityA, cityC].sort());

    // SEC-017: every change audited as this admin, with the previous values.
    const audit = await db("SELECT action, entity_id, metadata FROM audit_log WHERE actor_id = $1 AND action LIKE 'delivery_zone.%' ORDER BY id", [admin.userId]);
    expect(audit.map((a) => a.action)).toEqual([
      'delivery_zone.created', 'delivery_zone.created',
      'delivery_zone.updated', 'delivery_zone.updated', 'delivery_zone.updated',
      'delivery_zone.deleted', 'delivery_zone.updated',
    ]);
    expect(audit[2].metadata).toMatchObject({ fee: 45, previous: { fee: 35 } });
    expect(audit[5].metadata.previous).toMatchObject({ name: `QA מרכז ${t}`, is_active: false });
    await db('DELETE FROM delivery_zones WHERE id = $1', [north.id]);
  });

  test('through PostgREST: no direct table write for anyone; the functions refuse anon and a customer', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.rpc('fn_admin_create_delivery_zone', { p_name: 'x', p_fee: 1, p_cities: [] })).error?.message).toContain('permission denied');
    expect((await anon.from('delivery_zones').insert({ name: `QA anon ${tag()}` })).error).not.toBeNull();

    const customer = await createUser({ admin: false });
    const user = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email: customer.email, password: customer.password });
    expect((await user.rpc('fn_admin_create_delivery_zone', { p_name: 'x', p_fee: 1, p_cities: [] })).error?.message).toBe('admin_aal2_required');
    expect((await user.from('delivery_zones').insert({ name: `QA user ${tag()}` })).error?.message).toContain('permission denied');
    expect((await user.from('delivery_zone_cities').delete().neq('city', '')).error?.message).toContain('permission denied');
  });
});

/** Baseline every admin screen shares (same checks as regression.admin.spec.js), plus a screenshot. */
async function adminBaseline(page, name, errors) {
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('400 16px "IBM Plex Sans Hebrew"'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="switch"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('type') !== 'hidden';
        return visible && (r.width < 44 || r.height < 44);
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
  await page.screenshot({ path: join(SCREENS, `admin-${name}.png`), fullPage: true });
  expect(errors).toEqual([]);
}

function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test.describe('admin delivery zones screen (client-010)', () => {
  test('cards arrive with their data; fee 84px with the shekel sign outside; 44px chips; clear one-zone error; add, remove, fee, off, new, delete', async ({ page, baseURL }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const t = tag();
    const headers = { origin: baseURL ?? '' };
    const center = await (await page.request.post('/api/admin/delivery-zones', { headers, data: { name: `QA מרכז ${t}`, fee: 35, cities: [`רמת גן ${t}`, `גבעתיים ${t}`] } })).json();
    const north = await (await page.request.post('/api/admin/delivery-zones', { headers, data: { name: `QA צפון ${t}`, fee: 45, cities: [`חיפה ${t}`] } })).json();

    // First frame is server-rendered: no call to the zones API on load.
    const apiCalls = [];
    page.on('request', (r) => r.url().includes('/api/admin/delivery-zones') && apiCalls.push(r.url()));
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'אזורי משלוח' })).toBeVisible();
    const card = page.locator(`[data-testid="zone-card"][data-zone="QA מרכז ${t}"]`);
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(`QA מרכז ${t}`);
    await expect(card.getByRole('listitem').filter({ hasText: `רמת גן ${t}` })).toBeVisible();
    await expect(card.getByText('עיר יכולה להיות רק באזור אחד.')).toBeVisible();
    expect(apiCalls).toEqual([]);

    // Fee field: 84px wide, 44px high, the shekel sign outside it, on its inline-end side (the left in RTL).
    const fee = card.getByRole('textbox', { name: `דמי משלוח לQA מרכז ${t} בשקלים` });
    await expect(fee).toHaveValue('35');
    const feeBox = await fee.boundingBox();
    expect([Math.round(feeBox?.width ?? 0), Math.round(feeBox?.height ?? 0)]).toEqual([84, 44]);
    const shekelBox = await card.locator('.admin-zone-fee > span').first().boundingBox();
    expect((shekelBox?.x ?? 0) + (shekelBox?.width ?? 0)).toBeLessThanOrEqual(feeBox?.x ?? 0);
    // Chips: 44px high, remove button 44x44, "+ עיר" dashed.
    const remove = card.getByRole('button', { name: `הסרת רמת גן ${t}` });
    const rb = await remove.boundingBox();
    expect([Math.round(rb?.width ?? 0), Math.round(rb?.height ?? 0)]).toEqual([44, 44]);
    const addCity = card.getByRole('button', { name: '+ עיר' });
    expect(await addCity.evaluate((el) => getComputedStyle(el).borderStyle)).toBe('dashed');
    await adminBaseline(page, 'delivery-zones', errors);

    // A city already in another zone: said in words, naming both, nothing saved.
    await addCity.click();
    await card.getByLabel('שם העיר').fill(`  חיפה   ${t} `);
    await card.getByRole('button', { name: 'הוספה', exact: true }).click();
    await expect(card.getByTestId('zone-message')).toHaveText(`${iso(`חיפה ${t}`)} כבר נמצאת באזור ${iso(`QA צפון ${t}`)}. עיר יכולה להיות רק באזור אחד.`);
    await expect(card.getByTestId('zone-message')).toHaveAttribute('role', 'alert');
    await page.screenshot({ path: join(SCREENS, 'admin-delivery-zones-city-taken.png'), fullPage: true });
    expect((await db('SELECT zone_id FROM delivery_zone_cities WHERE city = $1', [`חיפה ${t}`]))[0].zone_id).toBe(north.id);

    // Add a free city.
    await card.getByLabel('שם העיר').fill(`בני ברק ${t}`);
    await card.getByRole('button', { name: 'הוספה', exact: true }).click();
    await expect(card.getByTestId('zone-message')).toHaveText(`${iso(`בני ברק ${t}`)} נוספה.`);
    await expect(card.getByRole('button', { name: `הסרת בני ברק ${t}` })).toBeVisible();

    // Remove a city.
    await card.getByRole('button', { name: `הסרת גבעתיים ${t}` }).click();
    await expect(card.getByTestId('zone-message')).toHaveText(`${iso(`גבעתיים ${t}`)} הוסרה.`);
    expect((await db('SELECT city FROM delivery_zone_cities WHERE zone_id = $1 ORDER BY city', [center.id])).map((r) => r.city)).toEqual([`בני ברק ${t}`, `רמת גן ${t}`].sort());

    // Fee: invalid is stopped in the form; a whole number is saved on Enter.
    await fee.fill('35.5');
    await fee.press('Enter');
    await expect(card.getByTestId('zone-message')).toHaveText('דמי משלוח: מספר שלם של שקלים, מ־0 עד 1000.');
    await fee.fill('50');
    await fee.press('Enter');
    await expect(card.getByTestId('zone-message')).toHaveText('נשמר.');
    expect((await db('SELECT fee_displayed FROM delivery_zones WHERE id = $1', [center.id]))[0].fee_displayed).toBe('50.00');

    // Turn the zone off (switch, keyboard).
    const sw = card.getByRole('switch', { name: 'משלוח לאזור הזה פעיל' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByText('האזור כבוי: לקוחות מהערים האלה לא יכולים להזמין משלוח.')).toBeVisible();
    expect((await db('SELECT is_active FROM delivery_zones WHERE id = $1', [center.id]))[0].is_active).toBe(false);

    // New zone through the form; a taken name is refused in words.
    await page.getByRole('button', { name: 'הוספת אזור' }).click();
    await page.getByLabel('שם האזור').fill(`QA צפון ${t}`);
    await page.getByLabel('דמי משלוח בשקלים').fill('30');
    await page.getByRole('button', { name: 'יצירת האזור' }).click();
    await expect(page.getByTestId('new-zone-message')).toHaveText('כבר יש אזור בשם הזה.');
    await page.getByLabel('שם האזור').fill(`QA דרום ${t}`);
    await page.getByRole('button', { name: 'יצירת האזור' }).click();
    const south = page.locator(`[data-testid="zone-card"][data-zone="QA דרום ${t}"]`);
    await expect(south.getByRole('textbox', { name: `דמי משלוח לQA דרום ${t} בשקלים` })).toHaveValue('30');

    // Delete asks first, then removes the card.
    await south.getByRole('button', { name: 'מחיקת האזור' }).click();
    await expect(south.getByText(`למחוק את האזור ${iso(`QA דרום ${t}`)}? הזמנות קיימות שומרות את דמי המשלוח שלהן.`)).toBeVisible();
    await south.getByRole('button', { name: 'מחיקה', exact: true }).click();
    await expect(south).toHaveCount(0);
    expect(await db('SELECT 1 FROM delivery_zones WHERE name = $1', [`QA דרום ${t}`])).toHaveLength(0);

    // Reload: the server shows what was saved.
    await page.reload();
    await expect(page.locator(`[data-testid="zone-card"][data-zone="QA מרכז ${t}"]`).getByRole('textbox', { name: `דמי משלוח לQA מרכז ${t} בשקלים` })).toHaveValue('50');
    // The two 409s above (city taken, name taken) are logged by the browser itself; nothing else may be.
    expect(errors.filter((e) => !e.includes('status of 409'))).toEqual([]);
    expect(errors).toHaveLength(2);
    await db('DELETE FROM delivery_zones WHERE id = ANY($1)', [[center.id, north.id]]);
  });

  test('dark mode renders the zone cards', async ({ page, baseURL }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const t = tag();
    const z = await (await page.request.post('/api/admin/delivery-zones', { headers: { origin: baseURL ?? '' }, data: { name: `QA כהה ${t}`, fee: 40, cities: [`עיר ${t}`] } })).json();
    await page.goto('/admin/settings');
    await expect(page.locator(`[data-testid="zone-card"][data-zone="QA כהה ${t}"]`)).toBeVisible();
    await adminBaseline(page, 'delivery-zones-dark', errors);
    await db('DELETE FROM delivery_zones WHERE id = $1', [z.id]);
  });
});

/** A day far ahead that no other test uses (orders are keyed by day). */
function freshDeliveryDay() {
  return new Date(Date.now() + (400 + crypto.randomInt(0, 20000)) * 864e5).toISOString().slice(0, 10);
}

/** A test order on `day` (inserted directly: the checkout path is not what is tested here). */
async function addDeliveryOrder(day, { status = 'paid', type = 'delivery', name = 'QA', phone = '+972500000001', email = null, customerId = null, city = 'QA city', address = 'QA street 1', window = null, notes = null } = {}) {
  const [row] = await db(
    `INSERT INTO orders (order_number, lookup_token_hash, lookup_token_expires_at, status, customer_id, guest_name, guest_phone, guest_email,
       fulfillment_type, delivery_date, delivery_time_window, delivery_address, delivery_city, delivery_notes,
       subtotal_displayed, delivery_fee_displayed, total_displayed, privacy_notice_version, terms_version, cancellation_notice_version)
     VALUES ($1, md5(random()::text), now() + interval '30 days', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 180, 35, 215, 'p', 't', 'c')
     RETURNING order_number`,
    [`Q${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status, customerId, customerId ? null : name, customerId ? null : phone, email,
      type, day, window, type === 'delivery' ? address : null, type === 'delivery' ? city : null, notes],
  );
  return row.order_number;
}

test.describe('delivery list API (api-008)', () => {
  test('anonymous visitor gets 401', async ({ request }) => {
    const res = await request.get('/api/admin/delivery-list?date=2027-01-05');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('paid delivery orders of that day only, courier fields only, sorted by time window, audited without PII', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const day = freshDeliveryDay();
    const other = new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

    const registered = await createUser({ admin: false });
    const regPhone = `+97252${crypto.randomInt(1000000, 9999999)}`;
    await db('INSERT INTO customers (id, name, phone, email) VALUES ($1, $2, $3, $4)', [registered.userId, 'לקוחה רשומה', regPhone, `reg-${tag()}@example.test`]);

    const numbers = [
      await addDeliveryOrder(day, { name: 'דנה כהן', phone: '+972501112233', email: 'dana@example.test', city: 'רמת גן', address: 'הרצל 12, דירה 4', window: '16:00-18:00', notes: 'קומה 2, לדפוק חזק' }),
      await addDeliveryOrder(day, { customerId: registered.userId, city: 'גבעתיים', address: 'כצנלסון 5', window: '10:00-12:00' }),
      await addDeliveryOrder(day, { name: 'אבי לוי', phone: '+972541234567', city: 'חיפה', address: 'הנשיא 3' }),
      await addDeliveryOrder(day, { status: 'payment_pending', name: 'ממתינה', phone: '+972509999999' }),
      await addDeliveryOrder(day, { status: 'cancelled', name: 'בוטלה' }),
      await addDeliveryOrder(day, { status: 'expired', name: 'פגה' }),
      await addDeliveryOrder(day, { type: 'pickup', name: 'איסוף' }),
      await addDeliveryOrder(other, { name: 'יום אחר' }),
    ];

    // Zod: a real date, nothing else.
    for (const q of ['', '?date=2027-02-30', '?date=today', `?date=${day}&status=all`]) {
      const r = await page.request.get(`/api/admin/delivery-list${q}`);
      expect(r.status(), q).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }

    const res = await page.request.get(`/api/admin/delivery-list?date=${day}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    const body = await res.json();
    expect(body).toEqual({
      day,
      pendingCount: 1,
      stops: [
        { name: 'לקוחה רשומה', phone: regPhone, address: 'כצנלסון 5', city: 'גבעתיים', timeWindow: '10:00-12:00', notes: null },
        { name: 'דנה כהן', phone: '+972501112233', address: 'הרצל 12, דירה 4', city: 'רמת גן', timeWindow: '16:00-18:00', notes: 'קומה 2, לדפוק חזק' },
        { name: 'אבי לוי', phone: '+972541234567', address: 'הנשיא 3', city: 'חיפה', timeWindow: null, notes: null },
      ],
    });
    // Minimization (SEC-016): toEqual above already rules out extra fields; also no email, price, order number, status or other day anywhere.
    const text = JSON.stringify(body);
    for (const leak of ['example.test', 'total', 'fee', ...numbers, 'paid', 'ממתינה', 'יום אחר', 'איסוף']) expect(text, leak).not.toContain(leak);

    // SEC-017: one audit row per generation (the 400s never reached the DB), counts only.
    const audit = await db("SELECT actor_id, metadata FROM audit_log WHERE action = 'delivery_list.generated' AND entity_id = $1", [day]);
    expect(audit).toEqual([{ actor_id: admin.userId, metadata: { stop_count: 3, pending_count: 1 } }]);
    await db('DELETE FROM orders WHERE delivery_date = ANY($1::date[])', [[day, other]]);
  });

  test('through PostgREST: anon has no access; a signed-in customer is refused', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.rpc('fn_admin_delivery_list', { p_day: '2027-01-05' })).error?.message).toContain('permission denied');
    const customer = await createUser({ admin: false });
    const user = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email: customer.email, password: customer.password });
    expect((await user.rpc('fn_admin_delivery_list', { p_day: '2027-01-05' })).error?.message).toBe('admin_aal2_required');
  });
});

test.describe('delivery list screen (client-011)', () => {
  test('anonymous visitor is sent to login', async ({ page }) => {
    await page.goto('/admin/delivery');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('arrives with its data, courier fields only, phone LTR tap-to-call, print sheet without chrome and with the footer, audited', async ({ page }) => {
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const day = freshDeliveryDay();
    const numbers = [
      await addDeliveryOrder(day, { name: 'דנה כהן', phone: '+972501112233', email: `dana-${tag()}@example.test`, city: 'רמת גן', address: 'הרצל 12, דירה 4', window: '16:00-18:00', notes: 'קומה 2, לדפוק חזק' }),
      await addDeliveryOrder(day, { name: 'Avi Levi', phone: '+972541234567', city: 'גבעתיים', address: 'כצנלסון 5', window: '10:00-12:00' }),
      await addDeliveryOrder(day, { name: 'נועה', phone: '+972521234567', city: 'חיפה', address: 'הנשיא 3' }),
      await addDeliveryOrder(day, { status: 'payment_pending', name: 'ממתינה לתשלום', phone: '+972509999999' }),
      await addDeliveryOrder(day, { status: 'payment_pending', name: 'עוד ממתינה', phone: '+972509999998' }),
    ];

    const apiCalls = [];
    page.on('request', (r) => r.url().includes('/api/') && apiCalls.push(r.url()));
    const res = await page.goto(`/admin/delivery?day=${day}`);
    expect(res?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const weekdays = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const [, m, dom] = day.split('-').map(Number);
    await expect(page.getByTestId('delivery-title')).toHaveText(`משלוחים ליום ${weekdays[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${dom}.${m}`);
    await expect(page.getByTestId('delivery-count')).toHaveText('3 משלוחים.');
    await expect(page.getByTestId('delivery-pending')).toHaveText('עוד 2 הזמנות משלוח ליום הזה מחכות לתשלום, ולא מופיעות ברשימה.');
    const stops = page.getByTestId('delivery-stop');
    await expect(stops).toHaveCount(3);
    await expect(stops.nth(0)).toContainText('Avi Levi');
    await expect(stops.nth(0).getByTestId('stop-window')).toHaveText('10:00-12:00');
    await expect(stops.nth(1)).toContainText('דנה כהן');
    await expect(stops.nth(1)).toContainText('כתובת: הרצל 12, דירה 4, רמת גן');
    await expect(stops.nth(1)).toContainText('הערות: קומה 2, לדפוק חזק');
    await expect(stops.nth(2).getByTestId('stop-window')).toHaveText('בלי שעה');

    // Phone: local form, tap-to-call in E.164, LTR-isolated inside the RTL line.
    const phone = stops.nth(1).getByTestId('stop-phone');
    await expect(phone).toHaveText('050-111-2233');
    await expect(phone).toHaveAttribute('href', 'tel:+972501112233');
    expect(await phone.evaluate((el) => [getComputedStyle(el).direction, getComputedStyle(el).unicodeBidi])).toEqual(['ltr', 'isolate']);

    // Minimization: nothing else about the orders reaches the page.
    const html = await page.content();
    for (const leak of ['example.test', 'ממתינה', ...numbers, '₪']) expect(html, leak).not.toContain(leak);
    await expect(page.getByTestId('delivery-footer')).toHaveText('מידע אישי של לקוחות. למחוק או לגרוס בסוף יום המשלוחים.');
    await expect(page.getByTestId('delivery-share')).toContainText('הודעות נעלמות');
    expect(apiCalls).toEqual([]);
    // The calendar tab stays active: the list belongs to the day.
    await expect(page.getByRole('navigation', { name: 'ניווט ניהול' }).getByRole('link', { name: 'יומן' })).toHaveAttribute('aria-current', 'page');
    await adminBaseline(page, 'delivery-list', errors);

    // Print sheet: no app bar, tabs, day arrows, print button or pending note; the footer repeats (fixed).
    await page.emulateMedia({ media: 'print' });
    for (const sel of ['.admin-appbar', '.admin-tabs', '[data-testid="delivery-print"]', '[data-testid="delivery-pending"]', '[data-testid="next-day"]']) {
      await expect(page.locator(sel), sel).toBeHidden();
    }
    await expect(stops).toHaveCount(3);
    expect(await page.getByTestId('delivery-footer').evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    await page.screenshot({ path: join(SCREENS, 'admin-delivery-list-print.png'), fullPage: true });
    await page.pdf({ path: join(SCREENS, 'admin-delivery-list.pdf'), format: 'A4', printBackground: true });
    await page.emulateMedia({ media: 'screen' });

    // SEC-017: the render generated the list once and logged it.
    const audit = await db("SELECT actor_id, metadata FROM audit_log WHERE action = 'delivery_list.generated' AND entity_id = $1", [day]);
    expect(audit).toEqual([{ actor_id: admin.userId, metadata: { stop_count: 3, pending_count: 2 } }]);
    await db('DELETE FROM orders WHERE delivery_date = $1', [day]);
  });

  test('empty day: says so, no print button; reached from the capacity day; arrows move the day; dark mode', async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const day = freshDeliveryDay();
    await page.goto(`/admin/capacity?day=${day}`);
    await page.getByTestId('open-delivery-list').click();
    await page.waitForURL(`**/admin/delivery?day=${day}`);
    await expect(page.getByTestId('delivery-empty')).toHaveText('אין משלוחים ששולמו ליום הזה.');
    await expect(page.getByTestId('delivery-print')).toHaveCount(0);
    await expect(page.getByTestId('delivery-count')).toHaveCount(0);
    await expect(page.getByTestId('delivery-footer')).toHaveCount(0);
    await expect(page.getByTestId('delivery-stop')).toHaveCount(0);
    await adminBaseline(page, 'delivery-list-empty-dark', errors);
    await page.getByTestId('next-day').click();
    await page.waitForURL(`**/admin/delivery?day=${new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)}`);
    // An invalid day falls back to today (like the capacity screen), never an error page.
    const r = await page.goto('/admin/delivery?day=2027-02-30');
    expect(r?.status()).toBe(200);
  });
});
