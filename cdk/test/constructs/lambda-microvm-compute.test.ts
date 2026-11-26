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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AwsSolutionsChecks } from 'cdk-nag';
import sharedConstants from '../../../contracts/constants.json';
import { AgentMemory } from '../../src/constructs/agent-memory';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import { DEFAULT_BEDROCK_MODEL_IDS } from '../../src/constructs/bedrock-models';
import {
  DEFAULT_MINIMUM_MEMORY_MIB,
  LambdaMicrovmCompute,
  MICROVM_AGENT_HOOK_ROUTES,
  MICROVM_ARTIFACT_OBJECT_KEY,
  MICROVM_BACKEND_TAG_KEY,
  MICROVM_BACKEND_TAG_VALUE,
  MICROVM_LOG_GROUP_PREFIX,
  MICROVM_NO_INGRESS_CONNECTOR_RESOURCE,
  MICROVM_PAYLOAD_TTL_DAYS,
  MICROVM_REGION_OVERRIDE_CONTEXT,
  MICROVM_SUPPORTED_MEMORY_MIB,
  assertLambdaMicrovmRegionSupported,
  isLambdaMicrovmImageConfigured,
  microvmNoIngressConnectorArn,
} from '../../src/constructs/lambda-microvm-compute';
import { LAMBDA_MICROVM_SUPPORTED_REGIONS } from '../../src/handlers/shared/microvm-regions';

const BASE_IMAGE_ARN = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';
const ARTIFACT_SHA256 = 'a'.repeat(64);
const GITHUB_TOKEN_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:abca/github-token-AbCdEf';
const APPLICATION_LOG_GROUP_NAME =
  '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/TestStack';

interface BuildOptions {
  readonly region?: string;
  readonly context?: Record<string, unknown>;
  readonly withImage?: boolean;
  readonly imageEnvironmentVariables?: Record<string, string>;
  readonly artifactSha256?: string | null;
  readonly managedImageVersion?: string;
  readonly externalImageIdentifier?: string;
  readonly externalImageVersion?: string;
  readonly withSessionRole?: boolean;
  readonly withRuntimeParity?: boolean;
  readonly regionAgnostic?: boolean;
  readonly minimumMemoryInMiB?: number;
}

interface Built {
  readonly stack: Stack;
  readonly construct: LambdaMicrovmCompute;
  readonly template: Template;
}

function instantiate(options: BuildOptions = {}): Omit<Built, 'template'> {
  const app = new App({ context: options.context });
  const stack = new Stack(app, 'TestStack', {
    env: options.regionAgnostic
      ? undefined
      : { account: '123456789012', region: options.region ?? 'us-east-1' },
  });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });

  let agentSessionRole: AgentSessionRole | undefined;
  if (options.withSessionRole) {
    const runtimeRole = new iam.Role(stack, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    agentSessionRole = new AgentSessionRole(stack, 'AgentSessionRole', {
      assumingRoles: [runtimeRole],
      taskScopedTables: [],
      traceArtifactsBucket: new s3.Bucket(stack, 'TraceBucket'),
      attachmentsBucket: new s3.Bucket(stack, 'AttachmentsBucket'),
    });
  }

  const construct = new LambdaMicrovmCompute(stack, 'LambdaMicrovmCompute', {
    vpc,
    agentSessionRole,
    ...(options.withRuntimeParity && {
      githubTokenSecret: secretsmanager.Secret.fromSecretCompleteArn(
        stack, 'GitHubTokenSecret', GITHUB_TOKEN_SECRET_ARN,
      ),
      agentMemory: new AgentMemory(stack, 'AgentMemory'),
      applicationLogGroup: new logs.LogGroup(stack, 'ApplicationLogGroup', {
        logGroupName: APPLICATION_LOG_GROUP_NAME,
      }),
    }),
    ...(options.withImage && {
      baseImageArn: BASE_IMAGE_ARN,
      baseImageVersion: '1',
      artifactSha256: options.artifactSha256 === null ? undefined : options.artifactSha256 ?? ARTIFACT_SHA256,
    }),
    externalImageIdentifier: options.externalImageIdentifier,
    externalImageVersion: options.externalImageVersion,
    managedImageVersion: options.managedImageVersion,
    imageEnvironmentVariables: options.imageEnvironmentVariables,
    minimumMemoryInMiB: options.minimumMemoryInMiB,
  });

  return { stack, construct };
}

function build(options: BuildOptions = {}): Built {
  const { stack, construct } = instantiate(options);
  return { stack, construct, template: Template.fromStack(stack) };
}

describe.each(['global', 'eu', 'us', undefined])('LambdaMicrovmCompute — bedrockGeoRegion=%s', (geo) => {
  let template: Template;

  beforeAll(() => {
    template = build({ context: geo === undefined ? {} : { bedrockGeoRegion: geo } }).template;
  });

  test('execution role grants only the selected inference profiles and bare foundation models', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'));
    const statements = policies.flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('bedrock:InvokeModel');
      });
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual([
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ]);
    const expectedGeo = geo ?? 'us';
    const resources = statements[0].Resource;
    expect(resources).toHaveLength(DEFAULT_BEDROCK_MODEL_IDS.length * 2);
    expect(resources).not.toContain('*');
    const rendered = JSON.stringify(resources);
    for (const modelId of DEFAULT_BEDROCK_MODEL_IDS) {
      expect(rendered).toContain(`:bedrock:*::foundation-model/${modelId}`);
      expect(rendered).toContain(`:bedrock:us-east-1:123456789012:inference-profile/${expectedGeo}.${modelId}`);
    }
    if (expectedGeo !== 'us') {
      expect(rendered).not.toContain('inference-profile/us.');
    }
  });
});

