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
 * Registry URI grammar (#246) — the single, dependency-free source of truth on
 * the TypeScript side. Kept free of any AWS SDK / runtime import so BOTH the
 * Lambda resolver (``registry-resolver.ts``) AND the CDK construct layer
 * (``constructs/blueprint.ts``, which validates refs at synth) can import it
 * without dragging aws-sdk into the synth graph.
 *
 * The regex MUST stay byte-for-byte equivalent to the Python ``_REGISTRY_REF``
 * (agent/src/workflow/validator.py); the ``contracts/registry-resolution/``
 * corpus is the agreement both sides reproduce. See REGISTRY.md §6.
 */

import type { RegistryAssetKind, RegistryRef } from './types';

/**
 *   registry://<kind>/<namespace>/<name>@<constraint>
 *     kind       snake_case: [a-z][a-z0-9_]*
 *     namespace  [a-z][a-z0-9-]*
 *     name       [a-z0-9][a-z0-9._-]*
 *     constraint MANDATORY: exact / caret / tilde semver only
 */
const REGISTRY_REF_RE =
  /^registry:\/\/([a-z][a-z0-9_]*)\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)@([\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Kinds that are valid targets of a registry ref. Mirrors REGISTRY.md §2. */
export const KNOWN_KINDS: ReadonlySet<RegistryAssetKind> = new Set<RegistryAssetKind>([
  'mcp_server',
  'cedar_policy_module',
  'skill',
  'plugin',
  'subagent',
  'prompt_fragment',
  'capability',
]);

/** Specific, machine-readable reasons a resolution can fail (REGISTRY.md §5). */
export type RegistryResolutionReason =
  | 'INVALID_REGISTRY_REF'
  | 'INVALID_CONSTRAINT'
  | 'NO_MATCHING_VERSION'
  | 'REMOVED';

/**
 * Thrown when a ref cannot be resolved. Carries the specific {@link RegistryResolutionReason}
 * and the offending ref so the create-task boundary can fail admission with
 * ``REGISTRY_RESOLUTION_FAILED`` + reason (fail-closed; ADR-018 sub-decision 6).
 */
export class RegistryResolutionError extends Error {
  readonly reason: RegistryResolutionReason;
  readonly ref: string;

  constructor(reason: RegistryResolutionReason, ref: string, detail?: string) {
    super(`registry resolution failed [${reason}] for ${ref}${detail ? `: ${detail}` : ''}`);
    this.name = 'RegistryResolutionError';
    this.reason = reason;
    this.ref = ref;
  }
}

/**
 * Parse a ``registry://`` reference into its components. Grammar-only — does not
 * touch the catalog. Throws {@link RegistryResolutionError} with
 * ``INVALID_REGISTRY_REF`` when the ref does not match the grammar (which
 * includes a missing/floating constraint — pins are mandatory).
 */
export function parseRef(ref: string): RegistryRef {
  const m = REGISTRY_REF_RE.exec(ref);
  if (!m) {
    throw new RegistryResolutionError('INVALID_REGISTRY_REF', ref);
  }
  const [, kind, namespace, name, constraint] = m;
  if (!KNOWN_KINDS.has(kind as RegistryAssetKind)) {
    throw new RegistryResolutionError('INVALID_REGISTRY_REF', ref, `unknown kind ${kind}`);
  }
  return { kind: kind as RegistryAssetKind, namespace, name, constraint };
}

/** True iff ``ref`` matches the grammar. Never throws — the non-throwing peer of
 *  {@link parseRef}, mirroring Python ``is_registry_ref``. */
export function isRegistryRef(ref: string): boolean {
  try {
    parseRef(ref);
    return true;
  } catch {
    return false;
  }
}

/** Partition key for a ref: ``{kind}#{namespace}/{name}`` (REGISTRY.md §3.1). */
export function assetPk(kind: RegistryAssetKind, namespace: string, name: string): string {
  return `${kind}#${namespace}/${name}`;
}
