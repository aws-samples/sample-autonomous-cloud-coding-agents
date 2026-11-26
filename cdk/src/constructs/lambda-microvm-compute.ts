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

import { Annotations, ArnFormat, AspectPriority, Aspects, Duration, NestedStack, RemovalPolicy, Stack, Tags, Token } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct, type IConstruct } from 'constructs';
import sharedConstants from '../../../contracts/constants.json';
import { CHANNEL_OAUTH_SECRET_PATTERNS } from '../deployment/features';
import { LAMBDA_MICROVM_SUPPORTED_REGIONS, isLambdaMicrovmRegionSupported } from '../handlers/shared/microvm-regions';
import { AgentMemory } from './agent-memory';
import { AgentSessionRole } from './agent-session-role';
import { inferenceProfileId, resolveBedrockGeoRegion, resolveBedrockModelIds } from './bedrock-models';

/** Fallback expiry (days) for /run payloads and private launch references. */
export const MICROVM_PAYLOAD_TTL_DAYS = 1;

/**
 * Per-resource cost tag identifying MicroVM infrastructure in mixed-backend stacks.
 */
export const MICROVM_BACKEND_TAG_KEY = 'abca:compute-backend';

export const MICROVM_BACKEND_TAG_VALUE = 'lambda-microvm';

/**
 * CloudWatch Logs namespace Lambda MicroVMs writes build- and run-time logs
 * under. Both the build role and the execution role are scoped to this prefix.
 */
export const MICROVM_LOG_GROUP_PREFIX = '/aws/lambda-microvms';

/**
 * Base S3 key for image artifacts. Managed builds insert the ZIP's SHA-256
 * before `.zip`, so changing code changes CodeArtifact.Uri. The unsuffixed key
 * remains available to the explicit out-of-band image builder.
 */
export const MICROVM_ARTIFACT_OBJECT_KEY = 'microvm-images/agent-artifact.zip';

const AGENT_HOOK_PORT = sharedConstants.microvm_lifecycle.hook_port;
const LIFECYCLE_HOOK_TIMEOUT_SECONDS = sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds;

/** Hook fields accept ENABLED/DISABLED, not paths. */
const HOOK_ENABLED = 'ENABLED';

const MICROVM_HOOK_ROUTE_PREFIX = '/aws/lambda-microvms/runtime/v1';

/** Fixed service routes served by agent/src/server.py. */
export const MICROVM_AGENT_HOOK_ROUTES = {
  ready: `${MICROVM_HOOK_ROUTE_PREFIX}/ready`,
  validate: `${MICROVM_HOOK_ROUTE_PREFIX}/validate`,
  run: `${MICROVM_HOOK_ROUTE_PREFIX}/run`,
  terminate: `${MICROVM_HOOK_ROUTE_PREFIX}/terminate`,
  suspend: `${MICROVM_HOOK_ROUTE_PREFIX}/suspend`,
  resume: `${MICROVM_HOOK_ROUTE_PREFIX}/resume`,
} as const;

const RUN_HOOK_TIMEOUT_SECONDS = 60;

const READY_HOOK_TIMEOUT_SECONDS = sharedConstants.microvm_hook_budgets.ready_hook_timeout_seconds;

const VALIDATE_HOOK_TIMEOUT_SECONDS = 60;

const TERMINATE_HOOK_TIMEOUT_SECONDS = 15;

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

export const DEFAULT_MINIMUM_MEMORY_MIB = MEMORY_8_GIB_IN_MIB;

const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

const HTTPS_PORT = 443;

const HTTP_PORT = 80;

/**
 * The MicroVM API spells its ARM64 enum ARM_64; Docker uses arm64.
 */
const CPU_ARCHITECTURE = 'ARM_64';
const MAX_MANAGED_IMAGE_VERSION_LENGTH = 64;

/**
 * Explicit no-ingress connector. When ingress connectors are omitted, the
 * service attaches a public HTTP_INGRESS connector.
 */
