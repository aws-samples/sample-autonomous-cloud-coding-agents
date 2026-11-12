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
 * Tests for `scripts/check-coverage-thresholds-sync.ts`, the coverage contract
 * drift gate.
 *
 * Almost every case here is an edit that the gate used to accept: it compared
 * only the jest floors and looked for the agent floor as a substring, so it
 * printed "in sync" while a floor was switched off, lowered or measured over
 * fewer files. A gate that fails by passing has to be tested by making it fail.
 *
 * As in check-constants-sync.test.ts (which explains why a root script is
 * tested from cdk/), the real script is spawned against a copy of the files it
 * reads. The script has mise parse TOML, so `mise` must be on PATH; it is
 * wherever this suite runs through `mise //cdk:test`. It also evaluates
 * web/vite.config.ts, whose imports the copy finds through links to the
 * repository's node_modules directories.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = 'scripts/check-coverage-thresholds-sync.ts';
const CONTRACT = 'contracts/coverage-thresholds.json';
const PYPROJECT = 'agent/pyproject.toml';
const AGENT_MISE = 'agent/mise.toml';
const VITE_CONFIG = 'web/vite.config.ts';
const FORGE = 'integrations/jira-forge-app/package.json';

/** Every file the script reads, relative to the repo root. */
const FIXTURE_FILES = [
  SCRIPT, CONTRACT, 'cdk/package.json', 'cli/package.json', PYPROJECT, AGENT_MISE, VITE_CONFIG, 'web/package.json', FORGE,
  'mise.toml', 'cdk/mise.toml', 'cli/mise.toml', 'web/mise.toml',
];

interface JestBlock {
  [setting: string]: unknown;
  collectCoverage?: boolean;
  collectCoverageFrom?: string[];
  coveragePathIgnorePatterns: string[];
  coverageThreshold: { global: Record<string, number> };
}
interface Manifest {
  scripts: Record<string, string>;
  jest: JestBlock;
}
interface Contract {
  jest: Record<string, JestBlock>;
  pytest?: { agent: { report: { fail_under: number } } };
}

/**
 * The environment without what a Git hook exports. Under a hook those variables name the developer's repository, and
 * the script and the fixture commands would ask about it instead of the copy.
 */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Copy the files the script reads into a temp root, apply `mutate`, and run it there. */