test('keeps main\'s execution role description byte-for-byte', () => {
  build().template.hasResourceProperties('AWS::IAM::Role', {
    Description: 'ABCA Lambda MicroVMs execution role: assumed by the running MicroVM and its runtime '
      + 'lifecycle hooks; writes logs and reads out-of-band /run payloads.',
  });
});

test('the execution role\'s IAM5 exception follows the policies CDK splits off for a large model list', () => {
  const { stack } = instantiate({
    context: { bedrockModels: Array.from({ length: 40 }, (_, index) => `anthropic.claude-audit-${index}-v1:0`) },
  });
  Aspects.of(stack).add(new AwsSolutionsChecks());
  const template = Template.fromStack(stack);
  const policiesOf = (type: string, role: string) => Object.entries(template.findResources(type))
    .filter(([id]) => id.includes(role)).map(([, policy]) => policy);
  const overflow = policiesOf('AWS::IAM::ManagedPolicy', 'ExecutionRoleOverflowPolicy');
  expect(overflow.length).toBeGreaterThan(0);
  expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-IAM5'))
    .filter(finding => finding.id.includes('/LambdaMicrovmCompute/ExecutionRole/'))
    .map(finding => String(finding.entry.data))).toEqual([]);
  const iam5 = (policy: Record<string, any>) => policy.Metadata.cdk_nag.rules_to_suppress
    .filter((rule: { id: string }) => rule.id === 'AwsSolutions-IAM5');
  const [defaultPolicy] = policiesOf('AWS::IAM::Policy', 'ExecutionRoleDefaultPolicy');
  for (const policy of overflow) expect(policy.Metadata.cdk_nag.rules_to_suppress).toEqual(iam5(defaultPolicy));
});

