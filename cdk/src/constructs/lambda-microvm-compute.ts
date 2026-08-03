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

import { Annotations, ArnFormat, Duration, RemovalPolicy, Stack, Tags, Token } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
// Single source of truth for the supported-Region list. ADR-021's
// `microvm-regions.ts` header is explicit that the list "is the ONLY place the
// list is declared — do not copy it", so the synth-time gate IMPORTS it rather
// than duplicating it. The module is a dependency-free pair of pure constants
// (no AWS SDK, no Lambda-runtime code), so pulling it into the CDK app tree
// costs nothing and cannot drift.
import { AgentSessionRole } from './agent-session-role';
import { LAMBDA_MICROVM_SUPPORTED_REGIONS, isLambdaMicrovmRegionSupported } from '../handlers/shared/microvm-regions';

/**
 * Lifecycle expiry for MicroVM `/run` hook payloads, in days.
 *
 * Mirrors {@link ECS_PAYLOAD_TTL_DAYS} in shape but NOT in role: on ECS the
 * orchestrator deletes the payload at finalize and the rule is only a crash
 * backstop, whereas the MicroVM strategy never deletes (ADR-021 sub-decision 3
 * / `microvmPayloadKey`) — so on this backend the lifecycle rule is the ONLY
 * reaper. Payloads carry the hydrated prompt context, so the TTL stays as tight
 * as the read-once-at-`/run` access pattern allows.
 */
export const MICROVM_PAYLOAD_TTL_DAYS = 1;

/**
 * Cost-allocation tag applied to every resource this construct creates
 * (ADR-021 sub-decision 4, "Cost attribution").
 *
 * The stack-level `compute_type` tag in `main.ts` carries a single value and is
 * already imprecise with two backends; these per-resource tags make MicroVM
 * spend attributable regardless of what the stack-level tag says.
 */
export const MICROVM_BACKEND_TAG_KEY = 'abca:compute-backend';

/** Tag value identifying the Lambda MicroVMs backend. */
export const MICROVM_BACKEND_TAG_VALUE = 'lambda-microvm';

/**
 * CloudWatch Logs namespace Lambda MicroVMs writes build- and run-time logs
 * under. Both the build role and the execution role are scoped to this prefix.
 */
export const MICROVM_LOG_GROUP_PREFIX = '/aws/lambda-microvms';

/**
 * Default S3 key the packaging helper (`cdk/scripts/package-microvm-artifact.sh`)
 * uploads the zip + Dockerfile artifact to, inside the artifact bucket this
 * construct creates. Kept in one place so the script, the `CfnMicrovmImage`
 * `codeArtifact.uri`, and the build role's `s3:GetObject` scope cannot drift.
 */
export const MICROVM_ARTIFACT_OBJECT_KEY = 'microvm-images/agent-artifact.zip';

/**
 * TCP port the agent's FastAPI server listens on inside the snapshot
 * (`agent/Dockerfile` → `EXPOSE 8080`), and therefore the port the MicroVM
 * lifecycle-hook listener is configured for.
 */
const AGENT_HOOK_PORT = 8080;

/**
 * `/run` hook path, as SERVED by `agent/src/server.py`.
 *
 * Load-bearing in P1: it is how the task payload reaches the agent
 * (`runHookPayload`, ADR-021 sub-decision 3) — there is no other
 * orchestrator→agent channel on this backend.
 *
 * The value is the service's fixed lifecycle-hook route, not a path of our
 * choosing. Live verification (2026-07-31, issue #645) found that the
 * `CreateMicrovmImage` **API** model has no hook-path field at all — it takes
 * only `ENABLED`/`DISABLED` plus a timeout — while the generated
 * CloudFormation type still types these as strings. Setting the string to the
 * route the agent actually answers is therefore correct under either reading:
 * if CloudFormation genuinely routes on it, it points at the real endpoint; if
 * it is ignored (as the API model implies), the value is inert. Keep in lockstep
 * with `MICROVM_HOOK_PREFIX` in `agent/src/server.py`.
 */
const RUN_HOOK_PATH = '/aws/lambda-microvms/runtime/v1/run';

/** `/run` hook budget (seconds). The hook only validates + starts the pipeline
 *  asynchronously, so it stays well inside the service's 1–60 s hook window. */
const RUN_HOOK_TIMEOUT_SECONDS = 60;

/**
 * `/ready` build hook path, as SERVED by `agent/src/server.py` (see
 * {@link RUN_HOOK_PATH} for why the string is the real route).
 *
 * **Mandatory, not optional.** `CreateMicrovmImage` rejects an image that
 * enables ANY lifecycle hook without `/ready` (live 2026-07-31):
 *
 * > The ready (/ready) MicroVM image hook must be enabled when any MicroVM
 * > lifecycle hook (run, resume, suspend, or terminate) is enabled. The ready
 * > hook signals when the application has finished initializing so the snapshot
 * > is taken in a ready state.
 *
 * So ADR-021's original "declare `/run` in P1, serve it in P2" plan was not a
 * reachable service state: `/ready` + `/run` now land together in P1.
 */
const READY_HOOK_PATH = '/aws/lambda-microvms/runtime/v1/ready';

/** `/ready` build-hook budget (seconds). The agent answers as soon as uvicorn is
 *  bound, so the snapshot is taken with a warm server. */
const READY_HOOK_TIMEOUT_SECONDS = 60;

/**
 * BASELINE memory sizes (MiB) the service accepts for a MicroVM image.
 *
 * NOT a range and NOT a per-VM ceiling: the service enumerates the allowed
 * baseline values per base image and rejects anything else. Live 2026-07-31
 * against `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`:
 *
 * > The requested memory size of 32768 MiB is not supported by base MicroVM
 * > image …al2023-1. Supported memory sizes in MiB are:
 * > [512, 1024, 2048, 4096, 8192].
 *
 * The service then scales a running MicroVM VERTICALLY on demand, up to a
 * 32 GiB / 16 vCPU peak (developer-guide sizing table) — so 8 GiB is the top of
 * the *configurable baseline*, not the amount of memory a task can use. The
 * boundary probe above establishes what the FIELD accepts; only the guide
 * establishes what the field MEANS (ADR-021's source hierarchy).
 *
 * Kept as an exported constant so {@link LambdaMicrovmComputeProps.minimumMemoryInMiB}
 * can fail at synth with the real list instead of at image-create time. The
 * individually named sizes exist only to keep the list out of `no-magic-numbers`
 * territory — the list itself is the contract.
 */
