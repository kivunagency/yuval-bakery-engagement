// Direct Postgres fixtures for the local stack (jobs, capacity race, timezone
// tests). Local stack only: connects as the postgres superuser through
// DATABASE_URL_TEST from apps/web/.env.local. Every fixture uses its own day
// and its own product so parallel or repeated runs never share state.
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { localEnv } = require('./env');

function connectionString() {
  return process.env.DATABASE_URL_TEST || localEnv().DATABASE_URL_TEST;
}

async function withClient(fn) {
  const c = new Client({ connectionString: connectionString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function pool(max) {
  return new Pool({ connectionString: connectionString(), max });
}

/** A day nobody else uses: far in the future, random, so runs never collide. */
async function freshDay(db, { oven, work, blackout = false }) {
  for (;;) {
    const offset = 3650 + crypto.randomInt(0, 20000);
    const { rows } = await db.query(
      `INSERT INTO capacity_day_ledger (day, oven_minutes_total, work_minutes_total, is_blackout)
       VALUES (CURRENT_DATE + $1::int, $2, $3, $4) ON CONFLICT (day) DO NOTHING RETURNING day::text`,
      [offset, oven, work, blackout],
    );
    if (rows[0]) return rows[0].day;
  }
}

/** A published product with exact minute costs per unit. */
async function freshProduct(db, { oven, work, price = 10 }) {
  const { rows } = await db.query(
    `INSERT INTO products (name, price_displayed, cost_basis, oven_minutes_cost, work_minutes_cost,
                           allergens, allergens_confirmed, photo_alt, is_available, is_published)
     VALUES ($1, $2, 'per_unit', $3, $4, ARRAY['gluten'], true, 'qa product photo', true, true)
     RETURNING id`,
    [`qa product ${crypto.randomUUID().slice(0, 8)}`, price, oven, work],
  );
  return rows[0].id;
}

function randomPhone() {
  return `+97250${crypto.randomInt(1000000, 9999999)}`;
}

function randomIp() {
  return `10.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
}

/** The exact argument list fn_create_standard_order takes, pickup, guest. */
function orderArgs(day, productId, quantity) {
  return [
    randomIp(), null, 'QA Guest', randomPhone(), null, 'pickup', day, null, null, null, null, null,
    JSON.stringify([{ product_id: productId, quantity }]), crypto.randomBytes(24).toString('hex'),
    'privacy-2026-10-v1', 'terms-2026-10-v1', 'cancellation-2026-10-v1',
  ];
}

const CREATE_ORDER_SQL = `SELECT id, order_number, status, oven_minutes_cost, work_minutes_cost
  FROM fn_create_standard_order($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)`;

async function createOrder(db, day, productId, quantity = 1) {
  const { rows } = await db.query(CREATE_ORDER_SQL, orderArgs(day, productId, quantity));
  return rows[0];
}

async function ledger(db, day) {
  const { rows } = await db.query(
    `SELECT oven_minutes_total, oven_minutes_reserved, oven_minutes_unpaid_reserved,
            work_minutes_total, work_minutes_reserved, work_minutes_unpaid_reserved
     FROM capacity_day_ledger WHERE day = $1`,
    [day],
  );
  return rows[0];
}

/** Make an order look stale to the sweep (only the timestamp, never the status). */
async function backdateExpiry(db, orderId, minutesAgo = 5) {
  await db.query(
    `UPDATE orders SET payment_pending_expires_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [orderId, minutesAgo],
  );
}

async function heartbeat(db, job) {
  const { rows } = await db.query('SELECT * FROM cron_heartbeats WHERE job_name = $1', [job]);
  return rows[0];
}

/**
 * Run a statement as a Supabase API role inside its own transaction, with the
 * JWT claims PostgREST would set. role: 'anon' | 'authenticated' | 'service_role'.
 */
async function asRole(db, role, claims, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, ...claims })]);
    await db.query(`SET LOCAL ROLE ${role === 'service_role' ? 'service_role' : role === 'anon' ? 'anon' : 'authenticated'}`);
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

module.exports = {
  withClient, pool, freshDay, freshProduct, createOrder, orderArgs, CREATE_ORDER_SQL,
  ledger, backdateExpiry, heartbeat, asRole, randomPhone, randomIp,
};
