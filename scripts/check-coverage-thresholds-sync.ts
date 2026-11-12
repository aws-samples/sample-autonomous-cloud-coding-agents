#!/usr/bin/env -S node --experimental-strip-types
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
 * Coverage contract drift check.
 *
 * ``contracts/coverage-thresholds.json`` is the source of truth for every
 * coverage floor and for the settings that decide what a floor measures. The
 * test runners read those values from their own manifests, so each manifest
 * carries a copy; this script fails when a copy says something else.
 *
 * It compares the values a runner will read, never text: package.json through
 * ``JSON.parse``, TOML through mise's parser (``mise config get``) and
 * vite.config.ts by evaluating it. A number left behind in a comment, a
 * contract value that is a prefix of the real one and a setting that narrows
 * what is measured are all drift.
 *
 *   cdk, cli   the jest block of package.json, every key except those in
 *              JEST_FREE_KEYS; scripts.test, verbatim
 *   agent      [tool.coverage.run] and [tool.coverage.report] in
 *              pyproject.toml, every key; the coverage flags of the test task
 *              in mise.toml, which win over those tables; pytest's addopts,
 *              verbatim; no config file that would be read before
 *              pyproject.toml
 *   web        the test block of vite.config.ts, every key except those in
 *              VITEST_FREE_KEYS; no root; scripts.test, verbatim
 *   jira-forge-app  scripts.test, verbatim: node:test has no config file, so
 *              the floors and the test file are arguments of the script
 *   mise       the task that runs each of those scripts and the agent's
 *              pytest, every key except those in TASK_FREE_KEYS
 *   rc files   none committed that mise, yarn or npm would read on top of
 *              those manifests (LAUNCHER_CONFIGS)
 *
 * Run via ``mise run check:coverage-thresholds-sync``. Exits 0 when in sync,
 * 1 on drift or when something it needs cannot be read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type Json = Record<string, unknown>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'contracts/coverage-thresholds.json';

/**
 * jest settings that cannot change which files a floor counts, which tests run or how a failed
 * run exits. Every other key of a jest block must be in the contract with the same value, so a
 * setting nobody thought of here (rootDir, projects, passWithNoTests, ...) is drift, not a way in.
 */
const JEST_FREE_KEYS = [
  'cacheDirectory', 'clearMocks', 'coverageDirectory', 'coverageReporters', 'globalSetup', 'maxWorkers', 'reporters',
  'setupFiles', 'setupFilesAfterEnv', 'transform', 'watchPathIgnorePatterns', 'workerIdleMemoryLimit',
];

/** The same for the test block of web/vite.config.ts. */
const VITEST_FREE_KEYS = ['css', 'environment', 'setupFiles', 'testTimeout'];

/**
 * The package.json files whose test script is the command the build runs. A flag there wins over
 * the settings of the runner, so the contract pins each script verbatim: a flag in any spelling,
 * a second command or another list of test files is drift.
 */
const TEST_SCRIPTS = ['cdk/package.json', 'cli/package.json', 'web/package.json', 'integrations/jira-forge-app/package.json'];

/**
 * The mise tasks the root build runs those scripts and the agent's pytest through, as mise names
 * them: ``//<directory>:<task>``. What comes after the script's name on a task line reaches the
 * runner as a flag would, and other keys of a task decide whether and how its line runs, so the
 * contract pins each task whole but for TASK_FREE_KEYS.
 */
const TEST_TASKS = ['//cdk:test', '//cli:test', '//web:test', '//agent:test', '//:test:jira-forge-app'];

/** Task keys that cannot change what a task runs. */
const TASK_FREE_KEYS = ['depends', 'description'];

/**
 * Files that pytest 9 and coverage.py 7 read before pyproject.toml, or in place of it, when they
 * sit next to it. With one of them present the tables pinned here are no longer the ones in force.
 */
const AGENT_SHADOW_CONFIGS = ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini', '.coveragerc', '.coveragerc.toml', 'setup.cfg', 'tox.ini'];

/**
 * Config files that the launcher of a pinned command reads on top of the manifest the contract pins,
 * by the directories it looks in. mise 2026.10 merges each of these names into the mise.toml next
 * to it, or reads it in its place; yarn 1.22 and npm take settings for the way a script is run from
 * an rc file. With one of them a pinned task or script runs differently and its text stays the same.
 * Not listed: mise.<env>.toml, which mise reads only when MISE_ENV names that environment.
 */
