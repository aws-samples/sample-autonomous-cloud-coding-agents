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
 * Test that the `deploy` task of `cdk/mise.toml` and `.github/workflows/deploy.yml`
 * stay in step (#843).
 *
 * The pipeline does not run the task: its `deploy` job runs `npx cdk deploy` on the
 * assembly that `build.yml` synthesized. What the task does before it deploys therefore
 * happens in the pipeline only where the workflow has a step of its own, and a step
 * added to the task is skipped there without a word. This test fails, without AWS
 * access, when a dependency or a command of the task is added, removed, moved or
 * changed and the table below does not follow, when a step the table records for the
 * pipeline is no longer in the workflow, and when a step of the workflow runs a preflight
 * that the table does not record for it.
 *
 * The task is read as text, so that this suite needs neither a TOML parser, which no
 * workspace declares, nor `mise` on PATH. It takes one form only: a description, then
 * `depends` and `run` as arrays of double-quoted strings, and compares each string
 * whole. Under another key or in another TOML spelling a step would go unseen, so
 * anything else in the table fails the test as well, and so does a sub-table of the task.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the Jest
 * tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW_FILE = '.github/workflows/deploy.yml';

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf-8');

/** The step of `deploy.yml` that does in the pipeline what an entry of the task does locally. */
interface PipelineStep {
  readonly job: string;
  /** Text that the `run` of exactly one step of that job contains. */
  readonly run: string;
}

/**
 * What each command of the task ends with: mise puts the arguments after `--` there. The
 * table records it with the command, because mise also runs a default written in it and
 * whatever follows it.
 */
const ARGS = "{{arg(name='cdkargs', var=true, required=false)}}";

/**
 * Every dependency and command of the task as the task writes it, in the task's order,
 * each with its step in the pipeline; no step where the workflow has none. The comment
 * on `[tasks.deploy]` gives the reason for each entry: keep the two in step.
 */
const PIPELINE: readonly (readonly [entry: string, step?: PipelineStep])[] = [
  [':clean:disk'],
  ['//web:bundle'],
  [`npx tsx scripts/preflight-bootstrap.ts ${ARGS}`],
  [`node --experimental-strip-types scripts/preflight-log-delivery.ts ${ARGS}`, { job: 'diff', run: 'cdk/scripts/preflight-log-delivery.ts --check-only' }],
  [`npx cdk deploy ${ARGS}`, { job: 'deploy', run: 'npx cdk deploy --app cdk/cdk.out' }],
];

const isComment = (line: string): boolean => line.trimStart().startsWith('#');

const MISE = read('cdk/mise.toml').split('\n');

/** The lines of the task's table: after its header, up to the next table. */
function taskLines(): string[] {
  const start = MISE.indexOf('[tasks.deploy]');
  if (start < 0) {
    throw new Error('cdk/mise.toml has no task deploy');
  }
  const body = MISE.slice(start + 1);
  const end = body.findIndex((line) => line.startsWith('['));
  return body.slice(0, end < 0 ? undefined : end);
}

/** The table without its comments, as mise reads it. */
const TASK = taskLines().filter((line) => line !== '' && !isComment(line)).join('\n');

/**
 * The headers of the task's sub-tables (`[tasks.deploy.env]`), which give it keys outside
 * its table. TOML reads a header with indentation, with spaces around its keys or with
 * quoted keys as the same header.
 */
const SUB_TABLES = MISE.filter((line) => /^\s*\[+\s*(tasks|"tasks"|'tasks')\s*\.\s*(deploy|"deploy"|'deploy')\s*\./.test(line));

/** `key = [...]`, where the array holds double-quoted strings and nothing else, in any layout. */
const STRING_ARRAY = /^(\w+) = \[((?:\s*"[^"\n]*",?)*)\s*\]$/gm;

/** The strings of one array of the table: the entries of `depends`, the commands of `run`. */
const strings = (key: string): string[] => [...TASK.matchAll(STRING_ARRAY)]
  .filter(([, name]) => name === key)
  .flatMap(([, , array]) => [...array.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]));

interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>;
}

const WORKFLOW = yaml.load(read(WORKFLOW_FILE)) as Workflow;

/**
 * The scripts that the steps of one job of the workflow run, without their comment
 * lines, and with a command that continues over several lines on one.
 */
const scripts = (job: string): string[] => (WORKFLOW.jobs[job]?.steps ?? [])
  .flatMap((step) => step.run ?? [])
  .map((script) => script.split('\n').filter((line) => !isComment(line)).join('\n').replace(/\s*\\\n\s*/g, ' '));

/** The preflights that a text names: `preflight-bootstrap` for that script, `preflight` for the task that runs it. */
const preflights = (text: string): string[] => text.match(/preflight[\w:-]*/g) ?? [];

describe('the deploy task and the deploy workflow', () => {
  test('every dependency and command of the task is recorded with its step in the pipeline', () => {
    // A description, then arrays of double-quoted strings (written `[...]` here), are all this test
    // reads. A literal string, a task reference or another key could be a step it does not see.
    expect([...TASK.replace(STRING_ARRAY, '$1 = [...]').split('\n'), ...SUB_TABLES]).toEqual([
      expect.stringMatching(/^description = "[^"\n]*"$/),
      'depends = [...]',
      'run = [...]',
    ]);
    // On a failure: decide what the pipeline does for the entry that differs, then record it in
    // PIPELINE (with its step in deploy.yml, or without one) and in the comment on [tasks.deploy].
    expect([...strings('depends'), ...strings('run')]).toEqual(PIPELINE.map(([entry]) => entry));
  });

  test('the comment on the task names the workflow and this test', () => {
    const lines = taskLines();
    // Above the commands: a comment below them belongs to the next table.
    const note = lines.slice(0, lines.findIndex((line) => line.startsWith('run = '))).filter(isComment).join('\n');

    expect(note).toContain(WORKFLOW_FILE);
    expect(note).toContain(path.relative(path.join(ROOT, 'cdk'), __filename));
  });

  const recorded = PIPELINE.flatMap(([, step]) => step ?? []);

  test.each(recorded)('exactly one step of the $job job of the workflow runs `$run`', ({ job, run }) => {
    expect(scripts(job).filter((script) => script.includes(run))).toHaveLength(1);
  });

  // The other direction, for the checks of the task, which carry `preflight` in the names of
  // their scripts and tasks. That holds what the table and the comment on [tasks.deploy] say
  // of the bootstrap preflight, that the pipeline does not run it (#127), until the table
  // records its step.
  test('a step of the workflow runs only the preflights that the table records for it', () => {
    const unrecorded = Object.keys(WORKFLOW.jobs).flatMap((job) => scripts(job).flatMap((script) => {
      const inTable = recorded.filter((step) => step.job === job && script.includes(step.run)).flatMap((step) => preflights(step.run));
      return preflights(script).filter((name) => !inTable.includes(name)).map((name) => `${name} in the ${job} job`);
    }));

    // On a failure: a step of the workflow runs a check of the task, and the table records no such
    // step. Record it in PIPELINE, and what the pipeline does in the comment on [tasks.deploy].
    expect(unrecorded).toEqual([]);
  });
});