function runInMutatedRepo(mutate: (root: string) => void): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-coverage-sync-'));
  try {
    for (const rel of FIXTURE_FILES) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
    }
    // The copy of web/vite.config.ts has to find its imports where the original does: in the hoisted node_modules
    // and, when yarn keeps a package out of the hoist, in web's own.
    for (const dir of ['node_modules', 'web/node_modules']) {
      if (fs.existsSync(path.join(REPO_ROOT, dir))) {
        fs.symlinkSync(path.join(REPO_ROOT, dir), path.join(root, dir));
      }
    }
    mutate(root);

    try {
      const stdout = execFileSync(
        process.execPath,
        ['--experimental-strip-types', path.join(root, SCRIPT)],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Rewrite a text file in the temp root. An edit that changes nothing would make its test vacuous. */
function edit(root: string, rel: string, change: (text: string) => string): void {
  const before = fs.readFileSync(path.join(root, rel), 'utf-8');
  const after = change(before);
  if (after === before) {
    throw new Error(`test edit left ${rel} unchanged: the text it replaces is gone`);
  }
  fs.writeFileSync(path.join(root, rel), after);
}

/** Patch a JSON file in the temp root. */
function editJson<T>(root: string, rel: string, change: (json: T) => void): void {
  edit(root, rel, (text) => {
    const json = JSON.parse(text) as T;
    change(json);
    return JSON.stringify(json, null, 2);
  });
}

/** Run with one edit and expect drift that names `where`. */
function expectDrift(mutate: (root: string) => void, ...where: string[]): void {
  const result = runInMutatedRepo(mutate);
  expect(result.stderr).toContain('Coverage contract drift detected');
  for (const text of where) {
    expect(result.stderr).toContain(text);
  }
  expect(result.status).toBe(1);
}

const agentFloor = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf-8')) as Contract).pytest!.agent.report.fail_under;

describe('check-coverage-thresholds-sync', () => {
  // A handful of subprocess spawns; give them room on a cold cache.
  jest.setTimeout(60_000);

  test('the real repository is in sync, and the check says how much it compared', () => {
    const result = runInMutatedRepo(() => {});

    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    // The count is the anti-vacuity assertion: a script that compared nothing would also exit 0.
    const [, checked] = /\((\d+) values checked\)/.exec(result.stdout) ?? [];
    expect(Number(checked)).toBeGreaterThanOrEqual(41);
  });

  describe('jest (cdk, cli)', () => {
    test('a floor lowered in the manifest', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cdk/package.json', (json) => {
          json.jest.coverageThreshold.global.branches = 60;
        });
      }, 'cdk/package.json jest coverageThreshold');
    });

    test('coverage collection switched off, which leaves the floor in place and unenforced', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cli/package.json', (json) => {
          json.jest.collectCoverage = false;
        });
      }, 'cli/package.json jest collectCoverage: false');
    });

    test('a directory added to the ignore patterns', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cdk/package.json', (json) => {
          json.jest.coveragePathIgnorePatterns.push('<rootDir>/src/handlers/');
        });
      }, 'cdk/package.json jest coveragePathIgnorePatterns');
    });

    test('collectCoverageFrom narrowed, or removed', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cli/package.json', (json) => {
          json.jest.collectCoverageFrom = ['src/commands/**/*.ts'];
        });
        editJson<Manifest>(root, 'cdk/package.json', (json) => {
          delete json.jest.collectCoverageFrom;
        });
      }, 'cli/package.json jest collectCoverageFrom', 'cdk/package.json jest collectCoverageFrom: not set');
    });

    // Each of these lets a run of one test file, or of none, exit 0 with the floors still in the block (jest 30.4).
    // None is a coverage setting, which is why the block is pinned whole except for a short list of harmless keys.
    // One run plants them all: each is the same comparison, and each has to be reported.
    test('settings the contract does not list', () => {
      const unlisted: [string, unknown][] = [
        ['testFailureExitCode', 0],
        ['passWithNoTests', true],
        ['rootDir', 'test'],
        ['roots', ['<rootDir>/test']],
        ['projects', [{ displayName: 'unit' }]],
        ['onlyChanged', true],
      ];
      expectDrift((root) => {
        editJson<Manifest>(root, 'cli/package.json', (json) => {
          Object.assign(json.jest, Object.fromEntries(unlisted));
        });
      }, ...unlisted.map(([setting, value]) =>
        `cli/package.json jest ${setting}: ${JSON.stringify(value)} does not match ${CONTRACT} jest.cli.${setting}: not set`));
    });

    test('a setting that cannot move a floor changes without the contract', () => {
      const result = runInMutatedRepo((root) => {
        editJson<Manifest>(root, 'cdk/package.json', (json) => {
          json.jest.maxWorkers = '50%';
        });
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
  });

  describe('pytest (agent)', () => {
    test('a lower floor, with the old number left behind in comments', () => {
      expectDrift((root) => {
        edit(root, PYPROJECT, text => text.replace(`fail_under = ${agentFloor}`, `fail_under = 5  # was: fail_under = ${agentFloor}`));
        edit(root, AGENT_MISE, text => text
          .replace(`--cov-fail-under=${agentFloor} `, '--cov-fail-under=5 ')
          .replace('description = "Run tests with pytest', `description = "Was --cov-fail-under=${agentFloor}. Run tests with pytest`));
      }, `${PYPROJECT} [tool.coverage.report] fail_under: 5`, '"--cov-fail-under=5"');
    });

    test('a contract floor that is only a prefix of the real one', () => {
      expectDrift((root) => {
        editJson<Contract>(root, CONTRACT, (json) => {
          json.pytest!.agent.report.fail_under = Number(String(agentFloor).slice(0, 1));
        });
      }, `${PYPROJECT} [tool.coverage.report] fail_under: ${agentFloor}`, `"--cov-fail-under=${agentFloor}"`);
    });

    test('files left out of the measurement with omit', () => {
      expectDrift((root) => {
        edit(root, PYPROJECT, text => text.replace('[tool.coverage.run]\n', '[tool.coverage.run]\nomit = ["src/runner.py"]\n'));
      }, `${PYPROJECT} [tool.coverage.run] omit: ["src/runner.py"]`);
    });

    test('coverage switched off in the test task', () => {
      expectDrift((root) => {
        edit(root, AGENT_MISE, text => text.replace('run = "uv run pytest ', 'run = "uv run pytest --no-cov '));
      }, `${AGENT_MISE} tasks.test.run coverage flags`, '"--no-cov"');
    });

    // pytest adds addopts to the command line of the test task, so a flag there changes the run as one on the task
    // line would. The value is pinned whole: no flag is special, and neither is the way the value is written.
    test.each([
      ['one more flag', 'addopts = "-ra --collect-only"'],
      ['a list', 'addopts = ["-ra", "--no-cov"]'],
    ])('the pytest addopts as %s', (_case, addopts) => {
      expectDrift((root) => {
        edit(root, PYPROJECT, text => text.replace('addopts = "-ra"', addopts));
      }, `${PYPROJECT} [tool.pytest.ini_options] addopts: `, `does not match ${CONTRACT} pytest.agent.addopts: "-ra"`);
    });

    // pytest 9 reads [tool.pytest] itself when [tool.pytest.ini_options] is empty: the pinned table would be one
    // that is no longer in force.
    test('the pytest settings moved to the table that pytest 9 reads natively', () => {
      expectDrift((root) => {
        edit(root, PYPROJECT, text => `${text.replace('[tool.pytest.ini_options]', '[tool.pytest]')}\n[tool.pytest.ini_options]\n`);
      }, `cannot read tool.pytest.ini_options.addopts from ${PYPROJECT}`);
    });

    // Each of these is read before pyproject.toml (pytest 9.1 findpaths.py, coverage 7.15 config.py): with an omit list
    // or a --no-cov in it, the floor measures less, or nothing, while pyproject.toml still matches the contract.
    test('config files that would be read before pyproject.toml, each of the eight names', () => {
      const names = ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini', '.coveragerc', '.coveragerc.toml', 'setup.cfg', 'tox.ini'];
      expectDrift((root) => {
        for (const name of names) {
          fs.writeFileSync(path.join(root, 'agent', name), '');
        }
      }, ...names.map(name => `  - agent/${name} exists`));
    });
  });

  describe('vitest (web)', () => {
    test('a floor lowered in the config', () => {
      expectDrift((root) => {
        edit(root, VITE_CONFIG, text => text.replace(/thresholds: \{ statements: \d+/, 'thresholds: { statements: 10'));
      }, `${VITE_CONFIG} test.coverage thresholds`);
    });

    test('a directory added to exclude', () => {
      expectDrift((root) => {
        edit(root, VITE_CONFIG, text => text.replace("'src/mocks/browser.ts']", "'src/mocks/browser.ts', 'src/domains/**']"));
      }, `${VITE_CONFIG} test.coverage exclude`);
    });

    // As for jest, the block is pinned whole but for a few harmless keys. The root is why: moved, at either level, the
    // coverage patterns match no file, and vitest 5.1 counts a floor over no file as met.
    test.each([
      ["environment: 'jsdom',", "environment: 'jsdom', root: './test',", 'test root: "./test"'],
      ["environment: 'jsdom',", "environment: 'jsdom', passWithNoTests: true,", 'test passWithNoTests: true'],
      ["provider: 'v8',", "provider: 'v8', allowExternal: true,", 'test.coverage allowExternal: true'],
      ['define: {', "root: './test', define: {", 'root: "./test"'],
    ])('a setting the contract does not list: %s -> %s', (from, to, drift) => {
      expectDrift((root) => {
        edit(root, VITE_CONFIG, text => text.replace(from, to));
      }, `${VITE_CONFIG} ${drift} does not match`);
    });
  });

  describe('test scripts', () => {
    // A runner takes a flag over its settings, and takes it in several spellings. The scripts are pinned whole, so
    // no spelling is special: one flag and one second command stand for all of them, in each of the three scripts.
    test.each(['--no-coverage', '|| true'])('the cdk, cli and web test scripts with "%s" appended', (suffix) => {
      const packages = ['cdk', 'cli', 'web'];
      expectDrift((root) => {
        for (const pkg of packages) {
          editJson<Manifest>(root, `${pkg}/package.json`, (json) => {
            json.scripts.test += ` ${suffix}`;
          });
        }
      }, ...packages.map(pkg => `${suffix}" does not match ${CONTRACT} commands.${pkg}/package.json`));
    });

    test('the web test script without --coverage, which collects nothing and applies no floor', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'web/package.json', (json) => {
          json.scripts.test = json.scripts.test.replace(' --coverage', '');
        });
      }, 'web/package.json scripts.test', `does not match ${CONTRACT} commands.web/package.json`);
    });

    // node:test has no config file: the floors of the Forge app and its one test file are arguments of the script.
    test.each([
      ['a floor lowered', /--test-coverage-lines=\d+/, '--test-coverage-lines=1'],
      ['its test file left to discovery, which passes when there is none', / test\/proxy\.test\.js$/, ''],
      ['--test-only, which runs nothing but tests marked only', /^node --test /, 'node --test --test-only '],
    ])('the Forge test script with %s', (_case, from, to) => {
      expectDrift((root) => {
        editJson<Manifest>(root, FORGE, (json) => {
          json.scripts.test = json.scripts.test.replace(from, to);
        });
      }, `${FORGE} scripts.test`, `does not match ${CONTRACT} commands.${FORGE}`);
    });

    test('a test script that is gone', () => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cli/package.json', (json) => {
          delete json.scripts.test;
        });
      }, `cli/package.json scripts.test: not set does not match ${CONTRACT} commands.cli/package.json`);
    });
  });

  describe('mise tasks', () => {
    // The build reaches each test script, and the agent's pytest, through a mise task. What follows the script's name
    // on the task line reaches the runner as a flag in the script would, so each task is pinned too.
    test('a suffix on the command line of each of the five test tasks', () => {
      expectDrift((root) => {
        edit(root, 'cdk/mise.toml', text => text.replace('"yarn test"]', '"yarn test --coverage=false"]'));
        edit(root, 'cli/mise.toml', text => text.replace('run = "yarn test"', 'run = "yarn test --no-coverage"'));
        edit(root, 'web/mise.toml', text => text.replace('run = "yarn test"', 'run = "yarn test --coverage.enabled=false"'));
        edit(root, AGENT_MISE, text => text.replace('coverage/coverage.json"', 'coverage/coverage.json || true"'));
        edit(root, 'mise.toml', text => text.replace('integrations/jira-forge-app"', 'integrations/jira-forge-app || true"'));
      },
      `cdk/mise.toml [tasks.test] run: ["mkdir -p $TMPDIR","yarn test --coverage=false"] does not match ${CONTRACT} tasks.//cdk:test.run`,
      `cli/mise.toml [tasks.test] run: "yarn test --no-coverage" does not match ${CONTRACT} tasks.//cli:test.run: "yarn test"`,
      `web/mise.toml [tasks.test] run: "yarn test --coverage.enabled=false" does not match ${CONTRACT} tasks.//web:test.run: "yarn test"`,
      `|| true" does not match ${CONTRACT} tasks.//agent:test.run`,
      'mise.toml [tasks.test:jira-forge-app] run: "npm test --prefix integrations/jira-forge-app || true" does not match');
    });

    // Other keys of a task decide whether and how its line runs, so a task is pinned whole: a key the contract does
    // not list is drift. Its description and its dependencies cannot change what runs, and are free.
    test('a task key the contract does not list, next to one that is free', () => {
      const result = runInMutatedRepo((root) => {
        edit(root, 'cli/mise.toml', text => text.replace('run = "yarn test"', 'run = "yarn test"\nshell = "bash -c"'));
        edit(root, 'cdk/mise.toml', text => text.replace('description = "Jest tests"', 'description = "Jest tests, with coverage"'));
      });

      expect(result.stderr).toContain(`cli/mise.toml [tasks.test] shell: "bash -c" does not match ${CONTRACT} tasks.//cli:test.shell: not set`);
      expect(result.stderr).not.toContain('cdk/mise.toml');
      expect(result.status).toBe(1);
    });

    test('a table of variables on a task, which the check cannot compare and so does not accept', () => {
      expectDrift((root) => {
        edit(root, 'web/mise.toml', text => text.replace('run = "yarn test"', 'run = "yarn test"\nenv = { CI = "true" }'));
      }, 'web/mise.toml [tasks.test]: cannot read "[env]"');
    });
  });

  describe('config files that a launcher reads on top of a pinned manifest', () => {
    // What mise 2026.10 reads next to a mise.toml, in each directory that holds a pinned task, and the rc files that
    // yarn 1.22 and npm read next to a pinned script. Any of them can change how a pinned command runs while the
    // text the contract pins stays the same.
    const MISE = [
      '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.miserc.toml', '.miserc.local.toml', 'mise', '.mise',
      '.config/mise.toml', '.config/mise.local.toml', '.config/miserc.toml', '.config/mise',
    ];
    const LAUNCHER_CONFIGS = [
      ...['.', 'cdk', 'cli', 'web', 'agent'].flatMap(dir => MISE.map(name => path.join(dir, name))),
      ...['.', 'cdk', 'cli', 'web'].flatMap(dir => ['.yarnrc', '.yarnrc.yml', '.npmrc'].map(name => path.join(dir, name))),
      'integrations/jira-forge-app/.npmrc',
    ];

    test('every one of them, in a tree that is not a git checkout', () => {
      expectDrift((root) => {
        for (const file of LAUNCHER_CONFIGS) {
          const isDirectory = file.endsWith('mise');
          fs.mkdirSync(path.join(root, isDirectory ? file : path.dirname(file)), { recursive: true });
          if (!isDirectory) {
            fs.writeFileSync(path.join(root, file), '');
          }
        }
      }, ...LAUNCHER_CONFIGS.map(file => `  - ${file} is in the repository`));
    });

    // In a checkout only what git tracks counts: a config file kept for one machine is not drift until it is
    // committed, and CI never sees it.
    test('in a git checkout, the one that is tracked and not the one that is not', () => {
      const result = runInMutatedRepo((root) => {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: ENV, stdio: 'pipe' });
        fs.writeFileSync(path.join(root, 'cli/.mise.toml'), '');
        fs.writeFileSync(path.join(root, 'mise.local.toml'), '');
        git('init', '--quiet');
        git('add', 'cli/.mise.toml');
      });

      expect(result.stderr).toContain('  - cli/.mise.toml is in the repository: mise reads it');
      expect(result.stderr).not.toContain('mise.local.toml');
      expect(result.status).toBe(1);
    });
  });

  describe('fails closed', () => {
    test('when the contract has no section for a package', () => {
      const result = runInMutatedRepo((root) => {
        editJson<Contract>(root, CONTRACT, (json) => {
          delete json.pytest;
        });
      });

      expect(result.stderr).toContain(`${CONTRACT} has no pytest.agent.run section`);
      expect(result.status).toBe(1);
    });

    // The check evaluates web/vite.config.ts. Without the packages that file imports there is nothing to put back
    // in line, so the message names the cause and leaves the advice about drift out.
    test('when dependencies are not installed, and says so', () => {
      const result = runInMutatedRepo((root) => {
        for (const link of ['node_modules', 'web/node_modules']) {
          fs.rmSync(path.join(root, link), { force: true });
        }
      });

      expect(result.stderr).toContain('dependencies have to be installed: run `mise run install`');
      expect(result.stderr).not.toContain('Coverage contract drift detected');
      expect(result.status).toBe(1);
    });

    test('when git cannot say what the checkout tracks', () => {
      expectDrift((root) => {
        fs.writeFileSync(path.join(root, '.git'), '');
      }, 'the check could not finish: cannot ask git which config files are committed');
    });

    test('when a manifest cannot be parsed', () => {
      const result = runInMutatedRepo((root) => {
        edit(root, PYPROJECT, text => text.replace('[tool.coverage.run]', '[tool.coverage.run'));
      });

      expect(result.stderr).toContain('the check could not finish');
      expect(result.status).toBe(1);
    });
  });
});
