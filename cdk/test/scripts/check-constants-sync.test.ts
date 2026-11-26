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

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/check-constants-sync.ts';
const PARITY_TEST_REL = 'agent/tests/test_constants_parity.py';

const FIXTURE_FILES = [
  SCRIPT_REL,
  'contracts/constants.json',
  'cdk/src/constructs/lambda-microvm-compute.ts',
  'cdk/src/handlers/shared/microvm/image-capability.ts',
  'cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts',
  PARITY_TEST_REL,
];

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runInMutatedRepo(mutate: (root: string) => void): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-constants-sync-'));
  try {
    for (const rel of FIXTURE_FILES) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
    }
    fs.cpSync(path.join(REPO_ROOT, 'agent/src'), path.join(root, 'agent/src'), {
      recursive: true,
      filter: (source) => path.basename(source) !== '__pycache__',
    });
    mutate(root);

    try {
      const stdout = execFileSync(
        process.execPath,
        ['--experimental-strip-types', path.join(root, SCRIPT_REL)],
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

function write(root: string, rel: string, contents: string): void {
  fs.writeFileSync(path.join(root, rel), contents);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

function patchContract(root: string, mutate: (json: Record<string, any>) => void): void {
  const json = JSON.parse(read(root, 'contracts/constants.json'));
  mutate(json);
  write(root, 'contracts/constants.json', JSON.stringify(json, null, 2));
}

describe('check-constants-sync', () => {
  jest.setTimeout(60_000);

  describe('MicroVM lifecycle image contract', () => {
    test.each([
      ['protocol_version', 0], ['protocol_version', 1.5], ['protocol_version', '1'],
      ['hook_port', 0], ['hook_port', 65536], ['hook_port', 8080.5],
      ['maximum_duration_seconds', 0], ['maximum_duration_seconds', 28801],
      ['maximum_duration_seconds', 28800.5], ['maximum_duration_seconds', '28800'],
      ['image_protocol_env', 'AWS_ACCESS_KEY_ID'], ['image_protocol_env', 'ABCA_MICROVM_bad'],
    ])('rejects invalid %s=%s', (key, value) => {
      const result = runInMutatedRepo(root => patchContract(root, json => {
        json.microvm_lifecycle[key] = value;
      }));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('microvm_lifecycle');
    });
    test.each([
      ['cdk/src/constructs/lambda-microvm-compute.ts', 'AGENT_HOOK_PORT', '8080'],
      ['cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts', 'MICROVM_MAX_DURATION_SECONDS', '28_800'],
      ['cdk/src/constructs/lambda-microvm-compute.ts', 'LIFECYCLE_HOOK_TIMEOUT_SECONDS', '30'],
      ['cdk/src/handlers/shared/microvm/image-capability.ts', 'MICROVM_LIFECYCLE_PROTOCOL', '"1"'],
      ['cdk/src/handlers/shared/microvm/image-capability.ts', 'MICROVM_LIFECYCLE_PROTOCOL', 'String(1)'],
      ['cdk/src/handlers/shared/microvm/image-capability.ts', 'MICROVM_IMAGE_PROTOCOL_ENV', '"ABCA_MICROVM_LIFECYCLE_PROTOCOL"'],
    ])('rejects a literal %s/%s', (file, name, value) => {
      const result = runInMutatedRepo(root => {
        write(root, file, `${read(root, file)}\nexport const ${name} = ${value};\n`);
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain('Cross-language constants drift detected');
    });
  });

  describe('the real repository', () => {
    test('passes, and says what it actually checked', () => {
      const result = runInMutatedRepo(() => {});

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Constants sync OK');
      expect(result.stdout).toMatch(/[1-9]\d* Python names checked across [1-9]\d* files under agent\/src/);
      expect(result.stdout).toMatch(/\d+ TypeScript name\(s\) across \d+ consumer\(s\)/);
    });
  });

  describe('literal re-declaration is rejected (the drift the gate exists for)', () => {
    test('catches an int literal in a Python consumer', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nDEFAULT_APPROVAL_GATE_CAP = 50\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cross-language constants drift detected');
      expect(result.stderr).toContain('DEFAULT_APPROVAL_GATE_CAP');
      expect(result.stderr).toContain('Read from contracts/constants.json instead');
    });

    test('catches an ANNOTATED int literal', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nFLOOR_TIMEOUT_S: int = 30\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FLOOR_TIMEOUT_S');
    });

    test('catches an UNANNOTATED float literal', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n_READY_WARMUP_TOTAL_BUDGET_SECONDS = 240.0\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('_READY_WARMUP_TOTAL_BUDGET_SECONDS');
    });

    test('catches a float literal ANNOTATED as float', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n`
          + '_READY_WARMUP_TOTAL_BUDGET_SECONDS: float = 240.0\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('_READY_WARMUP_TOTAL_BUDGET_SECONDS');
    });

    test('catches a negative literal', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nAPPROVAL_GATE_CAP_MIN = -1\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('APPROVAL_GATE_CAP_MIN');
    });

    test('catches a string literal for the string-valued constant', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/jira_reactions.py',
          `${read(root, 'agent/src/jira_reactions.py')}\n`
          + 'FORGE_WEBTRIGGER_SUFFIX = ".webtrigger.atlassian.app"\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FORGE_WEBTRIGGER_SUFFIX');
    });

    test('catches a re-declared linear_vault cache key', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/config.py',
          `${read(root, 'agent/src/config.py')}\n`
          + '_LINEAR_VAULT_CUSTOM_PARAMS = {"actor": "app", "prompt": "consent"}\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('_LINEAR_VAULT_CUSTOM_PARAMS');
    });

    test('catches a collection literal for the allowlist mapping', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n`
          + 'MICROVM_PLATFORM_CONFIG_ENV_BY_KEY = {"task_table_name": "TASK_TABLE_NAME"}\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('MICROVM_PLATFORM_CONFIG_ENV_BY_KEY');
    });

    test('catches a frozenset literal for the required subset', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n`
          + 'MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS = frozenset({"task_table_name"})\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS');
    });

    test.each([
      ['MICROVM_PLATFORM_CONFIG_ARN_KEYS', 'frozenset({"agent_session_role_arn"})'],
      ['MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY', '"github_token_secret_arn"'],
    ])('catches a literal %s (the ARN check must follow the contract)', (name, literal) => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n${name} = ${literal}\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`"${name}" is not a plain read of its contract value`);
    });

    test('catches the TypeScript half of the hook-budget invariant', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'cdk/src/constructs/lambda-microvm-compute.ts',
          `${read(root, 'cdk/src/constructs/lambda-microvm-compute.ts')}\n`
          + 'const READY_HOOK_TIMEOUT_SECONDS = 300;\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('READY_HOOK_TIMEOUT_SECONDS');
    });

    test('catches arithmetic on a value read from the contract', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nDEFAULT_APPROVAL_GATE_CAP: int = int(_AGC["default"]) + 49\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/agent\/src\/policy\.py:\d+: "DEFAULT_APPROVAL_GATE_CAP" is not a plain read/);
    });

    test('catches a literal hidden inside a conversion', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nAPPROVAL_GATE_CAP_MAX: int = int("9999")\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('APPROVAL_GATE_CAP_MAX');
    });

    test('catches a read of the wrong contract key', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/policy.py',
          `${read(root, 'agent/src/policy.py')}\nAPPROVAL_GATE_CAP_MAX: int = int(_AGC["min"])\n`,
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('APPROVAL_GATE_CAP_MAX = <contract section>["max"]');
    });

    test('catches a re-declaration in a file that is not a known consumer, at any depth', () => {
      const result = runInMutatedRepo((root) => {
        write(root, 'agent/src/hooks.py', `${read(root, 'agent/src/hooks.py')}\nFLOOR_TIMEOUT_S = 1\n`);
        write(root, 'agent/src/workflow/gate_fixture.py', 'import policy\n\npolicy.DEFAULT_TASK_TIMEOUT_S = 1\n');
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/agent\/src\/hooks\.py:\d+: "FLOOR_TIMEOUT_S"/);
      expect(result.stderr).toContain('agent/src/workflow/gate_fixture.py:3: "DEFAULT_TASK_TIMEOUT_S"');
    });

    test('catches an owned name among the targets of a tuple assignment', () => {
      const result = runInMutatedRepo((root) => {
        write(root, 'agent/src/hooks.py', `${read(root, 'agent/src/hooks.py')}\nretries, FLOOR_TIMEOUT_S = 3, 1\n`);
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/agent\/src\/hooks\.py:\d+: "FLOOR_TIMEOUT_S" is not a plain read/);
    });

    test('catches an owned name among tuple targets even when the value is a contract read', () => {
      const result = runInMutatedRepo((root) => {
        write(root, 'agent/src/hooks.py', `${read(root, 'agent/src/hooks.py')}\nretries, FLOOR_TIMEOUT_S = _ATS["min"]\n`);
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/agent\/src\/hooks\.py:\d+: "FLOOR_TIMEOUT_S" is not a plain read/);
    });

    test('catches an augmented assignment to an owned name', () => {
      const result = runInMutatedRepo((root) => {
        write(root, 'agent/src/hooks.py', `${read(root, 'agent/src/hooks.py')}\nFLOOR_TIMEOUT_S += 1\n`);
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/agent\/src\/hooks\.py:\d+: "FLOOR_TIMEOUT_S" is not a plain read/);
    });

    test('catches a TypeScript literal on the line after the `=`', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'cdk/src/constructs/lambda-microvm-compute.ts',
          `${read(root, 'cdk/src/constructs/lambda-microvm-compute.ts')}\n`
          + 'const READY_HOOK_TIMEOUT_SECONDS =\n  300;\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/cdk\/src\/constructs\/lambda-microvm-compute\.ts:\d+: "READY_HOOK_TIMEOUT_SECONDS" is not a plain read/);
    });

    test('catches a conversion in the TypeScript consumer', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'cdk/src/constructs/lambda-microvm-compute.ts',
          `${read(root, 'cdk/src/constructs/lambda-microvm-compute.ts')}\n`
          + 'export const READY_HOOK_TIMEOUT_SECONDS = Number("300");\n',
        );
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('READY_HOOK_TIMEOUT_SECONDS');
    });

    test('fails when an owned constant is no longer assigned anywhere', () => {
      const result = runInMutatedRepo((root) => {
        const policy = read(root, 'agent/src/policy.py');
        expect(policy).toContain('\nFLOOR_TIMEOUT_S: int = ');
        write(root, 'agent/src/policy.py', policy.replace('\nFLOOR_TIMEOUT_S: int = ', '\nMIN_TIMEOUT_S: int = '));
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('"FLOOR_TIMEOUT_S" is owned by contracts/constants.json but assigned nowhere under agent/src');
    });

    test('fails when an owned TypeScript constant is no longer declared in its consumer', () => {
      const consumer = 'cdk/src/constructs/lambda-microvm-compute.ts';
      const result = runInMutatedRepo((root) => {
        const source = read(root, consumer);
        expect(source).toContain('\nconst READY_HOOK_TIMEOUT_SECONDS = ');
        write(root, consumer, source.replace('\nconst READY_HOOK_TIMEOUT_SECONDS = ', '\nconst READY_TIMEOUT_SECONDS = '));
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('"READY_HOOK_TIMEOUT_SECONDS" is owned by contracts/constants.json but declared in none of its TypeScript consumers (');
      expect(result.stderr).toContain(consumer);
      expect(result.stderr).toContain('update OWNED_TS_NAMES in scripts/check-constants-sync.ts');
    });

    test('fails when the value-parity test does not cover an owned constant', () => {
      const result = runInMutatedRepo((root) => {
        const parity = read(root, PARITY_TEST_REL);
        expect(parity).toContain('"FLOOR_TIMEOUT_S"');
        write(root, PARITY_TEST_REL, parity.replace('"FLOOR_TIMEOUT_S"', '"MIN_TIMEOUT_S"'));
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`"FLOOR_TIMEOUT_S" is owned by contracts/constants.json but ${PARITY_TEST_REL} does not compare its value`);
    });

    test('fails closed when agent/src is missing', () => {
      const result = runInMutatedRepo((root) => {
        fs.rmSync(path.join(root, 'agent/src'), { recursive: true });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('check-constants-sync:');
    });

    test('does NOT flag a contract-sourced assignment', () => {
      const result = runInMutatedRepo((root) => {
        write(
          root,
          'agent/src/server.py',
          `${read(root, 'agent/src/server.py')}\n`
          + 'DEFAULT_APPROVAL_GATE_CAP = SHARED_CONSTANTS["approval_gate_cap"]["default"]\n'
          + '_READY_WARMUP_TOTAL_BUDGET_SECONDS: int = _HOOK_BUDGETS["warmup_total_budget_seconds"]\n'
          + 'MICROVM_PLATFORM_CONFIG_ENV_BY_KEY = dict(_PLATFORM_CONFIG_CONTRACT["env_by_key"])\n',
        );
      });

      expect(result.status).toBe(0);
    });
  });

  describe('contract SHAPE validation', () => {
    test('rejects a missing microvm_platform_config block', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          delete json.microvm_platform_config;
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('microvm_platform_config');
    });

    test('rejects a non-snake_case wire key', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.env_by_key.TaskTableName = 'TASK_TABLE_NAME_2';
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('snake_case');
    });

    test('rejects a non-UPPER_SNAKE env var name', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.env_by_key.task_table_name = 'task-table-name';
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('UPPER_SNAKE');
    });

    test('rejects two wire keys mapping onto the same env var', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.env_by_key.nudges_table_name = 'TASK_TABLE_NAME';
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('same env var');
    });

    test('rejects a required key that is not a wire key', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.required.push('not_a_wire_key');
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not_a_wire_key');
    });
  });

  describe('ARN-pinning contract (review B5)', () => {
    test.each([
      ['new_resource_arn', 'NEW_RESOURCE'],
      ['new_resource', 'NEW_RESOURCE_ARN'],
    ])('rejects an unvalidated ARN field %s → %s', (key, envName) => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.env_by_key[key] = envName;
        });
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`ARN-shaped key "${key}" is missing from arn_keys`);
    });

    test('accepts a new ARN field when its validation is also declared', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.env_by_key.new_resource_arn = 'NEW_RESOURCE_ARN';
          json.microvm_platform_config.arn_keys.push('new_resource_arn');
        });
      });
      expect(result.status).toBe(0);
    });

    test('rejects an arn_keys entry that is not a wire key', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.arn_keys.push('imaginary_arn');
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('imaginary_arn');
    });

    test('rejects an anchor that is not among arn_keys', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.account_anchor_key = 'task_table_name';
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('account_anchor_key');
    });

    test('rejects an anchor that is not REQUIRED — the disarm-by-omission hole', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          const mpc = json.microvm_platform_config;
          mpc.arn_keys.push('linear_oauth_secret_arn');
          mpc.account_anchor_key = 'linear_oauth_secret_arn';
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('skippable by omission');
    });

    test('rejects an empty arn_keys list', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_platform_config.arn_keys = [];
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('arn_keys');
    });
  });

  describe('hook-budget invariant', () => {
    test.each(['LIFECYCLE_HANDLER_BUDGET_S', 'LIFECYCLE_HOOK_TIMEOUT_S'])(
      'rejects a hardcoded lifecycle budget %s',
      (name) => {
        const result = runInMutatedRepo((root) => {
          write(root, 'agent/src/microvm_http.py',
            `${read(root, 'agent/src/microvm_http.py')}\n${name}: float = 20\n`);
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(name);
      },
    );

    test.each([0, 1])('rejects a lifecycle handler budget %s seconds beyond the service timeout', (offset) => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_hook_budgets.lifecycle_handler_budget_seconds =
            json.microvm_hook_budgets.lifecycle_hook_timeout_seconds + offset;
        });
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lifecycle_handler_budget_seconds must be <');
    });

    test('rejects a warm-up budget that does not fit inside the hook timeout', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_hook_budgets.warmup_total_budget_seconds =
            json.microvm_hook_budgets.ready_hook_timeout_seconds;
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('warmup_total_budget_seconds');
    });

    test('rejects a required warm-up that leaves the optional ones nothing', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_hook_budgets.warmup_required_timeout_seconds =
            json.microvm_hook_budgets.warmup_total_budget_seconds;
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('warmup_required_timeout_seconds');
    });

    test('rejects a non-integer budget', () => {
      const result = runInMutatedRepo((root) => {
        patchContract(root, (json) => {
          json.microvm_hook_budgets.ready_hook_timeout_seconds = 300.5;
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('microvm_hook_budgets');
    });
  });
});
