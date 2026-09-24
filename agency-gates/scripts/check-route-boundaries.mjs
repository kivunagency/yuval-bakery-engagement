#!/usr/bin/env node
/**
 * Rule 2, architecture contracts: an API route is the contract layer. It must not reach
 * into the database itself. Data access belongs in the server layer, behind a named module.
 *
 * Measured on egoz-maniv 2026-09-12: 108 of 115 routes violate, with 276 direct database
 * accesses and 340 inline queries. SEVEN routes are clean. A gate that refused a violation
 * would refuse every pull request here, so this ratchets: see lib/ratchet.mjs for why that
 * is the only shape that finishes.
 *
 * Exit codes
 *   0  ran, nothing got worse      1  ran, something got worse      2  DID NOT RUN
 *
 * Usage
 *   node check-route-boundaries.mjs --report [--json]
 *   node check-route-boundaries.mjs --write-baseline <file>
 *   node check-route-boundaries.mjs --ratchet --baseline <file> [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runRatchet } from './lib/ratchet.mjs';

// mishkei-lev keeps its app at the repo root and egoz-maniv keeps it under
// output/frontend/src. A gate written against either layout is silently vacuous on the
// other, which is the failure this whole line of work exists to stop.
const SKIP = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.vercel',
  'coverage',
  '.worktrees',
]);
function findApiDirs(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    if (e.name === 'api' && /(^|[\\/])app[\\/]api$/.test(p)) out.push(p);
    else findApiDirs(p, depth + 1, out);
  }
  return out;
}
/**
 * EVERY source file under app/api, not only `route.ts`.
 *
 * boaz's finding D on mishkei-lev #160, and the easiest bypass of the lot: a query moved
 * into `app/api/x/db-helper.ts` was completely invisible. It had not gone behind a module
 * in lib/server, which is what Rule 2 asks for. It moved one file sideways and stayed in
 * the route layer. No sophistication required.
 */
function routesUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) routesUnder(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

// Holding a client is NOT the violation. Querying from the route is.
//
// Learned by running this against mishkei-lev, where every one of 39 routes creates a
// request-scoped client through `createRouteHandlerClient` and hands it to a service
// module, which is the pattern Rule 2 actually wants. Counting client creation would have
// called all 39 violations. It also missed that name entirely, because the first draft
// knew only egoz's vocabulary, so it reported 0 for the right answer by the wrong route.
//
// So: client creation is tracked (it still ratchets, because a NEW one is worth noticing)
// but a route is only VIOLATING when it runs a query itself. On egoz that moves the count
// from 108 to 85, and the 23 it releases are routes that hold a client and delegate.
// Any import path ENDING in a database module, under any alias scheme. Three projects,
// three vocabularies, and the first two drafts each knew only the one in front of them:
//   egoz-maniv    @server/db                  a path alias
//   mishkei-lev   @/lib/server/supabase       with createRouteHandlerClient
//   KivunOS       @/lib/server/db             a module level singleton, no factory call
// Each time the pattern matched the project it was written against and quietly reported
// zero for the others, which reads as a clean bill of health rather than as blindness.
const DB_ACCESS =
  /from\s+['"][^'"]*\/(?:db|database|supabase)['"]|\b(?:createDbClient|createAdminClient|createServerClient|createRouteHandlerClient|createClient)\s*\(/g;
// WHAT COUNTS AS A QUERY, and why this is wider than it looks.
//
// boaz measured the first version against five realistic forms and it caught ONE:
//
//   .from('employees')                    caught
//   .from(`employees`)                    escaped, template literal
//   .from(TBL)                            escaped, identifier not literal, and this is
//                                         ALREADY the house style in
//                                         lib/server/document-storage/index.ts:218,351
//   .from('agent_operation_log_2026')     escaped, because [a-z_]+ has no digits, and
//                                         those are the AUDIT LOG partitions. The gate
//                                         was blind to exactly the tables that matter.
//   a string containing a comment opener  escaped, see strip() below
//
// So: a quoted or templated name WITH digits allowed, or a bare identifier. `Array.from(`
// is excluded, because it is the one common call that would otherwise be a false positive
// and a gate with false positives gets switched off.
// Round two, after boaz measured five MORE escaping shapes and two false positives.
//
//   .from ('x')             a space before the paren
//   db['from']('x')         computed member access
//   .from(`log_${year}`)    a DYNAMIC table name, which boaz calls the worst of them:
//                           a computed target is exactly where input can reach
//   .from(cfg.table)        a property, not a bare identifier
//
// And two that must NOT count, which the previous lookbehind got wrong:
//
//   Buffer.from(x)          appears four times in this repo's own
//                           lib/server/supabase/index.ts, in webhook signature checks
//   Uint8Array.from(x)      `(?<!\bArray)` FAILED here, because a word boundary cannot
//                           exist between `8` and `Array`. A negative lookbehind has to
//                           name the whole identifier, never its tail.
const NOT_A_QUERY =
  '(?<![.\\w$])(?:Array|Buffer|Uint8Array|Uint16Array|Uint32Array|Int8Array|Int16Array|' +
  'Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|Object|Set|Map|Promise)';
const TARGET = '[\'"`][^\'"`]*[\'"`]|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';
const INLINE_QUERY = new RegExp(
  '(?:(?<!' +
    NOT_A_QUERY +
    ')\\.\\s*from|\\[\\s*[\'"`]from[\'"`]\\s*\\])\\s*\\(\\s*(?:' +
    TARGET +
    ')\\s*\\)',
  'g'
);
/**
 * Remove comments WITHOUT being fooled by a comment opener inside a string literal.
 *
 * The regex version was defeated by a single string containing a comment opener and
 * closer, which swallowed everything between them including a real query. boaz noted this
 * is the identical hand-rolled stripper this project rejected once before, in PR #9, in a
 * new location. So it is a character scanner that tracks whether it is inside a string.
 * Not a parser, but it knows the one thing a regex cannot: which quotes are open.
 */
function strip(src) {
  // A REGEX LITERAL is the third generation of this same defect, and boaz found it:
  // `const SEP = /[/*]/;` made the scanner read `/*` as a comment opener and delete the
  // rest of the file. A scanner that tracks quotes but not regex literals is still a
  // scanner that can be handed a character it misreads. `prev` holds the last significant
  // character, which is exactly how JavaScript itself tells division from a regex.
  let out = '',
    i = 0,
    q = null,
    inLine = false,
    inBlock = false,
    inRe = false,
    prev = '';
  while (i < src.length) {
    const c = src[i],
      n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
        out += ' ';
        continue;
      }
      i++;
      continue;
    }
    if (q) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (inRe) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '/') inRe = false;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    // A `/` after a value is division; after an operator, a keyword, or nothing, it opens
    // a regex literal. Same rule the language uses.
    if (c === '/' && !/[\w$)\]]/.test(prev)) {
      inRe = true;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
      i++;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function scan(root, dnr) {
  const apiDirs = findApiDirs(root);
  if (apiDirs.length === 0) {
    dnr(`no app/api directory found under ${root}. Nothing was checked, and that is not a pass`);
  }
  const routes = apiDirs.flatMap((d) => routesUnder(d));
  if (routes.length === 0) {
    dnr(
      `found ${apiDirs.length} app/api directory but zero route files under it. Nothing was checked`
    );
  }
  const items = {};
  let db_access = 0,
    inline_query = 0;
  for (const r of routes) {
    const src = strip(readFileSync(r, 'utf8'));
    const d = (src.match(DB_ACCESS) || []).length;
    const q = (src.match(INLINE_QUERY) || []).length;
    if (!(d || q)) continue;
    const key = relative(root, r).split('\\').join('/');
    // `_db_client_held` is CONTEXT (leading underscore, see lib/ratchet.mjs): holding a
    // client is not the violation, querying from the route is. Only inline_query ratchets.
    items[key] = { _db_client_held: d, inline_query: q };
    db_access += d;
    inline_query += q;
  }
  return {
    items,
    summary: {
      routes_total: routes.length,
      routes_violating: Object.values(items).filter((v) => v.inline_query > 0).length,
      routes_holding_a_client_only: Object.values(items).filter((v) => v.inline_query === 0).length,
      db_clients_held: db_access,
      inline_query,
    },
  };
}

runRatchet({
  tool: 'check-route-boundaries',
  rule: 'Rule 2, route boundaries',
  headline: (s) =>
    `${s.routes_violating} of ${s.routes_total} routes query directly ` +
    `(${s.inline_query} inline queries), ${s.routes_holding_a_client_only} hold a client and delegate`,
  scan,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
