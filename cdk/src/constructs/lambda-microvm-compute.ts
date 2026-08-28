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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
// Cross-language contract (S9): `microvm_hook_budgets` couples THIS construct's
// `/ready` hook timeout to the agent's own warm-up ceiling in
// `agent/src/server.py`. Imported (not copied) so `tsc` fails on a renamed field,
// and `scripts/check-constants-sync.ts` enforces the `warmup_total < ready_hook`
// invariant plus the no-literal-redeclaration rule on both sides. See
// `contracts/constants.md`.
// Single source of truth for the supported-Region list. ADR-021's
// `microvm-regions.ts` header is explicit that the list "is the ONLY place the
// list is declared — do not copy it", so the synth-time gate IMPORTS it rather
// than duplicating it. The module is a dependency-free pair of pure constants
// (no AWS SDK, no Lambda-runtime code), so pulling it into the CDK app tree
// costs nothing and cannot drift.
import { AgentMemory } from './agent-memory';
import { AgentSessionRole } from './agent-session-role';
import { resolveBedrockModelIds } from './bedrock-models';
import sharedConstants from '../../../contracts/constants.json';
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
 * Value every hook field on `AWS::Lambda::MicrovmImage` takes to turn a hook ON.
 *
 * **The field is an ENUM, not a path** — `[DISABLED, ENABLED]`. The CDK L1 types
 * `hooks.microvmHooks.run` and its three siblings as plain `string` and documents
 * no allowed values, which is why this construct originally sent the agent's
 * route there. CloudFormation **rejected all four at change-set early validation**
 * (live 2026-08-06, ADR-021 P2-F2 — the stack was never touched, so there was no
 * rollback to read):
 *
 * > /aws/lambda-microvms/runtime/v1/run is not a valid enum value. Supported
 * > values: [DISABLED, ENABLED] (at
 * > /Resources/…/Properties/Hooks/MicrovmHooks/Run)
 *
 * So the CloudFormation surface is IDENTICAL to the `CreateMicrovmImage` API
 * surface (`--hooks '{"microvmHooks":{"run":"ENABLED",…}}'`), not different from
 * it as the previous comment here claimed. There is no hook-path field on either
 * surface: the service calls fixed well-known routes, which
 * {@link MICROVM_AGENT_HOOK_ROUTES} records and the live build/run logs confirm.
 *
 * `DISABLED` is never emitted: a hook the agent does not serve is OMITTED rather
 * than disabled, so the exactness test can assert the declared set in both
 * directions (see `/suspend` + `/resume`, P3).
 */
const HOOK_ENABLED = 'ENABLED';

/**
 * Route prefix the MicroVM service POSTs its lifecycle hooks to, and the prefix
 * the agent mounts them under (`MICROVM_HOOK_PREFIX` in `agent/src/server.py`).
 */
const MICROVM_HOOK_ROUTE_PREFIX = '/aws/lambda-microvms/runtime/v1';

/**
 * The service's fixed hook ROUTES, keyed by hook name — the paths
 * `agent/src/server.py` must serve.
 *
 * ## ⚠️ These are AGENT ROUTE CONSTANTS ONLY. Never send them to an AWS API.
 *
 * They were previously passed as the `hooks.*` property VALUES on the L1, on the
 * reasoning that the generated CloudFormation type accepts strings and documents
 * no allowed-value constraint. CloudFormation refused every one of them
 * (P2-F2 — see {@link HOOK_ENABLED} for the verbatim early-validation output):
 * the hook fields are `ENABLED`/`DISABLED` enums on BOTH the CloudFormation and
 * the API surface, and neither surface accepts a path at all.
 *
 * The routes are still worth declaring here because they are a CROSS-PACKAGE
 * CONTRACT that nothing else in the CDK tree records: the service POSTs to these
 * exact paths (live 2026-08-06 — `"POST /aws/lambda-microvms/runtime/v1/ready
 * HTTP/1.1" 200 OK`, and the same for `/validate`, `/run` and `/terminate`), so a
 * prefix drift between this map and the agent's `MICROVM_HOOK_PREFIX` surfaces as
 * a failed image build (`/ready`, `/validate`) or a failed lifecycle transition on
 * a real task (`/run`, `/terminate`). The construct test compares THIS map — not
 * the rendered template, which no longer contains a path — against the routes the
 * agent serves.
 */
