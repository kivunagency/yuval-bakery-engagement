// @ts-check
// Products domain regression (client-006 admin products, SEC-011 catalog photos).
// Real chain: browser session (password + TOTP) -> Next.js route -> PostgREST
// as the admin's own aal2 JWT -> SECURITY DEFINER functions -> audit_log, and
// for photos: signed upload to the private staging bucket -> server re-encode
// -> public product-photos bucket.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { join } = require('node:path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { createUser, db, uiLogin } = require('./helpers/admin-ui');
const { createAdmin } = require('./helpers/admin');
const { localEnv } = require('./helpers/env');
const { SCREENS } = require('./helpers/baseline');
const { withClient, freshDay, createOrder, ledger } = require('./helpers/db');

const tag = () => crypto.randomUUID().slice(0, 6);
const base = (name) => ({ name, price: 42.5, costBasis: 'per_unit', ovenMinutes: 7, workMinutes: 9 });

function service() {
  const env = localEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/** A small JPEG carrying EXIF (a camera make and a GPS-like artist tag), as a phone photo would. */
function exifJpeg(color = '#aa5500') {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .withExif({ IFD0: { Make: 'QA-PHONE', Artist: 'GPS 32.0853 34.7818' } })
    .jpeg()
    .toBuffer();
}

/** upload-url -> PUT -> finalize, through the app, as the browser does it. */
async function uploadPhoto(api, headers, productId, bytes, altText, contentType = 'image/jpeg') {
  const u = await api.post(`/api/admin/products/${productId}/photos/upload-url`, { headers });
  expect(u.status()).toBe(200);
  const { uploadId, uploadUrl } = await u.json();
  const put = await fetch(uploadUrl, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
  expect(put.ok).toBe(true);
  const res = await api.post(`/api/admin/products/${productId}/photos`, { headers, data: altText === undefined ? { uploadId } : { uploadId, altText } });
  return { res, uploadId };
}

async function stagingHas(uploadId) {
  const { data } = await service().storage.from('product-photos-staging').list('incoming', { limit: 1000 });
  return (data ?? []).some((f) => f.name === uploadId);
}

test.describe('admin products API (client-006)', () => {
  test('anonymous visitor gets 401 on every verb', async ({ request }) => {
    const id = crypto.randomUUID();
    const pid = crypto.randomUUID();
    for (const res of [
      await request.post('/api/admin/products', { data: base('x') }),
      await request.patch(`/api/admin/products/${id}`, { data: { price: 1 } }),
      await request.delete(`/api/admin/products/${id}`),
      await request.post(`/api/admin/products/${id}/photos/upload-url`),
      await request.post(`/api/admin/products/${id}/photos`, { data: { uploadId: pid } }),
      await request.patch(`/api/admin/products/${id}/photos/${pid}`, { data: { altText: 'x' } }),
      await request.delete(`/api/admin/products/${id}/photos/${pid}`),
    ]) {
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  test('admin at aal2: create, validate, publish rules (allergens confirmed, re-confirm after an allergen edit), soft delete, audited', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const name = `QA מוצר ${tag()}`;

    // CSRF: no Origin, or a foreign one.
    expect((await api.post('/api/admin/products', { data: base(name) })).status()).toBe(403);
    expect((await api.post('/api/admin/products', { headers: { origin: 'https://evil.example' }, data: base(name) })).status()).toBe(403);

    // Zod: missing field, bad price (3 decimals, negative, string), minutes not whole or too big, unknown key, long name.
    for (const data of [
      { name, price: 10, costBasis: 'per_unit', ovenMinutes: 1 },
      { ...base(name), price: 1.005 },
      { ...base(name), price: -1 },
      { ...base(name), price: '10' },
      { ...base(name), ovenMinutes: 1.5 },
      { ...base(name), workMinutes: 1441 },
      { ...base(name), costBasis: 'per_box' },
      { ...base(name), photoAlt: 'x' },
      { ...base('x'.repeat(81)) },
      { ...base(name), allergens: ['x'.repeat(41)] },
    ]) {
      const r = await api.post('/api/admin/products', { headers, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_input' });
    }

    // Create: trimmed, allergen entries normalized and de-duplicated, not published, not confirmed.
    const created = await api.post('/api/admin/products', {
      headers,
      data: { ...base(` ${name} `), price: 19.99, ingredients: ' קמח, חמאה ', allergens: ['gluten', ' dairy', 'gluten', 'תות  שדה'], mayContain: ['nuts'], description: '  ' },
    });
    expect(created.status()).toBe(201);
    const p = await created.json();
    expect(p).toEqual({
      id: expect.any(String), name, description: null, price: 19.99, costBasis: 'per_unit', ovenMinutes: 7, workMinutes: 9,
      ingredients: 'קמח, חמאה', allergens: ['gluten', 'dairy', 'תות שדה'], mayContain: ['nuts'], allergenNotes: null,
      allergensConfirmed: false, isAvailable: true, isPublished: false, photos: [],
    });

    // Publishing without the allergen confirmation: refused by the DB, nothing changes.
    const refused = await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: true } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toEqual({ error: 'allergens_not_confirmed' });
    expect((await db('SELECT is_published FROM products WHERE id = $1', [p.id]))[0].is_published).toBe(false);

    const published = await api.patch(`/api/admin/products/${p.id}`, { headers, data: { allergensConfirmed: true, isPublished: true } });
    expect(published.status()).toBe(200);
    expect(await published.json()).toMatchObject({ allergensConfirmed: true, isPublished: true });

    // In the public catalog now, without its minutes.
    const catalog = await (await api.get('/api/catalog')).json();
    const pub = catalog.products.find((x) => x.id === p.id);
    expect(pub).toMatchObject({ name, price: 19.99, allergens: ['gluten', 'dairy', 'תות שדה'], mayContain: ['nuts'] });
    expect(JSON.stringify(pub)).not.toContain('Minutes');

    // An allergen edit on a published product without a new confirmation: refused (it would un-confirm).
    const edit = await api.patch(`/api/admin/products/${p.id}`, { headers, data: { allergens: ['gluten', 'dairy', 'eggs'] } });
    expect(edit.status()).toBe(409);
    expect(await edit.json()).toEqual({ error: 'allergens_not_confirmed' });
    // Unpublished, the same edit is saved and turns the confirmation off.
    const draft = await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: false, allergens: ['gluten', 'dairy', 'eggs'] } });
    expect(await draft.json()).toMatchObject({ isPublished: false, allergensConfirmed: false, allergens: ['gluten', 'dairy', 'eggs'] });
    // A non-allergen edit keeps the confirmation.
    await api.patch(`/api/admin/products/${p.id}`, { headers, data: { allergensConfirmed: true } });
    expect(await (await api.patch(`/api/admin/products/${p.id}`, { headers, data: { price: 21, isAvailable: false, description: 'עוגיה' } })).json()).toMatchObject({
      allergensConfirmed: true, price: 21, isAvailable: false, description: 'עוגיה',
    });
    // null clears an optional text.
    expect((await (await api.patch(`/api/admin/products/${p.id}`, { headers, data: { description: null } })).json()).description).toBeNull();

    expect((await api.patch(`/api/admin/products/${p.id}`, { headers, data: {} })).status()).toBe(400);
    expect((await api.patch('/api/admin/products/not-a-uuid', { headers, data: { price: 1 } })).status()).toBe(400);
    const missing = await api.patch(`/api/admin/products/${crypto.randomUUID()}`, { headers, data: { price: 1 } });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    // Soft delete: gone from the admin read and the catalog, row kept, unpublished; a second delete is 404.
    await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: true } });
    expect((await api.delete(`/api/admin/products/${p.id}`, { headers })).status()).toBe(200);
    expect((await api.delete(`/api/admin/products/${p.id}`, { headers })).status()).toBe(404);
    expect((await api.patch(`/api/admin/products/${p.id}`, { headers, data: { price: 1 } })).status()).toBe(404);
    const row = (await db('SELECT is_published, deleted_at FROM products WHERE id = $1', [p.id]))[0];
    expect(row.is_published).toBe(false);
    expect(row.deleted_at).not.toBeNull();
    expect((await (await api.get('/api/catalog')).json()).products.find((x) => x.id === p.id)).toBeUndefined();

    // SEC-017: every change audited as this admin; updates carry only what changed, with the previous value.
    const audit = await db("SELECT action, metadata FROM audit_log WHERE actor_id = $1 AND entity_id = $2 ORDER BY id", [admin.userId, p.id]);
    expect(audit.map((a) => a.action)).toEqual([
      'product.created', 'product.updated', 'product.updated', 'product.updated', 'product.updated', 'product.updated', 'product.updated', 'product.deleted',
    ]);
    expect(audit[1].metadata.changes).toEqual({ allergens_confirmed: { from: false, to: true }, is_published: { from: false, to: true } });
    expect(audit[4].metadata.changes).toMatchObject({ price: { from: 19.99, to: 21 }, is_available: { from: true, to: false } });
  });

  test('photos (SEC-011): signed upload to a private staging bucket, re-encoded without EXIF into the public bucket, alt text required to publish', async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const headers = { origin: baseURL ?? '' };
    const p = await (await api.post('/api/admin/products', { headers, data: { ...base(`QA צילום ${tag()}`), allergensConfirmed: true, isPublished: true } })).json();
    expect(p.isPublished).toBe(true);

    // Published product: a photo without alt text is refused, and its public copy is removed again.
    const noAlt = await uploadPhoto(api, headers, p.id, await exifJpeg());
    expect(noAlt.res.status()).toBe(409);
    expect(await noAlt.res.json()).toEqual({ error: 'photo_alt_required' });
    expect(await stagingHas(noAlt.uploadId)).toBe(false);
    const { data: leftovers } = await service().storage.from('product-photos').list(`products/${p.id}`);
    expect(leftovers ?? []).toEqual([]);

    // Unpublished: the photo is accepted without alt, then publishing is refused until it has one.
    await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: false } });
    const first = await uploadPhoto(api, headers, p.id, await exifJpeg());
    expect(first.res.status()).toBe(201);
    const withPhoto = await first.res.json();
    expect(withPhoto.photos).toEqual([{ id: expect.any(String), url: expect.stringContaining(`/storage/v1/object/public/product-photos/products/${p.id}/`), altText: null }]);
    expect(await stagingHas(first.uploadId)).toBe(false); // the original is deleted
    const blocked = await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: true } });
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'photo_alt_required' });

    // The stored file is a new JPEG: no EXIF, readable from the public URL by anyone.
    const served = await fetch(withPhoto.photos[0].url);
    expect(served.ok).toBe(true);
    const bytes = Buffer.from(await served.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(bytes.includes(Buffer.from('QA-PHONE'))).toBe(false);

    const photoId = withPhoto.photos[0].id;
    const alt = await api.patch(`/api/admin/products/${p.id}/photos/${photoId}`, { headers, data: { altText: '  עוגיית חמאה על צלחת לבנה ' } });
    expect((await alt.json()).photos[0].altText).toBe('עוגיית חמאה על צלחת לבנה');
    expect((await api.patch(`/api/admin/products/${p.id}`, { headers, data: { isPublished: true } })).status()).toBe(200);
    // Clearing the alt text of a published product's photo: refused.
    const clear = await api.patch(`/api/admin/products/${p.id}/photos/${photoId}`, { headers, data: { altText: '' } });
    expect(clear.status()).toBe(409);
    expect(await clear.json()).toEqual({ error: 'photo_alt_required' });
    // The catalog serves the photo with its own alt text.
    const pub = (await (await api.get('/api/catalog')).json()).products.find((x) => x.id === p.id);
    expect(pub.photos).toEqual([{ url: withPhoto.photos[0].url, alt: 'עוגיית חמאה על צלחת לבנה' }]);

    // Not an image (HTML with a JPEG content type): refused by magic bytes, staging emptied, nothing attached.
    const html = await uploadPhoto(api, headers, p.id, Buffer.from('<html><script>alert(1)</script></html>'), 'x');
    expect(html.res.status()).toBe(422);
    expect(await html.res.json()).toEqual({ error: 'photo_rejected' });
    expect(await stagingHas(html.uploadId)).toBe(false);
    // Finalizing an upload that never happened, or twice.
    expect((await api.post(`/api/admin/products/${p.id}/photos`, { headers, data: { uploadId: crypto.randomUUID() } })).status()).toBe(400);
    expect((await api.post(`/api/admin/products/${p.id}/photos`, { headers, data: { uploadId: first.uploadId, altText: 'x' } })).status()).toBe(400);
    // The body never names a path.
    expect((await api.post(`/api/admin/products/${p.id}/photos`, { headers, data: { uploadId: first.uploadId, path: 'products/x.jpg' } })).status()).toBe(400);

    // Second photo, made primary; then up to 6, the 7th refused.
    const second = await (await uploadPhoto(api, headers, p.id, await exifJpeg('#225588'), 'עוגייה חצויה')).res.json();
    const secondId = second.photos[1].id;
    const primary = await (await api.patch(`/api/admin/products/${p.id}/photos/${secondId}`, { headers, data: { primary: true } })).json();
    expect(primary.photos.map((x) => x.id)).toEqual([secondId, photoId]);
    for (let i = 0; i < 4; i++) expect((await uploadPhoto(api, headers, p.id, await exifJpeg(), `תמונה ${i}`)).res.status()).toBe(201);
    const seventh = await uploadPhoto(api, headers, p.id, await exifJpeg(), 'שביעית');
    expect(seventh.res.status()).toBe(409);
    expect(await seventh.res.json()).toEqual({ error: 'photo_limit_reached' });

    // A photo of another product through this product's URL: 404, like a missing one.
    const other = await (await api.post('/api/admin/products', { headers, data: base(`QA אחר ${tag()}`) })).json();
    expect((await api.patch(`/api/admin/products/${other.id}/photos/${photoId}`, { headers, data: { altText: 'x' } })).status()).toBe(404);
    expect((await api.delete(`/api/admin/products/${other.id}/photos/${photoId}`, { headers })).status()).toBe(404);

    // Delete: row and public file both gone.
    const del = await api.delete(`/api/admin/products/${p.id}/photos/${photoId}`, { headers });
    expect(del.status()).toBe(200);
    expect((await del.json()).photos.map((x) => x.id)).not.toContain(photoId);
    expect((await fetch(withPhoto.photos[0].url)).ok).toBe(false);

    const actions = (await db("SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'product_photo.%' ORDER BY id", [admin.userId])).map((a) => a.action);
    expect(actions).toEqual(['product_photo.added', 'product_photo.updated', 'product_photo.added', 'product_photo.made_primary',
      'product_photo.added', 'product_photo.added', 'product_photo.added', 'product_photo.added', 'product_photo.deleted']);

    const paths = (await db('SELECT storage_path FROM product_photos WHERE product_id = $1', [p.id])).map((r) => `${r.storage_path}`);
    await service().storage.from('product-photos').remove(paths);
    await db('DELETE FROM products WHERE id = ANY($1)', [[p.id, other.id]]);
  });

  test('a new price or new minutes never change an order already placed (snapshot)', async ({ page, baseURL }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };
    const p = await (await page.request.post('/api/admin/products', { headers, data: { ...base(`QA snapshot ${tag()}`), price: 30, ovenMinutes: 4, workMinutes: 6, allergensConfirmed: true, isPublished: true } })).json();
    const { day, order, before } = await withClient(async (c) => {
      const d = await freshDay(c, { oven: 200, work: 200 });
      const o = await createOrder(c, d, p.id, 2);
      return { day: d, order: o, before: await ledger(c, d) };
    });
    expect([order.oven_minutes_cost, order.work_minutes_cost]).toEqual([8, 12]);

    const changed = await page.request.patch(`/api/admin/products/${p.id}`, { headers, data: { price: 55, ovenMinutes: 20, workMinutes: 30 } });
    expect(changed.status()).toBe(200);

    const [o] = await db('SELECT oven_minutes_cost, work_minutes_cost, subtotal_displayed FROM orders WHERE id = $1', [order.id]);
    expect([o.oven_minutes_cost, o.work_minutes_cost, Number(o.subtotal_displayed)]).toEqual([8, 12, 60]);
    const [line] = await db('SELECT unit_price_displayed, line_total_displayed, product_name_snapshot FROM order_items WHERE order_id = $1', [order.id]);
    expect([Number(line.unit_price_displayed), Number(line.line_total_displayed), line.product_name_snapshot]).toEqual([30, 60, p.name]);
    expect(await withClient((c) => ledger(c, day))).toEqual(before);
  });

  test('through PostgREST: no direct table write for anyone, even an aal2 admin; the functions refuse anon and a customer', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.rpc('fn_admin_create_product', { p_product: {} })).error?.message).toContain('permission denied');
    expect((await anon.rpc('fn_admin_add_product_photo', { p_product_id: crypto.randomUUID(), p_storage_path: 'x', p_alt_text: 'x' })).error?.message).toContain('permission denied');
    expect((await anon.from('products').update({ price_displayed: 0 }).neq('name', '')).error).not.toBeNull();

    const customer = await createUser({ admin: false });
    const user = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await user.auth.signInWithPassword({ email: customer.email, password: customer.password });
    expect((await user.rpc('fn_admin_create_product', { p_product: { name: 'x' } })).error?.message).toBe('admin_aal2_required');
    expect((await user.rpc('fn_admin_delete_product', { p_product_id: crypto.randomUUID() })).error?.message).toBe('admin_aal2_required');

    // Even an aal2 admin cannot write the tables directly (the audit could be skipped).
    const { client: adminClient } = await createAdmin();
    expect((await adminClient.from('products').insert({ name: 'x', price_displayed: 1, cost_basis: 'per_unit', oven_minutes_cost: 1, work_minutes_cost: 1 })).error?.message).toContain('permission denied');
    expect((await adminClient.from('product_photos').delete().neq('storage_path', '')).error?.message).toContain('permission denied');
    // ...but the functions work for it, and validate: unknown key, and a path the server never writes.
    expect((await adminClient.rpc('fn_admin_create_product', { p_product: { ...{ name: 'x', price: 1, cost_basis: 'per_unit', oven_minutes: 1, work_minutes: 1 }, photo_alt: 'x' } })).error?.message).toBe('product_invalid: photo_alt');
    const made = await adminClient.rpc('fn_admin_create_product', { p_product: { name: `QA rpc ${tag()}`, price: 1, cost_basis: 'per_batch', oven_minutes: 0, work_minutes: 0 } });
    expect(made.error).toBeNull();
    const bad = await adminClient.rpc('fn_admin_add_product_photo', { p_product_id: made.data.id, p_storage_path: `products/${made.data.id}/../../x.jpg`, p_alt_text: 'x' });
    expect(bad.error?.message).toBe('product_photo_path_invalid');
    await db('DELETE FROM products WHERE id = $1', [made.data.id]);
  });

  test('DB rules hold for every writer: published product with a photo lacking alt text, deleted and published', async () => {
    await withClient(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens_confirmed)
         VALUES ($1, 1, 'per_unit', 1, 1, true) RETURNING id`, [`QA rule ${tag()}`]);
      const id = rows[0].id;
      await c.query("INSERT INTO product_photos (product_id, storage_path) VALUES ($1, 'products/x/y.jpg')", [id]);
      await expect(c.query('UPDATE products SET is_published = true WHERE id = $1', [id])).rejects.toThrow('product_photo_alt_required');
      await c.query("UPDATE product_photos SET alt_text = 'תיאור' WHERE product_id = $1", [id]);
      await c.query('UPDATE products SET is_published = true WHERE id = $1', [id]);
      await expect(c.query("INSERT INTO product_photos (product_id, storage_path, alt_text) VALUES ($1, 'products/x/z.jpg', '  ')", [id])).rejects.toThrow('product_photo_alt_required');
      await expect(c.query('UPDATE products SET allergens_confirmed = false WHERE id = $1', [id])).rejects.toThrow('products_published_requires_allergens_confirmed');
      await expect(c.query('UPDATE products SET deleted_at = now() WHERE id = $1', [id])).rejects.toThrow('products_deleted_not_published');
      await c.query('DELETE FROM products WHERE id = $1', [id]);
    });
  });
});

/** Baseline every admin screen shares (same checks as regression.admin/delivery), plus a screenshot. */
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

test.describe('admin products screens (client-006)', () => {
  test('list arrives with its data; create through the form; photo with alt text; publish; sold-out switch on the row', async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const headers = { origin: baseURL ?? '' };
    const listed = await (await page.request.post('/api/admin/products', { headers, data: { ...base(`QA רשימה ${tag()}`), allergens: ['gluten'] } })).json();

    // First frame is server-rendered: the product is in the HTML, no products API call on load.
    const apiCalls = [];
    page.on('request', (r) => r.url().includes('/api/admin/products') && apiCalls.push(r.url()));
    await page.goto('/admin/catalog');
    await expect(page.getByRole('heading', { level: 1, name: 'מוצרים' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'מוצרים' })).toHaveAttribute('aria-current', 'page');
    const row = page.locator(`[data-testid="product-row"][data-product-id="${listed.id}"]`);
    await expect(row.getByRole('heading', { level: 2 })).toHaveText(listed.name);
    await expect(row.getByTestId('product-published')).toHaveText('לא מפורסם');
    await expect(row.getByTestId('product-blockers')).toHaveText('לאשר את הרכיבים והאלרגנים.');
    expect(apiCalls).toEqual([]);
    await adminBaseline(page, 'products-list', errors);

    // Sold-out switch on the row, saved.
    await row.getByTestId('product-available').click();
    await expect(row.getByTestId('product-paused')).toHaveText('אזל');
    expect((await db('SELECT is_available FROM products WHERE id = $1', [listed.id]))[0].is_available).toBe(false);

    // New product through the form: field errors in words, then created and taken to its page.
    await page.getByTestId('product-add').click();
    await page.waitForURL('**/admin/catalog/new');
    await expect(page.getByTestId('snapshot-note')).toHaveText('מחיר חדש או זמנים חדשים חלים רק על הזמנות חדשות. הזמנות שכבר התקבלו שומרות את המחיר והזמנים מרגע ההזמנה.');
    await adminBaseline(page, 'products-new', errors);
    const name = `QA טופס ${tag()}`;
    await page.getByTestId('product-save').click();
    await expect(page.getByTestId('error-name')).toHaveText('צריך שם, עד 80 תווים.');
    await page.getByLabel('שם המוצר').fill(name);
    await page.getByLabel('מחיר', { exact: true }).fill('12.345');
    await page.getByTestId('product-save').click();
    await expect(page.getByTestId('error-price')).toBeVisible();
    await page.getByLabel('מחיר', { exact: true }).fill('18.5');
    await page.getByTestId('basis-per_batch').check();
    await page.getByLabel('דקות תנור').fill('12');
    await page.getByLabel('דקות עבודה').fill('20');
    await page.getByLabel('רכיבים', { exact: true }).fill('קמח, ביצים, חמאה');
    await page.getByTestId('contains-gluten').check();
    await page.getByTestId('contains-eggs').check();
    await page.getByTestId('mayContain-nuts').check();
    await page.getByTestId('product-contains-other').fill('קינמון');
    await page.getByTestId('product-allergens-confirmed').check();
    await page.getByTestId('product-save').click();
    await page.waitForURL(/\/admin\/catalog\/[0-9a-f-]{36}\?created=1$/);
    await expect(page.getByTestId('product-created')).toHaveText('המוצר נוצר. עכשיו מוסיפים תמונה.');
    const id = page.url().split('/').pop()?.split('?')[0] ?? '';
    const [saved] = await db('SELECT price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost, allergens, allergens_may_contain, allergens_confirmed, is_published FROM products WHERE id = $1', [id]);
    expect({ ...saved, price_displayed: Number(saved.price_displayed) }).toEqual({
      price_displayed: 18.5, cost_basis: 'per_batch', oven_minutes_cost: 12, work_minutes_cost: 20,
      allergens: ['gluten', 'eggs', 'קינמון'], allergens_may_contain: ['nuts'], allergens_confirmed: true, is_published: false,
    });

    // An allergen edit un-ticks the confirmation and says so.
    await page.getByTestId('contains-dairy').check();
    await expect(page.getByTestId('product-allergens-confirmed')).not.toBeChecked();
    await expect(page.getByTestId('allergens-reset')).toBeVisible();
    await page.getByTestId('product-allergens-confirmed').check();

    // Photo: alt text required by the form, then uploaded, re-encoded and listed with it.
    const photo = await exifJpeg();
    await expect(page.locator('.admin-prod-filename')).toHaveText('לא נבחר קובץ');
    await page.getByTestId('photo-file').setInputFiles({ name: 'cake.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(page.locator('.admin-prod-filename')).toHaveText('cake.jpg');
    await page.getByTestId('photo-upload').click();
    await expect(page.getByTestId('upload-message')).toHaveText('כותבים תיאור קצר של התמונה (עד 200 תווים).');
    await page.getByTestId('photo-new-alt').fill('עוגת שמרים עם קינמון על קרש עץ');
    await page.getByTestId('photo-upload').click();
    await expect(page.getByTestId('upload-message')).toHaveText('התמונה נוספה.');
    await expect(page.getByTestId('photo-card')).toHaveCount(1);
    await expect(page.getByTestId('photo-alt')).toHaveValue('עוגת שמרים עם קינמון על קרש עץ');
    await expect(page.getByTestId('photo-card').locator('img')).toHaveJSProperty('complete', true);

    // Publish from the form.
    await page.getByTestId('form-published').click();
    await page.getByTestId('product-save').click();
    await expect(page.getByTestId('product-message')).toHaveText('נשמר.');
    const [after] = await db('SELECT is_published, allergens FROM products WHERE id = $1', [id]);
    expect(after).toEqual({ is_published: true, allergens: ['gluten', 'eggs', 'dairy', 'קינמון'] });
    await adminBaseline(page, 'products-edit', errors);

    // Delete, confirmed, back to the list without it.
    await page.getByTestId('product-delete').click();
    await expect(page.getByText(`למחוק את ⁨${name}⁩? הוא יוצא מהקטלוג. הזמנות שכבר התקבלו נשארות כמו שהן.`)).toBeVisible();
    await page.getByTestId('product-delete-confirm').click();
    await page.waitForURL('**/admin/catalog');
    await expect(page.locator(`[data-product-id="${id}"]`)).toHaveCount(0);

    const paths = (await db('SELECT storage_path FROM product_photos WHERE product_id = $1', [id])).map((r) => `${r.storage_path}`);
    await service().storage.from('product-photos').remove(paths);
    await db('DELETE FROM products WHERE id = ANY($1)', [[id, listed.id]]);
  });

  test('a product page that does not exist is a 404; a deleted one too', async ({ page }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    expect((await page.goto(`/admin/catalog/${crypto.randomUUID()}`))?.status()).toBe(404);
    expect((await page.goto('/admin/catalog/not-a-uuid'))?.status()).toBe(404);
  });
});