describe('LambdaMicrovmCompute — image provisioned from a managed base image', () => {
  let built: Built;
  let template: Template;

  beforeAll(() => {
    built = build({ withImage: true, withSessionRole: true, withRuntimeParity: true });
    template = built.template;
  });

  describe('explicit managed runtime version', () => {
    let pinned: Built;

    beforeAll(() => {
      pinned = build({
        withImage: true, withSessionRole: true, withRuntimeParity: true, managedImageVersion: '7.0',
      });
    });

    test('pins new workers without changing the managed image build or ownership', () => {
      expect(pinned.construct.imageVersion).toBe('7.0');
      expect(pinned.template.findResources('AWS::Lambda::MicrovmImage'))
        .toEqual(template.findResources('AWS::Lambda::MicrovmImage'));
    });

    test.each(['', 'latest', '0', '1.a'])('rejects invalid runtime version %p', managedImageVersion => {
      expect(() => build({ withImage: true, managedImageVersion }))
        .toThrow('microvm_managed_image_version');
    });

    test('requires managed image inputs', () => {
      expect(() => build({ managedImageVersion: '7.0' }))
        .toThrow('microvm_managed_image_version');
    });
  });

  test('synthesizes exactly one MicroVM image from the artifact bucket object', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      BaseImageArn: BASE_IMAGE_ARN,
      BaseImageVersion: '1',
      CodeArtifact: {
        Uri: {
          'Fn::Join': ['', [
            's3://',
            { Ref: Match.stringLikeRegexp('LambdaMicrovmComputeArtifactBucket') },
            `/microvm-images/agent-artifact-${ARTIFACT_SHA256}.zip`,
          ]],
        },
      },
    });
  });

  test('a changed artifact updates the URI without replacing the image identity', () => {
    const next = build({ withImage: true, artifactSha256: 'b'.repeat(64) });
    const firstImages = template.findResources('AWS::Lambda::MicrovmImage');
    const nextImages = next.template.findResources('AWS::Lambda::MicrovmImage');
    expect(Object.keys(nextImages)).toEqual(Object.keys(firstImages));
    const first = Object.values(firstImages)[0]!.Properties;
    const second = Object.values(nextImages)[0]!.Properties;
    expect(second.Name).toEqual(first.Name);
    expect(second.CodeArtifact.Uri).not.toEqual(first.CodeArtifact.Uri);
    expect(JSON.stringify(second.CodeArtifact.Uri)).toContain(`agent-artifact-${'b'.repeat(64)}.zip`);
  });

  test.each([null, '', 'not-a-sha256', 'A'.repeat(64), 'a'.repeat(63)])(
    'rejects managed builds without an exact artifact digest: %p',
    artifactSha256 => {
      expect(() => instantiate({ withImage: true, artifactSha256 }))
        .toThrow(/microvm_artifact_sha256/);
    },
  );

  test('builds an ARM64 image at the largest ACCEPTED BASELINE (8 GiB)', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Resources: [{ MinimumMemoryInMiB: 8192 }],
    });
    expect(DEFAULT_MINIMUM_MEMORY_MIB).toBe(8192);
    expect(MICROVM_SUPPORTED_MEMORY_MIB).toEqual([512, 1024, 2048, 4096, 8192]);
    expect(Math.max(...MICROVM_SUPPORTED_MEMORY_MIB)).toBe(DEFAULT_MINIMUM_MEMORY_MIB);
  });

  test('declares all six served hooks with the shared P3 lifecycle budget', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;
    expect(hooks.Port).toBe(8080);

    expect(hooks.MicrovmHooks).toEqual({
      Run: 'ENABLED',
      RunTimeoutInSeconds: 60,
      Terminate: 'ENABLED',
      TerminateTimeoutInSeconds: 15,
      Suspend: 'ENABLED',
      SuspendTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
      Resume: 'ENABLED',
      ResumeTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
    });

    expect(hooks.MicrovmImageHooks).toEqual({
      Ready: 'ENABLED',
      ReadyTimeoutInSeconds: sharedConstants.microvm_hook_budgets.ready_hook_timeout_seconds,
      Validate: 'ENABLED',
      ValidateTimeoutInSeconds: 60,
    });
  });

  test('sends NO hook path as a property value — the fields are enums (P2-F2)', () => {
    // The L1 types every hook field as `string`; CloudFormation accepts only ENABLED or DISABLED.
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const rendered = JSON.stringify(Object.values(images)[0]!);
    expect(rendered).not.toContain('/aws/lambda-microvms/runtime/v1');
    for (const route of Object.values(MICROVM_AGENT_HOOK_ROUTES)) {
      expect(rendered).not.toContain(route);
    }
  });

  test("the out-of-band script's API request matches the CDK-managed image", () => {
    const script = readFileSync(
      resolve(__dirname, '../../scripts/package-microvm-artifact.sh'), 'utf8',
    );

    const flagJson = (flag: string): unknown => {
      const match = new RegExp(`--${flag} '([^']+)'`).exec(script);
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!);
    };

    const toCfnKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(toCfnKeys);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, inner]) => [key[0]!.toUpperCase() + key.slice(1), toCfnKeys(inner)]),
      );
    };

    const image = Object.values(template.findResources('AWS::Lambda::MicrovmImage'))[0]!;
    expect(toCfnKeys(flagJson('hooks'))).toEqual(image.Properties.Hooks);
    expect(toCfnKeys(flagJson('cpu-configurations'))).toEqual(image.Properties.CpuConfigurations);
    expect(Object.entries(flagJson('environment-variables') as Record<string, string>)
      .map(([Key, Value]) => ({ Key, Value }))).toEqual(image.Properties.EnvironmentVariables);
  });

  test('pause/wake handlers leave response headroom inside declared service timeouts', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;
    expect(hooks.MicrovmHooks.SuspendTimeoutInSeconds)
      .toBeGreaterThan(sharedConstants.microvm_hook_budgets.lifecycle_handler_budget_seconds);
    expect(hooks.MicrovmHooks.ResumeTimeoutInSeconds)
      .toBeGreaterThan(sharedConstants.microvm_hook_budgets.lifecycle_handler_budget_seconds);
  });

  test('the six declared agent hook routes share the service-owned prefix', () => {
    const routes = Object.values(MICROVM_AGENT_HOOK_ROUTES);
    expect(routes).toHaveLength(6);
    for (const route of routes) {
      expect(route).toMatch(/^\/aws\/lambda-microvms\/runtime\/v1\/(ready|validate|run|terminate|suspend|resume)$/);
    }
    expect([...routes].sort()).toEqual([
      '/aws/lambda-microvms/runtime/v1/ready',
      '/aws/lambda-microvms/runtime/v1/resume',
      '/aws/lambda-microvms/runtime/v1/run',
      '/aws/lambda-microvms/runtime/v1/suspend',
      '/aws/lambda-microvms/runtime/v1/terminate',
      '/aws/lambda-microvms/runtime/v1/validate',
    ]);
    expect(Object.keys(MICROVM_AGENT_HOOK_ROUTES).sort())
      .toEqual(['ready', 'resume', 'run', 'suspend', 'terminate', 'validate']);
  });

  test('every declared hook timeout sits inside the service window for its kind', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;

    for (const key of ['RunTimeoutInSeconds', 'TerminateTimeoutInSeconds']) {
      const value = (hooks.MicrovmHooks as Record<string, number>)[key]!;
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(60);
    }
    for (const key of ['ReadyTimeoutInSeconds', 'ValidateTimeoutInSeconds']) {
      const value = (hooks.MicrovmImageHooks as Record<string, number>)[key]!;
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3_600);
    }
  });

  test("/ready's budget comes from the contract and outlasts the agent's warm-up", () => {
    const budgets = sharedConstants.microvm_hook_budgets;
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const imageHooks = Object.values(images)[0]!.Properties.Hooks.MicrovmImageHooks;

    expect(imageHooks.ReadyTimeoutInSeconds).toBe(budgets.ready_hook_timeout_seconds);
    expect(budgets.warmup_total_budget_seconds).toBeLessThan(budgets.ready_hook_timeout_seconds);
    expect(budgets.warmup_required_timeout_seconds)
      .toBeLessThan(budgets.warmup_total_budget_seconds);
    expect(budgets.ready_hook_timeout_seconds - budgets.warmup_total_budget_seconds)
      .toBeGreaterThanOrEqual(30);
  });

  test('bakes only the non-secret image protocol marker by default', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      EnvironmentVariables: [{
        Key: sharedConstants.microvm_lifecycle.image_protocol_env,
        Value: String(sharedConstants.microvm_lifecycle.protocol_version),
      }],
    });
  });
  test('rejects an override of the image source protocol', () => {
    expect(() => instantiate({
      withImage: true,
      imageEnvironmentVariables: { [sharedConstants.microvm_lifecycle.image_protocol_env]: '999' },
    })).toThrow('protocol marker is owned by the image source');
  });

  test('routes image build-time egress through the BUILD connector, not the runtime one', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      EgressNetworkConnectors: [
        { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeBuildEgressConnector'), 'Arn'] },
      ],
    });
    expect(built.construct.buildEgressConnectorArns)
      .not.toEqual(built.construct.egressConnectorArns);
  });

  test('exposes the image ARN as both the identifier and the IAM grant scope', () => {
    expect(built.construct.imageIdentifier).toBeDefined();
    expect(built.construct.imageIdentifier).toBe(built.construct.imageArn);
    expect(built.construct.imageVersion).toBeUndefined();
  });

  test('creates TWO egress connectors on the private subnets, both with an operator role', () => {
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);

    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      // The service requires OperatorRole for VPC_EGRESS; the generated L1 types it optional.
      OperatorRole: {
        'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeConnectorOperatorRole'), 'Arn'],
      },
      Configuration: {
        VpcEgressConfiguration: {
          AssociatedComputeResourceTypes: ['MicroVm'],
          NetworkProtocol: 'IPv4',
          SubnetIds: Match.anyValue(),
          SecurityGroupIds: [
            { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeMicrovmSG'), 'GroupId'] },
          ],
        },
      },
    });

    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      OperatorRole: {
        'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeConnectorOperatorRole'), 'Arn'],
      },
      Configuration: {
        VpcEgressConfiguration: {
          SecurityGroupIds: [
            { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeMicrovmBuildSG'), 'GroupId'] },
          ],
        },
      },
    });

    const operatorRoles = Object.keys(template.findResources('AWS::IAM::Role'))
      .filter(id => id.includes('LambdaMicrovmComputeConnectorOperatorRole'));
    expect(operatorRoles).toHaveLength(1);
  });

  test('operator role trusts lambda.amazonaws.com and can manage ENIs', () => {
    const [, role] = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([id]) => id.includes('LambdaMicrovmComputeConnectorOperatorRole'))!;

    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('sts:AssumeRole');
    expect(statements[0].Principal).toEqual({ Service: 'lambda.amazonaws.com' });
    expect(statements[0].Condition).toBeUndefined();

    expect(JSON.stringify(role.Properties.ManagedPolicyArns))
      .toContain('service-role/AWSLambdaVPCAccessExecutionRole');

    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeConnectorOperatorRole'));
    const actions = policies
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>)
      .flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]);
    for (const action of [
      'ec2:CreateNetworkInterface',
      'ec2:DeleteNetworkInterface',
      'ec2:DescribeNetworkInterfaces',
      'ec2:DescribeSubnets',
      'ec2:DescribeVpcs',
      'ec2:DescribeSecurityGroups',
      'ec2:AssignPrivateIpAddresses',
      'ec2:UnassignPrivateIpAddresses',
      'ec2:CreateTags',
    ]) {
      expect(actions).toContain(action);
    }
    const rendered = JSON.stringify(policies);
    expect(rendered).not.toContain('s3:');
    expect(rendered).not.toContain('dynamodb:');
    expect(rendered).not.toContain('lambda:');
  });

  test('runtime security group allows TCP 443 egress only', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Lambda MicroVMs agent sessions - egress TCP 443 only',
      SecurityGroupEgress: [
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
      ],
    });
  });

  test('BUILD security group additionally allows TCP 80 (apt-get), and only there', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Lambda MicroVMs image BUILD - egress TCP 443 + 80 (apt-get)',
      SecurityGroupEgress: [
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }),
      ],
    });

    const [, runtimeSg] = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
      .find(([id]) => id.includes('LambdaMicrovmComputeMicrovmSG'))!;
    expect(runtimeSg.Properties.SecurityGroupEgress).toHaveLength(1);
    expect(JSON.stringify(runtimeSg.Properties.SecurityGroupEgress)).not.toContain('"FromPort":80');
  });

  test('exposes the explicit NO_INGRESS connector for RunMicrovm', () => {
    // RunMicrovm attaches a public HTTP_INGRESS connector when ingressNetworkConnectors is omitted.
    expect(built.construct.ingressConnectorArns).toHaveLength(1);
    expect(built.construct.ingressConnectorArns[0])
      .toMatch(/^arn:.+:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS$/);
    expect(MICROVM_NO_INGRESS_CONNECTOR_RESOURCE).toBe('aws-network-connector:NO_INGRESS');
    expect(built.construct.ingressConnectorArns[0]).not.toContain('123456789012');
  });

  test('creates a retention-managed log group under the service log namespace', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `${MICROVM_LOG_GROUP_PREFIX}/TestStack-abca-agent`,
      RetentionInDays: 90,
    });
  });

  test('creates the artifact and payload buckets, both private + TLS-only + encrypted', () => {
    template.resourceCountIs('AWS::S3::Bucket', 4);
    const buckets = template.findResources('AWS::S3::Bucket');
    const microvmBuckets = Object.entries(buckets).filter(([id]) => id.includes('LambdaMicrovmCompute'));
    expect(microvmBuckets).toHaveLength(2);
    for (const [, bucket] of microvmBuckets) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(bucket.Properties.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      });
    }
  });

  test('payload bucket expires objects as a fallback for failed finalization', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'microvm-payload-ttl',
            Status: 'Enabled',
            ExpirationInDays: MICROVM_PAYLOAD_TTL_DAYS,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
        ]),
      },
    });
  });

  test('artifact bucket has NO object expiry (the snapshot may be rebuilt from it)', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const [, artifactBucket] = Object.entries(buckets)
      .find(([id]) => id.includes('LambdaMicrovmComputeArtifactBucket'))!;
    const rules = artifactBucket.Properties.LifecycleConfiguration.Rules;
    expect(rules).toEqual([
      expect.objectContaining({
        Id: 'microvm-artifact-mpu-abort',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      }),
    ]);
    expect(rules[0].ExpirationInDays).toBeUndefined();
  });

  test('both roles are trusted by lambda.amazonaws.com for AssumeRole AND TagSession', () => {
    const roles = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole') || id.includes('LambdaMicrovmComputeExecutionRole'));
    expect(roles).toHaveLength(2);

    for (const [, role] of roles) {
      const statements = role.Properties.AssumeRolePolicyDocument.Statement;
      expect(statements.map((s: { Action: string }) => s.Action).sort())
        .toEqual(['sts:AssumeRole', 'sts:TagSession']);
      for (const statement of statements) {
        expect(statement.Principal).toEqual({ Service: 'lambda.amazonaws.com' });
      }
    }
  });

  test('NO source-key condition on any MicroVM-facing role trust (P2-F1/F3)', () => {
    // The service cannot assume a role whose trust policy carries a source condition (ADR-021 §4).
    const roles = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole')
        || id.includes('LambdaMicrovmComputeExecutionRole')
        || id.includes('LambdaMicrovmComputeConnectorOperatorRole'));
    expect(roles).toHaveLength(3);

    for (const [, role] of roles) {
      const trust = role.Properties.AssumeRolePolicyDocument;
      for (const statement of trust.Statement) {
        expect(statement.Condition).toBeUndefined();
      }
      const rendered = JSON.stringify(trust);
      expect(rendered).not.toContain('aws:SourceAccount');
      expect(rendered).not.toContain('aws:SourceArn');
      expect(rendered).not.toContain('aws:SourceOrgID');
    }
  });

  test('build role reads exactly the selected and manual artifacts and writes MicroVM logs', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole'));
    expect(policies).toHaveLength(1);
    const statements = policies[0]![1].Properties.PolicyDocument.Statement;
    const actions = statements.flatMap((s: { Action: string | string[] }) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions.sort()).toEqual([
      'logs:CreateLogGroup',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      's3:GetObject',
    ]);
    const s3Statement = statements.find((s: { Action: string }) => s.Action === 's3:GetObject');
    expect(JSON.stringify(s3Statement.Resource)).toContain(MICROVM_ARTIFACT_OBJECT_KEY);
    expect(s3Statement.Resource).toEqual([
      built.stack.resolve(built.construct.artifactBucket.arnForObjects(
        `microvm-images/agent-artifact-${ARTIFACT_SHA256}.zip`,
      )),
      built.stack.resolve(built.construct.artifactBucket.arnForObjects(MICROVM_ARTIFACT_OBJECT_KEY)),
    ]);
  });

  test('execution role gets READ-ONLY on the payload bucket and no write/delete', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'));
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    const actions: string[] = statements.flatMap((s: { Action: string | string[] }) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]);

    expect(actions).toContain('s3:GetObject*');
    const s3Actions = actions.filter(a => a.startsWith('s3:'));
    expect(s3Actions).toEqual(['s3:GetObject*', 's3:GetBucket*', 's3:List*']);
    for (const action of s3Actions) {
      expect(action).not.toMatch(/Put|Delete|Abort|Write|^s3:\*$/);
    }
  });

  function executionRoleStatements(): Array<{
    Action: string | string[];
    Resource?: unknown;
    Condition?: unknown;
  }> {
    return Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  }

  function statementsWithAction(action: string) {
    return executionRoleStatements().filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes(action);
    });
  }

  test('execution role reads the GitHub PAT secret (needed before the SessionRole is assumed)', () => {
    const statements = statementsWithAction('secretsmanager:GetSecretValue');
    const rendered = JSON.stringify(statements);
    expect(rendered).toContain(GITHUB_TOKEN_SECRET_ARN);
    expect(rendered).not.toContain('secretsmanager:PutSecretValue');
    expect(rendered).not.toContain('secretsmanager:UpdateSecret');
  });

  test('execution role gets the channel-OAuth PREFIX grant, GetSecretValue only', () => {
    const prefixStatement = executionRoleStatements().find(
      statement => JSON.stringify(statement.Resource ?? '').includes('bgagent-linear-oauth-*'),
    )!;
    expect(prefixStatement).toBeDefined();
    expect(prefixStatement.Action).toBe('secretsmanager:GetSecretValue');
    const resources = JSON.stringify(prefixStatement.Resource);
    expect(resources).toContain('bgagent-linear-oauth-*');
    expect(resources).toContain('bgagent-jira-oauth-*');
    expect(resources).not.toContain('secret:*');
  });

  test('execution role Bedrock grant is scoped to explicit model + inference-profile ARNs', () => {
    const statements = statementsWithAction('bedrock:InvokeModel');
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    expect(statement.Action).toEqual([
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ]);

    const resources = statement.Resource as unknown[];
    expect(resources).toHaveLength(DEFAULT_BEDROCK_MODEL_IDS.length * 2);
    const rendered = JSON.stringify(resources);
    for (const modelId of DEFAULT_BEDROCK_MODEL_IDS) {
      expect(rendered).toContain(`:bedrock:*::foundation-model/${modelId}`);
      expect(rendered).toContain(`inference-profile/us.${modelId}`);
    }
    expect(resources).not.toContain('*');
  });

  test('execution role gets AgentCore Memory read+write so learning actually persists', () => {
    const rendered = JSON.stringify(executionRoleStatements());
    expect(rendered).toContain('bedrock-agentcore:CreateEvent');
    expect(rendered).toContain('bedrock-agentcore:RetrieveMemoryRecords');
  });

  test('execution role can write to the APPLICATION_LOGS group platform_config names', () => {
    const statements = executionRoleStatements().filter((statement) => {
      const resource = JSON.stringify(statement.Resource ?? '');
      return resource.includes('ApplicationLogGroup');
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    const rendered = JSON.stringify(statements[0]!.Resource);
    expect(rendered).toContain('ApplicationLogGroup');
    expect(rendered).not.toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
  });

  test('logs:CreateLogGroup is on the BUILD role only, never the execution role', () => {
    const buildActions = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole'))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement)
      .flatMap((st: { Action: string | string[] }) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
    expect(buildActions).toContain('logs:CreateLogGroup');

    const execActions = executionRoleStatements()
      .flatMap(st => (Array.isArray(st.Action) ? st.Action : [st.Action]));
    expect(execActions).not.toContain('logs:CreateLogGroup');
    expect(execActions).toContain('logs:CreateLogStream');
    expect(execActions).toContain('logs:PutLogEvents');
  });

  test('the two logs grants stay separate — one namespace cannot cover the other', () => {
    const logsStatements = executionRoleStatements().filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some(action => action.startsWith('logs:'));
    });
    expect(logsStatements).toHaveLength(2);
    const rendered = JSON.stringify(logsStatements);
    expect(rendered).toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
    expect(rendered).toContain('ApplicationLogGroup');
    expect(rendered).not.toContain('"logs:*"');
  });

  test('execution role can describe AZs, for a CDK target repo\'s synth build gate', () => {
    const statements = statementsWithAction('ec2:DescribeAvailabilityZones');
    expect(statements).toHaveLength(1);
    // EC2 Describe* actions support no resource-level permissions, so Resource must be '*'.
    expect(statements[0]!.Resource).toBe('*');
    const ec2Actions = executionRoleStatements()
      .flatMap(st => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter(action => action.startsWith('ec2:'));
    expect(ec2Actions).toEqual(['ec2:DescribeAvailabilityZones']);
  });

  test('execution role still has NO direct DynamoDB grant — tenant data goes via the SessionRole', () => {
    expect(JSON.stringify(executionRoleStatements())).not.toContain('dynamodb:');
  });

  test('execution role gets no artifacts/trace bucket grant (delivery rides the SessionRole)', () => {
    const s3Resources = executionRoleStatements()
      .flatMap(st => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter(action => action.startsWith('s3:'));
    expect(s3Resources).toEqual(['s3:GetObject*', 's3:GetBucket*', 's3:List*']);
    const rendered = JSON.stringify(
      executionRoleStatements().filter((st) => {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
        return actions.some(action => action.startsWith('s3:'));
      }),
    );
    expect(rendered).toContain('LambdaMicrovmComputePayloadBucket');
    expect(rendered).not.toContain('TraceBucket');
    expect(rendered).not.toContain('AttachmentsBucket');
  });

  test('the BUILD role gains none of the P2 runtime grants', () => {
    const rendered = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole')),
    );
    expect(rendered).not.toContain('bedrock:');
    expect(rendered).not.toContain('bedrock-agentcore:');
    expect(rendered).not.toContain('secretsmanager:');
    expect(rendered).not.toContain('dynamodb:');
    expect(rendered).not.toContain('ec2:');
    expect(rendered).not.toContain('ApplicationLogGroup');
  });

  test('execution role is admitted to the per-task SessionRole (tenant-data delegation)', () => {
    const sessionRoles = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([id]) => id.includes('AgentSessionRole'));
    expect(sessionRoles).toHaveLength(1);
    const trust = JSON.stringify(sessionRoles[0]![1].Properties.AssumeRolePolicyDocument);
    expect(trust).toContain('sts:TagSession');
    expect(trust).toContain('LambdaMicrovmComputeExecutionRole');

    const execPolicies = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole')),
    );
    expect(execPolicies).toContain('sts:AssumeRole');
  });

  test('never grants lambda:CreateMicrovmAuthToken to anything (no JWE consumer in P1–P3)', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('CreateMicrovmAuthToken');
  });

  test('describes configured-image verification and rollback without installation-specific history', () => {
    const warnings = built.construct.node.metadata.filter(m => m.type === 'aws:cdk:warning');
    const message = warnings.map(w => String(w.data)).join('\n');
    expect(JSON.stringify(built.construct.node.metadata))
      .toContain('abca:microvm-image-p1-smoke-unverified');
    expect(JSON.stringify(built.construct.node.metadata))
      .not.toContain('abca:microvm-image-p1-not-runnable');
    expect(message).toContain('verify the configured image and coordinator together');
    for (const hook of ['/ready', '/validate', '/run', '/terminate', '/suspend', '/resume']) {
      expect(message).toContain(hook);
    }
    expect(message).toContain('actual launched image version before allowing sleep');
    expect(message).toContain('Nested deployments require bundle 1.9.0');
    expect(message).toContain('explicit image version for rollback');
    expect(message).not.toContain('Image 6.0');
  });

  test('enables every hook the agent serves, and only those (rendered form)', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const rendered = JSON.stringify(Object.values(images)[0]!.Properties.Hooks);
    for (const hook of ['Run', 'Terminate', 'Ready', 'Validate', 'Suspend', 'Resume']) {
      expect(rendered).toContain(`"${hook}":"ENABLED"`);
    }
    expect(rendered).not.toContain('DISABLED');
  });

  test('tags every MicroVM resource with the backend cost-allocation tag', () => {
    const json = template.toJSON();
    const taggedTypes = [
      'AWS::Lambda::MicrovmImage',
      'AWS::Lambda::NetworkConnector',
      'AWS::S3::Bucket',
      'AWS::IAM::Role',
      'AWS::EC2::SecurityGroup',
    ];
    for (const type of taggedTypes) {
      const allResources = json.Resources as Record<string, {
        Type: string;
        Properties?: { Tags?: Array<{ Key: string; Value: string }> };
      }>;
      const resources = Object.entries(allResources)
        .filter(([id, r]) => r.Type === type && id.includes('LambdaMicrovmCompute'));
      expect(resources.length).toBeGreaterThan(0);
      for (const [id, resource] of resources) {
        expect(resource.Properties?.Tags).toEqual(
          expect.arrayContaining([
            { Key: MICROVM_BACKEND_TAG_KEY, Value: MICROVM_BACKEND_TAG_VALUE },
          ]),
        );
        expect(id).toContain('LambdaMicrovmCompute');
      }
    }
  });
});

