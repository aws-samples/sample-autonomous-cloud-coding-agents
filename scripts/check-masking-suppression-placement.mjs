#!/usr/bin/env node
// Guards the semgrep suppression comments in source files (#790, #257).
//
// A suppression comment is the documented escape hatch of the semgrep gates, and
// an unchecked one is an unreviewed off switch. This check holds every one of
// them, in every tracked ts/js/py file, to two rules:
//
//  1. FORM. The suppression word is followed by `: <rule-id> -- <reason>` (the
//     failure message prints an example). Without a rule id the comment silences
//     every rule on its line; without a reason nobody can review it. The word is
//     found the way semgrep finds it, which is far looser than this form spells
//     it and makes no difference between code and comment. So a line that holds
//     the word at all must be one well-formed suppression and nothing else: a
//     comment that only talks about suppressions has to use other words.
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
//     A suppression counts as one for a masking rule when that rule's id stands
//     anywhere on its line: semgrep reads an id in more places and spellings
//     than the documented one, and all of them contain the id.
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

// This file is scanned like any other, so no line of it may hold the word: it is
// assembled from two halves, and the patterns spell it with a character class.
const WORD = 'nose' + 'mgrep';
const IGNORE_SUPPRESSIONS = '--disable-nose' + 'm';
// The word as semgrep finds it. Both of its patterns (one for the flagged line,
// one for the line above) match only where this one does, so nothing it honours
// is missed; `u` makes `i` fold letters the way semgrep's matcher does.
const MENTION = /(?<![a-z0-9])nose[m]\w*/giu;
// The documented form, read from where a mention starts.
const WELL_FORMED = /^nose[m]grep: [\w.-]+ -- \S/;
// A masking rule id, wherever it stands on a suppression line.
const MASKING_RULE = /(?:ts|py)-silent-success-masking/g;

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
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const mentions = [...line.matchAll(MENTION)];
    if (mentions.length === 0) return;
    suppressions++;
    if (mentions.length > 1 || !WELL_FORMED.test(line.slice(mentions[0].index))) {
      malformed.push({ file, line: i + 1, text: line.trim(), read: mentions.map((mention) => `"${mention[0]}"`).join(', ') });
      return;
    }
    const rules = new Set(line.match(MASKING_RULE));
    if (rules.size === 0) return;
    masking++;
    for (const rule of rules) {
      // On the finding's line (inline) or directly above it.
      if (!found.has(`${file}:${i + 1}:${rule}`) && !found.has(`${file}:${i + 2}:${rule}`)) {
        unbound.push({ file, line: i + 1, text: line.trim(), rule });
      }
    }
  });
}

if (malformed.length > 0) {
  console.error(`\n✖ ${malformed.length} semgrep suppression(s) not in the form \`${WORD}: <rule-id> -- <reason>\`:\n`);
  for (const v of malformed) console.error(`  ${v.file}:${v.line} (semgrep reads ${v.read})\n      ${v.text}`);
  console.error(
    '\nName the rule being suppressed and say why the finding is acceptable, for example\n' +
      `\`// ${WORD}: ts-silent-success-masking -- <why callers may treat this failure as an empty success>\`.\n` +
      'Without a rule id the comment silences every rule on its line. Semgrep finds the word far more loosely than this\n' +
      'form spells it, in code as well as in comments, so a line may hold it only as one such suppression. If the line is\n' +
      'not meant to suppress anything, reword the comment or rename the identifier that semgrep reads as the word.\n',
  );
}
if (unbound.length > 0) {
  console.error(`\n✖ ${unbound.length} silent-success-masking suppression(s) suppress nothing — semgrep reports no finding of that rule on the line or on the line below:\n`);
  for (const v of unbound) console.error(`  ${v.file}:${v.line} (${v.rule})\n      ${v.text}`);
  console.error(
    '\nIf the comment drifted away from its `return`, move it onto that line or directly above it, with any prose above that\n' +
      '(see PLACEMENT FOOTGUN in .semgrep/silent-success-masking.yaml). If the rule no longer flags this code, delete the\n' +
      'suppression and keep the explanation as an ordinary comment. The rule in brackets is the one without a finding: its\n' +
      'id counts wherever it stands on the line, so do not name a masking rule in the reason of another suppression.\n',
  );
}
if (malformed.length > 0 || unbound.length > 0) process.exit(1);

console.log(
  `✓ ${suppressions} semgrep suppressions in ${files.length} source files name a rule and a reason; ` +
    `all ${masking} silent-success-masking suppressions bind to one of ${found.size} findings`,
);