const MEMORY_512_MIB = 512;
const MEMORY_1_GIB_IN_MIB = 1024;
const MEMORY_2_GIB_IN_MIB = 2048;
const MEMORY_4_GIB_IN_MIB = 4096;
const MEMORY_8_GIB_IN_MIB = 8192;
export const MICROVM_SUPPORTED_MEMORY_MIB: readonly number[] = [
  MEMORY_512_MIB,
  MEMORY_1_GIB_IN_MIB,
  MEMORY_2_GIB_IN_MIB,
  MEMORY_4_GIB_IN_MIB,
  MEMORY_8_GIB_IN_MIB,
];

/**
 * Baseline memory the image declares, in MiB — the largest baseline the service
 * accepts (see {@link MICROVM_SUPPORTED_MEMORY_MIB}).
 *
 * The ABCA agent is a build-heavy workload, so P1 asks for the top of the
 * accepted baseline list rather than a smaller one it would spend the whole task
 * scaling up from. Automatic vertical scaling then supplies burst capacity to a
 * 32 GiB peak; nothing here requests that, and nothing can.
 *
 * This was `32768` until live verification refuted it as a *baseline* value.
 */
export const DEFAULT_MINIMUM_MEMORY_MIB = MEMORY_8_GIB_IN_MIB;

/** Retention for the MicroVM log group — parity with the ECS task log group. */
const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/** HTTPS port — the only egress allowed out of the MicroVM at RUN time. */
const HTTPS_PORT = 443;

/**
 * HTTP port. Allowed on the **build-time** connector only.
 *
 * `agent/Dockerfile` installs Debian packages, and `apt-get` fetches over plain
 * HTTP. With a 443-only egress path every snapshot build failed (live
 * 2026-07-31): `Could not connect to deb.debian.org:80 … E: Unable to locate
 * package curl` → `exit code: 100`. DNS resolved fine — the port was the sole
 * cause. Opening 80 for the build path (and only the build path) made the build
 * succeed immediately; see {@link LambdaMicrovmCompute.buildSecurityGroup}.
 */
const HTTP_PORT = 80;

/** Graviton/ARM64: the agent image is ARM64 on every backend. */
const CPU_ARCHITECTURE = 'arm64';

/**
 * Resource-name half of the Lambda-managed **`NO_INGRESS`** network connector
 * ARN, i.e. everything after `…:aws:network-connector:`.
 *
 * Why this exists at all: `RunMicrovm` does **not** default to "no ingress". A
 * launch that omits `ingressNetworkConnectors` entirely came back (live
 * 2026-07-31) with a service-attached PUBLIC connector and a public endpoint:
 *
 * ```
 * "ingressNetworkConnectors": ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS"]
 * ```
 *
 * ADR-021's "no inbound exposure" posture therefore has to be an **explicit
 * control**, not an omission: the strategy passes the `NO_INGRESS` connector on
 * every `RunMicrovm`. The ARN shape is taken verbatim from that observed
 * `HTTP_INGRESS` ARN, with the connector name swapped.
 */
export const MICROVM_NO_INGRESS_CONNECTOR_RESOURCE = 'aws-network-connector:NO_INGRESS';

/**
 * ARN of the Lambda-managed `NO_INGRESS` connector in {@link scope}'s
 * partition/Region (see {@link MICROVM_NO_INGRESS_CONNECTOR_RESOURCE}).
 *
 * Account segment is the literal `aws` — these connectors are service-owned, not
 * account-owned, exactly like the AWS-managed policy ARNs.
 */
export function microvmNoIngressConnectorArn(scope: Construct): string {
  return Stack.of(scope).formatArn({
    service: 'lambda',
    account: 'aws',
    resource: 'network-connector',
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    resourceName: MICROVM_NO_INGRESS_CONNECTOR_RESOURCE,
  });
}

/**
 * CDK context flag that bypasses the synth-time Region gate.
 *
 * Exists because {@link LAMBDA_MICROVM_SUPPORTED_REGIONS} rots by design: when
 * AWS launches Lambda MicroVMs in a new Region, an operator there must not have
 * to wait for an ABCA release. The live probes (CLI onboarding, `platform
 * doctor`) already accept the new Region, so this flag only unblocks synth.
 */
export const MICROVM_REGION_OVERRIDE_CONTEXT = 'microvm_region_override';

/**
 * Fail synth when the `lambda-microvm` backend is enabled in a Region that is
 * not in the statically documented support list (ADR-021 sub-decision 4,
 * "Regional availability enforcement" — the synth/deploy row).
 *
 * Three behaviours worth knowing:
 *
 *  - **Unresolved (token) Region → check SKIPPED.** A region-agnostic app
 *    (`new Stack(app, 'X')` with no `env`, or `env.region` left to the CLI)
 *    resolves `Stack.region` to the `AWS::Region` pseudo-parameter, whose value
 *    is unknowable at synth. Comparing a token against a Region list would
 *    reject every region-agnostic synth — including `cdk synth` on a developer
 *    box with no `CDK_DEFAULT_REGION` — so the static layer stands down and the
 *    live probes (onboarding / doctor / orchestration classification) carry the
 *    enforcement. This is a deliberate hole in the *static* layer only.
 *  - **Escape hatch.** `--context microvm_region_override=true` skips the check;
 *    the error message names the flag so an operator in a just-launched Region
 *    is never blocked on a code change.
 *  - **Failure is a synth-time throw, not a warning.** ADR-021 requires "synth
 *    fails when ComputeTypes includes lambda-microvm in an unlisted Region"; a
 *    warning would let a broken deploy through to a runtime AccessDenied.
 */
export function assertLambdaMicrovmRegionSupported(scope: Construct): void {
  const region = Stack.of(scope).region;

  if (Token.isUnresolved(region)) {
    // Region-agnostic synth — nothing to compare. See the doc comment above.
    return;
  }
  if (isLambdaMicrovmRegionSupported(region)) {
    return;
  }
  if (scope.node.tryGetContext(MICROVM_REGION_OVERRIDE_CONTEXT)) {
    Annotations.of(scope).addWarningV2(
      'abca:microvm-region-override',
      `The lambda-microvm compute backend is enabled in ${region}, which is not in the ABCA `
      + `supported-Region list (${LAMBDA_MICROVM_SUPPORTED_REGIONS.join(', ')}). Proceeding because `
      + `--context ${MICROVM_REGION_OVERRIDE_CONTEXT} is set. If AWS has launched Lambda MicroVMs in `
      + `${region}, add it to LAMBDA_MICROVM_SUPPORTED_REGIONS (cdk/src/handlers/shared/microvm-regions.ts) `
      + 'and drop the flag.',
    );
    return;
  }

  throw new Error(
    `AWS Lambda MicroVMs are not available in ${region}. The lambda-microvm compute backend is `
    + 'enabled (--context compute_type=lambda-microvm) but the stack Region is not one of: '
    + `${LAMBDA_MICROVM_SUPPORTED_REGIONS.join(', ')}. Either deploy the stack into a supported `
    + 'Region, drop the backend (--context compute_type=agentcore or ecs), or — if AWS has since '
    + `launched Lambda MicroVMs in ${region} — bypass this static check with `
    + `--context ${MICROVM_REGION_OVERRIDE_CONTEXT}=true and add ${region} to `
    + 'LAMBDA_MICROVM_SUPPORTED_REGIONS in cdk/src/handlers/shared/microvm-regions.ts.',
  );
}

