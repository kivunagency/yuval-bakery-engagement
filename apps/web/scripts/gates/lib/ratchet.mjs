/**
 * The ratchet: a gate for a rule that is already broken in hundreds of places.
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IS SHARED. Two gates needed the identical mechanism
 * within an hour of each other (Rule 2, route boundaries, 108 of 115 routes; Rule 20,
 * swallowed catch blocks, 104 of them). A third would have made this a concept with no
 * owner appearing in three places, which is exactly what Rule 24 forbids, and it would
 * have been written while shipping the Rule 19 gate. So it was extracted first.
 *
 * THE MECHANISM. A rule that is violated 108 times cannot be enforced by refusing a
 * violation: that refuses every pull request, and a gate everyone routes around is worse
 * than no gate. So the count is recorded in a committed baseline and only an INCREASE is
 * refused. Touch a bad file and you are not asked to fix it, only not to add to it. Fix
 * one and the baseline drops and cannot climb back. A retrofit that finishes.
 *
 * A scanner supplies: scan(root) -> { items: { 'path': {metric: n, ...} }, summary }
 * Only files WITH a violation appear in items. Metrics are integers, lower is better.
 *
 * Exit codes, uniform across every gate built on this:
 *   0  ran, nothing got worse
 *   1  ran, something got worse
 *   2  DID NOT RUN (Rule 20), reason printed by name
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function didNotRun(reason, { asJson = false, tool = 'ratchet' } = {}) {
  if (asJson) console.log(JSON.stringify({ status: 'DID_NOT_RUN', reason }, null, 2));
  else {
    console.error(`DID NOT RUN: ${tool}`);
    console.error('  reason: ' + reason);
  }
  process.exit(2);
}

export function runRatchet({ tool, rule, headline, scan, argv, cwd }) {
  const flag = (n, d = null) => {
    const i = argv.indexOf(n);
    return i === -1 ? d : argv[i + 1];
  };
  const has = (n) => argv.includes(n);
  const asJson = has('--json');
  const dnr = (reason) => didNotRun(reason, { asJson, tool });

  const root = flag('--root', cwd);
  const scanned = scan(root, dnr);
  const { items, summary } = scanned;

  // write a baseline
  const writeTo = flag('--write-baseline');
  if (writeTo) {
    writeFileSync(
      writeTo,
      JSON.stringify(
        {
          _comment: `${rule} ratchet. Counts may go DOWN, never up. Regenerate only when lowering.`,
          rule,
          summary,
          items,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    console.log(`baseline written: ${writeTo}`);
    console.log('  ' + headline(summary));
    process.exit(0);
  }

  // compare
  if (has('--ratchet')) {
    const basePath = flag('--baseline');
    if (!basePath)
      dnr(
        '--ratchet needs --baseline <file>. Without a baseline there is nothing to compare against, and an uncomparable check is not a pass'
      );
    if (!existsSync(basePath)) dnr(`baseline not found: ${basePath}. Nothing was compared`);
    let base;
    try {
      base = JSON.parse(readFileSync(basePath, 'utf8'));
    } catch (e) {
      dnr(`baseline ${basePath} could not be parsed: ${e.message}`);
    }
    const baseItems = base.items || base.routes; // routes: the name the first gate used
    if (!baseItems) dnr(`baseline ${basePath} holds no "items" map`);

    const worse = [],
      added = [],
      improved = [];
    for (const [file, v] of Object.entries(items)) {
      const b = baseItems[file];
      if (!b) {
        // A NEW file only counts as a new violation if it actually violates something.
        // A file can enter `items` carrying ONLY context metrics (leading underscore),
        // and then it is a new file that breaks no rule.
        //
        // Measured on mishkei-lev #160: five routes added on develop after this branch
        // was cut appeared as "NEW violating file(s). New code has no excuse." Every one
        // of them had inline_query=0. They held a database client and delegated, which is
        // the pattern Rule 2 WANTS. The gate was refusing correct code in its most
        // accusatory voice, which is how a gate loses the room.
        const violates = Object.keys(v).some((k) => !k.startsWith('_') && (v[k] || 0) > 0);
        if (violates) added.push({ file, ...v });
        continue;
      }
      // A metric whose name starts with `_` is CONTEXT, not a violation: recorded so a
      // human reading the baseline can see the shape of the file, never compared.
      //
      // This exists because of a real false refusal on mishkei-lev, 2026-09-18. The Rule 2
      // detector was corrected to recognise a second project's import vocabulary, which
      // took `db_clients_held` from 46 to 84. Not one line of that repo's code changed;
      // the detector simply stopped being blind. The ratchet read the rise as a regression
      // and refused the PR. A number going up because the instrument improved is not the
      // codebase getting worse, and a gate that cannot tell the two apart teaches people
      // to regenerate baselines to make red go away, which is how a ratchet dies.
      const cmp = (o) => Object.keys(o).filter((k) => !k.startsWith('_'));
      const up = cmp(v).some((k) => (v[k] || 0) > (b[k] || 0));
      const down = cmp({ ...v, ...b }).some((k) => (v[k] || 0) < (b[k] || 0));
      if (up) worse.push({ file, was: b, now: v });
      else if (down) improved.push({ file, was: b, now: v });
    }
    for (const file of Object.keys(baseItems)) {
      if (!items[file]) improved.push({ file, was: baseItems[file], now: null });
    }

    const failed = worse.length + added.length;
    const result = {
      status: 'RAN',
      rule,
      verdict: failed ? 'WORSE' : 'NOT_WORSE',
      summary,
      baseline: base.summary,
      worse,
      added,
      improved,
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(failed ? 1 : 0);
    }

    const bar = '='.repeat(70);
    console.log(bar);
    console.log(`${rule}: ` + (failed ? 'REFUSED' : 'not worse'));
    console.log('now:      ' + headline(summary));
    console.log('baseline: ' + headline(base.summary));
    console.log(bar);
    if (added.length) {
      console.log('');
      console.log(`NEW violating file(s): ${added.length}. New code has no excuse.`);
      for (const a of added) console.log(`  ${a.file}   ${fmt(a, ['file'])}`);
    }
    if (worse.length) {
      console.log('');
      console.log(
        `file(s) that got WORSE: ${worse.length}. You are not required to fix these, only not to add to them.`
      );
      for (const w of worse) console.log(`  ${w.file}   ${diffLine(w.was, w.now)}`);
    }
    if (improved.length) {
      console.log('');
      console.log(
        `improved: ${improved.length}. Re-run with --write-baseline to lock the gain in so it cannot climb back.`
      );
      for (const i of improved.slice(0, 8))
        console.log(`  ${i.file}   ${diffLine(i.was, i.now || {})}`);
    }
    if (!failed && !improved.length) console.log('\nno change.');
    console.log('');
    console.log(bar);
    process.exit(failed ? 1 : 0);
  }

  // report (L2)
  if (asJson) {
    console.log(JSON.stringify({ status: 'RAN', rule, summary, items }, null, 2));
    process.exit(0);
  }
  const bar = '='.repeat(70);
  console.log(bar);
  console.log(`${rule}: report`);
  console.log(bar);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(22)} ${v}`);
  const worstFirst = Object.entries(items)
    .map(([f, v]) => [f, Object.values(v).reduce((a, b) => a + b, 0), v])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (worstFirst.length) {
    console.log('');
    console.log('worst offenders:');
    for (const [f, total, v] of worstFirst)
      console.log(`  ${String(total).padStart(4)}   ${f}   ${fmt(v)}`);
  }
  console.log('');
  console.log(bar);
  process.exit(0);
}

const fmt = (o, skip = []) =>
  Object.entries(o)
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
const diffLine = (was, now) =>
  Object.keys({ ...was, ...now })
    .map((k) => `${k} ${was[k] || 0} to ${now[k] || 0}`)
    .join(', ');
