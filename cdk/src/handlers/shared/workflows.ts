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
 * CDK-side workflow descriptors — the create-task boundary's view of the
 * first-party workflow files shipped under ``agent/workflows/`` (#248).
 *
 * The agent owns the authoritative YAML and the single cross-field validator
 * (``agent/src/workflow/validator.py``, Python). CDK cannot import that
 * validator, but admission control needs a few fields per workflow —
 * ``requires_repo``, ``read_only``, and the required-input contract — to
 * validate a ``CreateTaskRequest`` and resolve a ``workflow_ref`` to a pinned
 * ``{id, version}``. This module is that minimal mirror: one descriptor per
 * shipped file, kept in sync by hand until the registry (#246) serves them.
 *
 * Keep this table in lockstep with ``agent/workflows/**`` — a `tests` fixture
 * asserts the ids/versions match the YAML.
 */

import { ResolvedWorkflow } from './types';

/** The required-input contract a workflow declares (mirrors the YAML). */
export interface WorkflowRequiredInputs {
  /** All of these inputs must be satisfiable. */
  readonly allOf?: readonly WorkflowInput[];
  /** At least one of these inputs must be satisfiable. */
  readonly oneOf?: readonly WorkflowInput[];
}

/** Inputs a workflow can require — the subset CDK validates at admission. */
export type WorkflowInput = 'issue_number' | 'task_description' | 'pr_number';

/** The CDK-relevant projection of a workflow file. */
export interface WorkflowDescriptor {
  readonly id: string;
  readonly version: string;
  /** Domain-resolved: whether the task clones a repo (drives preflight). */
  readonly requiresRepo: boolean;
  /** Whether the workflow runs read-only (drives the preflight permission level). */
  readonly readOnly: boolean;
  readonly requiredInputs: WorkflowRequiredInputs;
}

/**
 * The shipped first-party workflows. The pr_* coding workflows mirror the
 * agent-side files authored in the same #248 cutover.
 */
const DESCRIPTORS: Record<string, WorkflowDescriptor> = {
  'coding/new-task-v1': {
    id: 'coding/new-task-v1',
    version: '1.0.0',
    requiresRepo: true,
    readOnly: false,
    requiredInputs: { oneOf: ['issue_number', 'task_description'] },
  },
  'coding/pr-iteration-v1': {
    id: 'coding/pr-iteration-v1',
    version: '1.0.0',
    requiresRepo: true,
    readOnly: false,
    requiredInputs: { allOf: ['pr_number'] },
  },
  'coding/pr-review-v1': {
    id: 'coding/pr-review-v1',
    version: '1.0.0',
    requiresRepo: true,
    readOnly: true,
    requiredInputs: { allOf: ['pr_number'] },
  },
  'default/agent-v1': {
    id: 'default/agent-v1',
    version: '1.0.0',
    requiresRepo: false,
    readOnly: false,
    requiredInputs: { allOf: ['task_description'] },
  },
  // Repo-less knowledge workflow (#248 Phase 3) — research → S3 artifact, no repo.
  'knowledge/web-research-v1': {
    id: 'knowledge/web-research-v1',
    version: '1.0.0',
    requiresRepo: false,
    readOnly: false,
    requiredInputs: { allOf: ['task_description'] },
  },
};

/** The platform default workflow — the last rung of the resolution ladder. */
export const DEFAULT_WORKFLOW_ID = 'default/agent-v1';

/** Pattern for a valid workflow ref: ``<domain>/<name>-vN[@<constraint>]``. */
const WORKFLOW_REF_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*-v\d+(@[^\s]+)?$/;

/**
 * Validate a ``workflow_ref`` value from a request body.
 *
 * Accepts ``undefined``/``null`` (⇒ resolution fallback) or a syntactically
 * valid ref string. Does NOT check the ref resolves to a known workflow —
 * {@link resolveWorkflowRef} does that and returns null on an unknown id.
 */
export function isValidWorkflowRef(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  return WORKFLOW_REF_PATTERN.test(value);
}

/**
 * Resolve a ``workflow_ref`` to a pinned ``{id, version}``, applying the
 * resolution ladder (WORKFLOWS.md §"Replacing task types"):
 *   1. explicit ``workflow_ref`` (strip any ``@constraint``);
 *   2. (Blueprint default — Phase 4, not yet wired);
 *   3. the platform default ``default/agent-v1``.
 *
 * Returns ``null`` when an explicit ref names an unknown workflow (caller
 * returns 400). A constraint suffix is accepted syntactically and, in Phase 1,
 * pins to the single shipped version of that id.
 */
export function resolveWorkflowRef(ref?: string | null): ResolvedWorkflow | null {
  if (ref === undefined || ref === null || ref === '') {
    const fallback = DESCRIPTORS[DEFAULT_WORKFLOW_ID];
    return { id: fallback.id, version: fallback.version };
  }
  const id = ref.split('@', 1)[0];
  const descriptor = DESCRIPTORS[id];
  if (!descriptor) return null;
  return { id: descriptor.id, version: descriptor.version };
}

/** Look up a descriptor by resolved id (after {@link resolveWorkflowRef}). */
export function getWorkflowDescriptor(id: string): WorkflowDescriptor | undefined {
  return DESCRIPTORS[id];
}

/** Whether the resolved workflow clones a repo (drives preflight gating). */
export function workflowRequiresRepo(id: string): boolean {
  return DESCRIPTORS[id]?.requiresRepo ?? true;
}

/**
 * Whether the resolved workflow runs read-only (drives preflight permissions).
 *
 * The unknown-id default is `false` (treat as writeable) ON PURPOSE: preflight
 * computes `needsWrite = !readOnly`, so `false` demands the *broader* token
 * permission set (contents:write), which is the conservative admission posture —
 * never under-checking the token. This is NOT the Cedar write-deny enforcement
 * axis (that is agent-side, keyed off `context.read_only`, and fails closed to
 * read-only for an unknown id in config.build_config); do not "align" this
 * default to `true` to match it — that would weaken the admission check.
 * Unknown ids are unreachable here anyway (create-task-core rejects unknown
 * refs with 400; orchestrate-task defaults a missing id to coding/new-task-v1).
 */
export function workflowIsReadOnly(id: string): boolean {
  return DESCRIPTORS[id]?.readOnly ?? false;
}

/**
 * Whether the resolved workflow operates on an existing pull request (it
 * requires ``pr_number`` and hydrates PR context rather than an issue). Drives
 * the PR-vs-issue branch in context hydration.
 */
export function workflowUsesPr(id: string): boolean {
  return DESCRIPTORS[id]?.requiredInputs.allOf?.includes('pr_number') ?? false;
}
