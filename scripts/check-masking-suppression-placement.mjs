#!/usr/bin/env node
// Guards the semgrep suppression comments of the repository (#790, #257).
//
// Run: node scripts/check-masking-suppression-placement.mjs  (wired into
// `security:sast:masking` and `:masking:range`, which put semgrep on PATH).
// Exit 0 when every suppression passes, 1 on a violation, 2 when the check could
// not run.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

const RULES = '.semgrep/silent-success-masking.yaml';
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py)$/;
const MARKDOWN = /\.(md|mdx)$/;

const WORD = 'nose' + 'mgrep';
const IGNORE_SUPPRESSIONS = '--disable-nose' + 'm';
// The word as semgrep finds it; `u` makes `i` fold letters the way semgrep's matcher does.
const MENTION = /(?<![a-z0-9])nose[m]\w*/giu;
const WELL_FORMED = /^nose[m]grep: [\w.-]+ -- \S/;
// semgrep reads a rule id in more places and spellings than the documented one, and all of them contain the id.
const MASKING_RULE = /(?:ts|py)-silent-success-masking/g;

function cannotRun(message) {
  console.error(`check-masking-suppression-placement: ${message}`);
  process.exit(2);
}

function scan() {
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
  return {
    // check_id carries the rules directory as a prefix (`semgrep.ts-silent-success-masking`).
    found: new Set(report.results.map((r) => `${r.path}:${r.start.line}:${r.check_id.split('.').pop()}`)),
    scanned: new Set(report.paths.scanned),
  };
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  cannotRun(`git ls-files failed: ${String(err.stderr ?? err.message).trim()}`);
}
const candidates = tracked.split('\0').filter((f) => f && !f.startsWith('.semgrep/'));
if (!candidates.some((f) => SOURCE_EXT.test(f))) cannotRun('git lists no tracked source file here. Run from the repository root.');

const { found, scanned } = scan();
// semgrep honours a suppression in workflows, Dockerfiles, shell scripts and configuration too, and picks its files
// by more than the name. It reads a source file that holds a NUL byte and does not read through a symbolic link.
const files = candidates.filter((f) => (!MARKDOWN.test(f) || scanned.has(f)) && lstatSync(f).isFile());
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
  `✓ ${suppressions} semgrep suppressions in ${files.length} files name a rule and a reason; ` +
    `all ${masking} silent-success-masking suppressions bind to one of ${found.size} findings`,
);