describe('LambdaMicrovmCompute — image built out of band', () => {
  const EXTERNAL_IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:my-agent';

  let byArn: Built;
  let byName: Built;
  let byNameVersioned: Built;

  beforeAll(() => {
    byArn = build({
      externalImageIdentifier: EXTERNAL_IMAGE_ARN,
      externalImageVersion: '7',
    });
    byName = build({ externalImageIdentifier: 'my-agent' });
    byNameVersioned = build({ externalImageIdentifier: 'my-agent', externalImageVersion: '3' });
  });

  test('uses the supplied identifier and synthesizes no image resource', () => {
    byArn.template.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    byArn.template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
    expect(byArn.construct.imageIdentifier).toBe(EXTERNAL_IMAGE_ARN);
    expect(byArn.construct.imageVersion).toBe('7');
    expect(byArn.construct.imageArn).toBe(EXTERNAL_IMAGE_ARN);
  });

  test('resolves a bare image NAME to its exact ARN and uses THAT as the identifier', () => {
    // RunMicrovm rejects a bare image name ("Malformed ARN - doesn't start with 'arn:'").
    expect(byName.construct.imageArn)
      .toMatch(/^arn:.+:lambda:us-east-1:123456789012:microvm-image:my-agent$/);
    expect(byName.construct.imageArn).not.toContain('microvm-image:*');
    expect(byName.construct.imageIdentifier).toBe(byName.construct.imageArn);
    expect(byName.construct.imageIdentifier).not.toBe('my-agent');
  });

  test('warns about the missing smoke guarantee, out-of-band path included', () => {
    for (const fixture of [byArn, byName]) {
      expect(JSON.stringify(fixture.construct.node.metadata))
        .toContain('abca:microvm-image-p1-smoke-unverified');
    }
  });

  test('an image version never changes the IAM scope', () => {
    expect(byNameVersioned.construct.imageArn).toBe(byName.construct.imageArn);
    expect(byNameVersioned.construct.imageVersion).toBe('3');
  });
});

