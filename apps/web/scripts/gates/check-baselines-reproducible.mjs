#!/usr/bin/env node
/**
 * A baseline is a recording, not a dial.
 *
 * The upstream workflow compared each committed baseline byte for byte with a fresh scan.
 * That stops a HAND EDIT (someone adjusting a number to clear a red check), which is the
 * point. But the upstream summaries also count every file scanned (`routes_total`,
 * `files_scanned`, ...), so on this repo, with several sessions adding files in parallel,
 * every PR that adds any file would fail the byte comparison without breaking any rule.
 *
 * YuvalBakery adaptation (2026-09-26): compare the VIOLATION entries only: for every file,
 * the metrics that ratchet (names without a leading underscore) and are above zero. A hand
 * edit still shows up; a new clean file does not.
 *
 * Exit codes
 *   0  every baseline matches a fresh scan      1  at least one does not
 *   2  DID NOT RUN (a baseline or a gate is missing or unreadable)
 *
 * Usage (from apps/web)
 *   node scripts/gates/check-baselines-reproducible.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES = [
  ['route-boundaries', 'check-route-boundaries'],
  ['swallowed-catch', 'check-swallowed-catch'],
  ['server-waterfall', 'check-server-waterfall'],
  ['hardcoded-hebrew', 'check-hardcoded-hebrew'],
  ['project-shape', 'check-project-shape'],
];

function dnr(reason) {
  console.error('DID NOT RUN: check-baselines-reproducible');
  console.error('  reason: ' + reason);
  process.exit(2);
}

function violations(items) {
  const out = {};
  for (const [file, metrics] of Object.entries(items || {})) {
    const kept = Object.fromEntries(
      Object.entries(metrics)
        .filter(([k, v]) => !k.startsWith('_') && Number(v) > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    if (Object.keys(kept).length) out[file] = kept;
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'gates-'));
let failed = 0;
for (const [name, script] of GATES) {
  const committed = join(process.cwd(), 'qa', 'gates', `${name}.baseline.json`);
  if (!existsSync(committed)) dnr(`baseline missing: qa/gates/${name}.baseline.json`);
  const fresh = join(tmp, `${name}.json`);
  try {
    execFileSync('node', [join(HERE, `${script}.mjs`), '--write-baseline', fresh], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    dnr(`${script}.mjs could not scan: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
  let a, b;
  try {
    a = violations(JSON.parse(readFileSync(committed, 'utf8')).items);
    b = violations(JSON.parse(readFileSync(fresh, 'utf8')).items);
  } catch (e) {
    dnr(`could not parse a baseline for ${name}: ${e.message}`);
  }
  const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = files.filter((f) => JSON.stringify(a[f] || null) !== JSON.stringify(b[f] || null));
  if (diffs.length) {
    failed++;
    console.log(`MISMATCH qa/gates/${name}.baseline.json is not what ${script}.mjs derives from this tree:`);
    for (const f of diffs.slice(0, 20))
      console.log(`  ${f}   committed ${JSON.stringify(a[f] || {})}   fresh ${JSON.stringify(b[f] || {})}`);
    console.log('  If a count went DOWN, lock it in:');
    console.log(`    node scripts/gates/${script}.mjs --write-baseline qa/gates/${name}.baseline.json`);
    console.log('  If you edited the file by hand to clear a red check, that is what this refuses.');
  } else {
    console.log(`ok  qa/gates/${name}.baseline.json (${Object.keys(a).length} file(s) recorded)`);
  }
}
process.exit(failed ? 1 : 0);