export const MICROVM_AGENT_HOOK_ROUTES = {
  ready: `${MICROVM_HOOK_ROUTE_PREFIX}/ready`,
  validate: `${MICROVM_HOOK_ROUTE_PREFIX}/validate`,
  run: `${MICROVM_HOOK_ROUTE_PREFIX}/run`,
  terminate: `${MICROVM_HOOK_ROUTE_PREFIX}/terminate`,
} as const;

/**
 * `/run` runtime-hook budget (seconds).
 *
 * `/run` is how the task payload reaches the agent (`runHookPayload`, ADR-021
 * sub-decision 3) — there is no other orchestrator→agent channel on this
 * backend. The hook only validates + starts the pipeline asynchronously, so it
 * stays well inside the service's 1–60 s runtime-hook window.
 */
const RUN_HOOK_TIMEOUT_SECONDS = 60;

/**
 * `/ready` build-hook budget (seconds).
 *
 * `/ready` is **mandatory, not optional**: `CreateMicrovmImage` rejects an image
 * that enables ANY lifecycle hook without it (live 2026-07-31):
 *
 * > The ready (/ready) MicroVM image hook must be enabled when any MicroVM
 * > lifecycle hook (run, resume, suspend, or terminate) is enabled. The ready
 * > hook signals when the application has finished initializing so the snapshot
 * > is taken in a ready state.
 *
 * So ADR-021's original "declare `/run` in P1, serve it in P2" plan was not a
 * reachable service state: `/ready` + `/run` land together in P1.
 *
 * **The budget is 300 s, not 60 s, because as of the P2-F5 fix `/ready` does real
 * work.** It no longer just reports that uvicorn is bound: it warms the 225 MiB
 * `claude` binary (`agent/src/server.py` → `_warm_snapshot_binaries`) so the
 * binary's pages are resident when the snapshot is taken, instead of being faulted
 * in lazily on the first task and blowing a timeout there (the defect that failed
 * every P2 smoke task at turn 0). A cold 225 MiB `exec` is the one thing on this
 * path that can plausibly take tens of seconds, and the build hook window allows
 * up to 3600 s, so a 60 s budget would trade the runtime failure for a build
 * failure. It stays far below the service ceiling: the cost of a too-generous
 * budget is only how long the service waits before calling a permanently-wedged
 * snapshot broken.
 *
 * The number is chosen against the agent's own warm-up ceiling, not guessed — and
 * it is not declared here either. Both this budget and the agent's
 * `_READY_WARMUP_TOTAL_BUDGET_SECONDS` come from `contracts/constants.json` →
 * `microvm_hook_budgets`, because the relationship between them is the invariant
 * that matters and a relationship cannot be enforced from one side. The agent's
 * ceiling bounds the WHOLE warm-up (required command + every best-effort one,
 * which share the remainder) at 240 s, leaving ~60 s here for uvicorn scheduling
 * and the request itself. Per-command timeouts deliberately do NOT compose on the
 * agent side — three commands at 120 s each would be 360 s and would blow this
 * budget, turning a fix for a runtime failure into a build failure.
 * `scripts/check-constants-sync.ts` fails the build if the contract ever stops
 * satisfying `warmup_total < ready_hook`, so the two numbers cannot drift apart in
 * a single-sided edit.
 */
const READY_HOOK_TIMEOUT_SECONDS = sharedConstants.microvm_hook_budgets.ready_hook_timeout_seconds;

/**
 * `/validate` build-hook budget (seconds).
 *
 * `/validate` is declared as of P2, when the agent started serving it. What it
 * asserts is narrower than ADR-021 first sketched, and the narrowing is a
 * consequence of THIS construct's IAM: it runs during the image build under
 * {@link LambdaMicrovmCompute.buildRole}, which holds only `s3:GetObject` on the
 * artifact plus log writes. So the "deeper warm-up assertions" (Bedrock
 * reachability, Memory access, tool availability) are not implementable here —
 * each would `AccessDenied` and fail every build. The agent's hook is therefore an
 * in-process self-check (server alive, every declared hook route registered,
 * interpreter floor, cross-package `platform_config` contract loaded), which is
 * exactly the class of failure a build hook CAN catch: a typo'd hook prefix would
 * otherwise surface as a failed lifecycle transition on the first real task
 * instead of as a failed build.
 *
 * The checks themselves are sub-millisecond (no AWS calls, no I/O beyond a stdout
 * line), so the budget is not sized for the work: it is sized for the
 * still-initialising path, where the agent answers **503** until module import
 * completes. 60 s covers that with orders of magnitude to spare. This used to be
 * an alias for {@link READY_HOOK_TIMEOUT_SECONDS} on the argument that one number
 * should cover both build hooks; the two DECOUPLED when `/ready` gained the
 * binary warm-up (P2-F5) and `/validate` did not, so sharing a number would now
 * mean sizing `/validate` for work it does not do. Set explicitly rather than
 * relying on the service's 30 s default: a permanently failing check SHOULD fail
 * the image build, and the budget is what decides how long the service waits
 * before calling it that.
 */