describe('LambdaMicrovmCompute — first deploy, no image configured', () => {
  let built: Built;

  beforeAll(() => {
    built = build();
  });

  test('provisions the substrate but no image, and reports no identifier', () => {
    built.template.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    built.template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
    expect(built.construct.imageIdentifier).toBeUndefined();
  });

  test('warns (does not throw) so the artifact bucket can be created before the upload', () => {
    const warnings = built.construct.node.metadata.filter(m => m.type === 'aws:cdk:warning');
    expect(warnings).toHaveLength(1);
    const message = String(warnings[0]!.data);
    expect(message).toContain('package-microvm-artifact.sh');
    expect(message).toContain('microvm_base_image_arn');
    expect(message).toContain('microvm_image_identifier');
    expect(JSON.stringify(built.construct.node.metadata))
      .toContain('abca:microvm-image-not-provisioned');
    expect(JSON.stringify(built.construct.node.metadata))
      .not.toContain('abca:microvm-image-p1-smoke-unverified');
  });
});

describe('LambdaMicrovmCompute — optional runtime-parity props omitted', () => {
  let template: Template;

  beforeAll(() => {
    template = build({ withImage: true, withSessionRole: true }).template;
  });

  function executionRolePolicies(): string {
    return JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole')),
    );
  }

  test('no GitHub PAT read and no AgentCore Memory grant without the props', () => {
    expect(executionRolePolicies()).not.toContain(GITHUB_TOKEN_SECRET_ARN);
    expect(executionRolePolicies()).not.toContain('bedrock-agentcore:');
  });

  test('no APPLICATION_LOGS grant without the log group, and the MicroVM one remains', () => {
    const rendered = executionRolePolicies();
    expect(rendered).not.toContain('ApplicationLogGroup');
    expect(rendered).toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
  });

  test('the input-free parity grants are still there (Bedrock, channel OAuth, AZ describe)', () => {
    const rendered = executionRolePolicies();
    expect(rendered).toContain('bedrock:InvokeModel');
    expect(rendered).toContain('bgagent-linear-oauth-*');
    expect(rendered).toContain('ec2:DescribeAvailabilityZones');
  });
});

