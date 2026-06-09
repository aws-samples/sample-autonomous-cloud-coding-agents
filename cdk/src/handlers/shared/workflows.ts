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
  /**
   * The workflow's declared preferred Bedrock model (`agent_config.model.id` in
   * the YAML), if any. Validated against {@link WORKFLOW_MODEL_ALLOWLIST} at the
   * create-task boundary (WORKFLOWS.md rule 13). `undefined` ⇒ the workflow
   * declared no model and inherits the Blueprint/platform default — always
   * admitted. A declared id MUST be on the allow-list or admission fails (no
   * silent downgrade). Keep in lockstep with the YAML's `agent_config.model.id`.
   */
  readonly modelId?: string;
}

/**
 * Platform allow-list of Bedrock model ids a workflow may pin via
 * `agent_config.model.id` (WORKFLOWS.md rule 13 / §"Model selection"). Mirrors
 * the foundation models the agent runtime is granted to invoke (`BEDROCK_MODEL_IDS`
 * in `cdk/src/constructs/ecs-agent-cluster.ts`), accepting both the bare id and
 * the `us.`-prefixed cross-region inference-profile form the runtime resolves.
 * A future Phase 4 will source this from the repo Blueprint; until then it is a
 * single platform-wide list checked at admission.
 */
export const WORKFLOW_MODEL_ALLOWLIST: readonly string[] = [
  'anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-20250514-v1:0',
  'us.anthropic.claude-opus-4-20250514-v1:0',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/**
 * Validate a resolved workflow's declared model against the platform allow-list
 * (WORKFLOWS.md rule 13). Returns the offending id when the workflow pins a
 * model NOT on the allow-list (caller fails admission — no silent downgrade);
 * returns `null` when the workflow declares no model or its model is permitted.
 */
export function disallowedWorkflowModel(id: string): string | null {
  const modelId = DESCRIPTORS[id]?.modelId;
  if (modelId === undefined) return null;
  return WORKFLOW_MODEL_ALLOWLIST.includes(modelId) ? null : modelId;
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

/** Split a ``workflow_ref`` into its id and optional ``@constraint`` suffix. */
export function parseWorkflowRef(ref: string): { id: string; constraint?: string } {
  const at = ref.indexOf('@');
  if (at === -1) return { id: ref };
  return { id: ref.slice(0, at), constraint: ref.slice(at + 1) };
}

/**
 * Why an explicit ``workflow_ref`` could not be resolved — lets the caller emit
 * a precise 400 instead of a generic one.
 *   - ``unknown_id``: the ``<domain>/<name>-vN`` id names no shipped workflow.
 *   - ``unsatisfiable_version``: the id exists but the ``@constraint`` pins a
 *     version the platform does not ship (Phase 1 ships exactly one version per
 *     id, so any constraint other than that version is unsatisfiable).
 */
export type WorkflowResolutionError = 'unknown_id' | 'unsatisfiable_version';

/**
 * Resolve a ``workflow_ref`` to a pinned ``{id, version}``, applying the
 * resolution ladder (WORKFLOWS.md §"Replacing task types"):
 *   1. explicit ``workflow_ref`` (id + optional ``@constraint``);
 *   2. (Blueprint default — Phase 4, not yet wired);
 *   3. the platform default ``default/agent-v1``.
 *
 * Returns ``null`` when an explicit ref cannot be resolved — either the id is
 * unknown OR an ``@constraint`` pins a version the platform does not ship. The
 * constraint is NO LONGER silently discarded (PR review #296 finding #6): a pin
 * like ``coding/new-task-v1@2.0.0`` fails admission rather than quietly running
 * ``1.0.0``. Use {@link resolveWorkflowRefError} for which case, to craft the 400.
 */
export function resolveWorkflowRef(ref?: string | null): ResolvedWorkflow | null {
  if (ref === undefined || ref === null || ref === '') {
    const fallback = DESCRIPTORS[DEFAULT_WORKFLOW_ID];
    return { id: fallback.id, version: fallback.version };
  }
  const { id, constraint } = parseWorkflowRef(ref);
  const descriptor = DESCRIPTORS[id];
  if (!descriptor) return null;
  // Phase 1: exactly one shipped version per id. A constraint must match it
  // exactly (semver ranges arrive with the registry in Phase 4, #246).
  if (constraint !== undefined && constraint !== descriptor.version) return null;
  return { id: descriptor.id, version: descriptor.version };
}

/**
 * Classify why {@link resolveWorkflowRef} returned ``null`` for an explicit ref,
 * so the caller can produce a specific 400 message. Returns ``null`` for a ref
 * that DOES resolve (or an absent ref, which falls back to the default).
 */
export function resolveWorkflowRefError(ref?: string | null): WorkflowResolutionError | null {
  if (ref === undefined || ref === null || ref === '') return null;
  const { id, constraint } = parseWorkflowRef(ref);
  const descriptor = DESCRIPTORS[id];
  if (!descriptor) return 'unknown_id';
  if (constraint !== undefined && constraint !== descriptor.version) return 'unsatisfiable_version';
  return null;
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
