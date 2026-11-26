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
import { makeClient } from '../handlers/shared/ua';

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
 * aliased per-account. Note `ca-central-1` and `us-east-1` / `ap-northeast-1`
 * skip `-az3`: the sets are not uniformly `az1..az3`, so they cannot be derived.
 *
 * Source: "Supported Availability Zones" in the Amazon Bedrock AgentCore
 * developer guide —
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-supported-azs
 */
export const AGENTCORE_SUPPORTED_AZ_IDS: Readonly<Record<string, readonly string[]>> = {
  'us-east-1': ['use1-az1', 'use1-az2', 'use1-az4'],
  'us-east-2': ['use2-az1', 'use2-az2', 'use2-az3'],
  'us-west-2': ['usw2-az1', 'usw2-az2', 'usw2-az3'],
  'ca-central-1': ['cac1-az1', 'cac1-az2', 'cac1-az4'],
  'sa-east-1': ['sae1-az1', 'sae1-az2', 'sae1-az3'],
  'eu-west-1': ['euw1-az1', 'euw1-az2', 'euw1-az3'],
  'eu-west-2': ['euw2-az1', 'euw2-az2', 'euw2-az3'],
  'eu-west-3': ['euw3-az1', 'euw3-az2', 'euw3-az3'],
  'eu-central-1': ['euc1-az1', 'euc1-az2', 'euc1-az3'],
  'eu-north-1': ['eun1-az1', 'eun1-az2', 'eun1-az3'],
  'eu-south-1': ['eus1-az1', 'eus1-az2', 'eus1-az3'],
  'eu-south-2': ['eus2-az1', 'eus2-az2', 'eus2-az3'],
  'ap-south-1': ['aps1-az1', 'aps1-az2', 'aps1-az3'],
  'ap-northeast-1': ['apne1-az1', 'apne1-az2', 'apne1-az4'],
  'ap-northeast-2': ['apne2-az1', 'apne2-az2', 'apne2-az3'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2', 'apse1-az3'],
  'ap-southeast-2': ['apse2-az1', 'apse2-az2', 'apse2-az3'],
  'ap-southeast-5': ['apse5-az1', 'apse5-az2', 'apse5-az3'],
  'ap-southeast-7': ['apse7-az1', 'apse7-az2', 'apse7-az3'],
  'us-gov-west-1': ['usgw1-az1', 'usgw1-az2', 'usgw1-az3'],
};

/**
 * Date {@link AGENTCORE_SUPPORTED_AZ_IDS} was last reconciled with the AWS
 * source table.
 */
export const AGENTCORE_SUPPORTED_AZ_IDS_SNAPSHOT_DATE = '2026-08-11';

/**
 * CDK context key whose value (a JSON array of AZ **names**, e.g.
 * `["us-east-1b", "us-east-1c"]`) overrides the auto-selected zones.
 */
export const AGENTCORE_AZS_CONTEXT_KEY = 'agentcore:availabilityZones';

/**
 * High-availability floor: AgentCore guidance is "at least two private subnets
 * in different Availability Zones".
 */
export const MIN_AGENTCORE_AZS = 2;

/**
 * How many zones auto-pin selects when more are supported.
 */
export const AUTO_PIN_AZ_COUNT = 2;

const ZONE_ID_SHAPE = /^[a-z]+[0-9]+-az[0-9]+$/;

const LOOKUP_TIMEOUT_MS = 5_000;

const LOOKUP_MAX_ATTEMPTS = 2;

export interface AvailabilityZoneInfo {
  /** Account-aliased zone name, e.g. `us-east-1a`. */
  readonly zoneName: string;
  /** Stable physical zone ID, e.g. `use1-az1`. */
  readonly zoneId: string;
}

export type DescribeAzsFn = (region: string) => Promise<AvailabilityZoneInfo[]>;

export type ResolveCallerAccountFn = (region: string) => Promise<string | undefined>;

export type AgentCoreAzDiagnosticLevel = 'error' | 'warning';

/**
 * A synth-time finding produced while resolving AZs.
 *
 * Returned to the caller rather than annotated in place: the resolver runs
 * before the stack exists, and CDK only collects annotations that hang off a
 * **stack**'s construct tree (App-node metadata reaches no stack artifact and
 * is silently dropped). {@link applyAgentCoreAzDiagnostics} attaches these once
 * the stack is constructed.
 */
export interface AgentCoreAzDiagnostic {
  readonly level: AgentCoreAzDiagnosticLevel;
  readonly message: string;
}

export interface AgentCoreAzResolution {
  /**
   * AZ names to pass to `ec2.Vpc({ availabilityZones })`, or `undefined` to keep
   * CDK's default `maxAzs` selection.
   */
  readonly zones?: string[];
  /** Findings to surface on the stack — see {@link applyAgentCoreAzDiagnostics}. */
  readonly diagnostics: readonly AgentCoreAzDiagnostic[];
}

export interface ResolveAgentCoreAzsOptions {
  /** Node used to read CDK context (the `App`'s node). */
  readonly node: Node;
  /** Target account (from `CDK_DEFAULT_ACCOUNT`); absent = env-agnostic synth. */
  readonly account?: string;
  /** Target region (from `CDK_DEFAULT_REGION`); absent = env-agnostic synth. */
  readonly region?: string;
  /**
   * Availability-zone lookup. Defaults to a live EC2
   * `DescribeAvailabilityZones` call; injectable so tests need no AWS access.
   */
  readonly describeAzs?: DescribeAzsFn;
  /**
   * Caller-account lookup used to confirm the ambient credentials point at the
   * account being deployed to. Defaults to `sts:GetCallerIdentity`.
   */
  readonly resolveCallerAccount?: ResolveCallerAccountFn;
}

/**
 * Attaches {@link AgentCoreAzResolution.diagnostics} to a construct inside the
 * **stack** being synthesized.
 *
 * `error`-level diagnostics fail synth.
 */
export function applyAgentCoreAzDiagnostics(scope: Construct, resolution: AgentCoreAzResolution): void {
  const annotations = Annotations.of(scope);
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.level === 'error') {
      annotations.addError(diagnostic.message);
    } else {
      annotations.addWarning(diagnostic.message);
    }
  }
}