/**
 * The four operator-supplied image inputs, read from CDK context by the stack.
 *
 * Extracted into a type so the stack can resolve them ONCE, before `TaskApi` is
 * constructed, and hand the same object to this construct — see
 * {@link isLambdaMicrovmImageConfigured} for why that ordering matters.
 */
export interface LambdaMicrovmImageInputs {
  readonly baseImageArn?: string;
  readonly baseImageVersion?: string;
  readonly externalImageIdentifier?: string;
  readonly externalImageVersion?: string;
}

/**
 * True when {@link inputs} selects one of the two image-provisioning states
 * (managed-base-image build, or an out-of-band image), i.e. the deployment will
 * have a MicroVM image and therefore an `imageArn` to scope IAM against.
 *
 * Exists so the three-state decision documented on {@link LambdaMicrovmCompute}
 * is made in exactly ONE place. `TaskApi` is constructed before this construct
 * (the cancel Lambda's ARN is needed earlier, hence the `Lazy.string` holders in
 * `stacks/agent.ts`), so the stack must know whether an image will exist *before*
 * the construct that creates it runs. Without a shared predicate the stack and
 * the construct would each re-derive that answer and could drift — and a drift
 * here means either a missing cancel grant or a grant scoped to an image that
 * does not exist.
 */
export function isLambdaMicrovmImageConfigured(inputs: LambdaMicrovmImageInputs): boolean {
  return Boolean((inputs.baseImageArn && inputs.baseImageVersion) || inputs.externalImageIdentifier);
}

/**
 * Properties for {@link LambdaMicrovmCompute}.
 */
export interface LambdaMicrovmComputeProps extends LambdaMicrovmImageInputs {
  /**
   * Platform VPC. Egress leaves the MicroVM through a `AWS::Lambda::NetworkConnector`
   * bound to this VPC's private-with-egress subnets, so the DNS Firewall /
   * security-group / flow-log stack applies to MicroVM traffic unchanged
   * (ADR-021 security table: "Egress ... None" delta).
   */
  readonly vpc: ec2.IVpc;

  /**
   * Per-task SessionRole (#209). When provided, the MicroVM **execution role**
   * is admitted to the SessionRole's trust via
   * {@link AgentSessionRole.admitComputeRole} — the mechanism was designed for
   * exactly this (ADR-021 sub-decision 4) — so tenant-data access stays on the
   * tag-scoped SessionRole instead of the execution role. Mirrors how
   * `EcsAgentCluster` delegates the Fargate task role. Omitted in isolated
   * construct tests, in which case NO tenant-data access is granted at all
   * (this construct never grants DynamoDB directly: unlike the ECS backend
   * there is no legacy direct-grant path to preserve).
   */
  readonly agentSessionRole?: AgentSessionRole;

  /**
   * ARN of the Lambda-managed base MicroVM image to build on
   * (`aws lambda-microvms list-managed-microvm-images`), e.g.
   * `arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1`.
   *
   * Supplying this **and** {@link baseImageVersion} switches the construct into
   * its primary mode: it synthesizes an `AWS::Lambda::MicrovmImage` (L1) whose
   * `codeArtifact.uri` points at {@link artifactObjectKey} in the artifact
   * bucket this construct creates. There is no default — base-image ARNs are
   * account/Region-scoped service data that is only discoverable through a live
   * API call, so hardcoding one would be a guess that rots.
   */
  readonly baseImageArn?: string;

  /**
   * Version of {@link baseImageArn}
   * (`aws lambda-microvms list-managed-microvm-image-versions`). Required
   * alongside `baseImageArn` because CloudFormation marks it required on
   * `AWS::Lambda::MicrovmImage` even though the API treats it as optional.
   */
  readonly baseImageVersion?: string;

  /**
   * Identifier (name or ARN) of a MicroVM image built **out of band** — i.e. by
   * running `cdk/scripts/package-microvm-artifact.sh` and then
   * `aws lambda-microvms create-microvm-image` by hand.
   *
   * Only consulted when {@link baseImageArn} is absent. It exists so an
   * operator can iterate on the snapshot (which takes minutes and often several
   * attempts) without a stack update per attempt, then hand the finished image
   * to the orchestrator.
   */
  readonly externalImageIdentifier?: string;

  /**
   * Version of {@link externalImageIdentifier}. Optional: the service resolves
   * the latest active version when omitted, which is what a
   * rebuild-in-place workflow wants.
   */
  readonly externalImageVersion?: string;

  /**
   * Name for the MicroVM image and its log group. Must be unique in the
   * account.
   * @default `<stackName>-abca-agent`
   */
  readonly imageName?: string;

  /**
   * S3 key of the zip + Dockerfile artifact inside the artifact bucket.
   * @default MICROVM_ARTIFACT_OBJECT_KEY
   */
  readonly artifactObjectKey?: string;

  /**
   * **Baseline** memory the image declares, in MiB.
   *
   * This is the size the MicroVM STARTS at, not a cap on what it may use: the
   * service scales a running MicroVM vertically on demand, up to a 32 GiB /
   * 16 vCPU peak, with no field to request that. So the practical effect of this
   * prop is where the VM begins (and what it is baseline-priced at), not whether
   * a build will fit.
   *
   * Must be one of {@link MICROVM_SUPPORTED_MEMORY_MIB} — the construct throws at
   * synth otherwise, because the service rejects any other baseline at
   * image-create time with a `ValidationException` an operator would only see
   * minutes into a build.
   *
   * @default 8192 — the largest accepted baseline (see DEFAULT_MINIMUM_MEMORY_MIB)
   */
  readonly minimumMemoryInMiB?: number;

  /**
   * Non-secret environment variables baked into the snapshot at build time.
   *
   * Deliberately empty by default. ADR-021 sub-decision 3 forbids secrets,
   * tokens, and per-task identity in the snapshot; the agent's non-secret
   * configuration parity with the ECS container (table names, `MEMORY_ID`,
   * `ARTIFACTS_BUCKET_NAME`, …) is P2 "smoke parity" work and is wired here
   * when it lands.
   * @default {} — no baked configuration
   */
  readonly imageEnvironmentVariables?: Record<string, string>;
}

