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
 * Registry asset resolver (#246). Turns a ``registry://kind/namespace/name@constraint``
 * reference into a concrete pinned {@link ResolvedAsset} by querying the
 * ``RegistryAssetsTable`` and applying semver + status rules.
 *
 * This is the TypeScript half of the two-language ``RegistryClient`` seam
 * (ADR-018 sub-decision 8): {@link parseRef}'s grammar MUST agree byte-for-byte
 * with the Python ``_REGISTRY_REF`` (agent/src/workflow/validator.py), and the
 * ``contracts/registry-resolution/`` corpus is the agreement both reproduce.
 *
 * See docs/design/REGISTRY.md §5 (resolution semantics) and §6 (grammar).
 */

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import * as semver from 'semver';
import { logger } from './logger';
// Grammar (parseRef/isRegistryRef/assetPk/RegistryResolutionError) lives in the
// dependency-free registry-ref.ts so the CDK construct layer can validate refs
// at synth without pulling aws-sdk into the graph. Re-exported below so existing
// importers of this module keep working.
import { assetPk, parseRef, RegistryResolutionError } from './registry-ref';
import type {
  RegistryAssetRecord,
  RegistryAssetStatus,
  ResolvedAsset,
  ResolvedAssetBundle,
} from './types';

export { assetPk, isRegistryRef, parseRef, RegistryResolutionError } from './registry-ref';
export type { RegistryResolutionReason } from './registry-ref';

/**
 * Translate an allowed constraint (exact / caret / tilde) into a
 * ``semver``-compatible range string. Anything the grammar somehow let through
 * that ``semver`` cannot parse is surfaced as ``INVALID_CONSTRAINT`` rather than
 * silently matching nothing.
 */
function toSemverRange(constraint: string, ref: string): string {
  // The grammar already restricts to exact / ^ / ~; semver accepts all three
  // as-is. validRange guards against a future grammar loosening slipping a
  // form through that would resolve to an unexpected range.
  if (semver.validRange(constraint, { loose: false }) === null) {
    throw new RegistryResolutionError('INVALID_CONSTRAINT', ref, constraint);
  }
  return constraint;
}

/** Injectable DDB client so tests can supply a mock (default: real client). */
export interface RegistryQueryClient {
  send(command: QueryCommand): Promise<{ Items?: Record<string, unknown>[] }>;
}

let defaultClient: RegistryQueryClient | undefined;
function getDefaultClient(): RegistryQueryClient {
  if (!defaultClient) {
    defaultClient = DynamoDBDocumentClient.from(new DynamoDBClient({})) as unknown as RegistryQueryClient;
  }
  return defaultClient;
}

/**
 * Resolve a single ``registry://`` ref against the catalog.
 *
 * 1. Parse the ref (grammar; may throw ``INVALID_REGISTRY_REF``).
 * 2. Query every version under the asset's partition.
 * 3. Rank candidates by parsed semver (descending); pick the highest whose
 *    version satisfies the constraint AND whose status is resolvable.
 * 4. Apply status rules (REGISTRY.md §5): ``approved`` resolves silently,
 *    ``deprecated`` resolves with a ``DEPRECATED`` warning, others are not
 *    candidates; if the single highest match is ``removed`` → ``REMOVED``.
 *
 * @throws {@link RegistryResolutionError} on any unresolved ref (fail-closed).
 */
export async function resolveRef(
  ref: string,
  opts?: { client?: RegistryQueryClient; tableName?: string },
): Promise<ResolvedAsset> {
  const parsed = parseRef(ref);
  const range = toSemverRange(parsed.constraint, ref);
  const client = opts?.client ?? getDefaultClient();
  const tableName = opts?.tableName ?? process.env.REGISTRY_ASSETS_TABLE_NAME;
  if (!tableName) {
    throw new RegistryResolutionError(
      'NO_MATCHING_VERSION',
      ref,
      'REGISTRY_ASSETS_TABLE_NAME not configured',
    );
  }

  const pk = assetPk(parsed.kind, parsed.namespace, parsed.name);
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
    }),
  );
  const rows = (result.Items ?? []) as unknown as RegistryAssetRecord[];

  // Candidates whose version satisfies the constraint AND is a valid semver.
  // DynamoDB returns rows sorted lexicographically by the version sort key,
  // which is WRONG for semver (1.10.0 < 1.9.0 as strings) — so we always rank
  // in code (REGISTRY.md §3.2).
  const matching = rows
    .filter((r) => semver.valid(r.version) !== null && semver.satisfies(r.version, range, { includePrerelease: false }))
    .sort((a, b) => semver.rcompare(a.version, b.version));

  if (matching.length === 0) {
    throw new RegistryResolutionError('NO_MATCHING_VERSION', ref);
  }

  // Highest matching version — but its status decides whether it resolves.
  const top = matching[0];
  const warnings = statusWarnings(top.status, ref, top.version);

  logger.info('registry ref resolved', {
    ref,
    resolved_version: top.version,
    status: top.status,
    warnings,
  });

  return {
    kind: top.kind,
    namespace: top.namespace,
    name: top.name,
    version: top.version,
    descriptor: top.descriptor,
    // artifact_url is attached by the resolve handler (presign); the library
    // returns descriptor-level data only.
    warnings,
  };
}