const DIAG = '[AgentCore AZs]';

const OVERRIDE_HINT = `Pin zones explicitly via CDK context '${AGENTCORE_AZS_CONTEXT_KEY}' `
  + '(see docs/guides/DEPLOYMENT_GUIDE.md — "AgentCore unsupported Availability Zones").';

/**
 * Validates and returns the optional {@link AGENTCORE_AZS_CONTEXT_KEY} override.
 *
 * Shape and content rules, all of which fail synth:
 *  - must be a JSON array (the `-c key=value` string form is parsed first);
 *  - entries must be non-empty strings;
 *  - at least {@link MIN_AGENTCORE_AZS} **distinct** entries;
 *  - entries must be zone *names*, not zone *IDs* (e.g. `use1-az2`);
 *  - when `region` is known, entries must be prefixed by it.
 *
 * @param node - node to read context from.
 * @param region - target region when known, enabling the prefix check.
 * @returns the validated AZ-name array, or `undefined` when the key is unset.
 */
export function resolveAgentCoreAzOverride(node: Node, region?: string): string[] | undefined {
  const raw = node.tryGetContext(AGENTCORE_AZS_CONTEXT_KEY);
  if (raw === undefined || raw === null) {
    return undefined;
  }
  // The CDK CLI's `-c key=value` delivers a raw string where `cdk.json` delivers an array.
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
    if (ZONE_ID_SHAPE.test(az)) {
      throw new Error(
        `Context '${AGENTCORE_AZS_CONTEXT_KEY}' entry ${JSON.stringify(az)} is a zone *ID*, not a `
        + 'zone *name*. AgentCore publishes its constraint as zone IDs, but a VPC is built from '
        + 'zone names, which are aliased per-account. Map the ID to the name for your account: '
        + "aws ec2 describe-availability-zones --region <region> --query 'AvailabilityZones[].[ZoneName,ZoneId]' "
        + '--output text — then pass the ZoneName (column 1).',
      );
    }
    if (region && !az.startsWith(region)) {
      throw new Error(
        `Context '${AGENTCORE_AZS_CONTEXT_KEY}' entry ${JSON.stringify(az)} is not in the target `
        + `region ${region}; availability-zone names are region-prefixed (e.g. ${region}a).`,
      );
    }
  }
  const distinct = new Set(override as string[]);
  if (distinct.size < MIN_AGENTCORE_AZS) {
    throw new Error(
      `Context '${AGENTCORE_AZS_CONTEXT_KEY}' must list at least ${MIN_AGENTCORE_AZS} distinct zones `
      + `for AgentCore high availability; got ${JSON.stringify(override)}.`,
    );
  }
  return override as string[];
}