/**
 * AWS Lambda MicroVMs compute backend — infrastructure half (ADR-021,
 * sub-decision 4; P1 of the phased rollout).
 *
 * Provisions, in dependency order:
 *
 *  1. **Egress network connectors** (`AWS::Lambda::NetworkConnector`) on the
 *     platform VPC's private-with-egress subnets — TWO of them, sharing one
 *     operator role:
 *      - the **runtime** connector with a 443-only security group. This is what
 *        keeps the ADR's "Egress: no delta vs AgentCore/ECS" claim true — MicroVM
 *        traffic traverses the same NAT / DNS Firewall / flow logs as the other
 *        two backends.
 *      - the **build-time** connector with a 443 **and 80** security group,
 *        referenced only by the image resource. `agent/Dockerfile` runs
 *        `apt-get`, which is plain HTTP; a 443-only build path fails every
 *        snapshot build (see {@link HTTP_PORT}). Runtime egress stays 443-only.
 *  2. **Artifact bucket** for the zip + Dockerfile the service builds the
 *     snapshot from, and a **payload bucket** for `/run` payloads that exceed
 *     the 4 KB `runHookPayload` cap (which is nearly all of them).
 *  3. **Build role** — assumed by Lambda during image creation: `s3:GetObject`
 *     on the artifact object and CloudWatch Logs writes. Without it Lambda
 *     cannot emit build logs, which makes a failed snapshot build undebuggable.
 *  4. **Execution role** — assumed by the running MicroVM: CloudWatch Logs,
 *     read-only on the payload bucket, and (when a SessionRole is wired)
 *     admission to the per-task SessionRole for tenant-data access.
 *  5. **MicroVM image** (`AWS::Lambda::MicrovmImage`) — see {@link baseImageArn}
 *     for why this is conditional.
 *
 * ## Image provisioning: three states, one construct
 *
 * | Props supplied | What happens | When to use it |
 * |---|---|---|
 * | `baseImageArn` + `baseImageVersion` | `AWS::Lambda::MicrovmImage` L1 is synthesized from `s3://<artifactBucket>/<artifactObjectKey>`; {@link imageIdentifier} is its ARN | steady state |
 * | `externalImageIdentifier` | no image resource; the supplied identifier is resolved to its exact ARN and handed to the orchestrator | iterating on the snapshot out of band |
 * | neither | roles + buckets + connectors only; a synth-time **warning**, no image, and no `MICROVM_IMAGE_IDENTIFIER` for the orchestrator | first deploy — you cannot upload the artifact before the bucket that holds it exists |
 *
 * That third state is not an oversight: the artifact bucket is created by this
 * stack, so the very first `--context compute_type=lambda-microvm` deploy has
 * nowhere to have put the zip yet. It is a **warning rather than a throw**
 * precisely so the bootstrap sequence (deploy → run the packaging script
 * against the now-existing bucket → redeploy with `microvm_base_image_arn`) is
 * possible at all. A `lambda-microvm` task submitted in that interim window
 * fails fast with the strategy's own "stack deployed without the MicroVM
 * substrate" error, which names the remedy.
 *
 * ## ⚠️ A P1 image is runnable, but NOT smoke-verified
 *
 * Reaching state 1 or 2 provisions a complete substrate, a buildable image, and
 * a payload-deliverable `/run` path: P1 declares AND the agent serves `/ready`
 * and `/run` (`agent/src/server.py`), because live verification proved the
 * original "declare in P1, serve in P2" split was not a reachable service state
 * — `CreateMicrovmImage` refuses any lifecycle hook without `/ready` (see
 * {@link READY_HOOK_PATH}), and an image with no hooks at all cannot receive a
 * `runHookPayload`.
 *
 * What is still unverified is everything P2 owns: AgentCore Memory grants +
 * `MEMORY_ID` delivery, the non-secret env parity the agent needs inside the
 * snapshot, egress specifics from a running MicroVM, and heartbeat/progress
 * behaviour end to end. So a `lambda-microvm` task can start and receive its
 * payload, but clone → change → PR is **not** covered by any test or live run
 * yet. That is what the `abca:microvm-image-p1-smoke-unverified` warning below
 * says, and it is repeated in `cdk/scripts/package-microvm-artifact.sh`.
 * `/validate` (build) and `/suspend`, `/resume`, `/terminate` (runtime) are
 * still deliberately not declared: a hook the service calls but nothing answers
 * fails the corresponding build or lifecycle transition.
 *
 * ## Deliberately NOT here (P1 scope)
 *
 * The execution role gets **no** Bedrock, Secrets Manager, AgentCore Memory, or
 * artifacts-bucket grants. On the ECS backend those exist because the agent
 * actually runs there today; ADR-021 puts agent parity on this backend in P2
 * ("smoke parity … AgentCore Memory parity (IAM grant + MEMORY_ID)"). Adding
 * them now would hand a role permissions nothing exercises, and would have to
 * be reviewed twice. `lambda:SuspendMicrovm` / `lambda:ResumeMicrovm` are
 * likewise absent (P3) and `lambda:CreateMicrovmAuthToken` is granted to no
 * role in any phase — no JWE consumer exists (sub-decision 3).
 */
export class LambdaMicrovmCompute extends Construct {
  /** S3 bucket holding the zip + Dockerfile the snapshot is built from. */
  public readonly artifactBucket: s3.Bucket;

  /** Key of the artifact object inside {@link artifactBucket}. */
  public readonly artifactObjectKey: string;

  /** S3 bucket holding oversized `/run` payloads (S3-pointer delivery). */
  public readonly payloadBucket: s3.Bucket;

  /** Role Lambda assumes while building the snapshot image. */
  public readonly buildRole: iam.Role;

  /** Role the running MicroVM (and its runtime lifecycle hooks) assumes. */
  public readonly executionRole: iam.Role;

  /**
   * Role Lambda assumes to manage the connectors' ENIs in the platform VPC.
   *
   * REQUIRED for `VPC_EGRESS` connectors, despite the generated L1 typing
   * `operatorRole` as optional — see the comment at the connector below.
   */
  public readonly connectorOperatorRole: iam.Role;

  /** Runtime egress network connector bound to the platform VPC (443 only). */
  public readonly egressConnector: lambda.CfnNetworkConnector;

  /** ARNs for `MICROVM_EGRESS_CONNECTOR_ARNS` / `lambda:PassNetworkConnector`. */
  public readonly egressConnectorArns: string[];

