/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Tests for the two steps of `.github/workflows/security.yml` that warn before a
 * scan ignore expires: the step that reads the ignore files (`osv-scanner.toml`
 * for the dependency scan, `.trivyignore` for the image scan), and the report to
 * the rolling issue.
 *
 * Both are shell written in the workflow file, and Actions runs them once a week:
 * a mistake there shows as a warning that never arrives. Each case runs the `run`
 * text of the two steps with bash, as the job does after a suite that passed, in
 * a throwaway repository that holds the ignore files of the case. A shell function
 * stands in for `gh` and keeps what it is asked to post. The reader asks the clock
 * for today, so its `node` starts with a preload that answers TODAY: the dates in
 * the cases are fixed, and so is the number of days each entry has left.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
}

const WORKFLOW_FILE = path.resolve(__dirname, '../../../.github/workflows/security.yml');
const WORKFLOW = yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf-8')) as { jobs: { security: { steps: Step[] } } };
const STEPS = WORKFLOW.jobs.security.steps;
const EXPIRY = STEPS.find((step) => step.id === 'expiry');
const REPORT = STEPS.find((step) => step.name === 'Report to the rolling issue');

/** The day the steps take for today (UTC). */
const TODAY = '2030-05-10';

/** A preload for `node` that makes `new Date()` the start of TODAY. */
const CLOCK = `const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : ['${TODAY}']));
  }
};
`;

/**
 * Stands in for `gh`. A shell function, so that no `gh` on PATH can answer in its
 * place: it finds no open issue, and keeps the body it is asked to post.
 */
const GH = `gh() {
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then mv "$2" "$POSTED"; fi
    shift
  done
}`;

interface Result {
  /** The entries the expiry step added to the job summary. */
  readonly listed: string[];
  /** The headings it added. */
  readonly headings: string[];
  /** The body the report step posted to the rolling issue, when it posted one. */
  readonly posted?: string;
}

