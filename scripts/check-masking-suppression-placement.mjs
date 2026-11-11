#!/usr/bin/env node
// Guards the semgrep suppression comments in source files (#790, #257).
//
// A suppression comment is the documented escape hatch of the semgrep gates, and
// an unchecked one is an unreviewed off switch. This check holds every one of
// them, in every tracked ts/js/py file, to two rules:
//
//  1. FORM. It reads `nosemgrep: <rule-id> -- <reason>`. Without a rule id the
//     comment silences every rule on its line; without a reason nobody can review
//     it. Any other mention of the word on a line of code counts too, because
//     semgrep honours the bare word anywhere on a flagged line.
//
//  2. BINDING, for the two silent-success-masking rules. `focus-metavariable: $RET`
//     in .semgrep/silent-success-masking.yaml anchors each finding on the returned
//     value, so a suppression only acts when it sits ON that line or on the line
//     IMMEDIATELY above it. One that sits anywhere else suppresses nothing: either
//     it drifted away from its return (the finding is then live, or the comment
//     only looks like it is doing something), or the code changed and no longer
//     needs it. Both are reported. This is asked of semgrep itself rather than
//     guessed from the text: the rules are run once with suppressions ignored and
//     every suppression must sit on, or directly above, a finding of its rule.
//
// The binding rule covers only the two local rules because only they can be run
// offline and reproducibly; the registry rules behind `security:sast` cannot.
//
// Run: node scripts/check-masking-suppression-placement.mjs  (wired into
// `security:sast:masking` and `:masking:range`, which put semgrep on PATH).
// Exit 0 when every suppression passes, 1 on a violation, 2 when the check could
// not run (it never passes on what it could not read).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = '.semgrep/silent-success-masking.yaml';
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py)$/;

// This file is scanned like any other, so no line of its code may read as a
// suppression: the word is assembled from two halves, and the patterns spell it
// with a character class.
const WORD = 'nose' + 'mgrep';
const IGNORE_SUPPRESSIONS = '--disable-nose' + 'm';
const MENTION = /\bnose[m](?:grep)?\b/;
// On a comment-only line semgrep honours the word only where it opens the
// comment; further in it is prose. On a line of code it honours it anywhere.
// What opens a comment depends on the language: in JS and TS a leading `#` is a
// private field and `*name` a generator method, both code.
const PY_COMMENT_ONLY = /^\s*#/;
const JS_COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$))/;
const OPENS_COMMENT = /^[^a-zA-Z0-9]*nose[m](?:grep)?\b/;
const WELL_FORMED = /\bnose[m]grep: [\w.-]+ -- \S/;
const MASKING = /\bnose[m]grep: ((?:ts|py)-silent-success-masking) -- /;

/** The check could not run: say why and stop, never report success. */
function cannotRun(message) {
  console.error(`check-masking-suppression-placement: ${message}`);
  process.exit(2);
}

/** `file:line` of every masking finding, with suppression comments ignored. */
function findings() {
  let stdout;
  try {
    stdout = execFileSync(
      'semgrep',
      ['scan', '--config', RULES, '--exclude', '.semgrep/*', IGNORE_SUPPRESSIONS, '--json', '--quiet', '--metrics=off', '--disable-version-check', '.'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    cannotRun(
      err.code === 'ENOENT'
        ? 'semgrep is not on PATH. Run this through `mise run security:sast:masking`.'
        : `semgrep failed (exit ${err.status}): ${String(err.stderr ?? err.message).trim()}`,
    );
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (err) {
    cannotRun(`semgrep did not print JSON: ${err.message}`);
  }
  if (!Array.isArray(report.results) || !Array.isArray(report.paths?.scanned) || report.paths.scanned.length === 0) {
    cannotRun('semgrep scanned no file, so no suppression can be matched to a finding.');
  }
  // check_id carries the rules directory as a prefix (`semgrep.ts-silent-success-masking`).
  return new Set(report.results.map((r) => `${r.path}:${r.start.line}:${r.check_id.split('.').pop()}`));
}

// Tracked source files only; the .semgrep/ fixtures trigger by design.
let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  cannotRun(`git ls-files failed: ${String(err.stderr ?? err.message).trim()}`);
}
const files = tracked.split('\0').filter((f) => f && SOURCE_EXT.test(f) && !f.startsWith('.semgrep/'));
if (files.length === 0) cannotRun('git lists no tracked source file here. Run from the repository root.');

const found = findings();
const malformed = [];
const unbound = [];
let suppressions = 0;
let masking = 0;
for (const file of files) {
  const commentOnly = file.endsWith('.py') ? PY_COMMENT_ONLY : JS_COMMENT_ONLY;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!MENTION.test(line) || (commentOnly.test(line) && !OPENS_COMMENT.test(line))) return;
    suppressions++;
    if (!WELL_FORMED.test(line)) {
      malformed.push({ file, line: i + 1, text: line.trim() });
      return;
    }
    const rule = MASKING.exec(line)?.[1];
    if (!rule) return;
    masking++;
    // On the finding's line (inline) or directly above it.
    if (!found.has(`${file}:${i + 1}:${rule}`) && !found.has(`${file}:${i + 2}:${rule}`)) {
      unbound.push({ file, line: i + 1, text: line.trim() });
    }
  });
}

if (malformed.length > 0) {
  console.error(`\n✖ ${malformed.length} semgrep suppression(s) not in the form \`${WORD}: <rule-id> -- <reason>\`:\n`);
  for (const v of malformed) console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  console.error(
    '\nName the rule being suppressed and say why the finding is acceptable, for example\n' +
      `\`// ${WORD}: ts-silent-success-masking -- <why callers may treat this failure as an empty success>\`.\n` +
      'Without a rule id the comment silences every rule on its line. If the line only mentions the word, reword it.\n',
  );
}
if (unbound.length > 0) {
  console.error(`\n✖ ${unbound.length} silent-success-masking suppression(s) suppress nothing — semgrep reports no finding of that rule on the line or on the line below:\n`);
  for (const v of unbound) console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  console.error(
    '\nIf the comment drifted away from its `return`, move it onto that line or directly above it, with any prose above that\n' +
      '(see PLACEMENT FOOTGUN in .semgrep/silent-success-masking.yaml). If the rule no longer flags this code, delete the\n' +
      'suppression and keep the explanation as an ordinary comment.\n',
  );
}
if (malformed.length > 0 || unbound.length > 0) process.exit(1);

console.log(
  `✓ ${suppressions} semgrep suppressions in ${files.length} source files name a rule and a reason; ` +
    `all ${masking} silent-success-masking suppressions bind to one of ${found.size} findings`,
);