  /**
   * Build-time egress network connector (443 **and** 80), used only by the image
   * build — never by a running MicroVM. See {@link HTTP_PORT}.
   */
  public readonly buildEgressConnector: lambda.CfnNetworkConnector;

  /** ARNs to pass as `create-microvm-image --egress-network-connectors`. */
  public readonly buildEgressConnectorArns: string[];

  /**
   * Ingress connectors passed on every `RunMicrovm`
   * (`MICROVM_INGRESS_CONNECTOR_ARNS`). In P1–P3 this is exactly the
   * Lambda-managed `NO_INGRESS` connector: the service's default is a PUBLIC
   * `HTTP_INGRESS`, so "no inbound" has to be requested explicitly (see
   * {@link MICROVM_NO_INGRESS_CONNECTOR_RESOURCE}).
   */
  public readonly ingressConnectorArns: string[];

  /** 443-only security group applied to the runtime connector's ENIs. */
  public readonly securityGroup: ec2.SecurityGroup;

  /** 443 + 80 security group applied to the BUILD connector's ENIs. */
  public readonly buildSecurityGroup: ec2.SecurityGroup;

  /** Log group for MicroVM build- and run-time logs. */
  public readonly logGroup: logs.LogGroup;

  /** The image resource, when this deployment builds one (see class docs). */
  public readonly image?: lambda.CfnMicrovmImage;

  /** Image name used for the image resource and the log group. */
  public readonly imageName: string;

  /** BASELINE memory (MiB) declared on the image; the service bursts above it. */
  public readonly minimumMemoryInMiB: number;

  /**
   * Value for `MICROVM_IMAGE_IDENTIFIER`. **Always a full image ARN**, never a
   * bare name — `RunMicrovm` rejects bare names outright
   * (`ValidationException: Malformed ARN - doesn't start with 'arn:'`, live
   * 2026-07-31), and so does `list-microvm-image-builds`. `undefined` in the
   * neither-input-supplied bootstrap state, in which case the stack must not
   * inject the MicroVM env block at all.
   */
  public readonly imageIdentifier?: string;

  /** Value for `MICROVM_IMAGE_VERSION`, when pinned. */
  public readonly imageVersion?: string;

  /**
   * The image's IAM resource ARN. Always set whenever {@link imageIdentifier}
   * is — a bare image name is resolved to its full
   * `…:microvm-image:<name>` ARN — so the orchestrator's `lambda:RunMicrovm` /
   * `GetMicrovm` / `TerminateMicrovm` grant is *always* scoped to this one
   * platform-created image and never widens to an account-level wildcard.
   * `undefined` only in the no-image bootstrap state, where no grant is issued
   * at all.
   */
  public readonly imageArn?: string;