const LAUNCHER_CONFIGS = [
  {
    reader: 'mise',
    directories: ['.', 'cdk', 'cli', 'web', 'agent'],
    names: [
      '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.miserc.toml', '.miserc.local.toml', 'mise', '.mise',
      '.config/mise.toml', '.config/mise.local.toml', '.config/miserc.toml', '.config/mise',
    ],
  },
  { reader: 'yarn', directories: ['.', 'cdk', 'cli', 'web'], names: ['.yarnrc', '.yarnrc.yml', '.npmrc'] },
  { reader: 'npm', directories: ['integrations/jira-forge-app'], names: ['.npmrc'] },
];

const errors: string[] = [];
let checked = 0;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(join(root, file), 'utf8')) as Json;
}

/** A section of the contract. A missing one is an error, not a reason to skip a package. */
function section(contract: Json, ...path: string[]): Json {
  const value = path.reduce<unknown>((node, key) => (node as Json | undefined)?.[key], contract);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${CONTRACT} has no ${path.join('.')} section`);
  }
  return value as Json;
}

/** A value from a TOML file as mise's parser prints it: a scalar bare, a table as ``key = value`` lines. */
function toml(file: string, key: string): string {
  try {
    return execFileSync('mise', ['config', 'get', '--file', join(root, file), key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const reason = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
    throw new Error(`cannot read ${key} from ${file} with \`mise config get\`: ${reason}`);
  }
}

/** A TOML table of plain values (booleans, numbers, strings, arrays of those) as an object. */
function tomlTable(file: string, key: string): Json {
  return Object.fromEntries(toml(file, key).split('\n').filter(Boolean).map((line) => {
    const eq = line.indexOf(' = ');
    try {
      if (eq < 1) throw new Error('not a key = value line');
      return [line.slice(0, eq), JSON.parse(line.slice(eq + ' = '.length))];
    } catch {
      throw new Error(`${file} [${key}]: cannot read "${line}". This check reads one-line values only, and no string that holds a backslash or a double quote: mise prints those in a form it does not parse`);
    }
  }));
}

/**
 * Of ``paths``, the files git tracks. A config file kept for one machine is not drift until it is
 * committed, and a CI checkout holds nothing else. A tree without ``.git`` (a source archive)
 * cannot tell the two apart: there, the paths that exist.
 */