export const MICROVM_NO_INGRESS_CONNECTOR_RESOURCE = 'aws-network-connector:NO_INGRESS';

/**
 * ARN of the service-owned NO_INGRESS connector in this partition and Region.
 * Its account segment is the literal aws.
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
 * Escape hatch for Regions launched after the static support list was updated.
 * This bypasses only the static check, at synth and in `bgagent setup`; live
 * service checks still apply.
 */
export const MICROVM_REGION_OVERRIDE_CONTEXT = 'microvm_region_override';

/**
 * Reject a concrete unsupported Region at synth. Unresolved Regions defer to
 * runtime checks; microvm_region_override permits newly supported Regions.
 */
export function assertLambdaMicrovmRegionSupported(scope: Construct): void {
  const region = Stack.of(scope).region;

  if (Token.isUnresolved(region)) {
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
      + `${region}, add it to compute.lambda-microvm.regions in contracts/deployment-capabilities.json `
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
    + 'compute.lambda-microvm.regions in contracts/deployment-capabilities.json.',
  );
}

export interface LambdaMicrovmImageInputs {
  readonly baseImageArn?: string;
  readonly baseImageVersion?: string;
  readonly artifactSha256?: string;
  readonly managedImageVersion?: string;
  readonly externalImageIdentifier?: string;
  readonly externalImageVersion?: string;
}

/** Whether managed or external image inputs select an image. */
export function isLambdaMicrovmImageConfigured(inputs: LambdaMicrovmImageInputs): boolean {
  return Boolean((inputs.baseImageArn && inputs.baseImageVersion) || inputs.externalImageIdentifier);
}

export interface LambdaMicrovmComputeProps extends LambdaMicrovmImageInputs {
  /** Stable parent deployment name for image/connector names when nested. */
  readonly deploymentName?: string;

  /**
   * Parent-owned execution role. Omitted by standalone constructs, which create
   * their own execution role.
   */
  readonly executionRole?: iam.Role;

  /** Explicit names used by nested deployments to preserve bootstrap PassRole scope. */
  readonly buildRoleName?: string;
  readonly connectorOperatorRoleName?: string;

  /**
   * Platform VPC for build and runtime connectors, using private-with-egress
   * subnets and the existing DNS Firewall, NAT and flow logs.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Per-task role providing tag-scoped tenant access. The execution role can assume
   * it when supplied; omitting it grants no direct DynamoDB or artifact access.
   */
  readonly agentSessionRole?: AgentSessionRole;

  /**
   * GitHub credential read by the execution role before the task assumes its
   * SessionRole. Omit only when that startup credential is unnecessary.
   */
  readonly githubTokenSecret?: secretsmanager.ISecret;

  /**
   * Platform Memory used for cross-task learning. Grants execution-role read/write
   * access; omit for deployments without Memory.
   */
  readonly agentMemory?: AgentMemory;

  /**
   * Platform APPLICATION_LOGS group named in platform_config. Its write grant is
   * separate from the service-owned /aws/lambda-microvms log namespace.
   */
  readonly applicationLogGroup?: logs.ILogGroup;

  /**
   * Service-managed base image ARN, discovered with list-managed-microvm-images.
   * With baseImageVersion and artifactSha256, creates a CloudFormation-managed image.
   */
  readonly baseImageArn?: string;

  /**
   * Base image version, required alongside baseImageArn by CloudFormation.
   */
  readonly baseImageVersion?: string;

  /**
   * SHA-256 of the uploaded ZIP, printed by package-microvm-artifact.sh.
   * Required for managed images: a mutable fixed key does not trigger updates.
   */
  readonly artifactSha256?: string;

  /**
   * Optional version to RUN from the managed image (for example `7.0`).
   * This does not alter the image build or transfer its CloudFormation ownership.
   * Omit to run the latest active version; pin a verified version for rollback.
   */
  readonly managedImageVersion?: string;

