// @ts-check
// job-001 regression: the scheduled functions, run exactly as Netlify would
// run them (the built netlify/functions/*.mjs bundles, invoked in plain Node),
// against the local stack. Needs `npm run build:functions` and `npm run stack:up`.
// What this does NOT prove: that Netlify actually schedules them (DID NOT RUN
// until a Netlify site exists, infra-002).
const { test, expect } = require('@playwright/test');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@supabase/supabase-js');
const { localEnv } = require('./helpers/env');
const db = require('./helpers/db');

const FUNCTIONS = join(__dirname, '..', 'netlify', 'functions');
const EXPIRY_JOB = 'expire_payment_pending_orders';
const RETENTION_JOB = 'retention_sweep';

/** Load a built function with the local stack's env, like Netlify injects it. */
async function loadFunction(name) {
  Object.assign(process.env, localEnv());
  return import(pathToFileURL(join(FUNCTIONS, `${name}.mjs`)).href);
}

async function invoke(name) {
  const mod = await loadFunction(name);
  const res = await mod.default(new Request('http://localhost/.netlify/functions/' + name, { method: 'POST', body: '{"next_run":"x"}' }));
  return { status: res.status, body: await res.json(), config: mod.config };
}

// The sweep is global (every stale order in the DB), so these tests must not
// interleave with each other.
test.describe.configure({ mode: 'serial' });

