import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_CHANNELS, COST_BASES, CUSTOM_CAKE_STATUSES, FULFILLMENT_TYPES, ORDER_SOURCES, ORDER_STATUSES } from '@/lib/shared/types';

const sql = readdirSync(join(__dirname, '..', 'supabase', 'migrations'))
  .sort()
  .map((f) => readFileSync(join(__dirname, '..', 'supabase', 'migrations', f), 'utf8'))
  .join('\n');

// Last CHECK (col IN (...)) in migration order wins, like the DB itself.
function checkValues(column: string): string[] {
  const re = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`, 'g');
  const all = [...sql.matchAll(re)];
  const last = all.at(-1);
  if (!last) throw new Error(`no CHECK for ${column}`);
  return last[1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort();
}

describe('shared enums mirror the DB CHECK constraints', () => {
  it.each([
    ['status', ORDER_STATUSES],
    ['fulfillment_type', FULFILLMENT_TYPES],
    ['order_source', ORDER_SOURCES],
    ['confirmation_channel', CONFIRMATION_CHANNELS],
    ['cost_basis', COST_BASES],
  ])('%s', (col, values) => {
    const found = checkValues(col);
    if (col === 'status') {
      // two tables have a status CHECK; the order one is the 5-value set
      const orderSet = [...sql.matchAll(/CHECK \(status IN \(([^)]*)\)/g)].map((m) => m[1]!).find((v) => v.includes('payment_pending'))!;
      expect(orderSet.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...values].sort());
      const cakeSet = [...sql.matchAll(/CHECK \(status IN \(([^)]*)\)/g)].map((m) => m[1]!).find((v) => v.includes('pending_review'))!;
      expect(cakeSet.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...CUSTOM_CAKE_STATUSES].sort());
      return;
    }
    expect(found).toEqual([...values].sort());
  });
});
