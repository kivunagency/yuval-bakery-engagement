import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_ERROR_CODES } from '@/lib/server/supabase/rpc';

// Every machine-readable code a migration raises must be known to the app,
// so an API route can map it instead of returning a generic 500.
// Messages that start with a function name (fn_...) or a table name are
// programming-error guards, not codes a caller handles.
describe('DB error codes', () => {
  it('lists every RAISE EXCEPTION code from the migrations', () => {
    const dir = join(__dirname, '..', 'supabase', 'migrations');
    const raised = new Set<string>();
    for (const f of readdirSync(dir)) {
      const sql = readFileSync(join(dir, f), 'utf8');
      for (const m of sql.matchAll(/RAISE EXCEPTION '([a-z][a-z0-9_]*)(?=['":])/g)) {
        const code = m[1]!;
        if (!code.startsWith('fn_') && code !== 'orders') raised.add(code);
      }
    }
    const known = new Set<string>(DB_ERROR_CODES);
    expect([...raised].filter((c) => !known.has(c))).toEqual([]);
  });
});