/**
 * Pure selection: given the account's AZ (name, id) pairs, returns the zone
 * *names* whose physical zone IDs are AgentCore-supported for `region`.
 *
 * Sorted by name: `DescribeAvailabilityZones` does not contract a response
 * order, and `Subnet.AvailabilityZone` is create-only.
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
  return zones
    .filter(zone => supportedIds.has(zone.zoneId))
    .map(zone => zone.zoneName)
    .sort((a, b) => a.localeCompare(b));
}

async function defaultDescribeAzs(region: string): Promise<AvailabilityZoneInfo[]> {
  const { EC2Client, DescribeAvailabilityZonesCommand } = await import('@aws-sdk/client-ec2');
  const client = makeClient(EC2Client, {
    region,
    maxAttempts: LOOKUP_MAX_ATTEMPTS,
    requestHandler: { requestTimeout: LOOKUP_TIMEOUT_MS, connectionTimeout: LOOKUP_TIMEOUT_MS },
  });
  const response = await client.send(
    new DescribeAvailabilityZonesCommand({
      Filters: [
        { Name: 'zone-type', Values: ['availability-zone'] },
        { Name: 'state', Values: ['available'] },
      ],
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
 * The CDK CLI passes only `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` to the
 * app process — not credentials and not `--profile` — so `cdk deploy --profile
 * prod` can leave this process on the default profile's credentials.
 */
async function defaultResolveCallerAccount(region: string): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const client = makeClient(STSClient, {
    region,
    maxAttempts: LOOKUP_MAX_ATTEMPTS,
    requestHandler: { requestTimeout: LOOKUP_TIMEOUT_MS, connectionTimeout: LOOKUP_TIMEOUT_MS },
  });
  const identity = await client.send(new GetCallerIdentityCommand({}));
  return identity.Account;
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { name?: string }).name;
    return code || 'Error';
  }
  return 'unknown error';
}

/**
 * Resolves the Availability-Zone *names* the AgentCore VPC should pin to.
 *
 * Resolution order:
 *  1. **Operator override** — a validated {@link AGENTCORE_AZS_CONTEXT_KEY}
 *     context value always wins, and is the only mechanism available to an
 *     env-agnostic assembly. When a bound account makes the mapping knowable,
 *     the override is additionally cross-checked against
 *     {@link AGENTCORE_SUPPORTED_AZ_IDS} and any mismatch is an error.
 *  2. **Auto-pin (default path)** — with a concrete account + region, confirm
 *     the ambient credentials match that account, resolve its name -> zone-ID
 *     mapping, intersect with the supported set, and pin
 *     {@link AUTO_PIN_AZ_COUNT} zones.
 *  3. **Unpinned** — env-agnostic synth or an unlisted region yields no pin and
 *     a warning, leaving CDK's default AZ selection. A *failure* to complete an
 *     attempted auto-pin yields no pin and an **error**, so it cannot pass
 *     silently.
 */
