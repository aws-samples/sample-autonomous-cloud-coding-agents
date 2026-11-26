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

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function agentDefaultFor(envVar: string): string {
  const configPy = read('agent/src/config.py');
  const match = configPy.match(new RegExp(`"${envVar}",\\s*"([^"]+)"`));
  expect(match).not.toBeNull();
  return match![1];
}

function documentedDefaults(markdown: string, envVar: string): string[] {
  const rows = markdown
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|') && line.includes(`\`${envVar}\``));
  const found: string[] = [];
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
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
  const DOCS_WITH_ENV_TABLES = [
    'docs/guides/DEVELOPER_GUIDE.md',
    'agent/README.md',
  ] as const;

  it('models.py TaskConfig defaults match the config.py fallbacks', () => {
    const modelsPy = read('agent/src/models.py');
    const field = (name: string) => {
      const m = new RegExp(`${name}: str = "([^"]+)"`).exec(modelsPy);
      if (!m) throw new Error(`models.py no longer declares ${name}`);
      return m[1];
    };
    expect(field('anthropic_model')).toBe(agentDefaultFor('ANTHROPIC_MODEL'));
    expect(field('haiku_model')).toBe(agentDefaultFor('ANTHROPIC_DEFAULT_HAIKU_MODEL'));
  });

  it('operator skills do not advertise a different geography than the platform default', () => {
    const expectedGeo = /^([a-z-]+)\./.exec(agentDefaultFor('ANTHROPIC_MODEL'))?.[1];
    expect(expectedGeo).toBeDefined();
    for (const skill of ['onboard-repo', 'troubleshoot']) {
      const text = read(`docs/abca-plugin/skills/${skill}/SKILL.md`);
      const wrong = [...text.matchAll(/\b(global|us-gov|us|eu|apac|jp|au)\.anthropic\.[a-z0-9.:-]+/g)]
        .filter((m) => m[1] !== expectedGeo)
        .map((m) => m[0]);
      expect(wrong).toEqual([]);
    }
  });

  it.each(DOCS_WITH_ENV_TABLES)('%s documents the real ANTHROPIC_MODEL default', (docPath) => {
    const expected = agentDefaultFor('ANTHROPIC_MODEL');
    const documented = documentedDefaults(read(docPath), 'ANTHROPIC_MODEL');
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
    // (Bedrock returns ValidationException).
    for (const envVar of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      expect(agentDefaultFor(envVar)).toMatch(/^(global|us-gov|us|eu|apac|jp|au)\./);
    }
  });

  it('no guarded doc presents a stale model id AS the default', () => {
    const allowed = new Set([
      agentDefaultFor('ANTHROPIC_MODEL'),
      agentDefaultFor('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ]);
    const CLAIMS_DEFAULT = /\bdefaults?\b|\bfallback\b|^\s*\|\s*`model_id`\s*\|/i;
    const MODEL_ID = /\b(?:global|us-gov|us|eu|apac|jp|au)\.anthropic\.claude-[a-z0-9-]+(?::[0-9]+)?/g;
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