const VALIDATE_HOOK_TIMEOUT_SECONDS = 60;

/**
 * `/terminate` runtime-hook budget (seconds).
 *
 * `/terminate` is declared as of P2. It is a log-and-acknowledge breadcrumb, NOT
 * a shutdown mechanism: the orchestrator finalizes the task and *then* calls
 * `TerminateMicrovm`, so the hook must not write terminal task status (it would
 * race the finalization it follows) and must not join the pipeline thread. Its
 * value is the last structured line in the task's log group from inside the guest.
 *
 * This is the one hook where a GENEROUS budget buys nothing and costs something.
 * There is nothing to drain — `_ProgressWriter` does a synchronous `put_item` per
 * event, so every progress write is already durable when this hook is called —
 * and the handler never joins the pipeline thread, so it completes in
 * milliseconds by construction. Meanwhile the budget bounds how long teardown
 * waits on a guest that is WEDGED, and a MicroVM that has not finished
 * terminating is still holding the account memory quota that gates admission for
 * everyone else.
 *
 * So this is set near the bottom of the service's 1–60 s window rather than at
 * it: 15 s is ~three orders of magnitude above the measured work, which absorbs
 * a scheduling delay on a guest still saturated by a build (the realistic reason
 * a fast handler answers slowly), while keeping teardown prompt. Exceeding it
 * costs only a reported hook failure — the task is already finalized and
 * `TerminateMicrovm` removes the VM regardless — which is why erring tight is
 * the safe direction here and erring generous is not.
 */
const TERMINATE_HOOK_TIMEOUT_SECONDS = 15;

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

/**
 * Graviton/ARM64: the agent image is ARM64 on every backend.
 *
 * The value is the service's **enum member spelling**, `ARM_64` — not the
 * lowercase `arm64` Docker/CDK use elsewhere. The CDK L1 types
 * `cpuConfigurations[].architecture` as a plain `string` and documents no allowed
 * values, and `arm64` was rejected at change-set early validation (live
 * 2026-08-06, ADR-021 P2-F2): *"arm64 is not a valid enum value. Supported
 * values: [ARM_64]"*. Matches `--cpu-configurations '[{"architecture":"ARM_64"}]'`
 * in `cdk/scripts/package-microvm-artifact.sh`, which had it right all along.
 */
