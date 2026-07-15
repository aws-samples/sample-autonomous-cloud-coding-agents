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

import { Annotations, Token } from 'aws-cdk-lib';
import { Construct, Node } from 'constructs';

/**
 * AgentCore-supported physical **Availability Zone IDs** per region.
 *
 * AgentCore Runtime (and the built-in Code Interpreter / Browser tools) only
 * places its elastic network interfaces in a subset of each region's zones. If
 * the VPC subnets land in an unsupported zone the
 * `AWS::BedrockAgentCore::Runtime` resource fails to stabilize
 * (`NotStabilized` — "subnets are in unsupported availability zones") and rolls
 * back the whole stack.
 *
 * The constraint is published in terms of **zone IDs** (e.g. `use1-az1`), which
 * are stable across accounts, NOT zone *names* (e.g. `us-east-1a`) which are
 * aliased per-account. Keep this map aligned with the AWS documentation:
 * https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/security/agentcore-vpc/#supported-availability-zones
 *
 * A region absent from this map is treated as "no known constraint" — the
 * auto-pin logic leaves AZ selection to CDK's default and operators can still
 * pin explicitly via the {@link AGENTCORE_AZS_CONTEXT_KEY} context override.
 */
export const AGENTCORE_SUPPORTED_AZ_IDS: Readonly<Record<string, readonly string[]>> = {
  'us-east-1': ['use1-az1', 'use1-az2', 'use1-az4'],
  'us-east-2': ['use2-az1', 'use2-az2', 'use2-az3'],
  'us-west-2': ['usw2-az1', 'usw2-az2', 'usw2-az3'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2', 'apse1-az3'],
  'ap-southeast-2': ['apse2-az1', 'apse2-az2', 'apse2-az3'],
  'ap-south-1': ['aps1-az1', 'aps1-az2', 'aps1-az3'],
  'ap-northeast-1': ['apne1-az1', 'apne1-az2', 'apne1-az4'],
  'eu-west-1': ['euw1-az1', 'euw1-az2', 'euw1-az3'],
  'eu-central-1': ['euc1-az1', 'euc1-az2', 'euc1-az3'],
};

/**
 * CDK context key whose value (a JSON array of AZ **names**, e.g.
 * `["us-east-1b", "us-east-1c"]`) overrides the auto-selected zones. Set it in
 * `cdk.context.json`, `cdk.json` `context`, or via
 * `-c 'agentcore:availabilityZones=["us-east-1b","us-east-1c"]'`.
 */
export const AGENTCORE_AZS_CONTEXT_KEY = 'agentcore:availabilityZones';

/** Minimum AZ count — AgentCore high-availability guidance is >=2 zones. */
const MIN_AGENTCORE_AZS = 2;

/** A single Availability Zone's name and its stable physical zone ID. */
export interface AvailabilityZoneInfo {
  /** Account-aliased zone name, e.g. `us-east-1a`. */
  readonly zoneName: string;
  /** Stable physical zone ID, e.g. `use1-az1`. */
  readonly zoneId: string;
}

/** Signature for the injectable `DescribeAvailabilityZones` lookup. */
export type DescribeAzsFn = (region: string) => Promise<AvailabilityZoneInfo[]>;

/** Options for {@link resolveAgentCoreAzs}. */
export interface ResolveAgentCoreAzsOptions {
  /** Scope used to read context and surface synth-time warnings (the `App`). */
  readonly scope: Construct;
  /** Target account (from `CDK_DEFAULT_ACCOUNT`); undefined/token = env-agnostic. */
  readonly account?: string;
  /** Target region (from `CDK_DEFAULT_REGION`); undefined/token = env-agnostic. */
  readonly region?: string;
  /**
   * Availability-zone lookup. Defaults to a live EC2
   * `DescribeAvailabilityZones` call; injectable so tests need no AWS access.
   */
  readonly describeAzs?: DescribeAzsFn;
}

/**
 * Validates and returns the optional {@link AGENTCORE_AZS_CONTEXT_KEY} override.
 *
 * Mirrors the loud-fail contract of `resolveBedrockModelIds` (bedrock-models.ts):
 * a malformed override fails synth with a clear message naming the key and the
 * expected JSON shape, rather than silently pinning nothing.
 *
 * @returns the validated AZ-name array, or `undefined` when the key is unset.
 * @throws if the value is not a JSON array, contains a non-string/empty entry,
 *   or lists fewer than {@link MIN_AGENTCORE_AZS} zones.
 */
export function resolveAgentCoreAzOverride(node: Node): string[] | undefined {
  const raw = node.tryGetContext(AGENTCORE_AZS_CONTEXT_KEY);
  if (raw === undefined || raw === null) {
    return undefined;
  }
  // `cdk.context.json` delivers a real array, but `-c key=value` on the CLI
  // (the recovery path this feature exists for) delivers a raw string. Parse the
  // string form so both behave identically. A non-JSON string — a true typo —
  // is left as-is and fails the Array.isArray check below with the same clear,
  // key-named error.
  let override: unknown = raw;
  if (typeof raw === 'string') {
    try {
      override = JSON.parse(raw);
    } catch {
      override = raw;
    }
  }
  if (!Array.isArray(override)) {
    throw new Error(
      `Context '${AGENTCORE_AZS_CONTEXT_KEY}' must be a JSON array of availability-zone names `
      + `(e.g. ["us-east-1b", "us-east-1c"]); got ${JSON.stringify(override)}.`,
    );
  }
  for (const az of override) {
    if (typeof az !== 'string' || az.trim().length === 0) {
      throw new Error(
        `Context '${AGENTCORE_AZS_CONTEXT_KEY}' entries must be non-empty availability-zone-name `
        + `strings; got ${JSON.stringify(az)}.`,
      );
    }
  }
  if (override.length < MIN_AGENTCORE_AZS) {
    throw new Error(
      `Context '${AGENTCORE_AZS_CONTEXT_KEY}' must list at least ${MIN_AGENTCORE_AZS} zones for `
      + `AgentCore high availability; got ${JSON.stringify(override)}.`,
    );
  }
  return override as string[];
}

/**
 * Pure selection: given the account's AZ (name, id) pairs, returns the zone
 * *names* whose physical zone IDs are AgentCore-supported for `region`.
 *
 * Returns an empty array when the region has no known constraint (absent from
 * {@link AGENTCORE_SUPPORTED_AZ_IDS}) or none of the account's zones match.
 */
export function selectSupportedAzNames(region: string, zones: readonly AvailabilityZoneInfo[]): string[] {
  const supported = AGENTCORE_SUPPORTED_AZ_IDS[region];
  if (!supported) {
    return [];
  }
  const supportedIds = new Set(supported);
  return zones.filter(zone => supportedIds.has(zone.zoneId)).map(zone => zone.zoneName);
}

/**
 * Live `DescribeAvailabilityZones` lookup (default {@link DescribeAzsFn}).
 *
 * The `@aws-sdk/client-ec2` module is imported dynamically so it is only loaded
 * when auto-pin actually runs (concrete env, no override) — not during
 * env-agnostic synth or in unit tests, which inject their own lookup.
 */
async function defaultDescribeAzs(region: string): Promise<AvailabilityZoneInfo[]> {
  const { EC2Client, DescribeAvailabilityZonesCommand } = await import('@aws-sdk/client-ec2');
  const client = new EC2Client({ region });
  const response = await client.send(
    new DescribeAvailabilityZonesCommand({
      // Standard AZs only — exclude Local Zones / Wavelength / Outposts.
      Filters: [{ Name: 'zone-type', Values: ['availability-zone'] }],
    }),
  );
  const zones: AvailabilityZoneInfo[] = [];
  for (const zone of response.AvailabilityZones ?? []) {
    if (zone.ZoneName && zone.ZoneId) {
      zones.push({ zoneName: zone.ZoneName, zoneId: zone.ZoneId });
    }
  }
  return zones;
}

/**
 * Resolves the Availability-Zone *names* the AgentCore VPC should pin to.
 *
 * Resolution order:
 *  1. **Operator override** — a validated {@link AGENTCORE_AZS_CONTEXT_KEY}
 *     context value always wins (works even in env-agnostic synth, which is how
 *     the CI-built artifact and production stack pin zones).
 *  2. **Auto-pin (default path)** — when synth has a concrete account + region,
 *     resolve the account's name -> zone-ID mapping, intersect it with
 *     {@link AGENTCORE_SUPPORTED_AZ_IDS} for the region, and pin the first
 *     {@link MIN_AGENTCORE_AZS} supported zones (matching AgentVpc's default
 *     `maxAzs`), so a fresh local `cdk deploy` lands only in supported zones
 *     without account-specific guesswork or widening the topology.
 *  3. **Fallback** — env-agnostic synth (token/undefined account or region), an
 *     unknown region, a failed lookup, or fewer than {@link MIN_AGENTCORE_AZS}
 *     supported zones all return `undefined`, leaving CDK's default AZ selection
 *     in place. Degraded cases (2 & 3 boundary) surface a synth warning rather
 *     than failing, so unaffected regions and offline synth still deploy.
 *
 * @returns AZ names to pass to `ec2.Vpc({ availabilityZones })`, or `undefined`
 *   to keep the default `maxAzs` selection.
 */
export async function resolveAgentCoreAzs(options: ResolveAgentCoreAzsOptions): Promise<string[] | undefined> {
  const { scope, account, region } = options;

  // 1. Explicit, validated override wins (throws loudly if malformed).
  const override = resolveAgentCoreAzOverride(scope.node);
  if (override) {
    return override;
  }

  // 2. Auto-pin needs a concrete account + region. Env-agnostic synth uses
  //    token placeholders (the CI-built artifact + production stack) — pin via
  //    the override there instead.
  if (!account || !region || Token.isUnresolved(account) || Token.isUnresolved(region)) {
    return undefined;
  }

  // 3. No published constraint for this region — don't guess.
  if (!AGENTCORE_SUPPORTED_AZ_IDS[region]) {
    return undefined;
  }

  const describeAzs = options.describeAzs ?? defaultDescribeAzs;

  // The return sits outside the try/catch so a failed lookup degrades to the
  // default AZ selection (surfaced as a warning) instead of masking the error
  // with an empty result inside the catch (ts-silent-success-masking / AI004).
  let pinnedZones: string[] | undefined;
  try {
    const zones = await describeAzs(region);
    const names = selectSupportedAzNames(region, zones);
    if (names.length >= MIN_AGENTCORE_AZS) {
      // Pin exactly MIN_AGENTCORE_AZS zones — the HA floor, matching AgentVpc's
      // default `maxAzs` (2). Pinning every supported zone would silently widen
      // an account that deploys fine today from 2 AZs to all supported (often 3
      // -> 6 subnets), so cap the selection to keep the topology stable.
      pinnedZones = names.slice(0, MIN_AGENTCORE_AZS);
    } else {
      Annotations.of(scope).addWarning(
        `[AgentCore AZs] Found only ${names.length} AgentCore-supported availability zone(s) in `
        + `${region} (need >=${MIN_AGENTCORE_AZS}); using CDK's default AZ selection. Pin zones `
        + `explicitly via context '${AGENTCORE_AZS_CONTEXT_KEY}' if the deploy hits unsupported zones.`,
      );
    }
  } catch (err) {
    Annotations.of(scope).addWarning(
      `[AgentCore AZs] Could not resolve AgentCore-supported availability zones for ${region} `
      + `(${err instanceof Error ? err.message : String(err)}); using CDK's default AZ selection. `
      + `Pin zones explicitly via context '${AGENTCORE_AZS_CONTEXT_KEY}' if the deploy hits unsupported zones.`,
    );
  }
  return pinnedZones;
}
