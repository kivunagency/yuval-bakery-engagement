// blindspot-002: business day and lead time are Asia/Jerusalem (BRIEF,
// Ran 2026-09-25), whatever zone the DB session runs in (UTC on Supabase and
// on the local stack). ADR-002 "Business day and lead time" records the rule.
// Run: npm run stack:up && npm run test:business-day
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../helpers/db.js');

let c;
before(async () => {
  const { Client } = require('pg');
  const { localEnv } = require('../helpers/env.js');
  c = new Client({ connectionString: process.env.DATABASE_URL_TEST || localEnv().DATABASE_URL_TEST });
  await c.connect();
});
after(async () => {
  await c.end();
});

// [instant (UTC), Jerusalem wall clock, business date, earliest delivery date]
const CASES = [
  ['2026-09-25T20:30:00Z', '23:30 Fri 25 Sep (summer, UTC+3)', '2026-09-25', '2026-09-26'],
  ['2026-09-25T21:30:00Z', '00:30 Sat 26 Sep: UTC still says the 25th', '2026-09-26', '2026-09-27'],
  ['2026-09-25T22:30:00Z', '01:30 Sat 26 Sep', '2026-09-26', '2026-09-27'],
  ['2026-12-01T21:59:00Z', '23:59 Tue 1 Dec (winter, UTC+2)', '2026-12-01', '2026-12-02'],
  ['2026-12-01T22:00:00Z', '00:00 Wed 2 Dec', '2026-12-02', '2026-12-03'],
  ['2026-10-24T21:30:00Z', '00:30 Sun 25 Oct, the night clocks go back', '2026-10-25', '2026-10-25'],
  ['2027-03-25T22:30:00Z', '00:30 Fri 26 Mar 2027, the night clocks go forward', '2027-03-26', '2027-03-27'],
];

describe('the DB computes the business day in Asia/Jerusalem, in any session zone', () => {
  test('the DB session zone really is UTC here (so a naive CURRENT_DATE is a UTC date)', async () => {
    const { rows } = await c.query('SHOW timezone');
    assert.match(rows[0].TimeZone, /UTC/);
  });

  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    test(`fn_business_date and fn_earliest_delivery_date, session zone ${zone}`, async () => {
      await c.query(`SET TIME ZONE '${zone}'`);
      try {
        for (const [at, label, day, earliest] of CASES) {
          const { rows } = await c.query(
            'SELECT fn_business_date($1::timestamptz)::text AS day, fn_earliest_delivery_date($1::timestamptz)::text AS earliest',
            [at],
          );
          assert.deepEqual(rows[0], { day, earliest }, label);
        }
      } finally {
        await c.query('RESET TIME ZONE');
      }
    });
  }

  test('the TypeScript rule (lib/shared/time) and the DB rule agree on 2000 instants, DST nights included', async () => {
    // Plain Node cannot import the TS module; this mirrors its one-line rule
    // (Intl in Asia/Jerusalem of instant + 24h) and tests/jerusalem.test.ts
    // pins the TS function to the same CASES table.
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
    const instants = [];
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 2000; i += 1) instants.push(new Date(start + i * 4.37 * 3600 * 1000).toISOString());
    const { rows } = await c.query(
      `SELECT t::text AS at, fn_earliest_delivery_date(t)::text AS earliest FROM unnest($1::timestamptz[]) AS t`, [instants]);
    const mismatches = rows.filter((r, i) => fmt.format(new Date(Date.parse(instants[i]) + 24 * 3600 * 1000)) !== r.earliest);
    assert.deepEqual(mismatches, []);
  });
});

describe('lead time is enforced by the DB, not only the UI (24 hours, Asia/Jerusalem)', () => {
  async function dayRow(day) {
    await c.query(
      `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 1000, 1000)
       ON CONFLICT (day) DO UPDATE SET is_blackout = false`,
      [day],
    );
  }

  async function today() {
    const { rows } = await c.query(`SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date::text AS today,
      ((now() + interval '24 hours') AT TIME ZONE 'Asia/Jerusalem')::date::text AS earliest`);
    return rows[0];
  }

  test('a standard order for today (Jerusalem) is refused with lead_time_not_met', async () => {
    const { today: day } = await today();
    await dayRow(day);
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    await assert.rejects(db.createOrder(c, day, product, 1), /lead_time_not_met/);
  });

  test('a standard order for a past date is refused', async () => {
    const { today: t } = await today();
    const { rows } = await c.query(`SELECT ($1::date - 3)::text AS d`, [t]);
    await dayRow(rows[0].d);
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    await assert.rejects(db.createOrder(c, rows[0].d, product, 1), /lead_time_not_met/);
  });

  test('the earliest allowed date is accepted, the day before it is refused', async () => {
    const { earliest } = await today();
    const { rows } = await c.query(`SELECT ($1::date - 1)::text AS d`, [earliest]);
    await dayRow(earliest);
    await dayRow(rows[0].d);
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    assert.equal((await db.createOrder(c, earliest, product, 1)).status, 'payment_pending');
    await assert.rejects(db.createOrder(c, rows[0].d, product, 1), /lead_time_not_met/);
  });

  test('refusal holds whatever the session zone is', async () => {
    const { today: day } = await today();
    await dayRow(day);
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    await c.query(`SET TIME ZONE 'Pacific/Kiritimati'`); // UTC+14: its "today" can be Jerusalem's tomorrow
    try {
      await assert.rejects(db.createOrder(c, day, product, 1), /lead_time_not_met/);
    } finally {
      await c.query('RESET TIME ZONE');
    }
  });

  test('a custom-cake request for today (Jerusalem) is refused', async () => {
    const { today: day } = await today();
    await assert.rejects(
      c.query(`INSERT INTO custom_cake_requests (requester_name, requester_phone, notes, desired_date, upload_rights_confirmed_at)
               VALUES ('QA', $1, 'qa cake', $2, now())`, [db.randomPhone(), day]),
      /lead_time_not_met/,
    );
  });

  test('approving a custom cake close to the day is Yuval\'s call, not blocked by the lead time', async () => {
    // The customer asked >= 24h ahead (checked on the request). Yuval may
    // approve later, closer to the day; the order that approval creates has
    // order_source = custom_cake and is exempt.
    const { earliest, today: day } = await today();
    const crypto = require('node:crypto');
    const adminId = crypto.randomUUID();
    await c.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [adminId, `tz-admin-${adminId}@example.test`]);
    await c.query(`INSERT INTO admins (id, display_name) VALUES ($1, 'QA tz admin')`, [adminId]);
    await dayRow(day);
    const { rows } = await c.query(
      `INSERT INTO custom_cake_requests (requester_name, requester_phone, notes, desired_date, upload_rights_confirmed_at)
       VALUES ('QA', $1, 'qa cake', $2, now()) RETURNING id`, [db.randomPhone(), earliest]);
    // time passes: the requested day is now today (simulated by moving the date)
    await c.query('UPDATE custom_cake_requests SET desired_date = $2 WHERE id = $1', [rows[0].id, day]);
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal2' })]);
      await c.query('SET LOCAL ROLE authenticated');
      const { rows: o } = await c.query(
        `SELECT status, delivery_date::text AS d, order_source FROM fn_approve_custom_cake_request($1, 100, 5, 5, $2, 'privacy-2026-10-v1', 'terms-2026-10-v1', 'cancellation-2026-10-v1')`,
        [rows[0].id, crypto.randomBytes(24).toString('hex')]);
      assert.deepEqual(o[0], { status: 'payment_pending', d: day, order_source: 'custom_cake' });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
});
