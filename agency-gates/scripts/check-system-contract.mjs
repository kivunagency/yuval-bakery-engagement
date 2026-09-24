#!/usr/bin/env node
/**
 * Rule 18: every system carries output/qa/SYSTEM-CONTRACT.md and output/qa/verify-all.sh,
 * and the contract is updated in the SAME COMMIT as any behaviour change.
 *
 * MEASURED 2026-09-18, and this is why it needs a mechanism rather than a sentence:
 *
 *   egoz-maniv    both files exist. SYSTEM-CONTRACT.md last modified 2026-08-18, a MONTH
 *                 of behaviour changes ago. "Updated in the same commit" has not happened
 *                 once in that month.
 *   mishkei-lev   NEITHER FILE EXISTS. Rule 18 was approved 2026-08-01.
 *   KivunOS       NEITHER FILE EXISTS.
 *
 * TWO CHECKS, because the rule has two halves and they fail differently.
 *
 *   --exist    the two files are present at all. A system with no contract has no
 *              definition of "working", which makes every other gate here a check against
 *              nothing in particular.
 *   --fresh    if this change touches BEHAVIOUR, the contract is in the same diff. This is
 *              the half that decays: the file gets written once at Phase 6 and then the
 *              system moves under it for a month, which is exactly what egoz shows.
 *
 * WHAT COUNTS AS A BEHAVIOUR CHANGE. Application code, server modules, database
 * migrations and functions. NOT documentation, tests, CI configuration, or the contract
 * itself. A gate that demands a contract update for a typo fix in a README gets switched
 * off, and then the real changes stop being covered too.
 *
 * Exit codes
 *   0  ran, the rule holds     1  ran, it does not     2  DID NOT RUN, reason by name
 *
 * Usage
 *   node check-system-contract.mjs --exist [--root .] [--json]
 *   node check-system-contract.mjs --fresh --base origin/develop [--root .] [--json]
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);
const asJson = has('--json');

function didNotRun(reason) {
  if (asJson) console.log(JSON.stringify({ status: 'DID_NOT_RUN', reason }));
  else {
    console.error('DID NOT RUN: check-system-contract');
    console.error('  reason: ' + reason);
  }
  process.exit(2);
}

const root = flag('--root', process.cwd());

// The contract lives under output/qa on egoz, and a greenfield project puts qa at the top.
// Accept either rather than legislating a path a project may already have chosen.
const CANDIDATES = [
  ['output/qa/SYSTEM-CONTRACT.md', 'output/qa/verify-all.sh'],
  ['qa/SYSTEM-CONTRACT.md', 'qa/verify-all.sh'],
];

function locate() {
  for (const [c, v] of CANDIDATES) if (existsSync(join(root, c))) return { contract: c, verify: v };
  return null;
}

// Behaviour, not prose. Ordered so the first match wins.
const EXEMPT =
  /^(docs?\/|\.github\/|README|CHANGELOG|.*\.md$|.*\.test\.|.*\.spec\.|tests?\/|qa\/|output\/qa\/)/;
const BEHAVIOUR =
  /^(app\/|src\/|lib\/|pages\/|components\/|server\/|db\/|supabase\/|migrations\/|output\/frontend\/)/;

if (has('--exist') || !has('--fresh')) {
  const found = locate();
  const result = {
    status: 'RAN',
    mode: 'exist',
    root,
    contract: found?.contract ?? null,
    verify: found?.verify ?? null,
    contractPresent: !!found,
    verifyPresent: !!(found && existsSync(join(root, found.verify))),
  };
  const ok = result.contractPresent && result.verifyPresent;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const bar = '='.repeat(70);
  console.log(bar);
  console.log('Rule 18, the system contract: ' + (ok ? 'present' : 'MISSING'));
  console.log(bar);
  if (ok) {
    console.log(`  ${result.contract}`);
    console.log(`  ${result.verify}`);
  } else {
    console.log('  Looked for, and did not find, either of:');
    for (const [c, v] of CANDIDATES) console.log(`    ${c}  +  ${v}`);
    console.log('');
    console.log('  A system with no contract has no written definition of "working", which');
    console.log('  makes every other gate a check against nothing in particular. Rule 18');
    console.log('  wants: what working means NOW, every layer WITH its blind spots, the');
    console.log('  rules that have no check, and the states that are true but alarming.');
  }
  console.log(bar);
  process.exit(ok ? 0 : 1);
}

// --fresh
const base = flag('--base');
if (!base)
  didNotRun(
    '--fresh needs --base <ref>. With no merge base there is nothing to compare, and an uncomparable check is not a pass'
  );

let changed;
try {
  changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
} catch (e) {
  didNotRun(
    `could not diff against ${base}: ${(e.stderr || e.message).toString().split('\n')[0]}. ` +
      `A shallow clone has no merge base; fetch-depth: 0.`
  );
}

const found = locate();
if (!found)
  didNotRun(
    `no SYSTEM-CONTRACT.md found under ${root}. Freshness cannot be judged ` +
      `against a file that does not exist; run --exist, which fails for the right reason.`
  );

const behaviour = changed.filter((f) => !EXEMPT.test(f) && BEHAVIOUR.test(f));
const touchedContract = changed.includes(found.contract);
const ok = behaviour.length === 0 || touchedContract;

const result = {
  status: 'RAN',
  mode: 'fresh',
  base,
  changedFiles: changed.length,
  behaviourFiles: behaviour,
  contract: found.contract,
  touchedContract,
  verdict: ok ? 'OK' : 'STALE',
};
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

const bar = '='.repeat(70);
console.log(bar);
console.log('Rule 18, contract freshness: ' + (ok ? 'ok' : 'REFUSED'));
console.log(bar);
console.log(`  ${changed.length} changed file(s), ${behaviour.length} of them behaviour`);
console.log(`  ${found.contract} ${touchedContract ? 'IS' : 'is NOT'} in this diff`);
if (!ok) {
  console.log('');
  console.log('  This change alters behaviour and leaves the contract describing the old');
  console.log('  system. Rule 18 says the SAME commit, because a contract updated later is');
  console.log('  a contract updated never: egoz-maniv last touched its own on 2026-08-18.');
  console.log('');
  for (const f of behaviour.slice(0, 15)) console.log('    ' + f);
  if (behaviour.length > 15) console.log(`    ... and ${behaviour.length - 15} more`);
}
console.log(bar);
process.exit(ok ? 0 : 1);