  /**
   * Name or ARN of an image built outside this construct. Used only when managed
   * base-image inputs are absent.
   */
  readonly externalImageIdentifier?: string;

  /**
   * Version of {@link externalImageIdentifier}. Optional: the service resolves
   * the latest active version when omitted.
   */
  readonly externalImageVersion?: string;

  /**
   * Name for the MicroVM image and its log group. Must be unique in the
   * account.
   * @default `<stackName>-abca-agent`
   */
  readonly imageName?: string;

  /**
   * Base S3 key of the zip + Dockerfile artifact. Managed builds append the
   * artifact digest before `.zip`; the manual builder uses this base key.
   * @default MICROVM_ARTIFACT_OBJECT_KEY
   */
  readonly artifactObjectKey?: string;

  /**
   * Service baseline in MiB; must be one of {@link MICROVM_SUPPORTED_MEMORY_MIB}.
   * This setting does not guarantee workload fit or capacity-change timing.
   * @default 8192
   */
  readonly minimumMemoryInMiB?: number;

  /**
   * Image-invariant, non-secret settings only. The construct also adds its lifecycle
   * protocol marker. Deployment configuration, credentials and task identity arrive
   * through /run and must not be baked into a shared snapshot.
   * @default {} — no caller-supplied settings
   */
  readonly imageEnvironmentVariables?: Record<string, string>;

  /**
   * Secrets Manager name patterns of the channel OAuth bundles the agent may
   * read: only those of deployed trackers.
   * @default both `bgagent-linear-oauth-*` and `bgagent-jira-oauth-*` (legacy topology)
   */
  readonly channelOauthSecretPatterns?: readonly string[];
}

/**
 * Lambda MicroVM infrastructure: build/runtime VPC connectors, image artifacts,
 * task payloads, logs, roles and an optional managed image.
 *
 * Runtime egress permits HTTPS; the separate build connector also permits HTTP
 * for apt-get. Every launch explicitly selects NO_INGRESS. The execution role
 * reads its task payload and startup credentials, invokes models, writes logs
 * and uses Memory. Tenant data remains on the per-task SessionRole; lifecycle
 * control remains on coordinator and decision-handler roles.
 *
 * Image provisioning has three states:
 * - baseImageArn + baseImageVersion + artifactSha256: build a managed image.
 * - externalImageIdentifier: use an image built outside this construct.
 * - neither: create infrastructure for the initial artifact upload, with a warning;
 *   tasks cannot run until an image is configured.
 *
 * Managed images enable all six served hooks. Automatic approval sleep requires
 * a compatible image and coordinator plus the deployment enable switch.
 */
export class LambdaMicrovmCompute extends Construct {
  /** S3 bucket holding the zip + Dockerfile the snapshot is built from. */
  public readonly artifactBucket: s3.Bucket;

  /** Key of the artifact object inside {@link artifactBucket}. */
  public readonly artifactObjectKey: string;
  /** Unsuffixed key used by the manual builder and packaging helper. */
  public readonly artifactBaseObjectKey: string;

  /** S3 bucket holding oversized `/run` payloads (S3-pointer delivery). */
  public readonly payloadBucket: s3.Bucket;

  /** Role Lambda assumes while building the snapshot image. */
  public readonly buildRole: iam.Role;

  /** Role the running MicroVM (and its runtime lifecycle hooks) assumes. */
  public readonly executionRole: iam.Role;

  /**
   * Service role managing connector ENIs; required for VPC_EGRESS.
   */
  public readonly connectorOperatorRole: iam.Role;

  /** Runtime egress network connector bound to the platform VPC (443 only). */
  public readonly egressConnector: lambda.CfnNetworkConnector;

  /** ARNs for `MICROVM_EGRESS_CONNECTOR_ARNS` / `lambda:PassNetworkConnector`. */
  public readonly egressConnectorArns: string[];

  /**
   * Build-time egress network connector (443 **and** 80), used only by the image
   * build — never by a running MicroVM.
   */
  public readonly buildEgressConnector: lambda.CfnNetworkConnector;

