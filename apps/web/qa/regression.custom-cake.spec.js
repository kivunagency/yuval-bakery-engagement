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
// api-006: approve / decline / live capacity check (admin at aal2).
// ---------------------------------------------------------------------------
const { createUser, uiLogin } = require('./helpers/admin-ui');
const { freshDay } = require('./helpers/db');

/** A request for its own far-future day with the given capacity; returns ids. */
async function requestOnFreshDay(request, { oven = 300, work = 300 } = {}) {
  const day = await withClient((db) => freshDay(db, { oven, work }));
  const phone = randomPhone();
  const res = await post(request, body({ desiredDate: day, phone }));
  expect(res.status()).toBe(201);
  const { requestId } = await res.json();
  created.push(requestId);
  return { requestId, day, phone };
}

test.describe('api-006 approve / decline', () => {
  test('without an aal2 admin session every admin route answers 401', async ({ request }) => {
    const { requestId } = await requestOnFreshDay(request);
    const h = { headers: { origin: ORIGIN } };
    expect((await request.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { ...h, data: { price: 100, ovenMinutes: 10, workMinutes: 10 } })).status()).toBe(401);
    expect((await request.post(`/api/admin/custom-cake-requests/${requestId}/decline`, { ...h, data: {} })).status()).toBe(401);
    expect((await request.get(`/api/admin/custom-cake-requests/${requestId}/capacity?oven=1&work=1`)).status()).toBe(401);
    const env = localEnv();
    const rpc = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/fn_admin_custom_cake_capacity_check`, {
      method: 'POST',
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_request_id: requestId, p_oven_minutes: 1, p_work_minutes: 1 }),
    });
    expect([401, 403, 404]).toContain(rpc.status);
  });

  test('approve: one transaction creates the payment_pending order and reserves exactly its minutes', async ({ page, request }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const { requestId, day } = await requestOnFreshDay(request, { oven: 300, work: 300 });

    // CSRF and contract.
    expect((await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { data: { price: 350, ovenMinutes: 90, workMinutes: 120 } })).status()).toBe(403);
    for (const data of [
      { price: 0, ovenMinutes: 90, workMinutes: 120 },
      { price: 350.001, ovenMinutes: 90, workMinutes: 120 },
      { price: 350, ovenMinutes: -1, workMinutes: 120 },
      { price: 350, ovenMinutes: 90, workMinutes: 1441 },
      { price: 350, ovenMinutes: 1.5, workMinutes: 120 },
      { price: 350, ovenMinutes: 90, workMinutes: 120, adminId: admin.userId },
    ]) {
      const r = await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { headers: { origin: ORIGIN }, data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
    }
    expect((await api.post('/api/admin/custom-cake-requests/not-a-uuid/approve', { headers: { origin: ORIGIN }, data: { price: 1, ovenMinutes: 1, workMinutes: 1 } })).status()).toBe(400);

    const check = await api.get(`/api/admin/custom-cake-requests/${requestId}/capacity?oven=90&work=120`);
    expect(await check.json()).toMatchObject({ day, fits: true, hasDay: true, isBlackout: false, dayPassed: false, ovenMinutesLeft: 300, workMinutesLeft: 300 });

    const res = await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { headers: { origin: ORIGIN }, data: { price: 350, ovenMinutes: 90, workMinutes: 120 } });
    expect(res.status()).toBe(200);
    const ok = await res.json();
    expect(ok).toMatchObject({ orderId: expect.any(String), orderNumber: expect.any(String), total: 350 });
    const token = ok.paymentPageUrl.split('/order/')[1];
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(ok.whatsappHref).toMatch(/^https:\/\/wa\.me\/9725\d{8}\?text=/);
    const text = decodeURIComponent(ok.whatsappHref.split('?text=')[1]);
    expect(text).toContain(ok.orderNumber);
    expect(text).toContain('350 ₪');
    expect(text).toContain(ok.paymentPageUrl);

    await withClient(async (db) => {
      const o = (await db.query(
        `SELECT status, order_source, custom_cake_request_id, total_displayed::float AS total, oven_minutes_cost, work_minutes_cost,
                delivery_date::text AS d, lookup_token_hash = fn_hash_token($2) AS token_ok, privacy_notice_version
         FROM orders WHERE id = $1`, [ok.orderId, token])).rows[0];
      expect(o).toEqual({ status: 'payment_pending', order_source: 'custom_cake', custom_cake_request_id: requestId, total: 350,
        oven_minutes_cost: 90, work_minutes_cost: 120, d: day, token_ok: true, privacy_notice_version: 'privacy-2026-10-v1' });
      const r = (await db.query('SELECT status, order_id, price_displayed::float AS p FROM custom_cake_requests WHERE id = $1', [requestId])).rows[0];
      expect(r).toEqual({ status: 'approved', order_id: ok.orderId, p: 350 });
      const l = (await db.query('SELECT oven_minutes_reserved, work_minutes_reserved, oven_minutes_unpaid_reserved, work_minutes_unpaid_reserved FROM capacity_day_ledger WHERE day = $1', [day])).rows[0];
      expect(l).toEqual({ oven_minutes_reserved: 90, work_minutes_reserved: 120, oven_minutes_unpaid_reserved: 90, work_minutes_unpaid_reserved: 120 });
      const a = (await db.query(`SELECT actor_id FROM audit_log WHERE action = 'custom_cake.approved' AND entity_id = $1`, [requestId])).rows;
      expect(a).toEqual([{ actor_id: admin.userId }]);
    });

    // Once approved it cannot be approved or declined again.
    const again = await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { headers: { origin: ORIGIN }, data: { price: 350, ovenMinutes: 90, workMinutes: 120 } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toBe('not_pending');
    const dec = await api.post(`/api/admin/custom-cake-requests/${requestId}/decline`, { headers: { origin: ORIGIN }, data: {} });
    expect(dec.status()).toBe(409);
  });

  test('capacity changed between check and click: 409, a fresh check, nothing written, never overbooked', async ({ page, request }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const { requestId, day } = await requestOnFreshDay(request, { oven: 100, work: 100 });
    expect((await (await api.get(`/api/admin/custom-cake-requests/${requestId}/capacity?oven=60&work=60`)).json()).fits).toBe(true);

    // A paid standard order takes most of the day in the meantime.
    await withClient((db) => db.query('UPDATE capacity_day_ledger SET oven_minutes_reserved = 50, work_minutes_reserved = 50 WHERE day = $1', [day]));

    const res = await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { headers: { origin: ORIGIN }, data: { price: 200, ovenMinutes: 60, workMinutes: 60 } });
    expect(res.status()).toBe(409);
    const j = await res.json();
    expect(j.error).toBe('capacity_changed');
    expect(j.check).toMatchObject({ fits: false, ovenMinutesLeft: 50, workMinutesLeft: 50 });
    await withClient(async (db) => {
      expect((await db.query('SELECT status, order_id FROM custom_cake_requests WHERE id = $1', [requestId])).rows[0]).toEqual({ status: 'pending_review', order_id: null });
      expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE custom_cake_request_id = $1', [requestId])).rows[0].n).toBe(0);
      expect((await db.query('SELECT oven_minutes_reserved, work_minutes_reserved FROM capacity_day_ledger WHERE day = $1', [day])).rows[0]).toEqual({ oven_minutes_reserved: 50, work_minutes_reserved: 50 });
    });
    // What still fits can be approved.
    const smaller = await api.post(`/api/admin/custom-cake-requests/${requestId}/approve`, { headers: { origin: ORIGIN }, data: { price: 200, ovenMinutes: 40, workMinutes: 35 } });
    expect(smaller.status()).toBe(200);
  });

  test('decline: optional reason, no capacity touched, WhatsApp text carries the reason', async ({ page, request }) => {
    const admin = await createUser({ admin: true, withTotp: true });
    await uiLogin(page, admin);
    const api = page.request;
    const { requestId, day } = await requestOnFreshDay(request);
    expect((await api.post(`/api/admin/custom-cake-requests/${requestId}/decline`, { headers: { origin: ORIGIN }, data: { reason: 'x'.repeat(301) } })).status()).toBe(400);
    const res = await api.post(`/api/admin/custom-cake-requests/${requestId}/decline`, { headers: { origin: ORIGIN }, data: { reason: 'היום הזה כבר מלא.' } });
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.declined).toBe(true);
    expect(decodeURIComponent(j.whatsappHref.split('?text=')[1])).toContain('היום הזה כבר מלא.');
    await withClient(async (db) => {
      expect((await db.query('SELECT status, decline_reason FROM custom_cake_requests WHERE id = $1', [requestId])).rows[0]).toEqual({ status: 'declined', decline_reason: 'היום הזה כבר מלא.' });
      expect((await db.query('SELECT oven_minutes_reserved FROM capacity_day_ledger WHERE day = $1', [day])).rows[0].oven_minutes_reserved).toBe(0);
    });
    // Without a reason too (fresh request).
    const other = await requestOnFreshDay(request);
    const r2 = await api.post(`/api/admin/custom-cake-requests/${other.requestId}/decline`, { headers: { origin: ORIGIN }, data: {} });
    expect(r2.status()).toBe(200);
    expect((await withClient((db) => db.query('SELECT decline_reason FROM custom_cake_requests WHERE id = $1', [other.requestId]))).rows[0].decline_reason).toBeNull();
  });

  test('the capacity check agrees with the real approval over a matrix of ledger states and costs', async ({ request }) => {
    const admin = await createUser({ admin: true, withTotp: false });
    const { requestId, day } = await requestOnFreshDay(request, { oven: 100, work: 100 });
    const ledgers = [
      [0, 0, 0, 0, false], [50, 50, 50, 50, false], [30, 30, 0, 0, false], [60, 10, 60, 10, false],
      [95, 95, 0, 0, false], [0, 0, 0, 0, true], [69, 0, 69, 0, false], [100, 100, 0, 0, false],
    ];
    const costs = [[0, 0], [1, 1], [5, 5], [30, 30], [35, 36], [40, 0], [0, 40], [70, 70], [71, 1], [100, 100], [101, 0]];
    const disagreements = [];
    let cases = 0;
    await withClient(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin.userId, role: 'authenticated', aal: 'aal2' })]);
        await db.query('SET LOCAL ROLE authenticated');
        for (const [ovenRes, workRes, ovenUnpaid, workUnpaid, blackout] of ledgers) {
          for (const [oven, work] of costs) {
            await db.query('SAVEPOINT c');
            await db.query('RESET ROLE');
            await db.query(
              `UPDATE capacity_day_ledger SET oven_minutes_reserved = $2, work_minutes_reserved = $3,
                 oven_minutes_unpaid_reserved = $4, work_minutes_unpaid_reserved = $5, is_blackout = $6 WHERE day = $1`,
              [day, ovenRes, workRes, ovenUnpaid, workUnpaid, blackout],
            );
            await db.query('SET LOCAL ROLE authenticated');
            const fits = (await db.query('SELECT (fn_admin_custom_cake_capacity_check($1, $2, $3) ->> \'fits\')::boolean AS f', [requestId, oven, work])).rows[0].f;
            let approved;
            try {
              await db.query('SAVEPOINT a');
              await db.query(`SELECT id FROM fn_approve_custom_cake_request($1, 100, $2, $3, 'qa-token-qa-token-qa-token', 'p', 't', 'c')`, [requestId, oven, work]);
              approved = true;
            } catch (e) {
              if (!String(e.message).startsWith('capacity_changed_recheck_before_approving')) throw e;
              approved = false;
              await db.query('ROLLBACK TO SAVEPOINT a');
            }
            cases += 1;
            if (fits !== approved) disagreements.push({ ledger: [ovenRes, workRes, ovenUnpaid, workUnpaid, blackout], cost: [oven, work], fits, approved });
            await db.query('ROLLBACK TO SAVEPOINT c');
          }
        }
      } finally {
        await db.query('ROLLBACK');
      }
    });
    expect(cases).toBe(ledgers.length * costs.length);
    expect(disagreements).toEqual([]);
  });
});
