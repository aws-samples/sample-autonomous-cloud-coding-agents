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
 * `/run` hook path. Load-bearing in P1: it is how the task payload reaches the
 * agent (`runHookPayload`, ADR-021 sub-decision 3) — there is no other
 * orchestrator→agent channel on this backend.
 */
const RUN_HOOK_PATH = '/run';

/** `/run` hook budget (seconds). The hook only validates + starts the pipeline
 *  asynchronously, so it stays well inside the service's 1–60 s hook window. */
const RUN_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Memory the image declares as its minimum, in MiB. 32 GiB is the service's
 * hard ceiling for MicroVMs (ADR-021 capability table), and the ABCA agent is a
 * build-heavy workload, so P1 asks for the ceiling rather than a smaller
 * default it would only OOM against. Repos that genuinely need more stay on the
 * `ecs` backend — that constraint is accepted in the ADR, not worked around here.
 */
const DEFAULT_MINIMUM_MEMORY_MIB = 32768;

/** Retention for the MicroVM log group — parity with the ECS task log group. */
const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/** HTTPS port — the only egress allowed out of the MicroVM ENIs. */
const HTTPS_PORT = 443;

/** Graviton/ARM64: the agent image is ARM64 on every backend. */
const CPU_ARCHITECTURE = 'arm64';

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
   * Minimum memory the image declares, in MiB.
   * @default 32768 (the service ceiling — see DEFAULT_MINIMUM_MEMORY_MIB)
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
 *  1. **Egress network connector** (`AWS::Lambda::NetworkConnector`) on the
 *     platform VPC's private-with-egress subnets, with a 443-only security
 *     group. This is what keeps the ADR's "Egress: no delta vs AgentCore/ECS"
 *     claim true — MicroVM traffic traverses the same NAT / DNS Firewall / flow
 *     logs as the other two backends.
 *  2. **Artifact bucket** for the zip + Dockerfile the service builds the
 *     snapshot from, and a **payload bucket** for `/run` payloads that exceed
 *     the 16 KB `runHookPayload` cap.
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
 * | `externalImageIdentifier` | no image resource; the supplied identifier is handed to the orchestrator | iterating on the snapshot out of band |
 * | neither | roles + buckets + connector only; a synth-time **warning**, no image, and no `MICROVM_IMAGE_IDENTIFIER` for the orchestrator | first deploy — you cannot upload the artifact before the bucket that holds it exists |
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
 * ## ⚠️ A P1 image is NOT runnable end to end
 *
 * Reaching state 1 or 2 provisions a *complete substrate* and a *buildable
 * image* — not a working backend. ADR-021 sub-decision 3's hook-phasing table
 * splits the two: P1 (this construct) **declares** the `/run` hook, but serving
 * it is agent-side work delivered in **P2**. An image built from a P1 deployment
 * boots the existing FastAPI server and then does not answer `/run`, so a
 * `lambda-microvm` task started against it will not progress past session start.
 *
 * This is called out in three places so it cannot be missed: here, in the
 * synth-time warning emitted whenever an image IS configured (see
 * `abca:microvm-image-p1-not-runnable` below), and in
 * `cdk/scripts/package-microvm-artifact.sh`. `/ready`, `/validate`,
 * `/suspend`, `/resume` and `/terminate` are deliberately not declared at all
 * yet — a hook the service calls but nothing answers fails the corresponding
 * build or lifecycle transition.
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

  /** Egress network connector bound to the platform VPC. */
  public readonly egressConnector: lambda.CfnNetworkConnector;

  /** ARNs for `MICROVM_EGRESS_CONNECTOR_ARNS` / `lambda:PassNetworkConnector`. */
  public readonly egressConnectorArns: string[];

  /** 443-only security group applied to the connector's ENIs. */
  public readonly securityGroup: ec2.SecurityGroup;

  /** Log group for MicroVM build- and run-time logs. */
  public readonly logGroup: logs.LogGroup;

  /** The image resource, when this deployment builds one (see class docs). */
  public readonly image?: lambda.CfnMicrovmImage;

  /** Image name used for the image resource and the log group. */
  public readonly imageName: string;

  /**
   * Value for `MICROVM_IMAGE_IDENTIFIER`. `undefined` in the
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

    // The connector, not the MicroVM, owns the ENIs — which is why
    // `lambda:PassNetworkConnector` is required on the orchestrator even for
    // AWS-managed connectors (ADR-021 sub-decision 4).
    //
    // `associatedComputeResourceTypes: ['MicroVm']` is the only value the
    // service accepts today (CloudFormation: "Currently, only MicroVm is
    // supported"). `operatorRole` is left unset so Lambda manages the ENIs with
    // its own service-linked role rather than a role we would have to trust.
    this.egressConnector = new lambda.CfnNetworkConnector(this, 'EgressConnector', {
      name: sanitizeImageName(`${stack.stackName}-microvm-egress`),
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          networkProtocol: 'IPv4',
          securityGroupIds: [this.securityGroup.securityGroupId],
          subnetIds: props.vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          }).subnetIds,
        },
      },
    });
    this.egressConnectorArns = [this.egressConnector.attrArn];

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
    // → Security and permissions"): *both* the build role and the execution
    // role are assumed by the ORDINARY Lambda service principal
    // `lambda.amazonaws.com`, and *both* need `sts:AssumeRole` AND
    // `sts:TagSession`. There is no `microvms.lambda.amazonaws.com` principal —
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
    // foot-gun. Narrowing to `aws:SourceArn` is a candidate once ADR-021's P1
    // "IAM action names / ARN formats" verification item is closed live.
    const microvmAssumedBy = new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
      },
    });

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
        resources: [{ minimumMemoryInMiB: props.minimumMemoryInMiB ?? DEFAULT_MINIMUM_MEMORY_MIB }],
        // Build-time network egress rides the same VPC connector as runtime, so
        // `pip`/`npm`/`uv` fetches during the snapshot build are subject to the
        // same DNS Firewall rules as the agent itself.
        egressNetworkConnectors: this.egressConnectorArns,
        logging: { cloudWatch: { logGroup: this.logGroup.logGroupName } },
        // No extra OS capabilities: the agent runs ordinary user-space tooling.
        additionalOsCapabilities: [],
        // Nothing baked in — see `imageEnvironmentVariables`.
        environmentVariables: Object.entries(props.imageEnvironmentVariables ?? {})
          .map(([key, value]) => ({ key, value })),
        hooks: {
          port: AGENT_HOOK_PORT,
          microvmHooks: {
            // ONLY `/run` in P1 — and note the agent does not SERVE it until P2
            // (ADR-021 sub-decision 3's hook-phasing table); it is declared here
            // so the image shape and IAM are reviewed once rather than twice.
            // `/suspend` and `/resume` land with the P3 interface widening, and
            // `/terminate` with P2: declaring a runtime hook the agent does not
            // answer fails the corresponding lifecycle transition. P1
            // termination is the orchestrator's `TerminateMicrovm`, which needs
            // no in-guest cooperation.
            run: RUN_HOOK_PATH,
            runTimeoutInSeconds: RUN_HOOK_TIMEOUT_SECONDS,
          },
          // `microvmImageHooks` (`/ready`, `/validate`) are the snapshot-quality
          // hooks ADR-021 sub-decision 3 wants, delivered in P2. Omitted in P1
          // because the agent does not implement them yet: configuring a
          // `/validate` endpoint that 404s would fail every image build.
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
      this.imageIdentifier = props.externalImageIdentifier;
      this.imageVersion = props.externalImageVersion;
      // `imageIdentifier` may legitimately be a bare image NAME (that is what
      // `create-microvm-image --name` returns and what `run-microvm
      // --image-identifier` accepts), which is not itself an IAM resource. Do
      // NOT let that widen the orchestrator's grant: the Service Authorization
      // Reference gives the `microvmImage` resource an unambiguous shape —
      // `arn:${Partition}:lambda:${Region}:${Account}:microvm-image:${MicrovmImageName}`
      // — so the exact ARN is derivable from the name plus this stack's
      // partition/Region/account. `formatArn` emits the Aws.PARTITION /
      // Aws.REGION / Aws.ACCOUNT_ID pseudo-parameters, so it is correct in a
      // region-agnostic app too.
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
      // Not a throw and not suppressible: P1 provisions a complete substrate and
      // a buildable image, which looks indistinguishable from a working backend
      // until a task silently fails to progress. ADR-021 sub-decision 3's
      // hook-phasing table puts serving `/run` in P2 (agent-side), so an operator
      // must be told that "deploy succeeded" is not "backend works".
      Annotations.of(this).addWarningV2(
        'abca:microvm-image-p1-not-runnable',
        'A MicroVM image is configured, but the lambda-microvm backend is not yet runnable end to '
        + 'end (ADR-021 P1). The image advertises the /run lifecycle hook, and the agent does not '
        + 'serve it until P2 — so a lambda-microvm task will start a MicroVM and then fail to '
        + 'progress past session start. Keep production repos on compute_type=agentcore or ecs '
        + 'until P2 (smoke parity) lands. The /ready, /validate, /suspend, /resume and /terminate '
        + 'hooks are deliberately not declared yet: a hook the service calls but nothing answers '
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
