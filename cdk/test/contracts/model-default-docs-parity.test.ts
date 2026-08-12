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

import * as fs from 'fs';
import * as path from 'path';

/**
 * DOCS CONTRACT: the model defaults the docs advertise must equal the defaults
 * the agent actually uses.
 *
 * The agent's default model is a Python literal in `agent/src/config.py` with no
 * CDK prop or environment knob in front of it, so a model bump is a one-line
 * source edit — and every doc that quotes the old value silently becomes a lie.
 * That is exactly what happened: four docs advertised a Sonnet-4.6 default long
 * after the code moved to Opus 4.8, and `agent/README.md` advertised a BARE
 * haiku id that cannot be invoked on-demand at all, contradicting the `us.`
 * -prefixed inference-profile id the stack actually deploys. Nothing guarded
 * either one, so both rotted unnoticed across several releases (#742).
 *
 * `cdk/test/constructs/bedrock-models.test.ts` already proves this
 * cross-language regex-grep pattern for the code→IAM half of the invariant (the
 * agent fallback must be in `DEFAULT_BEDROCK_MODEL_IDS` or every task fails at
 * turn 0 with AccessDenied). This file closes the code→docs half: the next model
 * bump fails CI here instead of quietly rotting the documentation.
 *
 * Deliberately asserts against the *rendered doc text* (the value inside
 * backticks in the env-var tables) rather than a shared constant, because the
 * failure mode being guarded is precisely a human reading a stale doc.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/**
 * Extracts an env-var fallback literal from `agent/src/config.py`, i.e. the
 * second argument of `os.environ.get("<name>", "<default>")`. Tolerates the
 * line wrapping Ruff applies to the call.
 */
function agentDefaultFor(envVar: string): string {
  const configPy = read('agent/src/config.py');
  const match = configPy.match(new RegExp(`"${envVar}",\\s*"([^"]+)"`));
  expect(match).not.toBeNull();
  return match![1];
}

/**
 * Extracts the `Default` cell of a markdown env-var table row keyed by
 * `` `<envVar>` `` — the value the doc advertises to a reader. Returns every
 * match so a doc with more than one such table fails loudly rather than having
 * the second table silently unguarded.
 */
function documentedDefaults(markdown: string, envVar: string): string[] {
  const rows = markdown
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|') && line.includes(`\`${envVar}\``));
  const found: string[] = [];
  for (const row of rows) {
    // Cells, minus the leading/trailing empties produced by the outer pipes.
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    // The default is the first backticked cell AFTER the one naming the env var.
    const nameIdx = cells.findIndex((c) => c === `\`${envVar}\``);
    if (nameIdx === -1) continue;
    for (const cell of cells.slice(nameIdx + 1)) {
      const literal = cell.match(/^`([^`]+)`$/);
      if (literal) {
        found.push(literal[1]);
        break;
      }
    }
  }
  return found;
}

describe('documented model defaults match the agent runtime defaults', () => {
  // The docs that advertise a default in an env-var table. Both are read by
  // humans configuring a deployment, so both must track config.py.
  const DOCS_WITH_ENV_TABLES = [
    'docs/guides/DEVELOPER_GUIDE.md',
    'agent/README.md',
  ] as const;

  it.each(DOCS_WITH_ENV_TABLES)('%s documents the real ANTHROPIC_MODEL default', (docPath) => {
    const expected = agentDefaultFor('ANTHROPIC_MODEL');
    const documented = documentedDefaults(read(docPath), 'ANTHROPIC_MODEL');
    // A doc that stops documenting the default at all is also a regression: the
    // guard would silently pass on an empty list.
    expect(documented.length).toBeGreaterThan(0);
    for (const value of documented) {
      expect(value).toBe(expected);
    }
  });

  it('agent/README.md documents the real ANTHROPIC_DEFAULT_HAIKU_MODEL default', () => {
    const expected = agentDefaultFor('ANTHROPIC_DEFAULT_HAIKU_MODEL');
    const documented = documentedDefaults(read('agent/README.md'), 'ANTHROPIC_DEFAULT_HAIKU_MODEL');
    expect(documented.length).toBeGreaterThan(0);
    for (const value of documented) {
      expect(value).toBe(expected);
    }
  });

  it('both agent defaults are inference-profile ids, not bare foundation-model ids', () => {
    // A bare `anthropic.…` id cannot be invoked with on-demand throughput
    // (Bedrock returns ValidationException), so documenting one sends readers
    // down a dead end. Guards the specific bug fixed in agent/README.md.
    for (const envVar of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      expect(agentDefaultFor(envVar)).toMatch(/^(us|eu|apac|global)\./);
    }
  });
});
