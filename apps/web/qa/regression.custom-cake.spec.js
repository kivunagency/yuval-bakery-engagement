// @ts-check
// Regression: custom-cake domain (api-005 request endpoint; later tasks add
// the form, the admin queue and approval). Runs against a local production
// build and the local stack (npm run stack:up). Setup and inspection use the
// postgres superuser; every behaviour under test goes through HTTP, the way
// the browser calls it.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const { localEnv } = require('./helpers/env');
const { withClient, randomIp, randomPhone } = require('./helpers/db');

const PORT = Number(process.env.PORT || 3100);
const ORIGIN = `http://localhost:${PORT}`;

/** A valid request body; override any field. */
function body(over = {}) {
  return {
    name: 'QA Cake Guest',
    phone: randomPhone().replace('+972', '0'),
    inscription: 'Happy birthday',
    notes: 'chocolate, two layers',
    desiredDate: '',
    uploadRightsConfirmed: true,
    photos: [],
    ...over,
  };
}

async function earliestDate(offsetDays = 0) {
  return withClient(async (db) => {
    const { rows } = await db.query(`SELECT (fn_earliest_delivery_date(now()) + $1::int)::text AS d`, [offsetDays]);
    return rows[0].d;
  });
}

async function post(request, data, { ip = randomIp(), origin = ORIGIN } = {}) {
  const headers = { 'x-nf-client-connection-ip': ip, 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return request.post('/api/custom-cake-requests', { data, headers });
}

async function storageUp() {
  const env = localEnv();
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/status`);
    return res.ok;
  } catch {
    return false;
  }
}

const created = [];
test.afterAll(async () => {
  if (created.length === 0) return;
  await withClient((db) => db.query('DELETE FROM custom_cake_requests WHERE id = ANY($1::uuid[])', [created]));
});

test.describe('api-005 POST /api/custom-cake-requests', () => {
  test('creates a pending_review request, holds no capacity, creates no order', async ({ request }) => {
    const day = await earliestDate(40);
    const ledgerBefore = await withClient((db) => db.query('SELECT * FROM capacity_day_ledger WHERE day = $1', [day]));
    const phoneLocal = `050-${String(Date.now()).slice(-7, -4)}-${String(Date.now()).slice(-4)}`;

    const res = await post(request, body({ desiredDate: day, phone: phoneLocal, email: '', whatsappFollowupOk: true }));
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ requestId: expect.any(String), uploads: [], photosUnavailable: false });
    created.push(json.requestId);

    await withClient(async (db) => {
      const { rows } = await db.query('SELECT * FROM custom_cake_requests WHERE id = $1', [json.requestId]);
      const r = rows[0];
      expect(r.status).toBe('pending_review');
      expect(r.requester_phone).toBe(`+972${phoneLocal.replace(/-/g, '').slice(1)}`);
      expect(r.requester_email).toBeNull();
      expect(r.whatsapp_followup_ok).toBe(true);
      expect(r.upload_rights_confirmed_at).not.toBeNull();
      expect(r.privacy_notice_version).toBe('privacy-2026-10-v1');
      expect(r.price_displayed).toBeNull();
      expect(r.oven_minutes_cost).toBeNull();
      expect(r.order_id).toBeNull();
      const orders = await db.query('SELECT count(*)::int AS n FROM orders WHERE custom_cake_request_id = $1', [json.requestId]);
      expect(orders.rows[0].n).toBe(0);
      const ledgerAfter = await db.query('SELECT * FROM capacity_day_ledger WHERE day = $1', [day]);
      expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
      const audit = await db.query(`SELECT actor_id, metadata FROM audit_log WHERE entity_id = $1 AND action = 'custom_cake.submitted'`, [json.requestId]);
      expect(audit.rows).toEqual([{ actor_id: 'custom_cake:anon', metadata: {} }]);
    });
  });

  test('refuses invalid input with 400 and writes nothing', async ({ request }) => {
    const day = await earliestDate(41);
    const phone = randomPhone();
    const bad = [
      body({ desiredDate: day, phone, uploadRightsConfirmed: false }),
      { ...body({ desiredDate: day, phone }), uploadRightsConfirmed: undefined },
      body({ desiredDate: day, phone, inscription: 'x'.repeat(121) }),
      body({ desiredDate: day, phone, notes: 'x'.repeat(501) }),
      body({ desiredDate: day, phone, name: 'x'.repeat(61) }),
      body({ desiredDate: day, phone, name: '   ' }),
      body({ desiredDate: day, phone: '03-1234567' }),
      body({ desiredDate: day, phone, email: 'not-an-email' }),
      body({ desiredDate: '2026-02-30', phone }),
      body({ desiredDate: day, phone, photos: Array(4).fill({ type: 'image/jpeg', size: 1000 }) }),
      body({ desiredDate: day, phone, photos: [{ type: 'image/svg+xml', size: 1000 }] }),
      body({ desiredDate: day, phone, photos: [{ type: 'image/gif', size: 1000 }] }),
      body({ desiredDate: day, phone, photos: [{ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }] }),
      body({ desiredDate: day, phone, price: 1 }),
      body({ desiredDate: day, phone, ovenMinutes: 0 }),
    ];
    for (const data of bad) {
      const res = await post(request, data);
      expect(res.status(), JSON.stringify(data).slice(0, 120)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_input' });
    }
    const n = await withClient((db) => db.query('SELECT count(*)::int AS n FROM custom_cake_requests WHERE requester_phone = $1', [phone]));
    expect(n.rows[0].n).toBe(0);
  });

  test('refuses a date inside the lead time (DB trigger) with 422', async ({ request }) => {
    const res = await post(request, body({ desiredDate: await earliestDate(-1) }));
    expect(res.status()).toBe(422);
    expect(await res.json()).toEqual({ error: 'lead_time_not_met' });
  });

  test('rate limits per IP (shared with checkout) and open requests per phone', async ({ request }) => {
    const day = await earliestDate(42);
    const ip = randomIp();
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await post(request, body({ desiredDate: day }), { ip });
      statuses.push(res.status());
      if (res.status() === 201) created.push((await res.json()).requestId);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);

    const phone = randomPhone();
    const perPhone = [];
    for (let i = 0; i < 3; i++) {
      const res = await post(request, body({ desiredDate: day, phone }));
      perPhone.push(res.status());
      if (res.status() === 201) created.push((await res.json()).requestId);
    }
    expect(perPhone).toEqual([201, 201, 429]);
  });

  test('refuses a cross-site or Origin-less POST with 403', async ({ request }) => {
    const day = await earliestDate(43);
    expect((await post(request, body({ desiredDate: day }), { origin: null })).status()).toBe(403);
    expect((await post(request, body({ desiredDate: day }), { origin: 'https://evil.example' })).status()).toBe(403);
  });

  test('stores customer text verbatim (escaping is the renderer\'s job, SEC-025)', async ({ request }) => {
    const inscription = '<script>alert(1)</script>';
    const res = await post(request, body({ desiredDate: await earliestDate(44), inscription }));
    expect(res.status()).toBe(201);
    const { requestId } = await res.json();
    created.push(requestId);
    const row = await withClient((db) => db.query('SELECT inscription_text FROM custom_cake_requests WHERE id = $1', [requestId]));
    expect(row.rows[0].inscription_text).toBe(inscription);
  });

  test('the DB functions are not callable with the anon key over PostgREST', async () => {
    const env = localEnv();
    for (const fn of ['fn_submit_custom_cake_request', 'fn_attach_custom_cake_photo']) {
      const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect([401, 403, 404]).toContain(res.status);
    }
  });

  test('photos: when Storage cannot issue upload URLs the request still stands and says so', async ({ request }) => {
    test.skip(await storageUp(), 'Storage is up: the degraded path is not reachable');
    const res = await post(request, body({ desiredDate: await earliestDate(45), photos: [{ type: 'image/jpeg', size: 2048 }] }));
    expect(res.status()).toBe(201);
    const json = await res.json();
    created.push(json.requestId);
    expect(json.uploads).toEqual([]);
    expect(json.photosUnavailable).toBe(true);
  });

  test('photos: signed upload, re-encode without EXIF, private path recorded', async ({ request }) => {
    test.skip(!(await storageUp()), 'DID NOT RUN: no Storage server in the local stack (task infra-local-storage blocked)');
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#aa5500' } })
      .withExif({ IFD0: { Make: 'QA-PHONE' } })
      .jpeg()
      .toBuffer();
    const res = await post(request, body({ desiredDate: await earliestDate(46), photos: [{ type: 'image/jpeg', size: photo.length }] }));
    expect(res.status()).toBe(201);
    const { requestId, uploads } = await res.json();
    created.push(requestId);
    expect(uploads).toHaveLength(1);
    const put = await fetch(uploads[0].url, { method: 'PUT', body: photo, headers: { 'content-type': 'image/jpeg' } });
    expect(put.ok).toBe(true);
    const fin = await request.post(`/api/custom-cake-requests/${requestId}/photos`, { headers: { origin: ORIGIN } });
    expect(await fin.json()).toEqual({ accepted: 1, rejected: 0 });
    const rows = await withClient((db) => db.query('SELECT storage_path FROM custom_cake_photos WHERE custom_cake_request_id = $1', [requestId]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].storage_path).toMatch(new RegExp(`^requests/${requestId}/[0-9a-f-]{36}\\.jpg$`));
  });
});

// ---------------------------------------------------------------------------
// client-002: the public form at /custom-cake and its confirmation screen.
// ---------------------------------------------------------------------------
const { checkPublicBaseline } = require('./helpers/baseline');

test.describe('client-002 custom-cake form', () => {
  test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-nf-client-connection-ip': randomIp() });
  });

  test('baseline: /custom-cake', async ({ page }) => {
    await checkPublicBaseline(page, '/custom-cake', 'custom-cake-form');
  });

  test('baseline: /custom-cake/sent, with and without the photo note', async ({ page }) => {
    await checkPublicBaseline(page, '/custom-cake/sent', 'custom-cake-sent');
    await checkPublicBaseline(page, '/custom-cake/sent?photos=unavailable', 'custom-cake-sent-photos-unavailable');
    await expect(page.getByText('התמונות לא עלו. אפשר לשלוח אותן אלינו בוואטסאפ.')).toBeVisible();
    // Only the two known values render a note; anything else is ignored.
    await page.goto('/custom-cake/sent?photos=<b>x</b>');
    await expect(page.locator('main')).not.toContainText('<b>');
    await expect(page.getByText('התמונות לא עלו')).toHaveCount(0);
  });

  test('the catalog row links here and the page arrives server-rendered', async ({ page, request }) => {
    const html = await (await request.get('/custom-cake')).text();
    expect(html).toContain('data-testid="privacy-notice-at-collection"');
    expect(html).toContain('data-context="custom_cake"');
    await page.goto('/');
    await page.locator('a[href="/custom-cake"]').first().click();
    await expect(page).toHaveURL(/\/custom-cake$/);
    await expect(page.getByRole('heading', { level: 1, name: 'עוגה בהתאמה אישית' })).toBeVisible();
  });

  test('privacy notice comes before the first personal field; notes hint is wired; date minimum is the lead time', async ({ page }) => {
    await page.goto('/custom-cake');
    const order = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="privacy-notice-at-collection"]');
      const firstInput = document.querySelector('form input, form textarea');
      return notice && firstInput ? notice.compareDocumentPosition(firstInput) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order).toBeTruthy();
    const notes = page.getByLabel('מה עוד חשוב שנדע (לא חובה)');
    const hintId = await page.getByTestId('notes-field-hint').getAttribute('id');
    expect((await notes.getAttribute('aria-describedby')) ?? '').toContain(hintId);
    expect(await page.getByLabel('לאיזה יום?').getAttribute('min')).toBe(await earliestDate(0));
    // Inputs keep their own direction: phone and email are LTR.
    await expect(page.getByLabel('טלפון נייד')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel('אימייל (לא חובה)')).toHaveAttribute('dir', 'ltr');
  });

  test('without the rights confirmation nothing is sent and the error says why', async ({ page }) => {
    const phone = randomPhone();
    await page.goto('/custom-cake');
    await page.getByLabel('שם', { exact: true }).fill('QA Form Guest');
    await page.getByLabel('טלפון נייד').fill(phone.replace('+972', '0'));
    await page.getByLabel('לאיזה יום?').fill(await earliestDate(50));
    let posted = false;
    page.on('request', (r) => r.url().includes('/api/custom-cake-requests') && (posted = true));
    await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
    await expect(page.getByText('צריך לאשר את הזכויות בתמונות כדי לשלוח.')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /התמונות שאני מעלה/ })).toBeFocused();
    expect(posted).toBe(false);
  });

  test('field errors: bad phone, empty name, a day inside the lead time', async ({ page }) => {
    await page.goto('/custom-cake');
    await page.getByLabel('טלפון נייד').fill('03-1234567');
    await page.getByLabel('לאיזה יום?').fill(await earliestDate(-1));
    await page.getByRole('checkbox', { name: /התמונות שאני מעלה/ }).check();
    await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
    await expect(page.getByText('צריך למלא שם, עד 60 תווים.')).toBeVisible();
    await expect(page.getByText('צריך מספר נייד ישראלי שמתחיל ב-05.')).toBeVisible();
    await expect(page.getByText('היום הזה קרוב מדי. אפשר לבקש לפחות 24 שעות מראש.')).toBeVisible();
    await expect(page.getByLabel('שם', { exact: true })).toBeFocused();
    await expect(page.getByLabel('טלפון נייד')).toHaveAttribute('aria-invalid', 'true');
  });

  test('send a request: lands on the confirmation, the row is pending_review with what was typed', async ({ page }) => {
    const phone = randomPhone();
    const day = await earliestDate(51);
    await page.goto('/custom-cake');
    await page.getByLabel('שם', { exact: true }).fill('QA Form Guest');
    await page.getByLabel('טלפון נייד').fill(phone.replace('+972', '0'));
    await page.getByLabel('אימייל (לא חובה)').fill('qa-form@example.test');
    await page.getByRole('checkbox', { name: 'אפשר לחזור אליי בוואטסאפ' }).check();
    await page.getByLabel('לאיזה יום?').fill(day);
    await page.getByLabel('טקסט על העוגה (לא חובה)').fill('מזל טוב נועה 7');
    await expect(page.getByText('14 מתוך 120 תווים')).toBeVisible();
    await page.getByLabel('מה עוד חשוב שנדע (לא חובה)').fill('שכבות שוקולד');
    await page.getByRole('checkbox', { name: /התמונות שאני מעלה/ }).check();
    await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
    await expect(page).toHaveURL(/\/custom-cake\/sent$/);
    await expect(page.getByRole('heading', { level: 1, name: 'הבקשה נשלחה' })).toBeVisible();

    const rows = await withClient((db) =>
      db.query('SELECT id, status, requester_name, requester_email, whatsapp_followup_ok, inscription_text, notes, desired_date::text AS d FROM custom_cake_requests WHERE requester_phone = $1', [phone]),
    );
    expect(rows.rows).toHaveLength(1);
    created.push(rows.rows[0].id);
    expect(rows.rows[0]).toMatchObject({
      status: 'pending_review', requester_name: 'QA Form Guest', requester_email: 'qa-form@example.test',
      whatsapp_followup_ok: true, inscription_text: 'מזל טוב נועה 7', notes: 'שכבות שוקולד', d: day,
    });
  });

  test('a photo that cannot be uploaded: the request is kept and the confirmation says to send it on WhatsApp', async ({ page }) => {
    test.skip(await storageUp(), 'Storage is up: the degraded path is not reachable');
    const phone = randomPhone();
    const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa5500' } }).jpeg().toBuffer();
    await page.goto('/custom-cake');
    await page.getByLabel('שם', { exact: true }).fill('QA Photo Guest');
    await page.getByLabel('טלפון נייד').fill(phone.replace('+972', '0'));
    await page.getByLabel('לאיזה יום?').fill(await earliestDate(52));
    await page.getByLabel('תמונות השראה (לא חובה)').setInputFiles({ name: 'cake.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.getByRole('checkbox', { name: /התמונות שאני מעלה/ }).check();
    await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
    await expect(page).toHaveURL(/\/custom-cake\/sent\?photos=unavailable$/);
    await expect(page.getByText('התמונות לא עלו. אפשר לשלוח אותן אלינו בוואטסאפ.')).toBeVisible();
    await expect(page.getByTestId('contact-block')).toBeVisible();
    const rows = await withClient((db) => db.query('SELECT id FROM custom_cake_requests WHERE requester_phone = $1', [phone]));
    expect(rows.rows).toHaveLength(1);
    created.push(rows.rows[0].id);
  });

  test('a 4th photo or an SVG is refused in the browser before anything is sent', async ({ page }) => {
    await page.goto('/custom-cake');
    await page.getByLabel('שם', { exact: true }).fill('QA Photo Guest');
    await page.getByLabel('טלפון נייד').fill(randomPhone().replace('+972', '0'));
    await page.getByLabel('לאיזה יום?').fill(await earliestDate(53));
    await page.getByLabel('תמונות השראה (לא חובה)').setInputFiles([
      { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ]);
    await page.getByRole('checkbox', { name: /התמונות שאני מעלה/ }).check();
    let posted = false;
    page.on('request', (r) => r.url().includes('/api/custom-cake-requests') && (posted = true));
    await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
    await expect(page.getByText('עד 3 תמונות, JPG, PNG או WebP, עד 10MB כל אחת.', { exact: true })).toBeVisible();
    expect(posted).toBe(false);
  });
});