describe('LambdaMicrovmCompute — memory sizing', () => {
  let at512: Built;

  beforeAll(() => {
    at512 = build({ withImage: true, minimumMemoryInMiB: 512 });
  });

  test.each(MICROVM_SUPPORTED_MEMORY_MIB)('accepts the supported size %i MiB', (mib) => {
    expect(() => instantiate({ withImage: true, minimumMemoryInMiB: mib })).not.toThrow();
  });

  test('an explicitly supported size reaches the image resource verbatim', () => {
    at512.template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Resources: [{ MinimumMemoryInMiB: 512 }],
    });
    expect(at512.construct.minimumMemoryInMiB).toBe(512);
  });

  test('rejects the old 32768 default at SYNTH, naming the accepted baselines', () => {
    let error: Error | undefined;
    try {
      instantiate({ withImage: true, minimumMemoryInMiB: 32768 });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('32768');
    expect(error!.message).toContain('512, 1024, 2048, 4096, 8192');
    expect(error!.message).toContain('BASELINE');
  });

  test.each([0, 256, 6144, 16384, 8193])('rejects the unsupported baseline %i MiB', (mib) => {
    expect(() => instantiate({ withImage: true, minimumMemoryInMiB: mib }))
      .toThrow(/is not a BASELINE memory size AWS Lambda MicroVMs accepts/);
  });
});