test.describe('job-001 expiry sweep (netlify/functions/expire-orders.mjs)', () => {
  test('is scheduled every 15 minutes', async () => {
    const mod = await loadFunction('expire-orders');
    expect(mod.config).toEqual({ schedule: '*/15 * * * *' });
  });

  test('expires a stale order, releases exactly its minutes, writes the heartbeat', async () => {
    await db.withClient(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 20 });
      const stale = await db.createOrder(c, day, product, 1);
      const fresh = await db.createOrder(c, day, product, 1);
      await db.backdateExpiry(c, stale.id);
      expect(await db.ledger(c, day)).toMatchObject({ oven_minutes_reserved: 20, work_minutes_reserved: 40, oven_minutes_unpaid_reserved: 20 });
      const before = await db.heartbeat(c, EXPIRY_JOB);

      const { status, body } = await invoke('expire-orders');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, failed: 0, heartbeat: 'written_by_db' });
      expect(body.expired).toBeGreaterThanOrEqual(1);

      const { rows } = await c.query('SELECT id, status, expired_at FROM orders WHERE id = ANY($1)', [[stale.id, fresh.id]]);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[stale.id].status).toBe('expired');
      expect(byId[stale.id].expired_at).not.toBeNull();
      expect(byId[fresh.id].status).toBe('payment_pending');
      // exactly one order's minutes came back, the fresh one still holds its own
      expect(await db.ledger(c, day)).toMatchObject({
        oven_minutes_reserved: 10, work_minutes_reserved: 20, oven_minutes_unpaid_reserved: 10, work_minutes_unpaid_reserved: 20,
      });

      const after = await db.heartbeat(c, EXPIRY_JOB);
      expect(after.last_error).toBeNull();
      expect(after.last_success_at.getTime()).toBeGreaterThan(before.last_success_at?.getTime() ?? 0);
      const { rows: audit } = await c.query(
        `SELECT actor_id FROM audit_log WHERE entity_id = $1 AND action = 'order.expired'`, [stale.id]);
      expect(audit).toEqual([{ actor_id: 'cron:job-001' }]);
    });
  });

  test('a second run (retry, double fire) releases nothing twice', async () => {
    await db.withClient(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 7, work: 3 });
      const o = await db.createOrder(c, day, product, 2);
      await db.backdateExpiry(c, o.id);
      await invoke('expire-orders');
      const once = await db.ledger(c, day);
      expect(once).toMatchObject({ oven_minutes_reserved: 0, work_minutes_reserved: 0 });
      await invoke('expire-orders');
      expect(await db.ledger(c, day)).toEqual(once);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'order.expired'`, [o.id]);
      expect(rows[0].n).toBe(1);
    });
  });

  test('writes the heartbeat when nothing is due (keep-alive, ADR-001)', async () => {
    await db.withClient(async (c) => {
      // clear anything stale left by other suites so this run has no work
      await (await loadFunction('expire-orders')).default();
      const before = await db.heartbeat(c, EXPIRY_JOB);
      const { body } = await invoke('expire-orders');
      expect(body).toMatchObject({ ok: true, expired: 0, failed: 0 });
      const after = await db.heartbeat(c, EXPIRY_JOB);
      expect(after.last_run_at.getTime()).toBeGreaterThan(before.last_run_at.getTime());
      expect(after.last_success_at.getTime()).toBeGreaterThan(before.last_success_at.getTime());
    });
  });

  test('one order that cannot be released does not block the others, and the failure is recorded', async () => {
    await db.withClient(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const poisonDay = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      const good = await db.createOrder(c, day, product, 1);
      const poison = await db.createOrder(c, poisonDay, product, 1);
      await db.backdateExpiry(c, good.id);
      await db.backdateExpiry(c, poison.id, 10); // oldest, so it is released first
      // Corrupt the poison day's ledger (a bug elsewhere): releasing 10 minutes
      // would take it below zero, which the ledger CHECK must refuse loudly.
      await c.query(`UPDATE capacity_day_ledger SET oven_minutes_reserved = 5, oven_minutes_unpaid_reserved = 5 WHERE day = $1`, [poisonDay]);
      const before = await db.heartbeat(c, EXPIRY_JOB);
      try {
        const { status, body } = await invoke('expire-orders');
        expect(status).toBe(500);
        expect(body.ok).toBe(false);
        expect(body.failed).toBe(1);
        expect(body.error).toContain(poison.id);

        const { rows } = await c.query('SELECT id, status FROM orders WHERE id = ANY($1)', [[good.id, poison.id]]);
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
        expect(byId[good.id]).toBe('expired'); // not held hostage by the poison order
        expect(byId[poison.id]).toBe('payment_pending'); // its flip rolled back with its release
        expect(await db.ledger(c, day)).toMatchObject({ oven_minutes_reserved: 0 });

        const after = await db.heartbeat(c, EXPIRY_JOB);
        expect(after.last_error).toContain('failed to expire');
        expect(after.last_run_at.getTime()).toBeGreaterThan(before.last_run_at.getTime());
        expect(after.last_success_at).toEqual(before.last_success_at); // not a success
      } finally {
        // repair, and let the next run clear it
        await c.query(`UPDATE capacity_day_ledger SET oven_minutes_reserved = 10, oven_minutes_unpaid_reserved = 10 WHERE day = $1`, [poisonDay]);
        await invoke('expire-orders');
      }
      expect((await db.heartbeat(c, EXPIRY_JOB)).last_error).toBeNull();
    });
  });

  test('expire never touches a paid order, even when its expiry time has passed', async () => {
    await db.withClient(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      const o = await db.createOrder(c, day, product, 1);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_status_change', 'true', true)`);
      await c.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
      await c.query(`UPDATE capacity_day_ledger SET oven_minutes_unpaid_reserved = 0, work_minutes_unpaid_reserved = 0 WHERE day = $1`, [day]);
      await c.query('COMMIT');
      await db.backdateExpiry(c, o.id);
      await invoke('expire-orders');
      const { rows } = await c.query('SELECT status FROM orders WHERE id = $1', [o.id]);
      expect(rows[0].status).toBe('paid');
      expect(await db.ledger(c, day)).toMatchObject({ oven_minutes_reserved: 10 });
    });
  });
});

