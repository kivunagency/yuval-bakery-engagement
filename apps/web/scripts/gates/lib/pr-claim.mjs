/**
 * A gate that asks the PR body to SAY something, when the diff shows it should.
 *
 * WHY THIS MODULE EXISTS. The Rule 27 declaration gate proved the shape works: it does not
 * forbid a new route, it refuses a PR that says nothing about whether the route registers
 * an operation. "none, because ..." is a good answer. Silence is not. Rules 17 and 26 want
 * the identical mechanism, and writing it a third time is the duplication Rule 24 exists to
 * prevent, so it was extracted before the second one was written.
 *
 * A gate supplies: when the diff TRIGGERS the question, and what shape of answer counts.
 * This module owns the diff, the body, all three outcomes, and every DID NOT RUN path.
 *
 * WHY A DECLARATION AND NOT A REFUSAL. The forcing function is the sentence, not the block.
 * A gate that refuses the work gets routed around; a gate that refuses SILENCE costs one
 * line and changes what the author had to think about before writing it.
 *
 * Exit codes
 *   0  no trigger, or triggered and answered
 *   1  triggered and the body says nothing
 *   2  DID NOT RUN (Rule 20), reason printed by name
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

export function runPrClaim({ tool, rule, trigger, claimPattern, howToAnswer, argv, cwd }) {
  const arg = (n, d = null) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const die = (code, msg) => {
    console.error(msg);
    process.exit(code);
  };
  const dnr = (why) => die(2, `DID NOT RUN: ${tool}\n  reason: ${why}`);

  const base = arg('base');
  if (!base)
    dnr(
      'no --base given. Without a base there is no diff, so nothing could be examined. This is not a pass.'
    );

  const bodyFile = arg('body-file');
  const bodyInline = arg('body');
  let body = null;
  if (bodyFile) {
    if (!existsSync(bodyFile))
      dnr(`--body-file ${bodyFile} does not exist. An unreadable body is not an answered one.`);
    body = readFileSync(bodyFile, 'utf8');
  } else if (bodyInline !== null) {
    body = bodyInline;
  } else {
    dnr(
      'no PR body supplied (--body or --body-file). Without it the claim cannot be read, and an unreadable claim is not a claim.'
    );
  }

  const root = arg('root', cwd);
  let nameStatus, diffText;
  try {
    nameStatus = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    diffText = execFileSync('git', ['diff', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    dnr(
      `git could not diff against ${base}: ${
        String(e.stderr || e.message)
          .trim()
          .split('\n')[0]
      }`
    );
  }

  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status.trim(), path: rest[rest.length - 1] };
    });

  const t = trigger({ files, diffText });
  if (!t.triggered) {
    console.log(`${rule}: not triggered. ${t.why}`);
    process.exit(0);
  }

  // YuvalBakery fix (2026-09-26), found by scripts/gates/selftest.sh: this used to read
  // `(m[1] || m[0])`, and the RTL gate's pattern opens with a `(^|\n)` group, so m[1] was
  // the newline itself, trimmed to '' and dropped. A claim anywhere but on the body's first
  // line was never seen, and a correct PR was refused. The whole match is the claim.
  const found = [...body.matchAll(claimPattern)].map((m) => m[0].trim()).filter(Boolean);

  console.log(`${rule}`);
  console.log(`triggered: ${t.why}`);
  for (const e of (t.evidence || []).slice(0, 20)) console.log(`  ${e}`);
  if ((t.evidence || []).length > 20) console.log(`  (+${t.evidence.length - 20} more)`);
  console.log(`claims found in the PR body: ${found.length}`);
  for (const f of found.slice(0, 10)) console.log(`  ${f.slice(0, 160)}`);

  if (found.length === 0) {
    console.log('');
    console.log(howToAnswer);
    process.exit(1);
  }
  console.log('');
  console.log('answered.');
  process.exit(0);
}