function tracked(paths: string[]): string[] {
  if (!existsSync(join(root, '.git'))) {
    return paths.filter(path => existsSync(join(root, path)));
  }
  try {
    return execFileSync('git', ['ls-files', '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean);
  } catch (err) {
    const reason = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
    throw new Error(`cannot ask git which config files are committed: ${reason}`);
  }
}

/** The arguments of a shell command line, quotes removed. */
function args(command: unknown): string[] {
  return String(command).replace(/['"]/g, '').split(/\s+/).filter(Boolean);
}

const show = (value: unknown): string => (value === undefined ? 'not set' : JSON.stringify(value));

/** Record drift unless the value a runner reads equals the contract's. */
function pin(where: string, actual: unknown, contractKey: string, expected: unknown): void {
  checked += 1;
  if (!isDeepStrictEqual(actual, expected)) {
    errors.push(`${where}: ${show(actual)} does not match ${CONTRACT} ${contractKey}: ${show(expected)}`);
  }
}

/** Pin ``keys`` and every key the contract names. A key that only one side has is drift. */
function pinKeys(where: string, actual: Json, contractKey: string, expected: Json, keys: string[] = Object.keys(actual)): void {
  for (const key of new Set([...keys, ...Object.keys(expected)])) {
    pin(`${where} ${key}`, actual[key], `${contractKey}.${key}`, expected[key]);
  }
}

/** The keys of a runner's settings that the contract has to pin: all but the free ones. */
const notFree = (settings: Json, free: string[]): string[] => Object.keys(settings).filter(key => !free.includes(key));

function checkJest(contract: Json, pkg: string): void {
  const jest = (readJson(`${pkg}/package.json`).jest ?? {}) as Json;
  pinKeys(`${pkg}/package.json jest`, jest, `jest.${pkg}`, section(contract, 'jest', pkg), notFree(jest, JEST_FREE_KEYS));
}

async function checkWeb(contract: Json): Promise<void> {
  // The config is code, so read what it returns for a vitest run rather than its text.
  const { default: exported } = await import(pathToFileURL(join(root, 'web/vite.config.ts')).href) as { default: unknown };
  const env = { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false };
  const config = (typeof exported === 'function' ? await exported(env) : exported) as Json;
  const { coverage, ...test } = (config.test ?? {}) as Json;
  const { coverage: pinnedCoverage, ...pinned } = section(contract, 'vitest', 'web');
  pinKeys('web/vite.config.ts test', test, 'vitest.web', pinned, notFree(test, VITEST_FREE_KEYS));
  pinKeys('web/vite.config.ts test.coverage', (coverage ?? {}) as Json, 'vitest.web.coverage', (pinnedCoverage ?? {}) as Json);

  // The patterns above are relative to the root. Moved, they match no file, and a floor over no file is met.
  pin('web/vite.config.ts root', config.root, 'vitest.web (no root: the patterns are relative to web/)', undefined);
}

function checkTestScripts(contract: Json): void {
  const pinned = section(contract, 'commands');
  for (const file of new Set([...TEST_SCRIPTS, ...Object.keys(pinned)])) {
    pin(`${file} scripts.test`, (readJson(file).scripts as Json | undefined)?.test, `commands.${file}`, pinned[file]);
  }
}

function checkTestTasks(contract: Json): void {
  const pinned = section(contract, 'tasks');
  for (const path of new Set([...TEST_TASKS, ...Object.keys(pinned)])) {
    const [, directory, name] = /^\/\/([^:]*):(.+)$/.exec(path) ?? [];
    if (name === undefined) {
      throw new Error(`${CONTRACT} tasks.${path}: a mise task is named //<directory>:<task>`);
    }
    const file = join(directory, 'mise.toml');
    const task = tomlTable(file, `tasks.${name}`);
    pinKeys(`${file} [tasks.${name}]`, task, `tasks.${path}`, (pinned[path] ?? {}) as Json, notFree(task, TASK_FREE_KEYS));
  }
}

function checkLauncherConfigs(): void {
  checked += 1;
  for (const { reader, directories, names } of LAUNCHER_CONFIGS) {
    for (const file of tracked(directories.flatMap(directory => names.map(name => join(directory, name))))) {
      errors.push(`${file} is in the repository: ${reader} reads it on top of the manifest that ${CONTRACT} pins, so a pinned test command may not run as written. Remove it (\`git rm\`). Settings for one machine belong in a file that is not committed`);
    }
  }
}

function checkAgent(contract: Json): void {
  const run = section(contract, 'pytest', 'agent', 'run');
  const report = section(contract, 'pytest', 'agent', 'report');
  pinKeys('agent/pyproject.toml [tool.coverage.run]', tomlTable('agent/pyproject.toml', 'tool.coverage.run'), 'pytest.agent.run', run);
  pinKeys('agent/pyproject.toml [tool.coverage.report]', tomlTable('agent/pyproject.toml', 'tool.coverage.report'), 'pytest.agent.report', report);

  // pytest-cov flags win over pyproject.toml. --cov-report only chooses output formats.
  const flags = args(toml('agent/mise.toml', 'tasks.test.run')).filter(arg => /^--(no-)?cov/.test(arg) && !arg.startsWith('--cov-report='));
  const expected = [
    ...(run.source as string[]).map(source => `--cov=${source}`),
    ...(run.branch ? ['--cov-branch'] : []),
    `--cov-fail-under=${report.fail_under}`,
  ];
  pin('agent/mise.toml tasks.test.run coverage flags', flags.sort(), 'pytest.agent (run.source, run.branch, report.fail_under)', expected.sort());

  // pytest puts its addopts setting in front of that command line, where a flag can switch coverage off or keep the
  // tests from running. It is pinned whole: no list of such flags is ever complete. pytest 9 refuses a pyproject.toml
  // that also fills [tool.pytest] itself, so this table is the one in force.
  pin('agent/pyproject.toml [tool.pytest.ini_options] addopts', toml('agent/pyproject.toml', 'tool.pytest.ini_options.addopts'), 'pytest.agent.addopts', section(contract, 'pytest', 'agent').addopts);

  checked += 1;
  for (const name of AGENT_SHADOW_CONFIGS.filter(file => existsSync(join(root, 'agent', file)))) {
    errors.push(`agent/${name} exists: pytest or coverage.py reads it before agent/pyproject.toml, so the settings ${CONTRACT} pins would not be the ones in force. Delete it and keep its settings in agent/pyproject.toml`);
  }
}

try {
  const contract = readJson(CONTRACT);
  checkJest(contract, 'cdk');
  checkJest(contract, 'cli');
  checkAgent(contract);
  await checkWeb(contract);
  checkTestScripts(contract);
  checkTestTasks(contract);
  checkLauncherConfigs();
} catch (err) {
  errors.push(`the check could not finish: ${err instanceof Error ? err.message : String(err)}`);
}

if (errors.length > 0) {
  console.error('Coverage contract drift detected:\n');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  console.error(`\n${CONTRACT} is the source of truth: put the manifest back in line with it. If coverage`);
  console.error('fell below a floor, add tests. Raising a floor takes the same change in the contract and the manifest.');
  console.error('Lowering one, measuring fewer files or changing a test command needs a maintainer to agree first: do not');
  console.error('edit the contract to make this check pass.');
  process.exit(1);
}

console.log(`Coverage settings match ${CONTRACT} (${checked} values checked)`);
