#!/usr/bin/env node
/**
 * Rule 17: "done" requires naming the ARTEFACT the change produced.
 *
 * The row that was written. The branch that executed. The button that was pressed. Green
 * tests are evidence of absent failures, never of a working feature, and this project has
 * paid for that distinction repeatedly: a janitor green at 0 of 0 while the endpoint
 * behind it returned 500, a migration merged and never applied, a fix verified by an API
 * call that proved the mechanism could work and never proved the client's path.
 *
 * So a PR that changes BEHAVIOUR must point at something that exists because of it.
 *
 * WHAT COUNTS. A row or record id, a commit sha, a screenshot, a run or job id, a quoted
 * before-and-after, a named invariant that flipped. Deliberately broad: the point is that
 * the author had to go and look at something, not that they matched a house format.
 *
 * WHAT DOES NOT COUNT. "tests pass", "verified", "works as expected". Those are the
 * sentences Rule 17 was written to stop.
 *
 * Exit codes
 *   0  no behaviour change, or changed and evidenced    1  changed and nothing cited
 *   2  DID NOT RUN (Rule 20)
 */

import { runPrClaim } from './lib/pr-claim.mjs';

// Behaviour lives in app code and database migrations. Docs, tests and CI config can all
// change without anything in the product behaving differently, and firing on them is how
// a gate becomes noise.
const BEHAVIOUR = /\.(ts|tsx|js|jsx|mjs|sql|py)$/;
const NOT_BEHAVIOUR =
  /(\.test\.|\.spec\.|\/qa\/|\/tests?\/|\/__tests__\/|\.github\/|\/scripts\/|\.md$|\.json$|learnings\.jsonl|audit-log)/;

// An artefact is something you can go and look at.
const ARTEFACT = new RegExp(
  [
    '\\b[0-9a-f]{7,40}\\b', // a commit sha
    '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', // a uuid, a row
    '!\\[[^\\]]*\\]\\([^)]+\\)', // a markdown image
    'https?://\\S+\\.(?:png|jpe?g|gif|webp)', // a screenshot
    'https?://github\\.com/\\S+/(?:actions/runs|pull)/\\d+', // a run or a PR
    '\\brun\\s+\\d{6,}', // a run id
    '\\bjob\\s+\\d{6,}',
    '(?:row|record|ticket|lease|payment|invoice|migration)\\s*#?\\s*[0-9a-zA-Z_-]{3,}',
    '\\b\\d+\\s*(?:->|to)\\s*\\d+\\b', // a before and after
    '\\b(?:BEFORE|AFTER)\\b.*\\d',
    'invariant[s]?\\b.*\\b(?:pass|fail|green|red|\\d+)',
    'שורה|מזהה|צילום מסך|לפני.*אחרי', // row, id, screenshot, before/after
  ].join('|'),
  'gi'
);

runPrClaim({
  tool: 'check-proof-of-execution',
  rule: 'Rule 17, proof of execution',
  trigger: ({ files }) => {
    const changed = files
      .filter((f) => f.status !== 'D' && BEHAVIOUR.test(f.path) && !NOT_BEHAVIOUR.test(f.path))
      .map((f) => f.path);
    if (changed.length === 0) {
      return { triggered: false, why: 'no behaviour file changed, only docs, tests or CI config' };
    }
    return {
      triggered: true,
      why: `${changed.length} file(s) that can change what the product does`,
      evidence: changed,
    };
  },
  claimPattern: ARTEFACT,
  howToAnswer: `This PR changes behaviour and the body names no artefact.

Rule 17: "done" requires naming the thing the change PRODUCED. The row that was written,
the branch that executed, the button that was pressed, the number that moved. Green tests
are evidence of absent failures, never of a working feature.

Point at something that exists because of this change:

    the row id or uuid it wrote
    a before and after:  7398 -> 7400
    a screenshot of the screen it fixed
    the run or job id where you watched it
    an invariant that flipped, by name

"tests pass" and "verified" are the sentences this rule was written to stop. They describe
your confidence, not the system.`,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