  /** ARNs to pass as `create-microvm-image --egress-network-connectors`. */
  public readonly buildEgressConnectorArns: string[];

  /**
   * Explicit NO_INGRESS connector passed on every RunMicrovm request.
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

  /**
   * Configured image memory baseline in MiB.
   */
  public readonly minimumMemoryInMiB: number;

  /**
   * Full image ARN for RunMicrovm. Undefined during the no-image bootstrap phase;
   * bare external names are resolved to ARNs for both launch and IAM.
   */
  public readonly imageIdentifier?: string;

  /** Value for `MICROVM_IMAGE_VERSION`, when pinned. */
  public readonly imageVersion?: string;

  /**
   * Exact image ARN used to scope lifecycle IAM; undefined only before an image
   * is configured. Image versions are separate request fields, not ARN suffixes.
   */
  public readonly imageArn?: string;

  constructor(scope: Construct, id: string, props: LambdaMicrovmComputeProps) {
    super(scope, id);

    assertLambdaMicrovmRegionSupported(this);

    const stack = Stack.of(this);
    const deploymentName = props.deploymentName ?? stack.stackName;
    if (Token.isUnresolved(deploymentName)) {
      throw new Error('Nested MicroVM resources require a concrete deploymentName from the parent stack');
    }
    const managedImage = Boolean(props.baseImageArn && props.baseImageVersion);
    if ((managedImage || props.artifactSha256 !== undefined)
      && !/^[a-f0-9]{64}$/.test(props.artifactSha256 ?? '')) {
      throw new Error(
        'Managed MicroVM images require microvm_artifact_sha256 (64 lowercase hex characters). '
        + 'Run cdk/scripts/package-microvm-artifact.sh and deploy with its printed artifact digest.',
      );
    }
    this.artifactBaseObjectKey = props.artifactObjectKey ?? MICROVM_ARTIFACT_OBJECT_KEY;
    this.artifactObjectKey = props.artifactSha256
      ? `${this.artifactBaseObjectKey.replace(/\.zip$/, '')}-${props.artifactSha256}.zip`
      : this.artifactBaseObjectKey;
    this.imageName = props.imageName ?? sanitizeImageName(`${deploymentName}-abca-agent`);

    this.minimumMemoryInMiB = props.minimumMemoryInMiB ?? DEFAULT_MINIMUM_MEMORY_MIB;
    if (!MICROVM_SUPPORTED_MEMORY_MIB.includes(this.minimumMemoryInMiB)) {
      throw new Error(
        `minimumMemoryInMiB=${this.minimumMemoryInMiB} is not a BASELINE memory size AWS Lambda `
        + `MicroVMs accepts. Supported baselines (MiB): ${MICROVM_SUPPORTED_MEMORY_MIB.join(', ')}. `
        + `The default is ${DEFAULT_MINIMUM_MEMORY_MIB}. Choose a supported baseline and verify `
        + 'that the workload fits; this setting alone does not establish available peak capacity.',
      );
    }

    Tags.of(this).add(MICROVM_BACKEND_TAG_KEY, MICROVM_BACKEND_TAG_VALUE);

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

    // The MicroVM service rejects source-conditioned trust on all three roles
    // and conditioned PassRole on the build/execution paths (ADR-021 §4).
    const microvmAssumedBy = new iam.ServicePrincipal('lambda.amazonaws.com');
    this.connectorOperatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      roleName: props.connectorOperatorRoleName,
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
      resources: ['*'],
    }));

    const vpcEgressSubnetIds = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    this.egressConnector = new lambda.CfnNetworkConnector(this, 'EgressConnector', {
      name: sanitizeImageName(`${deploymentName}-microvm-egress`),
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

    this.buildEgressConnector = new lambda.CfnNetworkConnector(this, 'BuildEgressConnector', {
      name: sanitizeImageName(`${deploymentName}-microvm-build-egress`),
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

    this.ingressConnectorArns = [microvmNoIngressConnectorArn(this)];

    this.logGroup = new logs.LogGroup(this, 'MicrovmLogGroup', {
      logGroupName: `${MICROVM_LOG_GROUP_PREFIX}/${this.imageName}`,
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'microvm-artifact-mpu-abort',
          enabled: true,
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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

    this.buildRole = new iam.Role(this, 'BuildRole', {
      roleName: props.buildRoleName,
      assumedBy: microvmAssumedBy,
      description:
        'ABCA Lambda MicroVMs image-build role: reads the zip+Dockerfile artifact from S3 '
        + 'and writes snapshot build logs to CloudWatch.',
    });
    grantTagSession(this.buildRole, microvmAssumedBy);

    this.buildRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [...new Set([this.artifactObjectKey, this.artifactBaseObjectKey])]
        .map(key => this.artifactBucket.arnForObjects(key)),
    }));
    this.grantMicrovmLogWrites(this.buildRole, { allowCreateLogGroup: true });

    this.executionRole = props.executionRole ?? createMicrovmExecutionRole(this, 'ExecutionRole');
    this.grantMicrovmLogWrites(this.executionRole, { allowCreateLogGroup: false });

    props.applicationLogGroup?.grantWrite(this.executionRole);

    this.payloadBucket.grantRead(this.executionRole);

    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(this.executionRole);
    }

    if (props.githubTokenSecret) {
      props.githubTokenSecret.grantRead(this.executionRole);
    }

    const channelOauthSecretPatterns = props.channelOauthSecretPatterns ?? CHANNEL_OAUTH_SECRET_PATTERNS;
    if (channelOauthSecretPatterns.length > 0) {
      this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: channelOauthSecretPatterns.map(resourceName => stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName,
        })),
      }));
    }

    const bedrockGeoRegion = resolveBedrockGeoRegion(this.node);
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
          resourceName: inferenceProfileId(bedrockGeoRegion, modelId),
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

    if (props.agentMemory) {
      props.agentMemory.grantReadWrite(this.executionRole);
    }

    this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));

    if (props.managedImageVersion !== undefined
      && (!props.baseImageArn || !props.baseImageVersion
        || typeof props.managedImageVersion !== 'string'
        || Token.isUnresolved(props.managedImageVersion)
        || props.managedImageVersion.length > MAX_MANAGED_IMAGE_VERSION_LENGTH
        || !/^[1-9]\d*(?:\.\d+)?$/.test(props.managedImageVersion))) {
      throw new Error('microvm_managed_image_version requires managed base-image inputs and a literal positive image version');
    }
    if (props.baseImageArn && props.baseImageVersion) {
      const requestedProtocol = props.imageEnvironmentVariables?.[sharedConstants.microvm_lifecycle.image_protocol_env];
      if (requestedProtocol !== undefined && requestedProtocol !== String(sharedConstants.microvm_lifecycle.protocol_version)) {
        throw new Error('The managed MicroVM lifecycle protocol marker is owned by the image source');
      }
      this.image = new lambda.CfnMicrovmImage(this, 'Image', {
        name: this.imageName,
        description: `ABCA agent snapshot for ${deploymentName} (ADR-021 lambda-microvm backend)`,
        baseImageArn: props.baseImageArn,
        baseImageVersion: props.baseImageVersion,
        buildRoleArn: this.buildRole.roleArn,
        codeArtifact: {
          uri: this.artifactBucket.s3UrlForObject(this.artifactObjectKey),
        },
        cpuConfigurations: [{ architecture: CPU_ARCHITECTURE }],
        resources: [{ minimumMemoryInMiB: this.minimumMemoryInMiB }],
        egressNetworkConnectors: this.buildEgressConnectorArns,
        logging: { cloudWatch: { logGroup: this.logGroup.logGroupName } },
        additionalOsCapabilities: [],
        environmentVariables: Object.entries({
          ...props.imageEnvironmentVariables,
          [sharedConstants.microvm_lifecycle.image_protocol_env]:
            String(sharedConstants.microvm_lifecycle.protocol_version),
        })
          .map(([key, value]) => ({ key, value })),
        hooks: {
          port: AGENT_HOOK_PORT,
          microvmHooks: {
            run: HOOK_ENABLED,
            runTimeoutInSeconds: RUN_HOOK_TIMEOUT_SECONDS,
            terminate: HOOK_ENABLED,
            terminateTimeoutInSeconds: TERMINATE_HOOK_TIMEOUT_SECONDS,
            suspend: HOOK_ENABLED,
            suspendTimeoutInSeconds: LIFECYCLE_HOOK_TIMEOUT_SECONDS,
            resume: HOOK_ENABLED,
            resumeTimeoutInSeconds: LIFECYCLE_HOOK_TIMEOUT_SECONDS,
          },
          microvmImageHooks: {
            ready: HOOK_ENABLED,
            readyTimeoutInSeconds: READY_HOOK_TIMEOUT_SECONDS,
            validate: HOOK_ENABLED,
            validateTimeoutInSeconds: VALIDATE_HOOK_TIMEOUT_SECONDS,
          },
        },
      });
      this.image.node.addDependency(this.buildRole, this.artifactBucket);

      this.imageIdentifier = this.image.attrImageArn;
      this.imageArn = this.image.attrImageArn;
      this.imageVersion = props.managedImageVersion;
    } else if (props.externalImageIdentifier) {
      this.imageVersion = props.externalImageVersion;
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
        + '--context microvm_artifact_sha256=<digest printed by the script> '
        + '(or point at an image you built by hand with --context microvm_image_identifier=<name|arn>).',
      );
    }

    if (this.imageIdentifier) {
      Annotations.of(this).addWarningV2(
        'abca:microvm-image-p1-smoke-unverified',
        'A MicroVM image is configured. Before enabling automatic suspension, verify the configured '
        + 'image and coordinator together using the P3 acceptance procedure. The coordinator checks the '
        + 'actual launched image version before allowing sleep. The agent serves /ready, /validate, '
        + '/run, /terminate, /suspend and /resume; managed images declare all six. '
        + 'Nested deployments require bundle 1.9.0 and a reviewed migration from existing flat stacks. '
        + 'Preserve a compatible coordinator and explicit image version for rollback. Follow '
        + 'docs/verification/README.md and docs/verification/645-p3-nested-stack.md.',
      );
    }

    NagSuppressions.addResourceSuppressions([this.artifactBucket, this.payloadBucket], [
      {
        id: 'AwsSolutions-S1',
        reason: 'Artifact bucket holds versioned agent zip+Dockerfile build inputs read only by '
          + 'the Lambda MicroVMs build role; the payload bucket holds ephemeral per-task /run payloads '
          + `with a ${MICROVM_PAYLOAD_TTL_DAYS}-day TTL, written only by the orchestrator and `
          + 'read only by the MicroVM execution role, both scoped to the bucket. Object-level access '
          + 'logging (a second log bucket + CloudTrail data events) is not justified for these '
          + 'build inputs or for transient boot payloads.',
      },
    ], true);

    const roleIam5 = [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch Logs wildcard is the service-owned '
          + `${MICROVM_LOG_GROUP_PREFIX}/* namespace (log stream names are minted per MicroVM, so no `
          + 'synth-time ARN exists); S3 object/* wildcard comes from CDK grantRead on the dedicated '
          + 'payload bucket (read-only, scoped to that bucket — ADR-021 sub-decision 3). The build '
          + 'role\'s s3:GetObject names the selected artifact and manual-build key. On the execution '
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
    ];
    NagSuppressions.addResourceSuppressions([this.buildRole, this.executionRole], roleIam5, true);
    // When the execution role's policy outgrows the inline limit, CDK moves statements
    // into managed policies during synthesis. Default priority runs this after cdk-nag.
    Aspects.of(this.executionRole).add({
      visit(node: IConstruct): void {
        if (node instanceof iam.CfnManagedPolicy) NagSuppressions.addResourceSuppressions(node, roleIam5);
      },
    }, { priority: AspectPriority.MUTATING });

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
        reason: 'EC2 Describe actions require wildcard resources. ENI mutations retain the '
          + 'wildcard scope validated with the MicroVM service; that does not establish that '
          + 'narrower mutation permissions are impossible. The role manages the two platform '
          + 'connectors, trusts lambda.amazonaws.com and has no tenant-data grant. Source-conditioned '
          + 'trust failed the recorded live checks; ADR-021 section 4 documents the limitation.',
      },
    ], true);
  }

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

