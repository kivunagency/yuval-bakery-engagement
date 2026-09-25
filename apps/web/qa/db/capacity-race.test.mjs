// qa-001: capacity race tests (ADR-002, DB-PLAN.md 10.5, SEC-007, SEC-021).
// Genuinely concurrent: every racer is its own Postgres connection (node pg
// pool), all released at the same instant by a barrier, each inside its own
// transaction, against the local stack's real PostgreSQL 17. A separate
// sampler connection reads the ledger in a tight loop for the whole race and
// every single read is asserted, not only the end state.
// Run: npm run stack:up && npm run test:race
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../helpers/db.js');

const RACERS = Number(process.env.RACE_N || 24);
const ROUNDS = Number(process.env.RACE_ROUNDS || 12);
const pool = db.pool(RACERS + 8);
let admin; // { id } an admin at aal2, for fn_cancel_order / fn_mark_order_paid
let settings; // single_order_capacity_pct, unpaid_holds_capacity_pct as numbers

before(async () => {
  const c = await pool.connect();
  try {
    const { rows } = await c.query(`SELECT key, (value)::text::numeric AS v FROM app_settings
      WHERE key IN ('single_order_capacity_pct', 'unpaid_holds_capacity_pct')`);
    settings = Object.fromEntries(rows.map((r) => [r.key, Number(r.v)]));
    const id = crypto.randomUUID();
    await c.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `race-admin-${id}@example.test`]);
    await c.query(`INSERT INTO admins (id, display_name) VALUES ($1, 'QA race admin')`, [id]);
    admin = { id };
  } finally {
    c.release();
  }
});

after(async () => {
  await pool.end();
});

// ---- setup arithmetic guard (DB-PLAN.md 10.6: a day too small for the
// single-order cap means every racer is rejected before anything races) ----
function assertRaceable({ total, cost }) {
  const singleCap = (total * settings.single_order_capacity_pct) / 100;
  assert.ok(cost <= singleCap, `test setup error: an order of ${cost} min exceeds the single-order cap ${singleCap} of a ${total}-min day, nothing would race`);
}

// ---- concurrency primitives ----
function barrier(n) {
  let arrived = 0;
  let release;
  const all = new Promise((r) => (release = r));
  return () => {
    arrived += 1;
    if (arrived === n) release();
    return all;
  };
}

/** Samples the ledger row of `day` until stop(); every read must satisfy check(row). */
function sampler(day, check) {
  let stopped = false;
  const violations = [];
  let reads = 0;
  const done = (async () => {
    const c = await pool.connect();
    try {
      while (!stopped) {
        const row = await db.ledger(c, day);
        reads += 1;
        const problem = check(row);
        if (problem) violations.push({ problem, row });
      }
    } finally {
      c.release();
    }
  })();
  return {
    async stop() {
      stopped = true;
      await done;
      return { reads, violations };
    },
  };
}

function ledgerInvariants(unpaidPct) {
  return (r) => {
    const out = [];
    for (const res of ['oven', 'work']) {
      const total = r[`${res}_minutes_total`];
      const reserved = r[`${res}_minutes_reserved`];
      const unpaid = r[`${res}_minutes_unpaid_reserved`];
      if (reserved < 0 || reserved > total) out.push(`capacity_never_negative: ${res} reserved ${reserved} of ${total}`);
      if (unpaid < 0 || unpaid > reserved) out.push(`${res} unpaid ${unpaid} outside [0, reserved ${reserved}]`);
      if (unpaid > (total * unpaidPct) / 100) out.push(`unpaid_never_exceeds_cap: ${res} unpaid ${unpaid} > ${unpaidPct}% of ${total}`);
    }
    return out.length ? out.join('; ') : null;
  };
}

/**
 * N racers, one connection each, each: BEGIN, wait for all, run `work`, hold
 * the transaction briefly (so losers queue behind a real lock), COMMIT or
 * ROLLBACK. Returns [{ ok, value | error }] in racer order.
 */
async function race(n, work) {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  const go = barrier(n);
  try {
    return await Promise.all(
      clients.map(async (c, i) => {
        await c.query('BEGIN');
        await go();
        try {
          const value = await work(c, i);
          await new Promise((r) => setTimeout(r, 5));
          await c.query('COMMIT');
          return { ok: true, value };
        } catch (e) {
          await c.query('ROLLBACK');
          return { ok: false, error: e.message.split(':')[0] };
        }
      }),
    );
  } finally {
    clients.forEach((c) => c.release());
  }
}

