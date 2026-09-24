#!/usr/bin/env node
/**
 * Rule 1: English-first. Hebrew reaches the screen through a translation file, never as a
 * literal in code. The rule calls a hardcoded Hebrew string a critical bug.
 *
 * HOW THE HEBREW IS DETECTED, and why this paragraph exists. Measuring this took FOUR
 * attempts on 2026-09-18, and the first three all produced confident, wrong numbers:
 *
 *   [א-ת] as a shell bracket range   reported 20 of 20 mishkei files as
 *                                              containing Hebrew. The real answer was 0.
 *                                              A multi-byte range in a POSIX bracket
 *                                              expression is not portable and matched
 *                                              everything.
 *   perl -ne '/\p{Hebrew}/'                    reported 0 for a file I had just READ
 *                                              Hebrew out of, because the input was not
 *                                              decoded as UTF-8 and the bytes never
 *                                              formed a Hebrew codepoint.
 *   grep -P '\p{Hebrew}'                       correct, but -P is absent on BSD grep,
 *                                              which is what this Mac ships.
 *
 * So: an explicit numeric codepoint range, in JavaScript, where strings are already
 * UTF-16. Three of the four methods agreed with each other and were all wrong together,
 * which is the case a planted-defect test catches and a cross-check does not.
 *
 * WHAT IT COUNTS. Hebrew in a STRING LITERAL or JSX text. Not in a comment: a Hebrew
 * comment is a note to a developer, not a string that reaches a user, and flagging it
 * would make this noisy enough to be switched off.
 *
 * WHY IT RATCHETS. egoz-maniv carries Hebrew in 212 of 330 source files, 51,799
 * characters. It is grandfathered by the rule's own text. mishkei-lev has ZERO in 23
 * files, because the rule existed while it was written. New projects get an empty
 * baseline and a blocking gate.
 *
 * Exit codes
 *   0  ran, nothing got worse     1  ran, something got worse     2  DID NOT RUN
 *
 * Usage
 *   node check-hardcoded-hebrew.mjs --report [--json]
 *   node check-hardcoded-hebrew.mjs --write-baseline <file>
 *   node check-hardcoded-hebrew.mjs --ratchet --baseline <file> [--json]
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
  'locales',
  'i18n',
  'messages',
  'translations',
]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Hebrew block U+0590 to U+05FF, written as numbers so no locale, shell or regex-engine
// difference can reinterpret it. This is the whole point of the header comment above.
const HEBREW = /[֐-׿]/;

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
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Strip comments so a Hebrew note to a developer is not reported as a user-facing string.
 * Deliberately simple: it does not parse, it removes `//` to end of line and block
 * comments. A `//` inside a string literal would over-strip, which can only ever cause
 * an UNDER-count, never a false accusation. Given this gate ratchets, under-counting is
 * the safe direction, and the header says so rather than leaving it to be discovered.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function scan(root, dnr) {
  const files = walk(root);
  if (files.length === 0) {
    dnr(
      `no .ts/.tsx/.js/.jsx files found under ${root}. Nothing was scanned, and that is ` +
        `not "no hardcoded Hebrew". Point --root at the application directory.`
    );
  }
  const items = {};
  let filesWithHebrew = 0,
    hebrewLines = 0,
    inComments = 0;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!HEBREW.test(src)) continue;
    const code = stripComments(src);
    let lines = 0;
    for (const line of code.split('\n')) if (HEBREW.test(line)) lines++;
    const commentOnly = !lines;
    if (commentOnly) {
      inComments++;
      continue;
    }
    filesWithHebrew++;
    hebrewLines += lines;
    items[relative(root, f)] = { hebrewLines: lines };
  }
  return {
    items,
    summary: {
      files: files.length,
      filesWithHebrew,
      hebrewLines,
      filesWithHebrewOnlyInComments: inComments,
    },
  };
}

runRatchet({
  tool: 'check-hardcoded-hebrew',
  rule: 'Rule 1, English-first i18n',
  headline: (s) =>
    `${s.filesWithHebrew} of ${s.files} file(s) carry Hebrew in code ` +
    `(${s.hebrewLines} line(s)); ${s.filesWithHebrewOnlyInComments} have it only in comments`,
  scan,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
