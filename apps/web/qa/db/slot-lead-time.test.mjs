// api-003: the 24-hour lead time is measured to the START of the chosen time
// slot (Asia/Jerusalem), and the DB enforces it at order insert
// (trg_orders_lead_time -> fn_slot_meets_lead_time), so no caller can skip it.
// RED before migration 20260926050000 (2026-09-26 01:19 Jerusalem): an order
// for 2026-09-27 with a 00:00 window, 22h41m away, was accepted.
// Run: npm run stack:up && npm run test:business-day
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../helpers/db.js');
const { cases: CASES } = require('./slot-lead-time.cases.json');

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

/** Run fn inside a transaction that is always rolled back (slots change earliest_slot_time). */
async function rolledBack(fn) {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

describe('fn_slot_meets_lead_time: 24 real hours to the slot start, around midnight and DST', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    test(`shared cases, session zone ${zone}`, async () => {
      await c.query(`SET TIME ZONE '${zone}'`);
      try {
        for (const [at, day, start, ok, why] of CASES) {
          const { rows } = await c.query('SELECT fn_slot_meets_lead_time($1::date, $2::time, $3::timestamptz) AS ok', [day, start, at]);
          assert.equal(rows[0].ok, ok, `${at} ${day} ${start}: ${why}`);
        }
      } finally {
        await c.query('RESET TIME ZONE');
      }
    });
  }
});

describe('the order insert enforces it (now-relative)', () => {
  async function earliest() {
    const { rows } = await c.query(`SELECT fn_earliest_delivery_date(now())::text AS d`);
    await c.query(
      `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 1000, 1000)
       ON CONFLICT (day) DO UPDATE SET is_blackout = false`, [rows[0].d]);
    return rows[0].d;
  }

  test('a 00:00 slot on the earliest date (always under 24h away) is refused with lead_time_not_met', async () => {
    const day = await earliest();
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    await rolledBack(async () => {
      const { rows } = await c.query(`INSERT INTO time_slots (start_time, end_time) VALUES ('00:00', '00:30') RETURNING id`);
      await c.query('SAVEPOINT s');
      await assert.rejects(db.createOrder(c, day, product, 1, rows[0].id), /lead_time_not_met/);
      await c.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  test('a slot starting one minute after now + 24h is accepted; one minute before is refused', async () => {
    // The two instants must fall on the same Jerusalem date as each other.
    const { rows: late } = await c.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') NOT BETWEEN '00:02' AND '23:57' AS edge`);
    if (late[0].edge) await new Promise((r) => setTimeout(r, 180_000));
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    const { rows: t } = await c.query(`
      SELECT ((now() + interval '24 hours 1 minute') AT TIME ZONE 'Asia/Jerusalem')::date::text AS day,
             to_char(date_trunc('minute', (now() + interval '24 hours 2 minutes') AT TIME ZONE 'Asia/Jerusalem'), 'HH24:MI') AS after,
             to_char(date_trunc('minute', (now() + interval '24 hours') AT TIME ZONE 'Asia/Jerusalem') - interval '1 minute', 'HH24:MI') AS before`);
    const { day, after: ok, before: tooSoon } = t[0];
    await c.query(`INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total) VALUES ($1, 1000, 1000) ON CONFLICT (day) DO UPDATE SET is_blackout = false`, [day]);
    await rolledBack(async () => {
      const { rows: s } = await c.query(
        `INSERT INTO time_slots (start_time, end_time) VALUES ($1::time, $1::time + interval '1 minute'), ($2::time, $2::time + interval '1 minute')
         RETURNING id, to_char(start_time, 'HH24:MI') AS start`, [ok, tooSoon]);
      const id = (hhmm) => s.find((r) => r.start === hhmm).id;
      assert.equal((await db.createOrder(c, day, product, 1, id(ok))).status, 'payment_pending');
      await c.query('SAVEPOINT s');
      await assert.rejects(db.createOrder(c, day, product, 1, id(tooSoon)), /lead_time_not_met/);
      await c.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  test('an inactive or unknown slot is refused with delivery_slot_unavailable', async () => {
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    const day = await db.freshDay(c, { oven: 100, work: 100 });
    await rolledBack(async () => {
      const { rows } = await c.query(`INSERT INTO time_slots (start_time, end_time, is_active) VALUES ('11:11', '12:12', false) RETURNING id`);
      await c.query('SAVEPOINT s');
      await assert.rejects(db.createOrder(c, day, product, 1, rows[0].id), /delivery_slot_unavailable/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await assert.rejects(db.createOrder(c, day, product, 1, '00000000-0000-0000-0000-00000000dead'), /delivery_slot_unavailable/);
    });
  });

  test('the order snapshots the slot and keeps delivery_time_window as HH:MM-HH:MM', async () => {
    const product = await db.freshProduct(c, { oven: 1, work: 1 });
    const day = await db.freshDay(c, { oven: 100, work: 100 });
    await rolledBack(async () => {
      const { rows: s } = await c.query(`INSERT INTO time_slots (start_time, end_time) VALUES ('13:15', '15:45') RETURNING id`);
      const o = await db.createOrder(c, day, product, 1, s[0].id);
      const { rows } = await c.query(
        `SELECT delivery_slot_id::text AS id, delivery_slot_start::text AS a, delivery_slot_end::text AS b, delivery_time_window AS w FROM orders WHERE id = $1`, [o.id]);
      assert.deepEqual(rows[0], { id: s[0].id, a: '13:15:00', b: '15:45:00', w: '13:15-15:45' });
    });
  });
});

describe('earliest_slot_time follows the first active slot (day strip and slot check agree)', () => {
  test('insert, deactivate and delete keep it equal to min(start_time) of active slots', async () => {
    const setting = async () => (await c.query(`SELECT value #>> '{}' AS v FROM app_settings WHERE key = 'earliest_slot_time'`)).rows[0].v;
    const first = async () => (await c.query(`SELECT to_char(min(start_time), 'HH24:MI') AS v FROM time_slots WHERE is_active`)).rows[0].v;
    assert.equal(await setting(), await first(), 'at rest');
    await rolledBack(async () => {
      const { rows } = await c.query(`INSERT INTO time_slots (start_time, end_time) VALUES ('06:30', '07:00') RETURNING id`);
      assert.equal(await setting(), '06:30');
      await c.query('UPDATE time_slots SET is_active = false WHERE id = $1', [rows[0].id]);
      assert.equal(await setting(), await first());
      await c.query(`INSERT INTO time_slots (start_time, end_time) VALUES ('05:00', '05:30')`);
      assert.equal(await setting(), '05:00');
      await c.query(`DELETE FROM time_slots WHERE start_time = '05:00'`);
      assert.equal(await setting(), await first());
    });
    assert.equal(await setting(), await first(), 'after rollback');
  });

  test('a selectable day never offers a slot that fails the slot check', async () => {
    // fn_day_too_soon(day) false  =>  every active slot of that day meets the lead time.
    const { rows } = await c.query(`
      SELECT d::date::text AS day, s.start_time::text AS start
      FROM generate_series(fn_business_date(now()), fn_business_date(now()) + 3, interval '1 day') d
      CROSS JOIN time_slots s
      WHERE s.is_active AND NOT fn_day_too_soon(d::date) AND NOT fn_slot_meets_lead_time(d::date, s.start_time, now())`);
    assert.deepEqual(rows, []);
  });
});
