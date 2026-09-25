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
