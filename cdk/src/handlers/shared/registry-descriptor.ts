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
 * Publish-time validation for registry assets (#246; REGISTRY.md §2/§3.3/§5/§6).
 * Pure functions with no AWS dependency so they are unit-testable in isolation
 * and reused by the publish handler.
 */

import * as semver from 'semver';
import type { RegistryAssetKind, RegistryDescriptor } from './types';

/** Kinds that have a loader in MVP and may therefore be published. */
export const PUBLISHABLE_KINDS: ReadonlySet<RegistryAssetKind> = new Set<RegistryAssetKind>([
  'mcp_server',
  'cedar_policy_module',
  'skill',
]);

/** Kinds carried in the grammar but not yet loadable (publish is rejected). */
export const RESERVED_KINDS: ReadonlySet<RegistryAssetKind> = new Set<RegistryAssetKind>([
  'plugin',
  'subagent',
  'prompt_fragment',
  'capability',
]);

const NAMESPACE_RE = /^[a-z][a-z0-9-]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Kinds whose artifact bytes are required at publish (REGISTRY.md §3.3). */
export const KINDS_REQUIRING_ARTIFACT: ReadonlySet<RegistryAssetKind> = new Set<RegistryAssetKind>([
  'mcp_server',
  'cedar_policy_module',
  'skill',
]);

/** A single validation failure: a machine field key + human message. */
export interface DescriptorViolation {
  readonly field: string;
  readonly message: string;
}

export interface PublishInput {
  readonly kind?: unknown;
  readonly namespace?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly descriptor?: unknown;
  readonly artifact_b64?: unknown;
}

/**
 * Validate a publish request's identity fields, version, and per-kind
 * descriptor. Returns all violations found (empty == valid) so the caller can
 * surface them together rather than one at a time.
 */
export function validatePublish(input: PublishInput): DescriptorViolation[] {
  const v: DescriptorViolation[] = [];

  // --- kind ---
  const kind = input.kind;
  if (typeof kind !== 'string' || (!PUBLISHABLE_KINDS.has(kind as RegistryAssetKind) && !RESERVED_KINDS.has(kind as RegistryAssetKind))) {
    v.push({ field: 'kind', message: `unknown kind ${String(kind)}` });
  } else if (RESERVED_KINDS.has(kind as RegistryAssetKind)) {
    v.push({ field: 'kind', message: `kind ${kind} is reserved and has no loader in MVP; cannot be published` });
  }

  // --- namespace / name ---
  if (typeof input.namespace !== 'string' || !NAMESPACE_RE.test(input.namespace)) {
    v.push({ field: 'namespace', message: 'namespace must match ^[a-z][a-z0-9-]*$' });
  }
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    v.push({ field: 'name', message: 'name must match ^[a-z0-9][a-z0-9._-]*$' });
  }

  // --- version: must be an EXACT semver (not a range) ---
  if (typeof input.version !== 'string' || semver.valid(input.version) === null) {
    v.push({ field: 'version', message: 'version must be an exact semver (e.g. 1.4.1)' });
  }

  // --- descriptor: shared + per-kind required fields ---
  const d = input.descriptor;
  if (typeof d !== 'object' || d === null) {
    v.push({ field: 'descriptor', message: 'descriptor is required and must be an object' });
  } else {
    const desc = d as Record<string, unknown>;
    if (typeof desc.summary !== 'string' || desc.summary.length === 0) {
      v.push({ field: 'descriptor.summary', message: 'summary is required' });
    }
    if (!Array.isArray(desc.permissions)) {
      v.push({ field: 'descriptor.permissions', message: 'permissions must be an array' });
    }
    if (typeof kind === 'string' && PUBLISHABLE_KINDS.has(kind as RegistryAssetKind)) {
      v.push(...validateKindDescriptor(kind as RegistryAssetKind, desc));
    }
  }

  // --- artifact required for loadable kinds, UNLESS the descriptor carries
  // the content inline. An mcp_server may ship its ``server_config`` directly
  // in the descriptor (the common case — the agent loader reads it from there),
  // in which case a separate artifact is redundant. Only require an artifact
  // when there is no inline content to load. ``cedar_policy_module`` / ``skill``
  // keep their bytes in the artifact, so they still require it.
  if (typeof kind === 'string' && KINDS_REQUIRING_ARTIFACT.has(kind as RegistryAssetKind)) {
    const hasArtifact = typeof input.artifact_b64 === 'string' && input.artifact_b64.length > 0;
    const hasInlineContent = hasInlineDescriptorContent(kind as RegistryAssetKind, input.descriptor);
    if (!hasArtifact && !hasInlineContent) {
      v.push({
        field: 'artifact_b64',
        message: `artifact_b64 is required for kind ${kind} (or provide inline content in the descriptor)`,
      });
    }
  }

  return v;
}

/**
 * True when the descriptor carries the loadable content inline, making a
 * separate artifact unnecessary. Today only ``mcp_server`` supports this — via
 * a ``server_config`` object the agent loader writes straight into ``.mcp.json``.
 */
function hasInlineDescriptorContent(kind: RegistryAssetKind, descriptor: unknown): boolean {
  if (kind !== 'mcp_server') {
    return false;
  }
  if (typeof descriptor !== 'object' || descriptor === null) {
    return false;
  }
  const cfg = (descriptor as Record<string, unknown>).server_config;
  return typeof cfg === 'object' && cfg !== null;
}

/** Per-kind descriptor required-field checks (REGISTRY.md §3.3). */
function validateKindDescriptor(
  kind: RegistryAssetKind,
  desc: Record<string, unknown>,
): DescriptorViolation[] {
  const v: DescriptorViolation[] = [];
  switch (kind) {
    case 'mcp_server':
      if (desc.transport !== 'http' && desc.transport !== 'stdio') {
        v.push({ field: 'descriptor.transport', message: "mcp_server transport must be 'http' or 'stdio'" });
      }
      if (typeof desc.tool_prefix !== 'string' || desc.tool_prefix.length === 0) {
        v.push({ field: 'descriptor.tool_prefix', message: 'mcp_server descriptor requires tool_prefix' });
      }
      break;
    case 'cedar_policy_module':
      if (!Array.isArray(desc.cedar_actions)) {
        v.push({ field: 'descriptor.cedar_actions', message: 'cedar_policy_module descriptor requires cedar_actions array' });
      }
      break;
    case 'skill':
      if (!Array.isArray(desc.tool_hints)) {
        v.push({ field: 'descriptor.tool_hints', message: 'skill descriptor requires tool_hints array' });
      }
      break;
    default:
      break;
  }
  return v;
}

/** Build the ``{kind}#{namespace}/{name}`` partition key. */
export function publishPk(kind: string, namespace: string, name: string): string {
  return `${kind}#${namespace}/${name}`;
}

/** Build the S3 artifact key ``{kind}/{namespace}/{name}/{version}/artifact``. */
export function artifactKey(kind: string, namespace: string, name: string, version: string): string {
  return `${kind}/${namespace}/${name}/${version}/artifact`;
}

/** Narrow a validated descriptor to the typed shape. */
export function asDescriptor(d: unknown): RegistryDescriptor {
  return d as RegistryDescriptor;
}