const CPU_ARCHITECTURE = 'ARM_64';

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
   * GitHub PAT secret. When provided, the MicroVM **execution role** gets
   * `grantRead` on it.
   *
   * This grant stays on the execution role rather than moving to the SessionRole
   * because of WHEN it is used: the agent resolves the token at startup, before
   * it has assumed the SessionRole — the same ordering that keeps the grant on the
   * ECS task role and the AgentCore runtime role. Without it the MicroVM cannot
   * clone, push, or open a PR, which is the whole task.
   *
   * Omitted in isolated construct tests → no grant.
   */
  readonly githubTokenSecret?: secretsmanager.ISecret;

  /**
   * AgentCore Memory for cross-task learning. When provided, the execution role
   * gets read+write so the agent's `write_task_episode` / `write_repo_learnings`
   * (`bedrock-agentcore:CreateEvent`) succeed on this substrate.
   *
   * Exactly the prop `EcsAgentCluster` takes, for exactly the same reason: the
   * `MEMORY_ID` the agent receives (in `agent_payload`, unchanged by ADR-021 P2)
   * makes it ATTEMPT the write, and without the grant that attempt fails closed on
   * AccessDenied. `memory.py` treats that as an infra failure — logged,
   * non-fatal — so learning would silently never persist on a MicroVM-only
   * deployment. Omitted in isolated construct tests / memory-less deployments.
   */
  readonly agentMemory?: AgentMemory;

  /**
   * The platform's APPLICATION_LOGS group — the same log group whose NAME travels
   * to the guest as `platform_config.log_group_name` (`stacks/agent.ts` →
   * `TaskOrchestrator.agentPlatformConfig` → `LOG_GROUP_NAME`). When provided, the
   * MicroVM **execution role** gets `logs:CreateLogStream` + `logs:PutLogEvents`
   * on it.
   *
   * Not optional in spirit — omitted only in isolated construct tests. P2 wired
   * the name into `platform_config`, which makes the agent ATTEMPT the write, and
   * shipped without the matching grant, so every structured per-task log line was
   * denied (live 2026-08-07, ADR-021 P2-F4):
   *
   * > User: …:assumed-role/…LambdaMicrovmComputeExecutionRo…/Lambda-microvmsExecutor-…
   * > is not authorized to perform: logs:CreateLogStream on resource:
   * > …:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/…
   *
   * The role's OTHER logs grant ({@link LambdaMicrovmCompute.grantMicrovmLogWrites})
   * is scoped to the service's own `/aws/lambda-microvms/*` namespace and cannot
   * cover this group — the two namespaces are unrelated. Non-fatal (the agent
   * degrades to stdout, which the MicroVM log group captures) but it empties the
   * platform's canonical per-task observability streams, `METRICS_REPORT`
   * included, on this backend only. Exactly the omission class the P2 Bedrock /
   * Secrets Manager / Memory grants exist to close.
   */
  readonly applicationLogGroup?: logs.ILogGroup;

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
   * Deliberately empty by default, and expected to STAY empty. ADR-021
   * sub-decision 3 forbids secrets, tokens, and per-task identity in the snapshot
   * — and P2 resolved the remaining question (where the agent's non-secret
   * configuration parity with the ECS container comes from) in favour of the
   * `/run` payload's `platform_config` block, NOT this prop. A snapshot is shared
   * across every task and every deployment that reuses it, so a table or bucket
   * name baked in here would be a deploy-time value frozen at image-build time —
   * stale the moment the stack is redeployed. Reach for this only for genuinely
   * image-invariant settings (a locale, a toolchain path).
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
 *  4. **Execution role** — assumed by the running MicroVM: CloudWatch Logs (both
 *     the service's own `/aws/lambda-microvms/*` namespace and the platform
 *     APPLICATION_LOGS group whose name `platform_config` delivers), read-only on
 *     the payload bucket, the P2 runtime-parity grants (GitHub PAT +
 *     channel-OAuth secret reads, scoped Bedrock invocation, AgentCore Memory,
 *     `ec2:DescribeAvailabilityZones` for a CDK repo's synth gate), and — when a
 *     SessionRole is wired — admission to the per-task SessionRole, which is the
 *     ONLY path to tenant data.
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
 * ## ⚠️ A P2 substrate is fully wired, but still NOT smoke-verified
 *
 * Reaching state 1 or 2 provisions a complete substrate, a buildable image, and
 * a payload-deliverable `/run` path: P1 declares AND the agent serves `/ready`
 * and `/run` (`agent/src/server.py`), because live verification proved the
 * original "declare in P1, serve in P2" split was not a reachable service state
 * — `CreateMicrovmImage` refuses any lifecycle hook without `/ready` (see
 * {@link READY_HOOK_TIMEOUT_SECONDS}), and an image with no hooks at all cannot
 * receive a `runHookPayload`.
 *
 * P2 adds the two halves an agent needs to actually finish a task: the runtime
 * IAM parity on the execution role (see item 4 above) and non-secret
 * configuration delivery through the `/run` payload's `platform_config` block
 * (`handlers/shared/strategies/lambda-microvm-strategy.ts`) — the substitute for
 * the env block the other two backends get at deploy time, since the snapshot must
 * not bake it in. It also declares the two hooks the agent gained in the same
 * phase: `/validate` (build-time self-check — see
 * {@link VALIDATE_HOOK_TIMEOUT_SECONDS} for why the build role's permissions bound
 * what it can assert) and `/terminate` (in-guest teardown breadcrumb —
 * {@link TERMINATE_HOOK_TIMEOUT_SECONDS}).
 *
 * What is still unverified is the thing no amount of wiring can assert: an
 * end-to-end clone → change → PR run on this substrate, plus egress specifics and
 * heartbeat/progress behaviour from a live MicroVM. That is what the
 * `abca:microvm-image-p1-smoke-unverified` warning below says, and it is repeated
 * in `cdk/scripts/package-microvm-artifact.sh`. Only `/suspend` and `/resume`
 * remain undeclared, until P3 implements them: a hook the service calls but
 * nothing answers fails the corresponding lifecycle transition.
 *
 * ## Deliberately NOT here
 *
 * The execution role gets no artifacts-bucket grant and no DynamoDB grant: an
 * artifact delivery write goes through the SessionRole's
 * `artifacts/${task_id}/*` statement (the AgentCore runtime role has no direct
 * grant either) and every table the agent touches is `task_id`-partitioned
 * SessionRole territory. It also has no UserConcurrencyTable grant — that counter
 * is orchestrator/reconciler-owned and the agent path never writes it.
 * `lambda:SuspendMicrovm` / `lambda:ResumeMicrovm` are absent (P3), and
 * `lambda:CreateMicrovmAuthToken` is granted to no role in any phase — no JWE
 * consumer exists (sub-decision 3).
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
    // the managed policy omits.
    //
    // ONE role for BOTH connectors: they differ only in security group, both are
    // created and owned by this construct in the same VPC, and a second identical
    // role would double the IAM surface a reviewer has to check for no isolation
    // gain (the role manages ENIs, not traffic).
    //
    // --- TRUST POLICY: bare service principal, NO source conditions (P2-F1/F3) ---
    //
    // Shared by all three MicroVM-facing roles (this one, `buildRole`,
    // `executionRole`) because the decision is one decision. `lambda.amazonaws.com`
    // is the correct principal — there is no `microvms.lambda.amazonaws.com`, and
    // using one is rejected at role-creation time with MalformedPolicyDocument.
    //
    // ⚠️ **`aws:SourceAccount`/`aws:SourceArn` are deliberately absent. Adding one
    // back re-breaks the deploy.** The Lambda MicroVMs service populates NO source
    // condition key when it assumes these roles, so a trust policy carrying one is
    // unassumable: both network connectors CREATE_FAILED deterministically, and
    // `RunMicrovm` surfaced the same root cause as a misleading caller-side
    // `iam:PassRole` denial on the orchestrator. Removing the conditions fixed both
    // within seconds. This looks like a regression to anyone applying the standard
    // confused-deputy pattern — and it already WAS one in the other direction: P1's
    // working probe had no conditions, and the P1 F2 fix added them "to mirror the
    // build/execution roles". `sts:TagSession` stays; it was never implicated.
    //
    // ADR-021 §4 is authoritative for the rest: the live evidence (P2-F1 / P2-F3,
    // verbatim failures, the two-arm PassRole experiment, the contaminated control
    // that produced run 1's false negative), the per-role compensating-controls
    // table, and the conditions under which the condition could be restored. The
    // trust shape here is asserted by `test/constructs/lambda-microvm-compute.test.ts`
    // ("NO source-key condition on any MicroVM-facing role trust").
    const microvmAssumedBy = new iam.ServicePrincipal('lambda.amazonaws.com');
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
    // TRUST POLICY: all three MicroVM-facing roles share `microvmAssumedBy` —
    // the BARE `lambda.amazonaws.com` service principal, with NO source
    // conditions. The warning and the pointer live at that constant's
    // declaration, above the connector operator role that needs it first; ADR-021
    // §4 carries the evidence (P2-F1 / P2-F3) and the per-role compensating
    // controls. The
    // build and execution roles additionally need `sts:TagSession` alongside
    // `sts:AssumeRole` (developer guide, "Trust policies"), which
    // {@link grantTagSession} adds.

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
    // Build role: keeps `logs:CreateLogGroup` — see `grantMicrovmLogWrites`.
    this.grantMicrovmLogWrites(this.buildRole, { allowCreateLogGroup: true });

    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: microvmAssumedBy,
      description:
        'ABCA Lambda MicroVMs execution role: assumed by the running MicroVM and its runtime '
        + 'lifecycle hooks; writes logs and reads out-of-band /run payloads.',
    });
    grantTagSession(this.executionRole, microvmAssumedBy);
    // Execution role: NO `logs:CreateLogGroup`. It runs untrusted repo code and
    // live evidence shows it only ever writes into the pre-created group — see
    // `grantMicrovmLogWrites` for the runbook citations and the re-verify note.
    this.grantMicrovmLogWrites(this.executionRole, { allowCreateLogGroup: false });

    // The APPLICATION_LOGS group the agent is TOLD to write to (P2-F4). Separate
    // from `grantMicrovmLogWrites` above and not reachable from it: that grant
    // covers the service-owned `/aws/lambda-microvms/*` namespace, while
    // `platform_config.log_group_name` points at the platform's vended
    // `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/<stack>` group —
    // the one the dashboard and every per-task log query read. Scoped to that one
    // group (CDK `grantWrite` → `logs:CreateLogStream` + `logs:PutLogEvents` on the
    // group's ARN, stream wildcard only), so this adds no cross-log-group reach.
    // See `applicationLogGroup` for the denial this fixes.
    props.applicationLogGroup?.grantWrite(this.executionRole);

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
    //
    // This is ALSO why nothing below grants DynamoDB: every table the agent
    // touches is `task_id`-partitioned and reachable only through the
    // SessionRole's `dynamodb:LeadingKeys` condition. `admitComputeRole` wires
    // both halves that needs (trust on the SessionRole + `sts:AssumeRole` /
    // `sts:TagSession` here), so P2 adds nothing to this seam — asserted by a
    // unit test, because a "convenience" direct grant is exactly how per-tenant
    // isolation gets lost.
    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(this.executionRole);
    }

    // --- P2 runtime parity on the EXECUTION role (ADR-021 "smoke parity") ---
    //
    // Feature-derived, not copied from `ecs-agent-cluster`: each grant below
    // exists because a specific agent code path fails without it on THIS
    // substrate. The ECS task role's remaining grants are deliberately absent —
    // the UserConcurrencyTable (orchestrator/reconciler-owned; the agent path
    // never writes it) and any artifacts-bucket access (delivery writes go
    // through the SessionRole's `artifacts/${task_id}/*` statement, so the
    // AgentCore runtime role has no direct grant either and neither does this).

    // Secrets Manager, part 1: the GitHub PAT, read at startup before the agent
    // assumes the SessionRole.
    if (props.githubTokenSecret) {
      props.githubTokenSecret.grantRead(this.executionRole);
    }

    // Secrets Manager, part 2: per-workspace Linear/Jira OAuth tokens. Same shape
    // and same reason as `ecs-agent-cluster`'s grant (ABCA-488): the CLI creates
    // `bgagent-linear-oauth-<slug>` / `bgagent-jira-oauth-<cloudId>` at setup, so
    // the name is unknown at synth and a PREFIX grant is the only expressible
    // scope. For a Linear/Jira-channel task the agent resolves that token at
    // startup (`config.resolve_linear_api_token` /
    // `resolve_jira_oauth_token`) to fire the 👀→✅ reaction and drive the channel
    // MCP; without the grant the fetch hits AccessDenied and both silently no-op
    // (logged by the token resolver, but invisible to the user in the channel).
    //
    // `GetSecretValue` ONLY — the agent reads; the orchestrator owns refresh /
    // PutSecretValue.
    this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-linear-oauth-*',
        }),
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    // Bedrock model invocation — scoped to explicit foundation-model and
    // cross-Region inference-profile ARNs (parity with the AgentCore runtime and
    // the ECS task role), NEVER `Resource: '*'`. The model set comes from the
    // shared, context-overridable list (`constructs/bedrock-models.ts`) so no
    // backend can drift from the others.
    //
    // Required on the COMPUTE role even though the SessionRole carries a
    // session-tagged Bedrock grant for cost attribution (#215): that attribution
    // is designed to FAIL OPEN — Claude Code's credential helper falls back to
    // ambient compute-role credentials when the assume-role fails — so without
    // this grant the fallback path AccessDenies and the task dies at turn 0.
    const bedrockResources: string[] = [];
    for (const modelId of resolveBedrockModelIds(this.node)) {
      bedrockResources.push(
        stack.formatArn({
          service: 'bedrock',
          region: '*',
          account: '',
          resource: 'foundation-model',
          resourceName: modelId,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        }),
        stack.formatArn({
          service: 'bedrock',
          resource: 'inference-profile',
          resourceName: `us.${modelId}`,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        }),
      );
    }
    this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: bedrockResources,
    }));

    // AgentCore Memory read+write, so cross-task learning actually persists on
    // this substrate. `MEMORY_ID` already reaches the agent inside
    // `agent_payload` (unchanged by P2 — it is task data, not platform config),
    // which means the agent ATTEMPTS the write regardless; the grant is what
    // decides whether it lands or fails closed.
    if (props.agentMemory) {
      props.agentMemory.grantReadWrite(this.executionRole);
    }

    // A CDK-based target repo's build gate runs `cdk synth`, and a stack wired to
    // a concrete env ({account, region}) does a synth-time availability-zone
    // context lookup. On a developer box the gitignored cdk.context.json caches
    // the answer; the agent clones fresh, so there is no cache and synth fires the
    // live lookup. Without this grant the role hits AccessDenied → "Synthesis
    // finished with errors" → a FALSE build-gate failure on code that builds fine
    // everywhere else (the exact regression the ECS task role hit). Read-only
    // describe with no resource-level scoping in IAM, so `Resource: '*'` is
    // mandatory (suppressed below); it grants no mutation and no data access.
    this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));

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
            // Values are the `ENABLED` enum, NOT the hook route: CloudFormation
            // rejects a path on every one of these four fields (P2-F2 — see
            // {@link HOOK_ENABLED}). The routes are fixed and service-owned;
            // {@link MICROVM_AGENT_HOOK_ROUTES} records them for the agent's
            // benefit and must never be sent here again.
            //
            // `/run` is the payload-delivery channel (and, since P2, the
            // platform-configuration channel); `/terminate` is the in-guest
            // teardown breadcrumb. The agent serves BOTH — enabling a runtime
            // hook nothing answers fails the corresponding lifecycle transition,
            // so each is enabled only once it is served.
            //
            // `/suspend` and `/resume` stay OMITTED (not `DISABLED`) until P3,
            // where the suspend/resume interface widening lands across all three
            // strategies. Note that termination does NOT depend on this hook:
            // `TerminateMicrovm` removes the VM with or without in-guest
            // cooperation, which is what makes a best-effort `/terminate` safe to
            // declare.
            run: HOOK_ENABLED,
            runTimeoutInSeconds: RUN_HOOK_TIMEOUT_SECONDS,
            terminate: HOOK_ENABLED,
            terminateTimeoutInSeconds: TERMINATE_HOOK_TIMEOUT_SECONDS,
          },
          microvmImageHooks: {
            // `/ready` is MANDATORY whenever any lifecycle hook is enabled — the
            // service refuses the create otherwise (see
            // READY_HOOK_TIMEOUT_SECONDS), which is why it moved from P2 to P1.
            // `/validate` joins it in P2, now that the agent serves a real
            // (AWS-call-free — see VALIDATE_HOOK_TIMEOUT_SECONDS) self-check: a
            // hook that 404s or reports failure fails every image build, so it
            // could not be enabled before there was something behind it.
            ready: HOOK_ENABLED,
            readyTimeoutInSeconds: READY_HOOK_TIMEOUT_SECONDS,
            validate: HOOK_ENABLED,
            validateTimeoutInSeconds: VALIDATE_HOOK_TIMEOUT_SECONDS,
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
      // Not a throw and not suppressible: the substrate now looks like a working
      // backend in every observable way — the image builds, launches, receives a
      // payload, and the execution role holds the full runtime permission set —
      // while nothing has exercised clone → change → PR on it. The warning's job is
      // to keep "deploy succeeded" from reading as "backend works".
      //
      // The id is deliberately UNCHANGED across P1→P2 (operators grep for it, and a
      // rename would read as "the old warning is gone, so it must be fine").
      Annotations.of(this).addWarningV2(
        'abca:microvm-image-p1-smoke-unverified',
        'A MicroVM image is configured. A P2 smoke run HAS now completed clone -> change -> PR on '
        + 'this substrate (2026-08-07: two tasks COMPLETED with pull requests, progress streaming to '
        + 'bgagent watch, and the 45s agent heartbeat observed live), the agent serves the /ready, '
        + '/validate, /run and /terminate hooks, and the execution role holds its full runtime '
        + 'permission set. What is still MISSING is a run with no manual intervention: that smoke '
        + 'needed a live IAM workaround, and the two defects behind it (ADR-021 P2r2-F9 / P2r2-F10 — '
        + 'the iam:PassedToService condition on both PassRole paths) are fixed in source but NOT yet '
        + 're-exercised live. ALSO REQUIRED: re-bootstrap to policy bundle 1.4.0 or the CDK-managed '
        + 'image path fails with iam:PassRole AccessDenied on the build role. So the backend still '
        + 'carries no smoke-parity guarantee for an unattended deployment - keep production repos on '
        + 'compute_type=agentcore or ecs until a clean run is on record. Only the /suspend and '
        + '/resume runtime hooks remain undeclared, until P3 implements them: a hook the service '
        + 'calls but nothing answers fails the corresponding lifecycle transition. '
        + "(This warning's id still reads p1- by design: it is frozen across phases so operator "
        + 'greps and suppression lists keep matching — read the text, not the id, for the phase.)',
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
          + 'role\'s s3:GetObject is scoped to a single object key, not a wildcard. On the execution '
          + 'role (ADR-021 P2 runtime parity, mirroring the ECS task role): the second Logs grant is '
          + 'CDK grantWrite (CreateLogStream + PutLogEvents only) on the SINGLE platform '
          + 'APPLICATION_LOGS group whose name platform_config delivers to the guest, whose ARN ends '
          + 'in a log-stream wildcard because streams are minted per task (ADR-021 P2-F4); '
          + 'Secrets Manager wildcards are CDK grantRead on the GitHub PAT secret plus the '
          + 'bgagent-linear-oauth-*/'
          + 'bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are '
          + 'created by the CLI at setup, so the name is unknown at synth; GetSecretValue only); '
          + 'AgentCore Memory wildcards are CDK grantRead/grantWrite on the single platform Memory '
          + 'resource; Bedrock InvokeModel is scoped to explicit foundation-model and '
          + 'inference-profile ARNs from the shared model list (no wildcard resource); '
          + 'ec2:DescribeAvailabilityZones requires Resource:* because EC2 describe actions have no '
          + 'resource-level scoping — read-only, no mutation and no data access, needed so a CDK '
          + 'target repo\'s `cdk synth` build gate can resolve AZ context on a fresh clone. No '
          + 'DynamoDB grant is issued to either role: tenant-data access goes exclusively through '
          + 'the per-task SessionRole\'s task_id-scoped policy.',
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
          + 'take no resource at all. The role is assumable ONLY by lambda.amazonaws.com, holds no '
          + 'data-plane permission, and is used solely to attach the two platform-owned connectors '
          + 'to the platform VPC. An aws:SourceAccount confused-deputy condition is NOT available '
          + 'on this trust: the Lambda MicroVMs service presents no source key when it assumes the '
          + 'role, and adding one makes the connector un-creatable (live-verified, ADR-021 P2-F1 — '
          + 'see ADR-021 section 4 for the per-role compensating controls). The '
          + 'AWS-managed VPC-access policy uses the same wildcard for the same reason.',
      },
    ], true);
  }

  /**
   * CloudWatch Logs writes scoped to the MicroVM log namespace.
   *
   * `CreateLogStream` + `PutLogEvents` go to both MicroVM-facing roles; the
   * `logs:CreateLogGroup` half is **build-role only**, and that asymmetry is
   * evidence-based rather than tidiness:
   *
   * - The service documents `CreateLogGroup` for the BUILD role, and losing build
   *   logs costs you the one artifact you need when a snapshot build fails — a
   *   failure mode we have actually hit (ADR-021 P1 4.3: the 443-only SG made the
   *   image unbuildable, and the root cause was only readable from this group).
   *   So the build role keeps it.
   * - The EXECUTION role does not get it. Across all three live runs (P1, P2 run
   *   1, P2 run 2) exactly ONE group under this prefix ever existed —
   *   `/aws/lambda-microvms/<imageName>`, the one CloudFormation pre-creates
   *   below — and both build-time and guest-runtime lines landed in it. No
   *   per-MicroVM or per-image sub-group was ever observed, and the post-run
   *   inventory (`645-p2-smoke-runbook.md` §8.6) records `/aws/lambda-microvms/*`
   *   log groups: **none** after stack deletion, with the "service-vended log
   *   groups created outside CloudFormation" list naming only
   *   `/aws/bedrock-agentcore/runtimes/…` and `/aws/lambda/…`. A create right the
   *   runtime provably never exercises does not belong on the role that runs
   *   untrusted repo code.
   *
   * ⚠️ RE-VERIFY on the pending clean re-run (ADR-021 P2 "the row is not yet
   * fully closed"). If guest logging ever goes silent on this backend, this
   * narrowing is the first thing to re-widen — the symptom would be an
   * `AccessDeniedException` naming `logs:CreateLogGroup` in the guest's stdout
   * fallback, which the MicroVM group still captures.
   *
   * @param role - the role to grant.
   * @param options - `allowCreateLogGroup` gates the build-role-only half.
   */
  private grantMicrovmLogWrites(
    role: iam.IRole,
    options: { readonly allowCreateLogGroup: boolean },
  ): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        ...(options.allowCreateLogGroup ? ['logs:CreateLogGroup'] : []),
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
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
 * statement through `assumeRolePolicy` keeps the two halves identical — which
 * since P2-F1/F3 means "identical and unconditioned": `principal.policyFragment.
 * conditions` is now empty, and the pass-through is kept deliberately rather
 * than hardcoding `{}` so that if a source-condition key ever becomes usable on
 * this path (see the trust-policy block in the constructor), adding it to the
 * principal fixes BOTH actions instead of half-closing the hole.
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