describe('microvmNoIngressConnectorArn — explicit no-inbound control', () => {
  test('builds the service-owned NO_INGRESS ARN for the stack Region', () => {
    const stack = new Stack(new App(), 'S', { env: { account: '123456789012', region: 'eu-west-1' } });
    expect(microvmNoIngressConnectorArn(stack))
      .toMatch(/^arn:.+:lambda:eu-west-1:aws:network-connector:aws-network-connector:NO_INGRESS$/);
  });

  test('never names the deployment account (these connectors are AWS-owned)', () => {
    const stack = new Stack(new App(), 'S', { env: { account: '999999999999', region: 'us-west-2' } });
    expect(microvmNoIngressConnectorArn(stack)).not.toContain('999999999999');
    expect(microvmNoIngressConnectorArn(stack)).toContain(':aws:network-connector:');
  });
});

describe('assertLambdaMicrovmRegionSupported — Region gate', () => {
  let overridden: Built;

  beforeAll(() => {
    overridden = build({
      region: 'eu-central-1',
      withImage: true,
      context: { [MICROVM_REGION_OVERRIDE_CONTEXT]: true },
    });
  });

  test.each(LAMBDA_MICROVM_SUPPORTED_REGIONS)('accepts %s', (region) => {
    expect(() => instantiate({ region, withImage: true })).not.toThrow();
  });

  test('fails synth in an unsupported Region, naming the list and the escape hatch', () => {
    let error: Error | undefined;
    try {
      instantiate({ region: 'eu-central-1', withImage: true });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toMatch(/AWS Lambda MicroVMs are not available in eu-central-1/);
    expect(error!.message).toContain(MICROVM_REGION_OVERRIDE_CONTEXT);
    expect(error!.message).toContain('us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1');
    expect(error!.message).toContain('contracts/deployment-capabilities.json');
  });

  test('the context escape hatch unblocks an unsupported Region', () => {
    overridden.template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    const warning = JSON.stringify(overridden.construct.node.metadata);
    expect(warning).toContain('abca:microvm-region-override');
    expect(warning).toContain('contracts/deployment-capabilities.json');
  });

  test('skips the check for a region-agnostic (token) Region rather than rejecting it', () => {
    expect(() => instantiate({ regionAgnostic: true, withImage: true })).not.toThrow();
  });

  test('is callable standalone on any construct scope', () => {
    const supported = new Stack(new App(), 'S', { env: { account: '1', region: 'us-west-2' } });
    expect(() => assertLambdaMicrovmRegionSupported(supported)).not.toThrow();

    const unsupported = new Stack(new App(), 'S', { env: { account: '1', region: 'sa-east-1' } });
    expect(() => assertLambdaMicrovmRegionSupported(unsupported)).toThrow(/not available in sa-east-1/);
  });
});

describe('isLambdaMicrovmImageConfigured — the shared three-state predicate', () => {
  test('true for a complete managed-base-image build', () => {
    expect(isLambdaMicrovmImageConfigured({
      baseImageArn: BASE_IMAGE_ARN,
      baseImageVersion: '1',
    })).toBe(true);
  });

  test('true for an out-of-band image, by ARN or by bare name', () => {
    expect(isLambdaMicrovmImageConfigured({ externalImageIdentifier: 'abca-agent' })).toBe(true);
    expect(isLambdaMicrovmImageConfigured({
      externalImageIdentifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:abca-agent',
    })).toBe(true);
  });

  test('false for a PARTIAL base-image config (CFN requires both fields)', () => {
    expect(isLambdaMicrovmImageConfigured({ baseImageArn: BASE_IMAGE_ARN })).toBe(false);
    expect(isLambdaMicrovmImageConfigured({ baseImageVersion: '1' })).toBe(false);
  });

  test('false when nothing is configured, and a version alone never counts', () => {
    expect(isLambdaMicrovmImageConfigured({})).toBe(false);
    expect(isLambdaMicrovmImageConfigured({ externalImageVersion: '7' })).toBe(false);
  });
});
