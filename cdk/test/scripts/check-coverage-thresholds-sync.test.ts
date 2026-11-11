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
 * web/vite.config.ts, whose imports the copy finds through a link to the
 * repository's node_modules.
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
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
    mutate(root);

    try {
      const stdout = execFileSync(
        process.execPath,
        ['--experimental-strip-types', path.join(root, SCRIPT)],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
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
    expect(Number(checked)).toBeGreaterThanOrEqual(35);
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
    test.each<[string, unknown]>([
      ['testFailureExitCode', 0],
      ['passWithNoTests', true],
      ['rootDir', 'test'],
      ['roots', ['<rootDir>/test']],
      ['projects', [{ displayName: 'unit' }]],
      ['onlyChanged', true],
    ])('a setting the contract does not list: %s', (setting, value) => {
      expectDrift((root) => {
        editJson<Manifest>(root, 'cli/package.json', (json) => {
          json.jest[setting] = value;
        });
      }, `cli/package.json jest ${setting}: ${JSON.stringify(value)} does not match ${CONTRACT} jest.cli.${setting}: not set`);
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

    // pytest adds addopts to the command line of the test task: --no-cov there switches the floor off, a second --cov
    // adds files to the measurement.
    test.each([
      ['addopts = "-ra --no-cov"', '--no-cov'],
      ['addopts = ["-ra", "--cov=tests"]', '--cov=tests'],
    ])('a coverage flag in the pytest settings: %s', (addopts, flag) => {
      expectDrift((root) => {
        edit(root, PYPROJECT, text => text.replace('addopts = "-ra"', addopts));
      }, `${PYPROJECT} [tool.pytest.ini_options] passes ${flag}:`);
    });

    // Each of these is read before pyproject.toml (pytest 9.1 findpaths.py, coverage 7.15 config.py): with an omit list
    // or a --no-cov in it, the floor measures less, or nothing, while pyproject.toml still matches the contract.
    test.each([
      'pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini', '.coveragerc', '.coveragerc.toml', 'setup.cfg', 'tox.ini',
    ])('a config file that would be read before pyproject.toml: %s', (name) => {
      expectDrift((root) => {
        fs.writeFileSync(path.join(root, 'agent', name), '');
      }, `agent/${name} exists`);
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
    // no spelling is special.
    test.each([
      ['cdk', '--coverage=false'],
      ['cdk', '--no-coverage'],
      ['cdk', '--collect-coverage=false'],
      ['cli', '--no-collectCoverage'],
      ['cli', '--collect-coverage-from=src/errors.ts'],
      ['cli', '|| true'],
      ['web', '--coverage.thresholds.lines=0'],
    ])('the %s test script with "%s" appended', (pkg, suffix) => {
      expectDrift((root) => {
        editJson<Manifest>(root, `${pkg}/package.json`, (json) => {
          json.scripts.test += ` ${suffix}`;
        });
      }, `${pkg}/package.json scripts.test`, `${suffix}" does not match ${CONTRACT} commands.${pkg}/package.json`);
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

    test('when a manifest cannot be parsed', () => {
      const result = runInMutatedRepo((root) => {
        edit(root, PYPROJECT, text => text.replace('[tool.coverage.run]', '[tool.coverage.run'));
      });

      expect(result.stderr).toContain('the check could not finish');
      expect(result.status).toBe(1);
    });
  });
});