/** Create the runtime role in its owning stack, independently of image resources. */
export function createMicrovmExecutionRole(scope: Construct, id: string): iam.Role {
  const principal = new iam.ServicePrincipal('lambda.amazonaws.com');
  const role = new iam.Role(scope, id, {
    assumedBy: principal,
    description:
      'ABCA Lambda MicroVMs execution role: assumed by the running MicroVM and its runtime '
      + 'lifecycle hooks; writes logs and reads out-of-band /run payloads.',
  });
  grantTagSession(role, principal);
  Tags.of(role).add(MICROVM_BACKEND_TAG_KEY, MICROVM_BACKEND_TAG_VALUE);
  return role;
}

/** The MicroVM service requires sts:TagSession beside sts:AssumeRole in the trust policy. */
function grantTagSession(role: iam.Role, principal: iam.ServicePrincipal): void {
  role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
    actions: ['sts:TagSession'],
    principals: [principal],
    conditions: principal.policyFragment.conditions,
  }));
}

function sanitizeImageName(candidate: string): string {
  const MAX_NAME_LENGTH = 64;
  return candidate
    .replace(/[^A-Za-z0-9-_]/g, '-')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, '');
}

export interface LambdaMicrovmStackProps extends Omit<
  LambdaMicrovmComputeProps, 'buildRoleName' | 'connectorOperatorRoleName'