/** Run the expiry step and then the report step, the suite having passed, in a temp repo holding `files`. */
function run(files: Record<string, string>, expiryOutcome = 'success'): Result {
  if (EXPIRY?.run === undefined || REPORT?.run === undefined) {
    throw new Error('security.yml has no step with the id `expiry`, or no step named "Report to the rolling issue"');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-security-workflow-'));
  const root = path.join(work, 'repo');
  const clock = path.join(work, 'clock.js');
  const summary = path.join(work, 'summary.md');
  const posted = path.join(work, 'posted.md');
  try {
    fs.mkdirSync(root);
    for (const [rel, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), contents);
    }
    fs.writeFileSync(clock, CLOCK);
    fs.writeFileSync(summary, '');

    // No inherited GIT_* variable: under a git hook they point at the real
    // repository. Every variable the steps read is set here: in CI the inherited
    // GITHUB_STEP_SUMMARY is the summary of the job that runs this suite.
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    const env = {
      ...Object.fromEntries(inherited),
      // The reader names `node`: the one that runs this suite, with TODAY for its clock.
      PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      NODE_OPTIONS: `--require ${JSON.stringify(clock)}`,
      POSTED: posted,
      GITHUB_STEP_SUMMARY: summary,
      SCAN_OUTCOME: 'success',
      EXPIRY_OUTCOME: expiryOutcome,
      GITHUB_RUN_NUMBER: '1',
      GITHUB_RUN_ID: '1',
      GITHUB_SERVER_URL: 'https://github.example',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_SHA: 'abc',
      GITHUB_ACTOR: 'someone',
      GITHUB_EVENT_NAME: 'schedule',
    };
    execFileSync('git', ['init', '--quiet'], { cwd: root, env, stdio: 'ignore' });
    execFileSync('git', ['add', '--all'], { cwd: root, env, stdio: 'ignore' });

    for (const script of [EXPIRY.run, REPORT.run]) {
      // The timeout is spawnSync's own: jest cannot stop a synchronous child.
      const result = spawnSync('bash', ['-c', `${GH}\n${script}`], { cwd: root, env, encoding: 'utf-8', timeout: 30_000 });
      if (result.status !== 0) {
        throw new Error(`a step exited with ${result.status}: ${result.error?.message ?? result.stderr}`);
      }
    }

    const lines = fs.readFileSync(summary, 'utf-8').split('\n');
    return {
      listed: lines.filter((line) => line.startsWith('- ')),
      headings: lines.filter((line) => line.startsWith('#')),
      posted: fs.existsSync(posted) ? fs.readFileSync(posted, 'utf-8') : undefined,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** An `osv-scanner.toml` with one ignore. */
const osvIgnore = (id: string, until: string): string => `[[IgnoredVulns]]\nid = "${id}"\neffectiveUntil = ${until}\nreason = "a reason"\n`;

describe('the weekly warning about scan ignores close to expiry', () => {
  // Every test is a handful of subprocess spawns; give them room on a loaded machine.
  jest.setTimeout(60_000);

  // Each line is in a form trivy 0.76.2 was seen to read that way. It trims the line,
  // takes one that then starts with `#` for a comment, and splits the others at white
  // space: the first word is the id, and the first later word that starts with `exp:`,
  // in lower case, is the expiry, even after a `#`. An entry whose expiry trivy cannot
  // read as a date is listed as such; one without an expiry is not listed.
  test('reads an image-scan ignore the way trivy does', () => {
    const { listed } = run({
      'agent/.trivyignore': [
        '# The reason for the entry below.',
        'CVE-2099-0001 exp:2030-05-20',
        '  CVE-2099-0002\texp:2030-05-20 trailing words\r',
        'CVE-2099-0003 # checked on 2030-07-09 exp:2030-05-20',
        'CVE-2099-0004 exp:2030-05-20 exp:2030-07-09',
        'CVE-2099-0005 exp:2030-13-45',
        'CVE-2099-0006 EXP:2030-05-20',
        'CVE-2099-0007',
        '# CVE-2099-0008 exp:2030-05-20',
        '  #CVE-2099-0009 exp:2030-05-20',
        'CVE-2099-0010 exp:soon',
        '',
      ].join('\n'),
    });

    expect(listed).toEqual([
      '- `agent/.trivyignore:2` CVE-2099-0001: ignored until 2030-05-20 (10 day(s) left)',
      '- `agent/.trivyignore:3` CVE-2099-0002: ignored until 2030-05-20 (10 day(s) left)',
      '- `agent/.trivyignore:4` CVE-2099-0003: ignored until 2030-05-20 (10 day(s) left)',
      '- `agent/.trivyignore:5` CVE-2099-0004: ignored until 2030-05-20 (10 day(s) left)',
      '- `agent/.trivyignore:6` CVE-2099-0005: ignored until 2030-13-45 (date not readable)',
      '- `agent/.trivyignore:11` CVE-2099-0010: ignored until soon (date not readable)',
    ]);
  });

  // The date is the first day on which trivy no longer applies the entry, so an
  // entry dated TODAY has expired. The last entry is 22 days ahead.
  test('lists an image-scan ignore from 21 days before the day it stops applying', () => {
    const { listed } = run({
      'agent/.trivyignore': [
        'CVE-2099-0001 exp:2030-05-08',
        'CVE-2099-0002 exp:2030-05-10',
        'CVE-2099-0003 exp:2030-05-11',
        'CVE-2099-0004 exp:2030-05-31',
        'CVE-2099-0005 exp:2030-06-01',
        '',
      ].join('\n'),
    });

    expect(listed).toEqual([
      '- `agent/.trivyignore:1` CVE-2099-0001: ignored until 2030-05-08 (expired)',
      '- `agent/.trivyignore:2` CVE-2099-0002: ignored until 2030-05-10 (expired)',
      '- `agent/.trivyignore:3` CVE-2099-0003: ignored until 2030-05-11 (1 day(s) left)',
      '- `agent/.trivyignore:4` CVE-2099-0004: ignored until 2030-05-31 (21 day(s) left)',
    ]);
  });

  test('lists the image-scan ignores of every directory beside the osv-scanner ignores, under one heading', () => {
    const { listed, headings } = run({
      'osv-scanner.toml': osvIgnore('GHSA-aaaa-bbbb-cccc', '2030-05-20'),
      'agent/osv-scanner.toml': osvIgnore('GHSA-dddd-eeee-ffff', '2030-05-20'),
      '.trivyignore': 'CVE-2099-0001 exp:2030-05-20\n',
      'agent/.trivyignore': 'CVE-2099-0002 exp:2030-05-20\n',
      'integrations/app/.trivyignore': 'CVE-2099-0003 exp:2030-05-20\n',
    });

    expect(listed).toEqual([
      '- `agent/osv-scanner.toml:3` GHSA-dddd-eeee-ffff: ignored until 2030-05-20 (10 day(s) left)',
      '- `osv-scanner.toml:3` GHSA-aaaa-bbbb-cccc: ignored until 2030-05-20 (10 day(s) left)',
      '- `.trivyignore:1` CVE-2099-0001: ignored until 2030-05-20 (10 day(s) left)',
      '- `agent/.trivyignore:1` CVE-2099-0002: ignored until 2030-05-20 (10 day(s) left)',
      '- `integrations/app/.trivyignore:1` CVE-2099-0003: ignored until 2030-05-20 (10 day(s) left)',
    ]);
    expect(headings).toHaveLength(1);
  });

  // Not about the image scan: the osv-scanner reader shares the lines that turn a
  // date into a warning with the image-scan reader, and these two reports are its own.
  test('keeps the two special reports of the osv-scanner reader', () => {
    const { listed } = run({
      'osv-scanner.toml': [
        '[[IgnoredVulns]]',
        'id = "GHSA-aaaa-bbbb-cccc"',
        'effectiveUntil = "soon"',
        '[[IgnoredVulns]]',
        'id = "GHSA-dddd-eeee-ffff"',
        '"effectiveUntil" = 2030-05-20',
        '',
      ].join('\n'),
    });

    expect(listed).toEqual([
      '- `osv-scanner.toml:3` GHSA-aaaa-bbbb-cccc: ignored until "soon" (date not readable)',
      expect.stringContaining('- `osv-scanner.toml:6` entry: expiry not readable in this form'),
    ]);
  });

  test('posts an image-scan ignore to the rolling issue when the suite passed', () => {
    const { posted } = run({ 'agent/.trivyignore': 'CVE-2099-0001 exp:2030-05-20\n' });

    expect(posted).toContain('- `agent/.trivyignore:1` CVE-2099-0001: ignored until 2030-05-20 (10 day(s) left)');
  });

  test('posts nothing when no ignore is close to expiry', () => {
    const { listed, posted } = run({
      'osv-scanner.toml': osvIgnore('GHSA-aaaa-bbbb-cccc', '2030-07-09'),
      'agent/.trivyignore': 'CVE-2099-0001 exp:2030-07-09\n',
    });

    expect(listed).toEqual([]);
    expect(posted).toBeUndefined();
  });

  test('names the step to look at when the check did not finish', () => {
    const { posted } = run({}, 'failure');

    expect(posted).toContain(`The step "${EXPIRY?.name}" in the workflow run shows why.`);
  });
});
