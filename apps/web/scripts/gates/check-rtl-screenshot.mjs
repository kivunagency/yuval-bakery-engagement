#!/usr/bin/env node
/**
 * Rule 26: Hebrew is verified RENDERED, never by reading the source.
 *
 * The bidi algorithm gives punctuation no direction of its own. `:` `;` `,` `()` `""` `-`
 * `/` `%` and digits all inherit direction from what follows, so a correct source string
 * renders with the mark on the wrong end. Reading the diff cannot catch it. Looking can.
 *
 * Origin: ticket #39 reached round FOUR over a colon. The fix is never to move the
 * character in the string, which only relocates the fault, and the only way to know which
 * you did is to look at it rendered.
 *
 * So: a PR that adds Hebrew to a user-facing surface must SAY it looked. A link to a
 * screenshot, an artifact, or a named rendered check. Not a promise, a reference.
 *
 * Exit codes
 *   0  no Hebrew added, or added and evidenced      1  Hebrew added, body says nothing
 *   2  DID NOT RUN (Rule 20)
 *
 * Usage
 *   node check-rtl-screenshot.mjs --base origin/develop --body-file pr-body.txt
 */

import { runPrClaim } from './lib/pr-claim.mjs';

// Hebrew that a user can see. Test fixtures and QA specs are excluded on purpose: they are
// not a surface anyone reads in a browser, and firing on them would make this noise.
const USER_FACING = /\.(tsx|ts|jsx|js|json|md|html)$/;
const NOT_A_SURFACE =
  /(\.test\.|\.spec\.|\/qa\/|\/tests?\/|\/__tests__\/|CHANGELOG|learnings\.jsonl|audit-log)/;
const HEBREW = /[֐-׿]/;
// A neutral is only RISKY when it sits between Hebrew and something that can pull its
// direction the other way: another Hebrew word, a digit, or Latin. The first draft matched
// any neutral anywhere on the line, so `const label = "שלום עולם";` triggered on the code's
// own quote and semicolon. That is the noise that gets a gate switched off, and the test
// caught it before this shipped.
const N = ':;,()\\[\\]"\'/%₪=<>';
const NEUTRAL_BESIDE_HEBREW = new RegExp(
  `[֐-׿][ \\t]*[${N}][ \\t]*[֐-׿0-9A-Za-z]` + `|[֐-׿0-9A-Za-z][ \\t]*[${N}][ \\t]*[֐-׿]`
);

// NO \b around the Hebrew alternatives. In JavaScript \b is defined against \w, and a
// Hebrew letter is not a \w character, so `\bצילום` can never match. Same class of bug as
// matching `גובה` inside `תגובה`: Hebrew has no word boundary that a regex engine knows.
const CLAIM =
  /(^|\n)[^\n]*(?:\bscreenshot\b|\brendered\b|\brtl[- ]?verified\b|צילום מסך|מרונדר)[^\n]*/gi;
const IMAGE =
  /!\[[^\]]*\]\([^)]+\)|https?:\/\/\S+\.(?:png|jpe?g|gif|webp)|user-images\.githubusercontent|github\.com\/user-attachments/gi;
const EITHER = new RegExp(`${CLAIM.source}|${IMAGE.source}`, 'gi');

runPrClaim({
  tool: 'check-rtl-screenshot',
  rule: 'Rule 26, Hebrew is verified rendered',
  trigger: ({ files, diffText }) => {
    const candidates = files
      .filter((f) => f.status !== 'D' && USER_FACING.test(f.path) && !NOT_A_SURFACE.test(f.path))
      .map((f) => f.path);
    if (candidates.length === 0) return { triggered: false, why: 'no user-facing file changed' };

    // only ADDED lines, and only Hebrew sitting next to a neutral character
    const added = [];
    let current = null;
    for (const line of diffText.split('\n')) {
      const m = line.match(/^\+\+\+ b\/(.+)$/);
      if (m) {
        current = m[1];
        continue;
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      if (!current || !candidates.includes(current)) continue;
      const text = line.slice(1);
      if (HEBREW.test(text) && NEUTRAL_BESIDE_HEBREW.test(text)) {
        added.push(`${current}: ${text.trim().slice(0, 100)}`);
      }
    }
    if (added.length === 0) {
      return { triggered: false, why: 'no Hebrew was added beside a direction-neutral character' };
    }
    return {
      triggered: true,
      why: `${added.length} added line(s) put Hebrew next to a character that has no direction of its own`,
      evidence: added,
    };
  },
  claimPattern: EITHER,
  howToAnswer: `This PR adds Hebrew next to a character the bidi algorithm gives NO direction of
its own, and the PR body does not say anyone looked at it rendered.

Reading the diff cannot catch this. The source string can be correct and the screen
still wrong, because ':' ';' ',' '()' '""' '/' '%' and digits all take their direction
from what follows them. Ticket #39 reached round FOUR over a colon.

Put one of these in the PR body:

    Screenshot: <link to the rendered screen>
    Rendered: verified on <screen name>, <what you looked at>

And when you fix one, fix it with DIRECTION (dir="auto", unicode-bidi: isolate, an RLM
where one neutral needs pinning). NEVER by moving the character inside the string: that
relocates the fault, it does not remove it.`,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
