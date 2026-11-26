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
import * as yaml from 'js-yaml';
import { BEDROCK_GEO_REGIONS, DEFAULT_BEDROCK_MODEL_IDS } from '../../../src/constructs/bedrock-models';
import {
  CODING_WORKFLOW_ID,
  DEFAULT_WORKFLOW_ID,
  WORKFLOW_MODEL_ALLOWLIST,
  disallowedWorkflowModel,
  getWorkflowDescriptor,
  isValidWorkflowRef,
  resolveWorkflowRef,
  resolveWorkflowRefError,
  workflowIsReadOnly,
  workflowRequiresRepo,
  workflowUsesPr,
} from '../../../src/handlers/shared/workflows';

describe('isValidWorkflowRef', () => {
  test('accepts valid refs, with or without a constraint', () => {
    expect(isValidWorkflowRef('coding/new-task-v1')).toBe(true);
    expect(isValidWorkflowRef('coding/pr-review-v1@1.0.0')).toBe(true);
    expect(isValidWorkflowRef(undefined)).toBe(true);
    expect(isValidWorkflowRef(null)).toBe(true);
  });

  test('rejects malformed refs', () => {
    expect(isValidWorkflowRef('new_task')).toBe(false);
    expect(isValidWorkflowRef('coding/new-task')).toBe(false);
    expect(isValidWorkflowRef('')).toBe(false);
    expect(isValidWorkflowRef(123)).toBe(false);
  });
});

describe('resolveWorkflowRef', () => {
  test('resolves an explicit ref to its pinned version', () => {
    expect(resolveWorkflowRef('coding/new-task-v1')).toEqual({ id: 'coding/new-task-v1', version: '1.0.0' });
  });

  test('accepts a constraint that matches the shipped version', () => {
    expect(resolveWorkflowRef('coding/pr-review-v1@1.0.0')).toEqual({ id: 'coding/pr-review-v1', version: '1.0.0' });
  });

  test('rejects an unsatisfiable @version pin instead of silently downgrading (#296 finding #6)', () => {
    expect(resolveWorkflowRef('coding/pr-review-v1@9.9.9')).toBeNull();
    expect(resolveWorkflowRefError('coding/pr-review-v1@9.9.9')).toBe('unsatisfiable_version');
  });

  test('classifies an unknown id distinctly from a bad version', () => {
    expect(resolveWorkflowRefError('coding/does-not-exist-v1')).toBe('unknown_id');
    expect(resolveWorkflowRefError('coding/new-task-v1')).toBeNull();
    expect(resolveWorkflowRefError('coding/new-task-v1@1.0.0')).toBeNull();
    expect(resolveWorkflowRefError(undefined)).toBeNull();
  });

  test('falls back to the repo-less platform default when ref is absent', () => {
    expect(resolveWorkflowRef(undefined)).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
    expect(resolveWorkflowRef(null)).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
    expect(resolveWorkflowRef('')).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
  });

  test('CODING_WORKFLOW_ID resolves to the disciplined coding workflow', () => {
    const resolved = resolveWorkflowRef(CODING_WORKFLOW_ID);
    expect(resolved).toEqual({ id: 'coding/new-task-v1', version: '1.0.0' });
  });

  test('returns null for an unknown but well-formed ref', () => {
    expect(resolveWorkflowRef('coding/does-not-exist-v1')).toBeNull();
  });
});

