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
    // Previously @9.9.9 was discarded and the task ran 1.0.0 — now it fails to
    // resolve so the caller can 400 rather than silently run a different version.
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
    // The channel processors pin this at the call site for a repo-bound task
    // (the "repo task ⇒ coding workflow" decision lives per-channel, not in the
    // resolver default). Assert the constant points at a real, repo-bound,
    // non-read-only workflow so a descriptor rename can't silently mispoint it.
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

/**
 * Drift guard: the CDK descriptor table is a hand-maintained mirror of the
 * agent-side YAML files (the agent owns the authoritative validator). This test
 * fails if a shipped workflow file's id/version/requires_repo/read_only stops
 * matching its CDK descriptor — forcing the mirror to be updated in lockstep.
 */
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

  test('every shipped workflow file has a matching CDK descriptor', () => {
    expect(yamlFiles.length).toBeGreaterThan(0);
    for (const file of yamlFiles) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const id = doc.id as string;
      const descriptor = getWorkflowDescriptor(id);
      expect(descriptor).toBeDefined();
      expect(descriptor!.version).toBe(doc.version);

      // requires_repo: explicit value, else domain default (coding ⇒ true).
      const resolvedRequiresRepo = doc.requires_repo !== undefined
        ? Boolean(doc.requires_repo)
        : doc.domain === 'coding';
      expect(descriptor!.requiresRepo).toBe(resolvedRequiresRepo);
      expect(descriptor!.readOnly).toBe(Boolean(doc.read_only ?? false));

      // Rule 13 mirror: the descriptor's modelId must match the YAML's
      // agent_config.model.id (undefined when the workflow declares no model).
      const agentConfig = (doc.agent_config ?? {}) as Record<string, unknown>;
      const model = (agentConfig.model ?? undefined) as Record<string, unknown> | undefined;
      const yamlModelId = model?.id as string | undefined;
      expect(descriptor!.modelId).toBe(yamlModelId);

      // And any declared model must itself be on the platform allow-list —
      // otherwise the workflow ships un-submittable (every task 400s at rule 13).
      if (yamlModelId !== undefined) {
        expect(WORKFLOW_MODEL_ALLOWLIST).toContain(yamlModelId);
      }

      // required_inputs parity (#296 finding #10): the descriptor's allOf/oneOf
      // must mirror the YAML's all_of/one_of exactly (order-insensitive). The
      // admission "is this task spec satisfiable" check keys off the descriptor,
      // so drift here silently over- or under-constrains submission.
      const ri = (doc.required_inputs ?? {}) as Record<string, unknown>;
      const yamlAllOf = (ri.all_of as string[] | undefined);
      const yamlOneOf = (ri.one_of as string[] | undefined);
      const norm = (xs?: readonly string[]) => (xs ? [...xs].sort() : undefined);
      expect(norm(descriptor!.requiredInputs.allOf)).toEqual(norm(yamlAllOf));
      expect(norm(descriptor!.requiredInputs.oneOf)).toEqual(norm(yamlOneOf));
    }
  });

  // #296 finding #10: _KNOWN_WRITEABLE_WORKFLOW_IDS (agent/src/config.py) is a
  // THIRD hand-maintained copy of the writeable set, used by the agent's
  // load-failure fallback. It must agree with the descriptors: a workflow that
  // is read_only:false (writeable) and repo-bound — i.e. the agent must allow
  // writes if its file fails to load — has to be in that set, or its writes get
  // mis-denied on the fallback path. Cross-check the agent constant against the
  // CDK descriptors so adding a writeable workflow without updating the agent
  // list fails CI here.
  test('agent _KNOWN_WRITEABLE_WORKFLOW_IDS matches the writeable repo-bound descriptors', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../../agent/src/config.py'), 'utf8',
    );
    const match = configPy.match(/_KNOWN_WRITEABLE_WORKFLOW_IDS\s*=\s*frozenset\(\(([^)]*)\)\)/s);
    expect(match).not.toBeNull();
    const agentWriteable = new Set(
      [...match![1].matchAll(/"([^"]+)"/g)].map(m => m[1]),
    );

    // The expected writeable set from the YAML: read_only:false AND requires_repo
    // (pr-review is read-only; default/agent-v1 is repo-less and intentionally
    // excluded so its fallback fails closed — mirrors the constant's own docstring).
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

  // #296 finding #10 residual: REPO_LESS_DEFAULT_WORKFLOW_ID (agent/src/config.py)
  // is the load-failure fallback's notion of "the one repo-less default". It must
  // (a) match the CDK platform default and (b) actually be requires_repo:false in
  // the YAML — otherwise the fallback mis-classifies repo-optionality on the very
  // path that exists to fail closed. DEFAULT_WORKFLOW_ID (the coding default) must
  // conversely be a repo-bound workflow. Both pinned here so drift fails CI.
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

    // (a) the repo-less default matches the CDK platform default…
    expect(repoLessDefault).toBe(DEFAULT_WORKFLOW_ID);

    // …and (b) the YAML for each names a workflow with the expected repo-optionality.
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
    // No shipped workflow pins a model today, so all resolve to null (admitted).
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
});