test.describe('job-001 daily retention (netlify/functions/retention-daily.mjs)', () => {
  test('is scheduled daily at 00:40 UTC', async () => {
    const mod = await loadFunction('retention-daily');
    expect(mod.config).toEqual({ schedule: '40 0 * * *' });
  });

  test('anonymizes records past retention, purges old attempt rows, reports Storage as DID NOT RUN', async () => {
    await db.withClient(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      const o = await db.createOrder(c, day, product, 1);
      await db.backdateExpiry(c, o.id);
      await invoke('expire-orders');
      await c.query(`UPDATE orders SET retention_until = now() - interval '1 day' WHERE id = $1`, [o.id]);
      const ip = db.randomIp();
      await c.query(`INSERT INTO order_attempt_log (ip_address, phone_e164, created_at) VALUES ($1, '+972500000000', now() - interval '400 days')`, [ip]);

      const { status, body } = await invoke('retention-daily');
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.heartbeat).toBe('written_by_wrapper');
      expect(body.steps.map((s) => s.step)).toEqual([
        'anonymize_due_records', 'purge_order_attempts', 'purge_lookup_attempts', 'purge_audit_log', 'purge_push_subscriptions',
        'purge_notification_attempts',
      ]);
      expect(body.steps.every((s) => s.ok)).toBe(true);
      expect(Object.keys(body.did_not_run)).toEqual(['storage_photo_deletion', 'storage_confirmation_pdf_deletion', 'customer_hard_delete']);

      const { rows } = await c.query('SELECT guest_name, guest_phone, pii_purged_at, total_displayed FROM orders WHERE id = $1', [o.id]);
      expect(rows[0]).toMatchObject({ guest_name: null, guest_phone: null });
      expect(rows[0].pii_purged_at).not.toBeNull();
      expect(Number(rows[0].total_displayed)).toBeGreaterThan(0); // accounting data kept
      const { rows: left } = await c.query('SELECT count(*)::int AS n FROM order_attempt_log WHERE ip_address = $1', [ip]);
      expect(left[0].n).toBe(0);
      const hb = await db.heartbeat(c, RETENTION_JOB);
      expect(hb.last_error).toBeNull();
      expect(hb.last_success_at).not.toBeNull();
    });
  });

  test('a failing step is recorded in the heartbeat and does not stop the other steps', async () => {
    await db.withClient(async (c) => {
      const { rows: saved } = await c.query(`SELECT value FROM app_settings WHERE key = 'audit_log_retention_years'`);
      await c.query(`DELETE FROM app_settings WHERE key = 'audit_log_retention_years'`);
      try {
        const { status, body } = await invoke('retention-daily');
        expect(status).toBe(500);
        expect(body.ok).toBe(false);
        const byStep = Object.fromEntries(body.steps.map((s) => [s.step, s]));
        expect(byStep.purge_audit_log.ok).toBe(false);
        expect(byStep.purge_audit_log.error).toContain('retention_setting_missing');
        expect(byStep.purge_push_subscriptions.ok).toBe(true); // ran after the failure
        const hb = await db.heartbeat(c, RETENTION_JOB);
        expect(hb.last_error).toContain('purge_audit_log');
      } finally {
        await c.query(`INSERT INTO app_settings (key, value, description) VALUES ('audit_log_retention_years', $1, 'B4b, pending accountant confirmation.')`, [JSON.stringify(saved[0].value)]);
      }
    });
  });
});

test.describe('job and capacity internals are not callable over the public API (SEC-007, SEC-001)', () => {
  // Real PostgREST path, anon key and a signed-in non-admin: what an attacker has.
  const SERVICE_ONLY = [
    ['fn_expire_stale_orders', {}],
    ['fn_record_cron_run', { p_job_name: 'expire_payment_pending_orders', p_ok: true }],
    ['fn_run_retention_sweep', {}],
    ['fn_anonymize_order', { p_order_id: '00000000-0000-0000-0000-000000000000' }],
    ['fn_anonymize_custom_cake_request', { p_request_id: '00000000-0000-0000-0000-000000000000' }],
    ['fn_purge_old_order_attempts', {}],
    ['fn_purge_old_lookup_attempts', {}],
    ['fn_purge_old_audit_log', {}],
    ['fn_purge_old_push_subscriptions', {}],
    ['fn_photos_due_for_purge', {}],
    ['fn_mark_photos_purged', { p_request_id: '00000000-0000-0000-0000-000000000000' }],
    ['fn_mark_confirmation_pdf_purged', { p_order_id: '00000000-0000-0000-0000-000000000000' }],
    ['fn_retention_due', {}],
    ['fn_customers_due_for_hard_delete', {}],
    ['fn_unsubscribe_by_token', { p_token: 'x' }],
    ['fn_reserve_capacity', { p_day: '2036-01-01', p_oven_minutes: 1, p_work_minutes: 1 }],
  ];

  for (const who of ['anon', 'authenticated']) {
    test(`${who}: every job/capacity internal is refused with permission denied`, async () => {
      const env = localEnv();
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      if (who === 'authenticated') {
        const email = `customer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
        const { error } = await client.auth.signUp({ email, password: 'qa-password-123456' });
        expect(error).toBeNull();
      }
      const allowed = [];
      for (const [fn, args] of SERVICE_ONLY) {
        const { error } = await client.rpc(fn, args);
        if (!error || !/permission denied/.test(error.message)) allowed.push(`${fn}: ${error ? error.message : 'EXECUTED'}`);
      }
      expect(allowed).toEqual([]);
    });
  }

  test('anon cannot call admin functions either (refused before the function body)', async () => {
    const env = localEnv();
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error } = await anon.rpc('fn_cancel_order', { p_order_id: '00000000-0000-0000-0000-000000000000' });
    expect(error?.message).toMatch(/permission denied/);
  });
});