describe('descriptor field accessors', () => {
  test('coding/new-task-v1 requires a repo, is writeable, is not a PR workflow', () => {
    expect(workflowRequiresRepo('coding/new-task-v1')).toBe(true);
    expect(workflowIsReadOnly('coding/new-task-v1')).toBe(false);
    expect(workflowUsesPr('coding/new-task-v1')).toBe(false);
  });

  test('coding/pr-review-v1 is read-only and a PR workflow', () => {
    expect(workflowIsReadOnly('coding/pr-review-v1')).toBe(true);
    expect(workflowUsesPr('coding/pr-review-v1')).toBe(true);
  });

  test('default/agent-v1 is repo-less', () => {
    expect(workflowRequiresRepo('default/agent-v1')).toBe(false);
  });

  test('knowledge/web-research-v1 is a repo-less, writeable, non-PR workflow (#248 Phase 3)', () => {
    expect(workflowRequiresRepo('knowledge/web-research-v1')).toBe(false);
    expect(workflowIsReadOnly('knowledge/web-research-v1')).toBe(false);
    expect(workflowUsesPr('knowledge/web-research-v1')).toBe(false);
    expect(resolveWorkflowRef('knowledge/web-research-v1')).toEqual({
      id: 'knowledge/web-research-v1', version: '1.0.0',
    });
  });

  test('unknown ids fall back to safe defaults (requires repo, writeable)', () => {
    expect(workflowRequiresRepo('nope/unknown-v1')).toBe(true);
    expect(workflowIsReadOnly('nope/unknown-v1')).toBe(false);
    expect(workflowUsesPr('nope/unknown-v1')).toBe(false);
  });
});

describe('CDK descriptors stay in sync with agent/workflows/**', () => {
  const workflowsRoot = path.resolve(__dirname, '../../../../agent/workflows');

  const yamlFiles = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'schema') walk(full);
        } else if (entry.name.endsWith('.yaml')) {
          out.push(full);
        }
      }
    };
    if (fs.existsSync(workflowsRoot)) walk(workflowsRoot);
    return out;
  })();

  test('every CDK descriptor has a shipped workflow file (no orphan admissions)', () => {
    const shippedIds = new Set(yamlFiles.map((file) => {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      return doc.id as string;
    }));
    const workflowsTs = fs.readFileSync(
      path.resolve(__dirname, '../../../src/handlers/shared/workflows.ts'), 'utf8',
    );
    const table = workflowsTs.slice(workflowsTs.indexOf('const DESCRIPTORS'));
    const declaredIds = [...table.matchAll(/^\s{4}id: '([^']+)',$/gm)].map((m) => m[1]);
    expect(declaredIds.length).toBeGreaterThan(0);

    const orphans = declaredIds.filter((id) => !shippedIds.has(id));
    expect(orphans).toEqual([]);
  });

  test('every shipped workflow file has a matching CDK descriptor', () => {
    expect(yamlFiles.length).toBeGreaterThan(0);
    for (const file of yamlFiles) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const id = doc.id as string;
      const descriptor = getWorkflowDescriptor(id);
      expect(descriptor).toBeDefined();
      expect(descriptor!.version).toBe(doc.version);

      const resolvedRequiresRepo = doc.requires_repo !== undefined
        ? Boolean(doc.requires_repo)
        : doc.domain === 'coding';
      expect(descriptor!.requiresRepo).toBe(resolvedRequiresRepo);
      expect(descriptor!.readOnly).toBe(Boolean(doc.read_only ?? false));

      const agentConfig = (doc.agent_config ?? {}) as Record<string, unknown>;
      const model = (agentConfig.model ?? undefined) as Record<string, unknown> | undefined;
      const yamlModelId = model?.id as string | undefined;
      expect(descriptor!.modelId).toBe(yamlModelId);

      if (yamlModelId !== undefined) {
        expect(WORKFLOW_MODEL_ALLOWLIST).toContain(yamlModelId);
      }

      const ri = (doc.required_inputs ?? {}) as Record<string, unknown>;
      const yamlAllOf = (ri.all_of as string[] | undefined);
      const yamlOneOf = (ri.one_of as string[] | undefined);
      const norm = (xs?: readonly string[]) => (xs ? [...xs].sort() : undefined);
      expect(norm(descriptor!.requiredInputs.allOf)).toEqual(norm(yamlAllOf));
      expect(norm(descriptor!.requiredInputs.oneOf)).toEqual(norm(yamlOneOf));
    }
  });

  test('agent _KNOWN_WRITEABLE_WORKFLOW_IDS matches the writeable repo-bound descriptors', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../../agent/src/config.py'), 'utf8',
    );
    const match = configPy.match(/_KNOWN_WRITEABLE_WORKFLOW_IDS\s*=\s*frozenset\(\s*\(([^)]*)\)\s*\)/s);
    expect(match).not.toBeNull();
    const agentWriteable = new Set(
      [...match![1].matchAll(/"([^"]+)"/g)].map(m => m[1]),
    );

    const expectedWriteable = new Set<string>();
    for (const file of yamlFiles) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const requiresRepo = doc.requires_repo !== undefined
        ? Boolean(doc.requires_repo)
        : doc.domain === 'coding';
      const readOnly = Boolean(doc.read_only ?? false);
      if (requiresRepo && !readOnly) expectedWriteable.add(doc.id as string);
    }
    expect([...agentWriteable].sort()).toEqual([...expectedWriteable].sort());
  });

  test('agent default-workflow constants agree with the YAML and CDK default', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../../agent/src/config.py'), 'utf8',
    );
    const grab = (name: string): string => {
      const m = configPy.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
      expect(m).not.toBeNull();
      return m![1];
    };
    const repoLessDefault = grab('REPO_LESS_DEFAULT_WORKFLOW_ID');
    const codingDefault = grab('DEFAULT_WORKFLOW_ID');

    expect(repoLessDefault).toBe(DEFAULT_WORKFLOW_ID);

    const docById = new Map<string, Record<string, unknown>>();
    for (const file of yamlFiles) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      docById.set(doc.id as string, doc);
    }
    const requiresRepoOf = (id: string): boolean => {
      const doc = docById.get(id);
      expect(doc).toBeDefined();
      return doc!.requires_repo !== undefined ? Boolean(doc!.requires_repo) : doc!.domain === 'coding';
    };
    expect(requiresRepoOf(repoLessDefault)).toBe(false);
    expect(requiresRepoOf(codingDefault)).toBe(true);
  });
});