  constructor(scope: Construct, id: string, props: LambdaMicrovmComputeProps) {
    super(scope, id);

    // Regional availability is checked HERE rather than in the stack so it
    // cannot be lost to a stack refactor: constructing this construct at all
    // means the backend is enabled.
    assertLambdaMicrovmRegionSupported(this);

    const stack = Stack.of(this);
    this.artifactObjectKey = props.artifactObjectKey ?? MICROVM_ARTIFACT_OBJECT_KEY;
    this.imageName = props.imageName ?? sanitizeImageName(`${stack.stackName}-abca-agent`);

    // Fail at SYNTH on an unsupported memory size. The service enumerates the
    // sizes a base image accepts and rejects anything else at create time, which
    // an operator otherwise discovers only after packaging + uploading.
    this.minimumMemoryInMiB = props.minimumMemoryInMiB ?? DEFAULT_MINIMUM_MEMORY_MIB;
    if (!MICROVM_SUPPORTED_MEMORY_MIB.includes(this.minimumMemoryInMiB)) {
      throw new Error(
        `minimumMemoryInMiB=${this.minimumMemoryInMiB} is not a BASELINE memory size AWS Lambda `
        + `MicroVMs accepts. Supported baselines (MiB): ${MICROVM_SUPPORTED_MEMORY_MIB.join(', ')}. `
        + `The default is ${DEFAULT_MINIMUM_MEMORY_MIB}, the largest accepted baseline. Note this is `
        + 'a BASELINE, not a cap: the service scales a running MicroVM vertically to a 32 GiB / '
        + '16 vCPU peak on its own, so asking for more here is neither possible nor necessary. A '
        + 'repo needing more than that SUSTAINED belongs on compute_type=ecs (16 vCPU / 120 GB).',
      );
    }

    // Backend-identifying cost-allocation tags on every resource below
    // (ADR-021: "MicroVM-specific resources shall carry backend-identifying
    // cost-allocation tags"). Applied at the construct scope so a resource
    // added later cannot be forgotten. L1 MicroVM resources are ITaggableV2,
    // so the aspect reaches them too.
    Tags.of(this).add(MICROVM_BACKEND_TAG_KEY, MICROVM_BACKEND_TAG_VALUE);

    // --- Networking: egress through the platform VPC ---
    this.securityGroup = new ec2.SecurityGroup(this, 'MicrovmSG', {
      vpc: props.vpc,
      description: 'Lambda MicroVMs agent sessions - egress TCP 443 only',
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTPS_PORT),
      'Allow HTTPS egress (GitHub API, AWS services)',
    );

    // BUILD-TIME security group: 443 + 80. Separate from the runtime group on
    // purpose — the agent at run time has no business speaking plain HTTP, but
    // `apt-get` inside `agent/Dockerfile` does, and a 443-only build path fails
    // every snapshot build (see HTTP_PORT). Keeping them apart means the
    // narrower runtime posture is unchanged by the build's requirement.
    this.buildSecurityGroup = new ec2.SecurityGroup(this, 'MicrovmBuildSG', {
      vpc: props.vpc,
      description: 'Lambda MicroVMs image BUILD - egress TCP 443 + 80 (apt-get)',
      allowAllOutbound: false,
    });
    this.buildSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTPS_PORT),
      'Allow HTTPS egress (package indexes, PyPI, npm)',
    );
    this.buildSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTP_PORT),
      'Allow HTTP egress for apt-get during the snapshot build (build path only)',
    );

    // OPERATOR ROLE — required, despite the generated L1 typing it optional.
    //
    // `CfnNetworkConnector.operatorRole?: string` reads like an opt-in, and this
    // construct originally left it unset "so Lambda manages the ENIs with its own
    // service-linked role". Live deploy 2026-07-31 refuted that outright — the
    // connector never reaches CREATE_COMPLETE without it:
    //
    //   NetworkConnectorOperatorRole is required for VPC_EGRESS connector type
    //   (Service: Lambda, Status Code: 400) HandlerErrorCode: InvalidRequest
    //
    // The permission set below is the minimal recipe validated standalone in that
    // run: `AWSLambdaVPCAccessExecutionRole` plus the ENI/tag/private-IP actions
    // the managed policy omits. Trust mirrors the build/execution roles
    // (`lambda.amazonaws.com` + `aws:SourceAccount`), so the confused-deputy
    // posture is identical on all three.
    //
    // ONE role for BOTH connectors: they differ only in security group, both are
    // created and owned by this construct in the same VPC, and a second identical
    // role would double the IAM surface a reviewer has to check for no isolation
    // gain (the role manages ENIs, not traffic).
    const microvmAssumedBy = new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
      },
    });
    this.connectorOperatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      assumedBy: microvmAssumedBy,
      description:
        'ABCA Lambda MicroVMs network-connector operator role: lets Lambda manage the connector '
        + 'ENIs in the platform VPC (required for VPC_EGRESS connectors).',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    this.connectorOperatorRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DeleteNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeNetworkInterfaceAttribute',
        'ec2:ModifyNetworkInterfaceAttribute',
        'ec2:DescribeSubnets',
        'ec2:DescribeVpcs',
        'ec2:DescribeSecurityGroups',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
        'ec2:CreateTags',
      ],
      // EC2 network-interface APIs are largely non-resource-scopable (the ENI
      // does not exist when CreateNetworkInterface is authorized, and the
      // Describe* calls take no resource), which is exactly why the AWS-managed
      // VPC-access policy uses `*` too. See the cdk-nag suppression below.
      resources: ['*'],
    }));

    // The connector, not the MicroVM, owns the ENIs — which is why
    // `lambda:PassNetworkConnector` is required on the orchestrator even for
    // AWS-managed connectors (ADR-021 sub-decision 4).
    //
    // `associatedComputeResourceTypes: ['MicroVm']` is the only value the
    // service accepts today (CloudFormation: "Currently, only MicroVm is
    // supported").
    const vpcEgressSubnetIds = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    this.egressConnector = new lambda.CfnNetworkConnector(this, 'EgressConnector', {
      name: sanitizeImageName(`${stack.stackName}-microvm-egress`),
      operatorRole: this.connectorOperatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          networkProtocol: 'IPv4',
          securityGroupIds: [this.securityGroup.securityGroupId],
          subnetIds: vpcEgressSubnetIds,
        },
      },
    });
    this.egressConnectorArns = [this.egressConnector.attrArn];

    // Build-time twin of the connector above, differing ONLY in security group
    // (443 + 80). Referenced by the image resource / packaging script, never by
    // `RunMicrovm`, so a running agent still gets the 443-only posture.
    this.buildEgressConnector = new lambda.CfnNetworkConnector(this, 'BuildEgressConnector', {
      name: sanitizeImageName(`${stack.stackName}-microvm-build-egress`),
      operatorRole: this.connectorOperatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          networkProtocol: 'IPv4',
          securityGroupIds: [this.buildSecurityGroup.securityGroupId],
          subnetIds: vpcEgressSubnetIds,
        },
      },
    });
    this.buildEgressConnectorArns = [this.buildEgressConnector.attrArn];

    // Explicit NO_INGRESS (F7). NOT an empty list: omitting the field makes the
    // service attach a PUBLIC HTTP_INGRESS connector and mint a public endpoint.
    this.ingressConnectorArns = [microvmNoIngressConnectorArn(this)];

    // --- Logs ---
    // Explicitly named under the service's `/aws/lambda-microvms/` namespace so
    // the build/execution role grants can be prefix-scoped AND so retention is
    // under our control (a service-created group defaults to never expire).
    this.logGroup = new logs.LogGroup(this, 'MicrovmLogGroup', {
      logGroupName: `${MICROVM_LOG_GROUP_PREFIX}/${this.imageName}`,
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Buckets ---
    // Artifact bucket: the zip + Dockerfile the service builds the snapshot
    // from. Dedicated (not a prefix on the attachments/trace bucket) for the
    // same structural reason EcsPayloadBucket is dedicated — the build role's
    // s3:GetObject then cannot reach tenant data. Deliberately NO expiry rule:
    // the artifact must survive as long as the image versions built from it,
    // which the service may re-read.
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'microvm-artifact-mpu-abort',
          enabled: true,
          // The artifact is tens/hundreds of MB, so uploads are multipart; a
          // failed `aws s3 cp` otherwise leaves billable parts forever.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Payload bucket: mirrors EcsPayloadBucket's configuration (BLOCK_ALL +
    // enforceSSL + S3_MANAGED + tight object expiry). See
    // MICROVM_PAYLOAD_TTL_DAYS for the one behavioural difference.
    this.payloadBucket = new s3.Bucket(this, 'PayloadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'microvm-payload-ttl',
          enabled: true,
          expiration: Duration.days(MICROVM_PAYLOAD_TTL_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Roles ---
    //
    // TRUST POLICY (verified against the AWS developer guide, "Lambda MicroVMs
    // → Security and permissions"): the build role, the execution role and the
    // connector operator role are all assumed by the ORDINARY Lambda service
    // principal `lambda.amazonaws.com` (`microvmAssumedBy`, declared with the
    // connector above because the operator role needs it first). The build and
    // execution roles additionally need `sts:TagSession` alongside
    // `sts:AssumeRole`. There is no `microvms.lambda.amazonaws.com` principal —
    // using one is rejected at role-creation time with MalformedPolicyDocument.
    //
    // CONFUSED-DEPUTY: `aws:SourceAccount` is pinned to this account, which is
    // the meaningful protection here — `lambda.amazonaws.com` is shared with
    // every other Lambda feature, so without it any caller who could make
    // Lambda act in *some* account could target these roles.
    //
    // `aws:SourceArn` is deliberately NOT added. Field reports of this exact
    // pattern (an `ArnLike` on `…:microvm-image/*`) have the service failing to
    // satisfy the condition — the image does not exist yet at build time — so
    // both `create-microvm-image` and `run-microvm` fail with "unable to assume
    // role". The AWS docs themselves are inconsistent about the separator in
    // MicroVM image ARNs (`microvm-image:<name>` vs `microvm-image/<name>`),
    // which is a second reason an ARN condition here is a deploy-time
    // foot-gun. The live 2026-07-31 run confirmed the observed image ARN uses
    // the `microvm-image:<name>` (colon) form; narrowing to `aws:SourceArn`
    // stays a P2 candidate rather than a P1 change.

    this.buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: microvmAssumedBy,
      description:
        'ABCA Lambda MicroVMs image-build role: reads the zip+Dockerfile artifact from S3 '
        + 'and writes snapshot build logs to CloudWatch.',
    });
    grantTagSession(this.buildRole, microvmAssumedBy);

    // s3:GetObject only, scoped to the single artifact key — not the bucket.
    // The build role runs the `/ready` and `/validate` build hooks, i.e. code
    // from the repo under build, so it gets the narrowest possible read.
    this.buildRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [this.artifactBucket.arnForObjects(this.artifactObjectKey)],
    }));
    this.grantMicrovmLogWrites(this.buildRole);

    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: microvmAssumedBy,
      description:
        'ABCA Lambda MicroVMs execution role: assumed by the running MicroVM and its runtime '
        + 'lifecycle hooks; writes logs and reads out-of-band /run payloads.',
    });
    grantTagSession(this.executionRole, microvmAssumedBy);
    this.grantMicrovmLogWrites(this.executionRole);

    // READ-ONLY on the payload bucket (ADR-021: "The MicroVM execution role
    // shall hold read-only access to the payload bucket, scoped to that
    // bucket"). Read-only is not a nicety: the MicroVM runs untrusted repo
    // code, so it must not be able to clobber another task's payload. Write +
    // lifecycle stay with the trusted orchestrator.
    this.payloadBucket.grantRead(this.executionRole);

    // Tenant-data access is delegated to the per-task SessionRole, exactly as
    // EcsAgentCluster does for the Fargate task role. NOTE the asymmetry with
    // that construct: there is no `else` branch granting DynamoDB directly —
    // this backend has no legacy deployments to keep working, so a missing
    // SessionRole means no tenant-data access rather than broad access.
    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(this.executionRole);
    }

    // --- Image ---
    // Branch through the shared predicate's two components rather than an
    // ad-hoc condition, so this construct and the stack's pre-TaskApi decision
    // (isLambdaMicrovmImageConfigured) can never disagree.
    if (props.baseImageArn && props.baseImageVersion) {
      this.image = new lambda.CfnMicrovmImage(this, 'Image', {
        name: this.imageName,
        description: `ABCA agent snapshot for ${stack.stackName} (ADR-021 lambda-microvm backend)`,
        baseImageArn: props.baseImageArn,
        baseImageVersion: props.baseImageVersion,
        buildRoleArn: this.buildRole.roleArn,
        codeArtifact: {
          uri: this.artifactBucket.s3UrlForObject(this.artifactObjectKey),
        },
        // ARM64 everywhere — the agent image is Graviton on all three backends.
        cpuConfigurations: [{ architecture: CPU_ARCHITECTURE }],
        resources: [{ minimumMemoryInMiB: this.minimumMemoryInMiB }],
        // Build-time egress uses the DEDICATED build connector (443 + 80), not
        // the runtime one: `apt-get` in `agent/Dockerfile` speaks plain HTTP and
        // a 443-only build path fails every snapshot build. Both connectors sit
        // on the same private-with-egress subnets, so DNS Firewall / NAT / flow
        // logs still apply to build traffic.
        egressNetworkConnectors: this.buildEgressConnectorArns,
        logging: { cloudWatch: { logGroup: this.logGroup.logGroupName } },
        // No extra OS capabilities: the agent runs ordinary user-space tooling.
        additionalOsCapabilities: [],
        // Nothing baked in — see `imageEnvironmentVariables`.
        environmentVariables: Object.entries(props.imageEnvironmentVariables ?? {})
          .map(([key, value]) => ({ key, value })),
        hooks: {
          port: AGENT_HOOK_PORT,
          microvmHooks: {
            // `/run` is the payload-delivery channel, and the agent SERVES it as
            // of P1 (`agent/src/server.py`). `/suspend` and `/resume` land with
            // the P3 interface widening, and `/terminate` with P2: declaring a
            // runtime hook the agent does not answer fails the corresponding
            // lifecycle transition. P1 termination is the orchestrator's
            // `TerminateMicrovm`, which needs no in-guest cooperation.
            run: RUN_HOOK_PATH,
            runTimeoutInSeconds: RUN_HOOK_TIMEOUT_SECONDS,
          },
          microvmImageHooks: {
            // `/ready` is MANDATORY whenever any lifecycle hook is enabled — the
            // service refuses the create otherwise (see READY_HOOK_PATH), which
            // is why it moved from P2 to P1. `/validate` stays out: the agent has
            // no validation endpoint, and one that 404s fails every image build.
            ready: READY_HOOK_PATH,
            readyTimeoutInSeconds: READY_HOOK_TIMEOUT_SECONDS,
          },
        },
      });
      // The image reads the artifact through the build role, so both must exist
      // (and the artifact bucket policy be in place) before the build starts.
      this.image.node.addDependency(this.buildRole, this.artifactBucket);

      this.imageIdentifier = this.image.attrImageArn;
      this.imageArn = this.image.attrImageArn;
      // Version intentionally unpinned: the service resolves the latest ACTIVE
      // version, which is what a redeploy-after-rebuild flow wants. Pinning to
      // `attrLatestActiveImageVersion` would be empty on the very first create
      // (the build has not finished) and would force a stack update per rebuild.
      this.imageVersion = undefined;
    } else if (props.externalImageIdentifier) {
      this.imageVersion = props.externalImageVersion;
      // An operator may pass a bare image NAME (that is what
      // `create-microvm-image --name` takes), but a bare name is useless to BOTH
      // consumers: it is not an IAM resource, and — refuting this construct's
      // former comment — `RunMicrovm` rejects it outright
      // (`ValidationException: Malformed ARN - doesn't start with 'arn:'`, live
      // 2026-07-31), as does `list-microvm-image-builds`. So the name is resolved
      // to its exact ARN ONCE here and that single value feeds both
      // `MICROVM_IMAGE_IDENTIFIER` and the lifecycle IAM scope.
      //
      // The Service Authorization Reference gives the `microvmImage` resource an
      // unambiguous shape —
      // `arn:${Partition}:lambda:${Region}:${Account}:microvm-image:${MicrovmImageName}`
      // — matching the ARN the live run observed, so the ARN is derivable from
      // the name plus this stack's partition/Region/account. `formatArn` emits
      // the Aws.PARTITION / Aws.REGION / Aws.ACCOUNT_ID pseudo-parameters, so it
      // is correct in a region-agnostic app too.
      //
      // Note the version is NOT part of the resource ARN: the SAR pattern ends
      // at the image name, and `RunMicrovm` carries `imageVersion` as a separate
      // request field, so pinning a version must never change the IAM scope.
      this.imageArn = props.externalImageIdentifier.startsWith('arn:')
        ? props.externalImageIdentifier
        : stack.formatArn({
          service: 'lambda',
          resource: 'microvm-image',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: props.externalImageIdentifier,
        });
      this.imageIdentifier = this.imageArn;
    } else {
      Annotations.of(this).addWarningV2(
        'abca:microvm-image-not-provisioned',
        'The lambda-microvm backend is enabled but no MicroVM image is configured, so the '
        + 'orchestrator will reject lambda-microvm tasks. This is the expected state of the FIRST '
        + 'deploy (the artifact bucket must exist before the artifact can be uploaded). Next: run '
        + 'cdk/scripts/package-microvm-artifact.sh to upload the zip+Dockerfile, then redeploy with '
        + '--context microvm_base_image_arn=<arn> --context microvm_base_image_version=<version> '
        + '(or point at an image you built by hand with --context microvm_image_identifier=<name|arn>).',
      );
    }

    if (this.imageIdentifier) {
      // Emitted on EVERY deploy that configures an image, in both image states.
      // Not a throw and not suppressible: P1 now provisions a substrate, a
      // buildable image AND a payload-deliverable /run path, which makes it look
      // even MORE like a working backend than before — while nothing in P1 has
      // exercised clone → change → PR on this substrate. The warning's job is to
      // keep "deploy succeeded" from reading as "backend works".
      Annotations.of(this).addWarningV2(
        'abca:microvm-image-p1-smoke-unverified',
        'A MicroVM image is configured. As of ADR-021 P1 the image IS creatable and launchable and '
        + 'the agent DOES serve the /ready and /run hooks, so a lambda-microvm task can start and '
        + 'receive its payload — but the backend has NO smoke-parity guarantee: AgentCore Memory '
        + 'grants and MEMORY_ID delivery, the agent\'s non-secret env parity inside the snapshot, '
        + 'egress specifics from a running MicroVM, and heartbeat/progress behaviour are all P2 and '
        + 'untested here. Keep production repos on compute_type=agentcore or ecs until P2 (smoke '
        + 'parity) lands. The /validate build hook and the /suspend, /resume and /terminate runtime '
        + 'hooks are deliberately still not declared: a hook the service calls but nothing answers '
        + 'fails the corresponding build or lifecycle transition.',
      );
    }

    NagSuppressions.addResourceSuppressions([this.artifactBucket, this.payloadBucket], [
      {
        id: 'AwsSolutions-S1',
        reason: 'Artifact bucket holds a single build input (the agent zip+Dockerfile) read only by '
          + 'the Lambda MicroVMs build role; the payload bucket holds ephemeral per-task /run payloads '
          + `with a ${MICROVM_PAYLOAD_TTL_DAYS}-day TTL, written only by the orchestrator (grantPut) and `
          + 'read only by the MicroVM execution role, both scoped to the bucket. Object-level access '
          + 'logging (a second log bucket + CloudTrail data events) is not justified for a single '
          + 'build input or for transient boot payloads.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions([this.buildRole, this.executionRole], [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch Logs wildcard is the service-owned '
          + `${MICROVM_LOG_GROUP_PREFIX}/* namespace (log stream names are minted per MicroVM, so no `
          + 'synth-time ARN exists); S3 object/* wildcard comes from CDK grantRead on the dedicated '
          + 'payload bucket (read-only, scoped to that bucket — ADR-021 sub-decision 3). The build '
          + 'role\'s s3:GetObject is scoped to a single object key, not a wildcard.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions([this.connectorOperatorRole], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaVPCAccessExecutionRole is the AWS-managed policy for exactly this job — '
          + 'letting Lambda manage ENIs in a customer VPC. The Lambda MicroVMs network connector '
          + 'REQUIRES an operator role for VPC_EGRESS (live-verified: '
          + '"NetworkConnectorOperatorRole is required for VPC_EGRESS connector type"), and the '
          + 'managed policy plus the explicit ENI/tag/private-IP statement is the minimal recipe '
          + 'validated standalone against the service. Hand-rolling the managed half would drift '
          + 'from AWS as the service evolves without narrowing anything (see the IAM5 note).',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'EC2 network-interface APIs are not meaningfully resource-scopable here: '
          + 'CreateNetworkInterface is authorized before the ENI exists, and the Describe* calls '
          + 'take no resource at all. The role is assumable ONLY by lambda.amazonaws.com with '
          + 'aws:SourceAccount pinned to this account, holds no data-plane permission, and is used '
          + 'solely to attach the two platform-owned connectors to the platform VPC. The '
          + 'AWS-managed VPC-access policy uses the same wildcard for the same reason.',
      },
    ], true);
  }

  /**
   * CloudWatch Logs writes scoped to the MicroVM log namespace.
   *
   * The service documents `logs:CreateLogGroup` + `CreateLogStream` +
   * `PutLogEvents` for the build role; the execution role gets the same set so
   * runtime logs land in the same, retention-managed group. `CreateLogGroup` is
   * included even though this construct pre-creates the group: the service
   * creates per-image/per-MicroVM groups under the prefix, and a missing
   * `CreateLogGroup` silently costs you the build logs — the one artifact you
   * need when a snapshot build fails.
   */
  private grantMicrovmLogWrites(role: iam.IRole): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: `${MICROVM_LOG_GROUP_PREFIX}/*`,
        }),
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: `${MICROVM_LOG_GROUP_PREFIX}/*:log-stream:*`,
        }),
      ],
    }));
  }
}

/**
 * Add `sts:TagSession` alongside the `sts:AssumeRole` CDK's `assumedBy` emits.
 *
 * The MicroVM service needs BOTH actions (developer guide, "Trust policies"),
 * but `iam.Role`'s `assumedBy` only renders `sts:AssumeRole`. Passing a second
 * statement through `assumeRolePolicy` keeps the `aws:SourceAccount` condition
 * identical on both actions — dropping it on the `TagSession` half would leave
 * the confused-deputy hole half-open.
 */
function grantTagSession(role: iam.Role, principal: iam.ServicePrincipal): void {
  role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
    actions: ['sts:TagSession'],
    principals: [principal],
    conditions: principal.policyFragment.conditions,
  }));
}

/**
 * Reduce a candidate name to the character set MicroVM image / network
 * connector names accept (alphanumerics, `-`, `_`) and cap its length.
 *
 * Stack names can contain characters these APIs reject, and an unresolved
 * (token) stack name would otherwise produce a name containing `${Token[...]}`.
 */
function sanitizeImageName(candidate: string): string {
  const MAX_NAME_LENGTH = 64;
  return candidate
    .replace(/[^A-Za-z0-9-_]/g, '-')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, '');
}
