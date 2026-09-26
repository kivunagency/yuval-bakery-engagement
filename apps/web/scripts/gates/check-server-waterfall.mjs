#!/usr/bin/env node
/**
 * Performance budget: the server building its own waterfall.
 *
 * Rule 31 says a screen renders its first meaningful frame from data the server already
 * had. It also names the trap that survives the obvious fix: the SERVER can build its own
 * waterfall. Moving three fetches from the client to the server and then awaiting them one
 * after another buys almost nothing, because the page still waits for the sum.
 *
 * Measured on mishkei-lev, which is why Rule 31 exists: a cold load of 2.0 to 3.4 seconds
 * against an EXPLAIN ANALYZE of 0.000463 seconds. The wait was round trips, not the
 * database, and a serial server is round trips with a different return address.
 *
 * WHAT IT COUNTS. Inside a server component, two or more CONSECUTIVE awaited assignments
 * where the later one does not reference anything the earlier one produced. Those are
 * independent reads taken in sequence, and Promise.all costs one line.
 *
 * WHAT IT DOES NOT COUNT, on purpose. An await that USES the previous result is a genuine
 * dependency, not a waterfall, and flagging it would make this noise. A file marked
 * "use client" is not a server component and is skipped.
 *
 * Exit codes
 *   0  ran, nothing got worse     1  ran, something got worse     2  DID NOT RUN
 *
 * Usage
 *   node check-server-waterfall.mjs --report [--json]
 *   node check-server-waterfall.mjs --write-baseline <file>
 *   node check-server-waterfall.mjs --ratchet --baseline <file> [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runRatchet } from './lib/ratchet.mjs';

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

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^(page|layout)\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// `const x = await f()` or `const { a, b } = await f()`
const AWAITED =
  /^\s*(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*await\s+([^;]+);?\s*$/;
const namesIn = (decl) => decl.match(/[A-Za-z_$][\w$]*/g) || [];

function scan(root, dnr) {
  const files = walk(root);
  if (files.length === 0) {
    dnr(
      `no page or layout files found under ${root}. Nothing was scanned, and that is not "no waterfalls".`
    );
  }
  const items = {};
  let chains = 0,
    awaits_in_chains = 0,
    server_files = 0;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // a client component is not a server component, and Rule 31 is about the server
    if (/^\s*['"]use client['"]/m.test(src)) continue;
    server_files++;

    const lines = src.split('\n');
    let run = []; // consecutive awaited assignments
    let fileChains = 0,
      fileAwaits = 0;
    const flush = () => {
      // a chain counts only when a later await does NOT use an earlier result
      if (run.length >= 2) {
        const produced = new Set();
        let independent = 0;
        for (const r of run) {
          const usesEarlier = namesIn(r.expr).some((n) => produced.has(n));
          if (!usesEarlier && produced.size > 0) independent++;
          for (const n of namesIn(r.decl)) produced.add(n);
        }
        if (independent > 0) {
          fileChains++;
          fileAwaits += independent + 1;
        }
      }
      run = [];
    };
    for (const line of lines) {
      const m = line.match(AWAITED);
      if (m) {
        run.push({ decl: m[1], expr: m[2] });
        continue;
      }
      if (line.trim() === '' || /^\s*\/\//.test(line)) continue; // blanks and comments do not break a run
      flush();
    }
    flush();

    if (fileChains) {
      items[relative(root, f).split('\\').join('/')] = {
        chains: fileChains,
        serial_awaits: fileAwaits,
      };
      chains += fileChains;
      awaits_in_chains += fileAwaits;
    }
  }
  return {
    items,
    summary: {
      server_files_scanned: server_files,
      files_with_a_waterfall: Object.keys(items).length,
      chains,
      awaits_in_chains,
    },
  };
}

runRatchet({
  tool: 'check-server-waterfall',
  rule: 'Rule 31, the server building its own waterfall',
  headline: (s) =>
    `${s.chains} serial chain(s) across ${s.files_with_a_waterfall} of ${s.server_files_scanned} server files, ` +
    `${s.awaits_in_chains} awaits that could have run together`,
  scan,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