export async function resolveAgentCoreAzs(options: ResolveAgentCoreAzsOptions): Promise<AgentCoreAzResolution> {
  const { node, account, region } = options;
  const diagnostics: AgentCoreAzDiagnostic[] = [];

  const envAgnostic = !account || !region || Token.isUnresolved(account) || Token.isUnresolved(region);
  const concreteRegion = envAgnostic ? undefined : region;

  const override = resolveAgentCoreAzOverride(node, concreteRegion);
  if (override) {
    if (concreteRegion && AGENTCORE_SUPPORTED_AZ_IDS[concreteRegion]) {
      diagnostics.push(...await verifyOverride(options, concreteRegion, override));
    }
    return { zones: override, diagnostics };
  }

  if (envAgnostic) {
    diagnostics.push({
      level: 'warning',
      message: `${DIAG} Synthesizing without a bound account/region, so AgentCore-supported zones `
        + 'cannot be auto-selected; CDK\'s default AZ selection is used and may land the Runtime ENIs '
        + `in an unsupported zone. ${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }

  if (!AGENTCORE_SUPPORTED_AZ_IDS[region!]) {
    diagnostics.push({
      level: 'warning',
      message: `${DIAG} No supported-zone data for region ${region} (map snapshot `
        + `${AGENTCORE_SUPPORTED_AZ_IDS_SNAPSHOT_DATE}); using CDK's default AZ selection. If AgentCore `
        + `now supports ${region}, add it to AGENTCORE_SUPPORTED_AZ_IDS in `
        + `cdk/src/constructs/agentcore-azs.ts. ${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }

  return autoPin(options, region!, diagnostics);
}

async function verifyOverride(
  options: ResolveAgentCoreAzsOptions,
  region: string,
  override: readonly string[],
): Promise<AgentCoreAzDiagnostic[]> {
  const diagnostics: AgentCoreAzDiagnostic[] = [];
  const describeAzs = options.describeAzs ?? defaultDescribeAzs;
  let zones: AvailabilityZoneInfo[] | undefined;
  try {
    zones = await describeAzs(region);
  } catch (err) {
    diagnostics.push({
      level: 'warning',
      message: `${DIAG} Could not verify the '${AGENTCORE_AZS_CONTEXT_KEY}' override against `
        + `${region}'s zone mapping (${errorLabel(err)}); using it as given.`,
    });
  }
  if (!zones) {
    return diagnostics;
  }
  const idByName = new Map(zones.map(zone => [zone.zoneName, zone.zoneId]));
  const supported = new Set(AGENTCORE_SUPPORTED_AZ_IDS[region]);
  const unknown = override.filter(name => !idByName.has(name));
  const unsupported = override.filter(name => {
    const id = idByName.get(name);
    return id !== undefined && !supported.has(id);
  });
  if (unknown.length > 0) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} '${AGENTCORE_AZS_CONTEXT_KEY}' lists zone(s) that do not exist in ${region}: `
        + `${unknown.join(', ')}.`,
    });
  }
  if (unsupported.length > 0) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} '${AGENTCORE_AZS_CONTEXT_KEY}' lists zone(s) whose physical zone IDs are not `
        + `AgentCore-supported in ${region}: `
        + `${unsupported.map(name => `${name} (${idByName.get(name)})`).join(', ')}. Supported IDs: `
        + `${AGENTCORE_SUPPORTED_AZ_IDS[region].join(', ')}.`,
    });
  }
  return diagnostics;
}

async function autoPin(
  options: ResolveAgentCoreAzsOptions,
  region: string,
  diagnostics: AgentCoreAzDiagnostic[],
): Promise<AgentCoreAzResolution> {
  const describeAzs = options.describeAzs ?? defaultDescribeAzs;
  const resolveCallerAccount = options.resolveCallerAccount ?? defaultResolveCallerAccount;

  let callerAccount: string | undefined;
  try {
    callerAccount = await resolveCallerAccount(region);
  } catch (err) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} Could not confirm which account the synth credentials belong to `
        + `(${errorLabel(err)}), so AgentCore-supported zones cannot be verified for ${region}. `
        + `${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }
  if (callerAccount && callerAccount !== options.account) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} Synth credentials resolve to account ${callerAccount} but the stack targets `
        + `${options.account}. Availability-zone names are aliased per-account, so the zone mapping `
        + 'from the wrong account would pin physically unsupported zones. Export the matching profile '
        + `(e.g. AWS_PROFILE) so the app process and the CDK CLI agree. ${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }

  let zones: AvailabilityZoneInfo[];
  try {
    zones = await describeAzs(region);
  } catch (err) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} Could not resolve AgentCore-supported availability zones for ${region} `
        + `(${errorLabel(err)}). Grant ec2:DescribeAvailabilityZones to the synth credentials, or `
        + `${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }

  const names = selectSupportedAzNames(region, zones);
  if (names.length < MIN_AGENTCORE_AZS) {
    diagnostics.push({
      level: 'error',
      message: `${DIAG} Found only ${names.length} AgentCore-supported availability zone(s) in `
        + `${region} for this account (need >=${MIN_AGENTCORE_AZS}). Supported zone IDs: `
        + `${AGENTCORE_SUPPORTED_AZ_IDS[region].join(', ')}. ${OVERRIDE_HINT}`,
    });
    return { zones: undefined, diagnostics };
  }
  return { zones: names.slice(0, AUTO_PIN_AZ_COUNT), diagnostics };
}