> {
  readonly deploymentName: string;
  readonly executionRole: iam.Role;
  /** Distinct image/connector/log names for an overlapping flat-to-nested migration. */
  readonly resourceNamePrefix?: string;
}

/** Child deployment for MicroVM resources; shared runtime trust stays in the parent. */
export class LambdaMicrovmStack extends NestedStack {
  public readonly compute: LambdaMicrovmCompute;

  constructor(scope: Construct, id: string, props: LambdaMicrovmStackProps) {
    super(scope, id, {
      description: 'ABCA Lambda MicroVM image, storage, build roles and network connectors',
    });
    if (Stack.of(props.executionRole) !== this.nestedStackParent) {
      throw new Error('LambdaMicrovmStack executionRole must be owned by its parent stack');
    }
    if (props.resourceNamePrefix !== undefined
      && (Token.isUnresolved(props.resourceNamePrefix)
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(props.resourceNamePrefix))) {
      throw new Error('microvm_resource_name_prefix must be 1–40 letters, digits or hyphens and start with a letter or digit');
    }
    // CDK creates bucket-cleanup providers at stack scope, outside Compute.
    Tags.of(this).add(MICROVM_BACKEND_TAG_KEY, MICROVM_BACKEND_TAG_VALUE);
    const roleName = (suffix: string): string => {
      const name = `${props.deploymentName}-${suffix}`;
      if (Token.isUnresolved(name) || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(name)) {
        throw new Error(`Nested MicroVM role name must be concrete and at most 64 characters: ${suffix}`);
      }
      return name;
    };
    this.compute = new LambdaMicrovmCompute(this, 'Compute', {
      ...props,
      deploymentName: props.resourceNamePrefix ?? props.deploymentName,
      buildRoleName: roleName('MicrovmBuildRole'),
      connectorOperatorRoleName: roleName('MicrovmConnectorRole'),
    });
  }
}