async function withConn(fn) {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Inside an open transaction: act as the aal2 admin for the rest of it. */
async function becomeAdmin(c) {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin.id, role: 'authenticated', aal: 'aal2' })]);
  await c.query('SET LOCAL ROLE authenticated');
}

async function becomeServiceRole(c) {
  await c.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c.query('SET LOCAL ROLE service_role');
}

async function markPaid(c, orderId) {
  await c.query('BEGIN');
  await becomeAdmin(c);
  const { rows } = await c.query('SELECT fn_mark_order_paid($1) AS ok', [orderId]);
  await c.query('COMMIT');
  assert.equal(rows[0].ok, true);
}

/** The ledger must equal what the orders say it holds (the ledger is a running total of them). */
async function assertLedgerMatchesOrders(c, day) {
  const l = await db.ledger(c, day);
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(oven_minutes_cost) FILTER (WHERE status IN ('payment_pending','paid')), 0)::int AS oven,
            COALESCE(SUM(work_minutes_cost) FILTER (WHERE status IN ('payment_pending','paid')), 0)::int AS work,
            COALESCE(SUM(oven_minutes_cost) FILTER (WHERE status = 'payment_pending'), 0)::int AS oven_unpaid,
            COALESCE(SUM(work_minutes_cost) FILTER (WHERE status = 'payment_pending'), 0)::int AS work_unpaid
     FROM orders WHERE delivery_date = $1`,
    [day],
  );
  const o = rows[0];
  assert.deepEqual(
    [l.oven_minutes_reserved, l.work_minutes_reserved, l.oven_minutes_unpaid_reserved, l.work_minutes_unpaid_reserved],
    [o.oven, o.work, o.oven_unpaid, o.work_unpaid],
    `ledger for ${day} does not match its orders`,
  );
  return l;
}

function tally(results) {
  const t = {};
  for (const r of results) {
    const k = r.ok ? 'ok' : r.error;
    t[k] = (t[k] || 0) + 1;
  }
  return t;
}

// =========================================================================

describe('capacity_never_negative: N racers for the last slots', () => {
  test(`${RACERS} simultaneous orders, room for exactly 3: exactly 3 succeed`, async () => {
    const total = 100;
    const cost = 10;
    assertRaceable({ total, cost });
    const { day, product } = await withConn(async (c) => {
      const day = await db.freshDay(c, { oven: total, work: total });
      const product = await db.freshProduct(c, { oven: cost, work: cost });
      // 70 minutes already PAID (not unpaid holds), so the physical total, not
      // the 70% unpaid cap, is what the racers hit: 30 minutes = 3 orders left.
      for (let i = 0; i < 7; i += 1) await markPaid(c, (await db.createOrder(c, day, product, 1)).id);
      assert.deepEqual(await db.ledger(c, day), {
        oven_minutes_total: 100, oven_minutes_reserved: 70, oven_minutes_unpaid_reserved: 0,
        work_minutes_total: 100, work_minutes_reserved: 70, work_minutes_unpaid_reserved: 0,
      });
      return { day, product };
    });

    const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
    const results = await race(RACERS, (c) => c.query(db.CREATE_ORDER_SQL, db.orderArgs(day, product, 1)));
    const { reads, violations } = await s.stop();

    assert.deepEqual(tally(results), { ok: 3, capacity_reservation_failed: RACERS - 3 });
    assert.deepEqual(violations, [], 'a ledger read during the race broke an invariant');
    assert.ok(reads > 0, 'the sampler never read the ledger during the race');
    const l = await withConn((c) => assertLedgerMatchesOrders(c, day));
    assert.equal(l.oven_minutes_reserved, 100);
    console.log(`  last-slot race: ${JSON.stringify(tally(results))}, ${reads} ledger reads during the race, 0 violations`);
  });

  test('mixed sizes: the winners are exactly what fits, never more than the total', async () => {
    const total = 120;
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: total, work: total * 2 }),
      product: await db.freshProduct(c, { oven: 7, work: 5 }),
    }));
    assertRaceable({ total, cost: 7 * 6 });
    const sizes = Array.from({ length: RACERS }, (_, i) => 1 + (i % 6)); // 7..42 oven minutes
    const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
    const results = await race(RACERS, (c, i) => c.query(db.CREATE_ORDER_SQL, db.orderArgs(day, product, sizes[i])));
    const { violations } = await s.stop();
    assert.deepEqual(violations, []);
    const won = results.reduce((sum, r, i) => sum + (r.ok ? sizes[i] * 7 : 0), 0);
    const l = await withConn((c) => assertLedgerMatchesOrders(c, day));
    assert.equal(l.oven_minutes_reserved, won);
    assert.ok(won <= (total * settings.unpaid_holds_capacity_pct) / 100);
    // no loser would have fitted in what is left (else a rejection was wrong)
    const leftUnpaid = (total * settings.unpaid_holds_capacity_pct) / 100 - l.oven_minutes_unpaid_reserved;
    for (const [i, r] of results.entries()) {
      if (!r.ok) assert.ok(sizes[i] * 7 > leftUnpaid, `racer ${i} (${sizes[i] * 7} min) was rejected with ${leftUnpaid} unpaid minutes left`);
    }
  });
});

describe('unpaid_never_exceeds_cap', () => {
  test(`${RACERS} simultaneous unpaid orders on an empty day: exactly 70% gets held`, async () => {
    const total = 100;
    const cost = 10;
    assertRaceable({ total, cost });
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: total, work: total }),
      product: await db.freshProduct(c, { oven: cost, work: cost }),
    }));
    const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
    const results = await race(RACERS, (c) => c.query(db.CREATE_ORDER_SQL, db.orderArgs(day, product, 1)));
    const { reads, violations } = await s.stop();
    const fit = (total * settings.unpaid_holds_capacity_pct) / 100 / cost; // 7
    assert.deepEqual(tally(results), { ok: fit, unpaid_holds_capacity_cap_exceeded: RACERS - fit });
    assert.deepEqual(violations, []);
    assert.ok(reads > 0);
    const l = await withConn((c) => assertLedgerMatchesOrders(c, day));
    assert.equal(l.oven_minutes_unpaid_reserved, 70);
  });

  test('paid orders do not count against the unpaid cap: the last 30% still sells', async () => {
    const { day, product } = await withConn(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      for (let i = 0; i < 7; i += 1) await markPaid(c, (await db.createOrder(c, day, product, 1)).id);
      return { day, product };
    });
    const results = await race(RACERS, (c) => c.query(db.CREATE_ORDER_SQL, db.orderArgs(day, product, 1)));
    assert.equal(tally(results).ok, 3);
    await withConn((c) => assertLedgerMatchesOrders(c, day));
  });
});

describe('single-order cap (35%)', () => {
  test('35 of 100 is accepted, 36 is refused, on an empty day', async () => {
    await withConn(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const one = await db.freshProduct(c, { oven: 1, work: 1 });
      assert.equal((await db.createOrder(c, day, one, 35)).status, 'payment_pending');
      await assert.rejects(db.createOrder(c, day, one, 36), /single_order_capacity_cap_exceeded/);
      await assertLedgerMatchesOrders(c, day);
    });
  });

  test('the cap applies per resource: work minutes over 35% are refused even when oven is small', async () => {
    await withConn(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const p = await db.freshProduct(c, { oven: 1, work: 36 });
      await assert.rejects(db.createOrder(c, day, p, 1), /single_order_capacity_cap_exceeded/);
    });
  });

  test(`${RACERS} racers each asking for exactly the cap: exactly 2 fit under the 70% unpaid cap`, async () => {
    const total = 100;
    const cost = 35;
    assertRaceable({ total, cost });
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: total, work: total }),
      product: await db.freshProduct(c, { oven: cost, work: cost }),
    }));
    const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
    const results = await race(RACERS, (c) => c.query(db.CREATE_ORDER_SQL, db.orderArgs(day, product, 1)));
    const { violations } = await s.stop();
    // After two winners (70 held), a third 35 breaks the unpaid cap AND the
    // physical total (105 > 100); fn_create_standard_order names the physical
    // one first. Either way: rejected, and exactly two won.
    assert.deepEqual(tally(results), { ok: 2, capacity_reservation_failed: RACERS - 2 });
    assert.deepEqual(violations, []);
    await withConn((c) => assertLedgerMatchesOrders(c, day));
  });
});

describe('release_exactly_once (SEC-007)', () => {
  test(`cancel racing expire on the same order, ${ROUNDS} rounds: one release per order`, async () => {
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: 1000, work: 1000 }),
      product: await db.freshProduct(c, { oven: 3, work: 4 }),
    }));
    const wins = { cancelled: 0, expired: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const order = await withConn(async (c) => {
        const o = await db.createOrder(c, day, product, 1);
        await db.backdateExpiry(c, o.id);
        return o;
      });
      const before = await withConn((c) => db.ledger(c, day));
      const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
      const results = await race(2, async (c, i) => {
        if (i === 0) {
          await becomeAdmin(c);
          return (await c.query('SELECT fn_cancel_order($1) AS released', [order.id])).rows[0].released;
        }
        await becomeServiceRole(c);
        return (await c.query('SELECT fn_expire_stale_orders() AS r')).rows[0].r;
      });
      const { violations } = await s.stop();
      assert.deepEqual(violations, []);
      assert.ok(results.every((r) => r.ok), JSON.stringify(results));

      const status = await withConn(async (c) => (await c.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status);
      assert.ok(status === 'cancelled' || status === 'expired', status);
      wins[status] += 1;
      assert.equal(results[0].value, status === 'cancelled', 'fn_cancel_order reported a release it did not make, or missed one it did');

      const afterRow = await withConn((c) => assertLedgerMatchesOrders(c, day));
      assert.equal(afterRow.oven_minutes_reserved, before.oven_minutes_reserved - 3, 'released more or less than once');
      assert.equal(afterRow.work_minutes_reserved, before.work_minutes_reserved - 4);
      const audits = await withConn(async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action IN ('order.cancelled','order.expired')`, [order.id])).rows[0].n);
      assert.equal(audits, 1);
    }
    console.log(`  cancel vs expire winners over ${ROUNDS} rounds: ${JSON.stringify(wins)}`);
  });

  test('a retried sweep (5 sweeps at once over the same stale orders) releases each order once', async () => {
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: 1000, work: 1000 }),
      product: await db.freshProduct(c, { oven: 5, work: 5 }),
    }));
    const ids = await withConn(async (c) => {
      const out = [];
      for (let i = 0; i < 10; i += 1) {
        const o = await db.createOrder(c, day, product, 1);
        await db.backdateExpiry(c, o.id);
        out.push(o.id);
      }
      return out;
    });
    const s = sampler(day, ledgerInvariants(settings.unpaid_holds_capacity_pct));
    const results = await race(5, async (c) => {
      await becomeServiceRole(c);
      return (await c.query('SELECT fn_expire_stale_orders() AS r')).rows[0].r;
    });
    const { violations } = await s.stop();
    assert.deepEqual(violations, []);
    assert.ok(results.every((r) => r.ok && r.value.failed === 0), JSON.stringify(results));
    await withConn(async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM orders WHERE id = ANY($1) AND status = 'expired'`, [ids]);
      assert.equal(rows[0].n, 10);
      const l = await assertLedgerMatchesOrders(c, day);
      assert.equal(l.oven_minutes_reserved, 0);
      const a = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ANY($1) AND action = 'order.expired'`, [ids.map(String)]);
      assert.equal(a.rows[0].n, 10);
    });
  });

  test(`mark-paid racing expire, ${ROUNDS} rounds: never both, ledger always matches the winner`, async () => {
    const { day, product } = await withConn(async (c) => ({
      day: await db.freshDay(c, { oven: 1000, work: 1000 }),
      product: await db.freshProduct(c, { oven: 6, work: 2 }),
    }));
    const wins = { paid: 0, expired: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const order = await withConn(async (c) => {
        const o = await db.createOrder(c, day, product, 1);
        await db.backdateExpiry(c, o.id);
        return o;
      });
      const results = await race(2, async (c, i) => {
        if (i === 0) {
          await becomeAdmin(c);
          return (await c.query('SELECT fn_mark_order_paid($1) AS ok', [order.id])).rows[0].ok;
        }
        await becomeServiceRole(c);
        return (await c.query('SELECT fn_expire_stale_orders() AS r')).rows[0].r;
      });
      assert.ok(results.every((r) => r.ok), JSON.stringify(results));
      const status = await withConn(async (c) => (await c.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status);
      assert.ok(status === 'paid' || status === 'expired', status);
      wins[status] += 1;
      assert.equal(results[0].value, status === 'paid');
      await withConn((c) => assertLedgerMatchesOrders(c, day));
    }
    console.log(`  mark-paid vs expire winners over ${ROUNDS} rounds: ${JSON.stringify(wins)}`);
  });

  test('double-click cancel on a paid order: one release', async () => {
    const { day, order } = await withConn(async (c) => {
      const day = await db.freshDay(c, { oven: 100, work: 100 });
      const product = await db.freshProduct(c, { oven: 10, work: 10 });
      const order = await db.createOrder(c, day, product, 1);
      await markPaid(c, order.id);
      return { day, order };
    });
    const results = await race(RACERS, async (c) => {
      await becomeAdmin(c);
      return (await c.query('SELECT fn_cancel_order($1) AS released', [order.id])).rows[0].released;
    });
    assert.equal(results.filter((r) => r.ok && r.value === true).length, 1, JSON.stringify(tally(results)));
    assert.ok(results.every((r) => r.ok));
    const l = await withConn((c) => assertLedgerMatchesOrders(c, day));
    assert.equal(l.oven_minutes_reserved, 0);
  });
});
