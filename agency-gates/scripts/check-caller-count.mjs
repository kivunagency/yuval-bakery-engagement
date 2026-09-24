#!/usr/bin/env node
/**
 * Rule 19: count the callers before changing a shared computation.
 *
 * The rule says that before changing or trusting any function returning a business
 * quantity, you list every caller and say so in the report. It has been an instruction,
 * and instructions are remembered unevenly. This counts them for you and puts the count
 * where the reviewer is already looking.
 *
 * WHY IT REPORTS AND DOES NOT BLOCK. Whether the callers were actually CHECKED is
 * judgment, and a gate cannot have it. What a gate can do is make the number impossible
 * to not know. On this project one money quantity reached seven separate implementations,
 * and every one of those started as a change somebody believed was local.
 *
 * Exit codes
 *   0  ran
 *   1  ran, and --strict was set with a changed function over the caller threshold
 *   2  DID NOT RUN (Rule 20). The reason is printed by name.
 *
 * Usage
 *   node check-caller-count.mjs --base origin/develop [--root .] [--json] [--strict N]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);
const asJson = has('--json');

function didNotRun(reason) {
  if (asJson) console.log(JSON.stringify({ status: 'DID_NOT_RUN', reason }, null, 2));
  else {
    console.error('DID NOT RUN: check-caller-count');
    console.error('  reason: ' + reason);
  }
  process.exit(2);
}

const ROOT = flag('--root', process.cwd());
const BASE = flag('--base');
if (!BASE)
  didNotRun(
    'no --base given. Without a base there is no diff, and no diff means nothing was examined. This is not a pass'
  );

let changedFiles;
try {
  changedFiles = execFileSync('git', ['diff', '--name-only', `${BASE}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (e) {
  didNotRun(
    `git could not diff against ${BASE}: ${
      String(e.stderr || e.message)
        .trim()
        .split('\n')[0]
    }`
  );
}
const codeChanged = changedFiles.filter(
  (f) => /\.(ts|tsx|js|mjs)$/.test(f) && !/\.(test|spec)\./.test(f)
);
if (codeChanged.length === 0) {
  const out = { status: 'RAN', base: BASE, changed_files: changedFiles.length, functions: [] };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else
    console.log(`no code files changed against ${BASE} (${changedFiles.length} files in the diff)`);
  process.exit(0);
}

// ---------------------------------------------------------------- which functions changed
//
// Only ADDED or REMOVED lines are examined, so a function that merely sits near an edit is
// not reported. The name must be exported, because an unexported one has no callers to count.

let diff;
try {
  diff = execFileSync('git', ['diff', '-U0', `${BASE}...HEAD`, '--', ...codeChanged], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  didNotRun(`git diff failed: ${String(e.message).split('\n')[0]}`);
}

const DECL = [
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(/g,
  /export\s+(?:async\s+)?function\s*\*\s*([A-Za-z_$][\w$]*)/g,
];
const changedFns = new Map(); // name -> file it was declared in
let currentFile = null;
for (const line of diff.split('\n')) {
  const m = line.match(/^\+\+\+ b\/(.+)$/);
  if (m) {
    currentFile = m[1];
    continue;
  }
  if (!/^[+-]/.test(line) || /^[+-]{3}/.test(line)) continue;
  const body = line.slice(1);
  for (const re of DECL) {
    re.lastIndex = 0;
    let g;
    while ((g = re.exec(body)) !== null) if (g[1]) changedFns.set(g[1], currentFile);
  }
}

if (changedFns.size === 0) {
  const out = { status: 'RAN', base: BASE, changed_files: codeChanged.length, functions: [] };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else
    console.log(
      `${codeChanged.length} code file(s) changed, no exported function declaration among the changed lines`
    );
  process.exit(0);
}

// ---------------------------------------------------------------- count the callers

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
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const allFiles = walk(ROOT);
if (allFiles.length === 0)
  didNotRun(`no source files found under ${ROOT}. Nothing could be counted`);

const results = [];
for (const [name, declFile] of changedFns) {
  const callRe = new RegExp(`(?<![\\w$.])${name}\\s*\\(`);
  const importRe = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
  const callers = [],
    importers = [];
  for (const f of allFiles) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (rel === declFile) continue;
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!importRe.test(src)) continue;
    if (callRe.test(src)) callers.push(rel);
    else importers.push(rel);
  }
  results.push({
    function: name,
    declared_in: declFile,
    callers: callers.length,
    caller_files: callers.slice(0, 20),
    mentioned_not_called: importers.length,
    is_test_only: callers.length > 0 && callers.every((c) => /\.(test|spec)\.|\/qa\//.test(c)),
  });
}
results.sort((a, b) => b.callers - a.callers);

const STRICT = flag('--strict');
const overThreshold = STRICT
  ? results.filter((r) => r.callers >= Number(STRICT) && !r.is_test_only)
  : [];

if (asJson) {
  console.log(
    JSON.stringify(
      {
        status: 'RAN',
        base: BASE,
        changed_files: codeChanged.length,
        functions: results,
        over_threshold: overThreshold.map((r) => r.function),
      },
      null,
      2
    )
  );
  process.exit(overThreshold.length ? 1 : 0);
}

const bar = '='.repeat(70);
console.log(bar);
console.log('Rule 19, callers of the functions this change touched');
console.log(
  `base ${BASE}, ${codeChanged.length} code file(s) changed, ${results.length} exported function(s) touched`
);
console.log(bar);
for (const r of results) {
  console.log('');
  const tag =
    r.callers === 0 ? 'NO CALLERS' : r.is_test_only ? 'tests only' : `${r.callers} caller(s)`;
  console.log(`  ${r.function}   ${tag}`);
  console.log(`     declared in ${r.declared_in}`);
  for (const c of r.caller_files) console.log(`       ${c}`);
  if (r.callers > r.caller_files.length)
    console.log(`       (+${r.callers - r.caller_files.length} more)`);
  if (r.mentioned_not_called)
    console.log(`     mentioned without being called in ${r.mentioned_not_called} file(s)`);
  if (r.callers === 0)
    console.log(
      '     nothing calls this. Either it is new, or it is dead, and those want different answers.'
    );
  if (r.callers >= 2 && !r.is_test_only)
    console.log('     Rule 19: say in the PR whether every one of these was checked.');
}
console.log('');
console.log(bar);
if (overThreshold.length) {
  console.log(
    `--strict ${STRICT}: ${overThreshold.map((r) => r.function).join(', ')} exceed the threshold`
  );
}
console.log(bar);
process.exit(overThreshold.length ? 1 : 0);
