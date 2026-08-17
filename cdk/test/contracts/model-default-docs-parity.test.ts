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

  /**
   * The env-var-table assertions above only reach the two docs that HAVE such a
   * table. Four other places quote a model literal — the `model_id` rows in
   * USER_GUIDE / REPO_ONBOARDING and their two generated Starlight mirrors — and
   * nothing read them, so on the next model bump CI would force the two guarded
   * docs to update while those four quietly went stale again. That is precisely
   * the rot this file exists to stop, so sweep every model literal in the doc set
   * instead of enumerating table shapes: any `us.`/`eu.`/`apac.`/`global.`-prefixed
   * Claude id in a guarded doc must be one the agent actually defaults to.
   *
   * Deliberately literal-based rather than row-based: it survives someone
   * re-wording a table, moving the value into prose, or adding a doc — none of
   * which a row parser would follow.
   */
  it('no guarded doc presents a stale model id AS the default', () => {
    const allowed = new Set([
      agentDefaultFor('ANTHROPIC_MODEL'),
      agentDefaultFor('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ]);
    // Only lines that CLAIM to state the default are in scope. A doc legitimately
    // names other models as illustrative examples — a per-repo override snippet, a
    // cost-comparison row, "switch to a lighter model such as X" — and failing those
    // would make the guard unmaintainable, so it would end up deleted rather than
    // fixed. Match on the claim, not on the mere presence of an id.
    // Two shapes claim a default: prose/cells saying so, and a `model_id` table row
    // whose Default CELL carries the literal with no such word on the line at all
    // (REPO_ONBOARDING's blueprint-defaults table and USER_GUIDE's per-repo table
    // are both this shape — mutation-tested, and a keyword-only rule misses them).
    const CLAIMS_DEFAULT = /\bdefaults?\b|\bfallback\b|^\s*\|\s*`model_id`\s*\|/i;
    // Prefixed inference-profile ids only. Bare `anthropic.claude-…` ids appear
    // legitimately when the docs explain WHY a bare id is not invocable, and the
    // IAM grant list in bedrock-models.ts is bare-by-contract — both out of scope
    // here and already covered by bedrock-models.test.ts.
    const MODEL_ID = /\b(?:us|eu|apac|global)\.anthropic\.claude-[a-z0-9-]+(?::[0-9]+)?/g;
    // Hand-authored sources plus every generated mirror that actually quotes a
    // prefixed id (enumerated from the tree, not guessed — `using/Overview.md`
    // mirrors USER_GUIDE but carries no literal, so listing it would assert
    // nothing while implying coverage).
    const GUARDED_DOCS = [
      'docs/guides/DEVELOPER_GUIDE.md',
      'docs/guides/USER_GUIDE.md',
      'docs/design/REPO_ONBOARDING.md',
      'agent/README.md',
      'docs/src/content/docs/architecture/Repo-onboarding.md',
      'docs/src/content/docs/customizing/Per-repo-overrides.md',
      'docs/src/content/docs/developer-guide/Model-configuration.md',
      'docs/src/content/docs/developer-guide/Repository-preparation.md',
      'docs/src/content/docs/developer-guide/Installation.md',
      'docs/src/content/docs/getting-started/Quick-start.mdx',
    ] as const;

    const offenders: string[] = [];
    for (const docPath of GUARDED_DOCS) {
      for (const [i, line] of read(docPath).split('\n').entries()) {
        if (!CLAIMS_DEFAULT.test(line)) continue;
        for (const id of line.match(MODEL_ID) ?? []) {
          if (!allowed.has(id)) offenders.push(`${docPath}:${i + 1} → ${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
