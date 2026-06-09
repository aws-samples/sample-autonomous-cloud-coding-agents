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
  DEFAULT_WORKFLOW_ID,
  getWorkflowDescriptor,
  isValidWorkflowRef,
  resolveWorkflowRef,
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

  test('strips a version constraint and pins to the shipped version', () => {
    expect(resolveWorkflowRef('coding/pr-review-v1@9.9.9')).toEqual({ id: 'coding/pr-review-v1', version: '1.0.0' });
  });

  test('falls back to the platform default when ref is absent', () => {
    expect(resolveWorkflowRef(undefined)).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
    expect(resolveWorkflowRef(null)).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
    expect(resolveWorkflowRef('')).toEqual({ id: DEFAULT_WORKFLOW_ID, version: '1.0.0' });
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
    }
  });
});
