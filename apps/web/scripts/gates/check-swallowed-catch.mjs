#!/usr/bin/env node
/**
 * Rule 20, the lint half: a check must know when it did not run.
 *
 * `catch { return false }` turns "I could not tell" into "no". That single substitution is
 * behind more of this project's incidents than any other line of code: a janitor that
 * passed at 0 of 0 while the endpoint behind it returned 500, a gate that reported green
 * because it could not see, a selftest whose container failed and which announced that the
 * gate itself was wrong.
 *
 * Three shapes are counted, because they cost different amounts to fix:
 *
 *   empty          catch {}                     nothing at all, not even a reason
 *   comment_only   catch { /* expected *\/ }     a human explained it and the program did not
 *   returns_falsy  catch { return false }       the dangerous one: an answer, and it is wrong
 *
 * Measured on egoz-maniv 2026-09-12: 11 empty, 78 comment only, 15 returning falsy, 104 in
 * total across 736 source files. Too many to refuse, so this ratchets like Rule 2 does.
 *
 * Exit codes
 *   0  ran, nothing got worse      1  ran, something got worse      2  DID NOT RUN
 *
 * Usage
 *   node check-swallowed-catch.mjs --report [--json]
 *   node check-swallowed-catch.mjs --write-baseline <file>
 *   node check-swallowed-catch.mjs --ratchet --baseline <file> [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { runRatchet } from './lib/ratchet.mjs';

// This file documents the three shapes it hunts, in its own header and in its own regexes,
// so scanning itself it counted three violations that are examples rather than defects.
// Caught by the count coming out at 107 where a scan of develop said 104, not by a check.
// Rule 29's gate carries the same exemption for the same reason.
const SELF = resolve(fileURLToPath(import.meta.url));

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
const EMPTY = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
const COMMENT = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*\}/g;
const FALSY =
  /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:false|null|undefined|0|\[\]|\{\})\s*;?\s*\}/g;

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
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function scan(root, dnr) {
  const files = walk(root);
  if (files.length === 0) {
    dnr(`no source files found under ${root}. Nothing was scanned, and that is not a clean result`);
  }
  const items = {};
  let empty = 0,
    comment_only = 0,
    returns_falsy = 0;
  for (const f of files) {
    // Only THIS file, resolved. The `|| basename(f) === basename(SELF)` that used to sit
    // here exempted any file anywhere in the tree that happened to share the name, which
    // is a hole in a Rule 20 scan opened by a convenience. boaz F7. The self-exemption
    // exists because this file's own documentation contains example catch blocks.
    if (resolve(f) === SELF) continue;
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const e = (src.match(EMPTY) || []).length;
    const c = (src.match(COMMENT) || []).length;
    const fa = (src.match(FALSY) || []).length;
    if (!(e || c || fa)) continue;
    const key = relative(root, f).split('\\').join('/');
    items[key] = {};
    if (e) items[key].empty = e;
    if (c) items[key].comment_only = c;
    if (fa) items[key].returns_falsy = fa;
    empty += e;
    comment_only += c;
    returns_falsy += fa;
  }
  return {
    items,
    summary: {
      files_scanned: files.length,
      files_with_a_swallow: Object.keys(items).length,
      empty,
      comment_only,
      returns_falsy,
      total: empty + comment_only + returns_falsy,
    },
  };
}

runRatchet({
  tool: 'check-swallowed-catch',
  rule: 'Rule 20, catch blocks that swallow',
  headline: (s) =>
    `${s.total} swallowing catch(es) in ${s.files_with_a_swallow} file(s) ` +
    `(${s.empty} empty, ${s.comment_only} comment only, ${s.returns_falsy} returning falsy)`,
  scan,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
});