/**
 * Apply the status rules to the winning candidate. Returns the warnings list
 * for resolvable statuses; throws for non-resolvable ones. ``removed`` is a
 * distinct reason so operators can tell a tombstoned pin from one that never
 * existed (REGISTRY.md §5).
 */
function statusWarnings(status: RegistryAssetStatus, ref: string, version: string): string[] {
  switch (status) {
    case 'approved':
      return [];
    case 'deprecated':
      return ['DEPRECATED'];
    case 'removed':
      throw new RegistryResolutionError('REMOVED', ref, `version ${version} is removed`);
    case 'submitted':
    case 'draft':
    case 'rejected':
      // The highest semver match is not in a resolvable state and no lower
      // approved version was selected — treat as no usable match.
      throw new RegistryResolutionError('NO_MATCHING_VERSION', ref, `highest match ${version} is ${status}`);
  }
}

/**
 * Resolve many refs in parallel into a {@link ResolvedAssetBundle} grouped by
 * kind. Any single unresolved ref rejects the whole call (fail-closed) — a task
 * with a bad pin must not partially resolve.
 */
export async function resolveAll(
  refs: readonly string[],
  opts?: { client?: RegistryQueryClient; tableName?: string },
): Promise<ResolvedAssetBundle> {
  // A task declares a handful of asset refs (bounded by blueprint authoring),
  // so unbounded parallelism here is acceptable — this is not driven by
  // unbounded external input.
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  const resolved = await Promise.all(refs.map((ref) => resolveRef(ref, opts)));

  const bundle: {
    mcp_servers: ResolvedAsset[];
    cedar_policy_modules: ResolvedAsset[];
    skills: ResolvedAsset[];
  } = { mcp_servers: [], cedar_policy_modules: [], skills: [] };

  for (const asset of resolved) {
    switch (asset.kind) {
      case 'mcp_server':
        bundle.mcp_servers.push(asset);
        break;
      case 'cedar_policy_module':
        bundle.cedar_policy_modules.push(asset);
        break;
      case 'skill':
        bundle.skills.push(asset);
        break;
      default:
        // Reserved kinds are declared in the grammar but have no loader yet
        // (REGISTRY.md §2); refusing here keeps the fail-closed guarantee
        // rather than silently dropping a resolved-but-unloadable asset.
        throw new RegistryResolutionError(
          'INVALID_REGISTRY_REF',
          `registry://${asset.kind}/${asset.namespace}/${asset.name}`,
          `kind ${asset.kind} has no loader in MVP`,
        );
    }
  }

  return bundle;
}