describe('disallowedWorkflowModel (WORKFLOWS.md rule 13)', () => {
  test('returns null for a workflow that declares no model (inherits default)', () => {
    expect(disallowedWorkflowModel('coding/new-task-v1')).toBeNull();
    expect(disallowedWorkflowModel('default/agent-v1')).toBeNull();
    expect(disallowedWorkflowModel('knowledge/web-research-v1')).toBeNull();
  });

  test('returns null for an unknown id (unreachable here; create-core 400s first)', () => {
    expect(disallowedWorkflowModel('nope/unknown-v1')).toBeNull();
  });

  test('the allow-list covers both bare and us-prefixed inference-profile ids', () => {
    expect(WORKFLOW_MODEL_ALLOWLIST).toContain('anthropic.claude-sonnet-4-6');
    expect(WORKFLOW_MODEL_ALLOWLIST).toContain('us.anthropic.claude-sonnet-4-6');
  });

  const DEPLOYABLE_GEOS = BEDROCK_GEO_REGIONS;

  test('the allow-list covers every GRANTED model in every geography it may be deployed with', () => {
    const missing: string[] = [];
    for (const bare of DEFAULT_BEDROCK_MODEL_IDS) {
      if (!WORKFLOW_MODEL_ALLOWLIST.includes(bare)) missing.push(bare);
      for (const geo of DEPLOYABLE_GEOS) {
        const id = `${geo}.${bare}`;
        if (!WORKFLOW_MODEL_ALLOWLIST.includes(id)) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the allow-list is exactly the granted set × every geography (admission is geo-blind)', () => {
    const grantedForms = new Set<string>();
    for (const bare of DEFAULT_BEDROCK_MODEL_IDS) {
      grantedForms.add(bare);
      for (const geo of DEPLOYABLE_GEOS) grantedForms.add(`${geo}.${bare}`);
    }
    const ungranted = WORKFLOW_MODEL_ALLOWLIST.filter((id) => !grantedForms.has(id));
    expect(ungranted).toEqual([]);
  });
});
