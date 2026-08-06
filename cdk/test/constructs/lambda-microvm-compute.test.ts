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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import {
  DEFAULT_MINIMUM_MEMORY_MIB,
  LambdaMicrovmCompute,
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

interface BuildOptions {
  readonly region?: string;
  readonly context?: Record<string, unknown>;
  readonly withImage?: boolean;
  readonly externalImageIdentifier?: string;
  readonly externalImageVersion?: string;
  readonly withSessionRole?: boolean;
  readonly regionAgnostic?: boolean;
  readonly minimumMemoryInMiB?: number;
}

interface Built {
  readonly stack: Stack;
  readonly construct: LambdaMicrovmCompute;
  readonly template: Template;
}

/**
 * Construct a minimal stack around the construct WITHOUT synthesizing it.
 *
 * Deliberately NOT the full `AgentStack`: this file asserts the construct's own
 * contract, so a bare `Stack` + VPC keeps each template small and makes the
 * resource counts below unambiguous. Stack-level wiring is covered in
 * `test/stacks/agent.test.ts`.
 *
 * Separate from {@link build} because the Region gate throws inside the
 * construct's constructor — those cases must never reach a synth, and skipping
 * it keeps the one describe that cannot cache a `Template` cheap.
 */
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
    // AgentSessionRole requires at least one assuming role; a stand-in for the
    // AgentCore runtime role keeps this test focused on the MicroVM execution
    // role being admitted *in addition* to it.
    const runtimeRole = new iam.Role(stack, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    agentSessionRole = new AgentSessionRole(stack, 'AgentSessionRole', {
      assumingRoles: [runtimeRole],
      taskScopedTables: [
        new dynamodb.Table(stack, 'TaskTable', {
          partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
        }),
      ],
      traceArtifactsBucket: new s3.Bucket(stack, 'TraceBucket'),
      attachmentsBucket: new s3.Bucket(stack, 'AttachmentsBucket'),
    });
  }

  const construct = new LambdaMicrovmCompute(stack, 'LambdaMicrovmCompute', {
    vpc,
    agentSessionRole,
    ...(options.withImage && {
      baseImageArn: BASE_IMAGE_ARN,
      baseImageVersion: '1',
    }),
    externalImageIdentifier: options.externalImageIdentifier,
    externalImageVersion: options.externalImageVersion,
    minimumMemoryInMiB: options.minimumMemoryInMiB,
  });

  return { stack, construct };
}

/** {@link instantiate} plus one synth, for assertions against the template. */
function build(options: BuildOptions = {}): Built {
  const { stack, construct } = instantiate(options);
  return { stack, construct, template: Template.fromStack(stack) };
}

describe('LambdaMicrovmCompute — image provisioned from a managed base image', () => {
  let built: Built;
  let template: Template;

  beforeAll(() => {
    built = build({ withImage: true, withSessionRole: true });
    template = built.template;
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
            `/${MICROVM_ARTIFACT_OBJECT_KEY}`,
          ]],
        },
      },
    });
  });

  test('builds an ARM64 image at the largest ACCEPTED BASELINE (8 GiB)', () => {
    // 32768 was rejected live: "The requested memory size of 32768 MiB is not
    // supported by base MicroVM image …al2023-1. Supported memory sizes in MiB
    // are: [512, 1024, 2048, 4096, 8192]." Note this configures the BASELINE —
    // the service scales vertically to a 32 GiB / 16 vCPU peak on its own, which
    // is why nothing here asks for the peak.
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      CpuConfigurations: [{ Architecture: 'arm64' }],
      Resources: [{ MinimumMemoryInMiB: 8192 }],
    });
    expect(DEFAULT_MINIMUM_MEMORY_MIB).toBe(8192);
    expect(MICROVM_SUPPORTED_MEMORY_MIB).toEqual([512, 1024, 2048, 4096, 8192]);
    expect(Math.max(...MICROVM_SUPPORTED_MEMORY_MIB)).toBe(DEFAULT_MINIMUM_MEMORY_MIB);
  });

  test('configures /ready + /run and NOTHING else (the rest fail their transition)', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;
    expect(hooks.Port).toBe(8080);
    // Paths are the routes `agent/src/server.py` actually serves (the API model
    // has no path field at all, so a made-up path would be a silent lie).
    expect(hooks.MicrovmHooks).toEqual({
      Run: '/aws/lambda-microvms/runtime/v1/run',
      RunTimeoutInSeconds: 60,
    });
    // /ready is MANDATORY: create-microvm-image refuses ANY lifecycle hook
    // without it, so "declare /run in P1, serve it in P2" was unreachable.
    expect(hooks.MicrovmImageHooks).toEqual({
      Ready: '/aws/lambda-microvms/runtime/v1/ready',
      ReadyTimeoutInSeconds: 60,
    });
    // A hook the service calls but the agent does not serve fails the lifecycle
    // transition (or every build), so nothing else may be advertised.
    expect(hooks.MicrovmHooks.Suspend).toBeUndefined();
    expect(hooks.MicrovmHooks.Resume).toBeUndefined();
    expect(hooks.MicrovmHooks.Terminate).toBeUndefined();
    expect(hooks.MicrovmImageHooks.Validate).toBeUndefined();
  });

  test('bakes NO environment variables into the snapshot (ADR-021: no secrets in the image)', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      EnvironmentVariables: [],
    });
  });

  test('routes image build-time egress through the BUILD connector, not the runtime one', () => {
    // The runtime connector is 443-only, and `agent/Dockerfile` runs `apt-get`
    // over HTTP/80 — pointing the build at it fails every snapshot build.
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
    // Version deliberately unpinned so the service resolves the latest ACTIVE
    // version after a rebuild without a stack update.
    expect(built.construct.imageVersion).toBeUndefined();
  });

  test('creates TWO egress connectors on the private subnets, both with an operator role', () => {
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);

    // Runtime connector.
    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      // REQUIRED for VPC_EGRESS despite the generated L1 typing it optional:
      // "NetworkConnectorOperatorRole is required for VPC_EGRESS connector type".
      OperatorRole: {
        'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeConnectorOperatorRole'), 'Arn'],
      },
      Configuration: {
        VpcEgressConfiguration: {
          // The only value the service accepts today.
          AssociatedComputeResourceTypes: ['MicroVm'],
          NetworkProtocol: 'IPv4',
          SubnetIds: Match.anyValue(),
          SecurityGroupIds: [
            { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaMicrovmComputeMicrovmSG'), 'GroupId'] },
          ],
        },
      },
    });

    // Build connector — same shape, different security group.
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

    // ONE operator role shared by both — a second identical role would double
    // the IAM surface with no isolation gain.
    const operatorRoles = Object.keys(template.findResources('AWS::IAM::Role'))
      .filter(id => id.includes('LambdaMicrovmComputeConnectorOperatorRole'));
    expect(operatorRoles).toHaveLength(1);
  });

  test('operator role trusts lambda.amazonaws.com and can manage ENIs', () => {
    const [, role] = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([id]) => id.includes('LambdaMicrovmComputeConnectorOperatorRole'))!;

    // Same confused-deputy posture as the build/execution roles.
    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('sts:AssumeRole');
    expect(statements[0].Principal).toEqual({ Service: 'lambda.amazonaws.com' });
    expect(statements[0].Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': '123456789012' },
    });

    // The AWS-managed policy for exactly this job...
    expect(JSON.stringify(role.Properties.ManagedPolicyArns))
      .toContain('service-role/AWSLambdaVPCAccessExecutionRole');

    // ...plus the ENI/tag/private-IP actions the probe run showed it needs.
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
    // It manages ENIs, nothing else — no data-plane reach.
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

    // The point of two groups: port 80 must NOT leak into the runtime posture.
    const [, runtimeSg] = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
      .find(([id]) => id.includes('LambdaMicrovmComputeMicrovmSG'))!;
    expect(runtimeSg.Properties.SecurityGroupEgress).toHaveLength(1);
    expect(JSON.stringify(runtimeSg.Properties.SecurityGroupEgress)).not.toContain('"FromPort":80');
  });

  test('exposes the explicit NO_INGRESS connector for RunMicrovm', () => {
    // Load-bearing: RunMicrovm attaches a PUBLIC HTTP_INGRESS connector when the
    // field is omitted, so "no inbound" must be requested, not assumed.
    expect(built.construct.ingressConnectorArns).toHaveLength(1);
    expect(built.construct.ingressConnectorArns[0])
      .toMatch(/^arn:.+:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS$/);
    expect(MICROVM_NO_INGRESS_CONNECTOR_RESOURCE).toBe('aws-network-connector:NO_INGRESS');
    // Service-owned, not account-owned — the account segment is the literal `aws`.
    expect(built.construct.ingressConnectorArns[0]).not.toContain('123456789012');
  });

  test('creates a retention-managed log group under the service log namespace', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `${MICROVM_LOG_GROUP_PREFIX}/TestStack-abca-agent`,
      RetentionInDays: 90,
    });
  });

  test('creates the artifact and payload buckets, both private + TLS-only + encrypted', () => {
    // artifact + payload, plus the trace/attachments buckets the test's
    // AgentSessionRole fixture needs.
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

  test('payload bucket expires objects (the ONLY reaper on this backend)', () => {
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

  test('both roles are trusted by lambda.amazonaws.com for AssumeRole AND TagSession, pinned to this account', () => {
    const roles = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole') || id.includes('LambdaMicrovmComputeExecutionRole'));
    expect(roles).toHaveLength(2);

    for (const [, role] of roles) {
      const statements = role.Properties.AssumeRolePolicyDocument.Statement;
      expect(statements.map((s: { Action: string }) => s.Action).sort())
        .toEqual(['sts:AssumeRole', 'sts:TagSession']);
      for (const statement of statements) {
        // `microvms.lambda.amazonaws.com` does not exist — using it is rejected
        // with MalformedPolicyDocument.
        expect(statement.Principal).toEqual({ Service: 'lambda.amazonaws.com' });
        // Confused-deputy: lambda.amazonaws.com is shared with every other
        // Lambda feature, so aws:SourceAccount must be on BOTH actions.
        expect(statement.Condition).toEqual({
          StringEquals: { 'aws:SourceAccount': '123456789012' },
        });
        expect(JSON.stringify(statement.Condition)).not.toContain('aws:SourceArn');
      }
    }
  });

  test('build role reads exactly the one artifact object and writes MicroVM logs', () => {
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
    // Object-scoped, not bucket-scoped.
    const s3Statement = statements.find((s: { Action: string }) => s.Action === 's3:GetObject');
    expect(JSON.stringify(s3Statement.Resource)).toContain(MICROVM_ARTIFACT_OBJECT_KEY);
  });

  test('execution role gets READ-ONLY on the payload bucket and no write/delete', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'));
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    const actions: string[] = statements.flatMap((s: { Action: string | string[] }) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]);

    // CDK's grantRead renders the Get*/List* read set.
    expect(actions).toContain('s3:GetObject*');
    // The MicroVM runs untrusted repo code — it must not be able to clobber
    // another task's payload, so nothing mutating may appear.
    const s3Actions = actions.filter(a => a.startsWith('s3:'));
    expect(s3Actions).toEqual(['s3:GetObject*', 's3:GetBucket*', 's3:List*']);
    for (const action of s3Actions) {
      expect(action).not.toMatch(/Put|Delete|Abort|Write|^s3:\*$/);
    }
  });

  test('execution role has NO Bedrock / Secrets Manager / DynamoDB grants (P2 scope)', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'));
    const rendered = JSON.stringify(policies);
    expect(rendered).not.toContain('bedrock:');
    expect(rendered).not.toContain('secretsmanager:');
    expect(rendered).not.toContain('dynamodb:');
    expect(rendered).not.toContain('bedrock-agentcore:');
  });

  test('execution role is admitted to the per-task SessionRole (tenant-data delegation)', () => {
    const sessionRoles = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([id]) => id.includes('AgentSessionRole'));
    expect(sessionRoles).toHaveLength(1);
    const trust = JSON.stringify(sessionRoles[0]![1].Properties.AssumeRolePolicyDocument);
    expect(trust).toContain('sts:TagSession');
    expect(trust).toContain('LambdaMicrovmComputeExecutionRole');

    // ...and the other half of admitComputeRole: the execution role may assume it.
    const execPolicies = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole')),
    );
    expect(execPolicies).toContain('sts:AssumeRole');
  });

  test('never grants lambda:CreateMicrovmAuthToken to anything (no JWE consumer in P1–P3)', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('CreateMicrovmAuthToken');
  });

  test('warns that a P1 image has no smoke-parity guarantee (hook phasing)', () => {
    // ADR-021 sub-decision 3, as corrected by the live P1 run: P1 declares AND
    // serves /ready + /run, so the image is creatable, launchable and
    // payload-deliverable — which makes it look even more like a working backend
    // than before, while nothing has exercised clone → change → PR on it.
    const warnings = built.construct.node.metadata.filter(m => m.type === 'aws:cdk:warning');
    const message = warnings.map(w => String(w.data)).join('\n');
    expect(JSON.stringify(built.construct.node.metadata))
      .toContain('abca:microvm-image-p1-smoke-unverified');
    // The superseded id must be gone, not merely reworded — operators grep for it.
    expect(JSON.stringify(built.construct.node.metadata))
      .not.toContain('abca:microvm-image-p1-not-runnable');
    expect(message).toContain('smoke');
    expect(message).toContain('P2');
    // It must state what IS true now, or it reads as the old (wrong) claim.
    expect(message).toContain('/run');
    expect(message).toContain('/ready');
  });

  test('declares no hook the agent does not serve yet', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const rendered = JSON.stringify(Object.values(images)[0]!.Properties.Hooks);
    for (const hook of ['Suspend', 'Resume', 'Terminate', 'Validate']) {
      expect(rendered).not.toContain(hook);
    }
    expect(rendered).toContain('"Run":"/aws/lambda-microvms/runtime/v1/run"');
    expect(rendered).toContain('"Ready":"/aws/lambda-microvms/runtime/v1/ready"');
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

  // Two distinct configurations (identifier given as an ARN vs as a bare name),
  // so two cached fixtures — synthesized once each, per cdk/AGENTS.md.
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
    // The buckets/roles/connectors still exist — the substrate is provisioned.
    byArn.template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
    expect(byArn.construct.imageIdentifier).toBe(EXTERNAL_IMAGE_ARN);
    expect(byArn.construct.imageVersion).toBe('7');
    expect(byArn.construct.imageArn).toBe(EXTERNAL_IMAGE_ARN);
  });

  test('resolves a bare image NAME to its exact ARN and uses THAT as the identifier', () => {
    // Load-bearing twice over:
    //  - IAM: a bare name is not an IAM resource, but the `microvmImage` ARN
    //    shape is fully derivable from it, so the grant stays pinned to THIS
    //    image instead of widening to `microvm-image:*`.
    //  - RunMicrovm: it rejects a bare name outright ("Malformed ARN - doesn't
    //    start with 'arn:'"), so the ORCHESTRATOR must receive the ARN too. The
    //    construct therefore publishes one value for both jobs.
    // The partition stays the Aws.PARTITION pseudo-parameter (unresolved until
    // deploy) so the same code is correct in aws-cn / aws-us-gov — hence the
    // suffix assertion rather than a literal `arn:aws:` comparison.
    expect(byName.construct.imageArn)
      .toMatch(/^arn:.+:lambda:us-east-1:123456789012:microvm-image:my-agent$/);
    expect(byName.construct.imageArn).not.toContain('microvm-image:*');
    expect(byName.construct.imageIdentifier).toBe(byName.construct.imageArn);
    expect(byName.construct.imageIdentifier).not.toBe('my-agent');
  });

  test('warns about the missing smoke guarantee, out-of-band path included', () => {
    // The warning is keyed on "an image is configured", not on which of the two
    // image states produced it — an out-of-band build is just as unverified.
    for (const fixture of [byArn, byName]) {
      expect(JSON.stringify(fixture.construct.node.metadata))
        .toContain('abca:microvm-image-p1-smoke-unverified');
    }
  });

  test('an image version never changes the IAM scope', () => {
    // The SAR `microvmImage` pattern ends at the name; `imageVersion` travels as
    // a separate RunMicrovm request field.
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
    // The warning has to be actionable: it names the bootstrap remedy and the
    // context flags that move the deployment out of this state.
    expect(message).toContain('package-microvm-artifact.sh');
    expect(message).toContain('microvm_base_image_arn');
    expect(message).toContain('microvm_image_identifier');
    expect(JSON.stringify(built.construct.node.metadata))
      .toContain('abca:microvm-image-not-provisioned');
    // ...and NOT the "configured but unverified" warning — there is no image to
    // be unverified, and stacking both would blur two different remedies.
    expect(JSON.stringify(built.construct.node.metadata))
      .not.toContain('abca:microvm-image-p1-smoke-unverified');
  });
});

describe('LambdaMicrovmCompute — memory sizing', () => {
  // TEST-CONVENTION EXEMPTION (cdk/AGENTS.md "synth once in beforeAll"): the
  // rejection cases assert the CONSTRUCTOR throws, so there is no template to
  // cache; they use `instantiate()`, which never calls Template.fromStack().
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
    // The service rejects it minutes into a build; failing at synth is the whole
    // point of validating here.
    let error: Error | undefined;
    try {
      instantiate({ withImage: true, minimumMemoryInMiB: 32768 });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('32768');
    expect(error!.message).toContain('512, 1024, 2048, 4096, 8192');
    // The message must say BASELINE, or an operator reads the rejection as "this
    // backend caps at 8 GiB" and moves a repo to ECS it did not need to.
    expect(error!.message).toContain('BASELINE');
    expect(error!.message).toContain('32 GiB');
    // ...and points at the backend that DOES have the SUSTAINED capacity.
    expect(error!.message).toContain('compute_type=ecs');
  });

  test.each([0, 256, 6144, 16384, 8193])('rejects the unsupported baseline %i MiB', (mib) => {
    expect(() => instantiate({ withImage: true, minimumMemoryInMiB: mib }))
      .toThrow(/is not a BASELINE memory size AWS Lambda MicroVMs accepts/);
  });
});

describe('microvmNoIngressConnectorArn — explicit no-inbound control', () => {
  test('builds the service-owned NO_INGRESS ARN for the stack Region', () => {
    // Shape taken verbatim from the HTTP_INGRESS ARN the service attached on a
    // launch that passed NO ingress connectors, with the name swapped. The
    // partition stays the Aws.PARTITION pseudo-parameter so the same code is
    // correct in aws-cn / aws-us-gov.
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
  // TEST-CONVENTION EXEMPTION (cdk/AGENTS.md "synth once in beforeAll"):
  // these cases assert that the construct's CONSTRUCTOR throws, so there is no
  // template to cache — a fixture built in `beforeAll` would fail the hook
  // rather than the test. They stay per-case but use `instantiate()`, which
  // skips `Template.fromStack()` entirely: the gate runs as the construct's
  // first statement, so no synth is needed to observe it. The one case that
  // DOES need a template (the escape hatch succeeding) is cached below.
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
    // One instantiation, three assertions on its message — the remedy has to
    // name the Region, the supported list, and the escape hatch, or an operator
    // in a just-launched Region is stuck.
    expect(error!.message).toMatch(/AWS Lambda MicroVMs are not available in eu-central-1/);
    expect(error!.message).toContain(MICROVM_REGION_OVERRIDE_CONTEXT);
    expect(error!.message).toContain('us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1');
  });

  test('the context escape hatch unblocks an unsupported Region', () => {
    overridden.template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    // Still surfaced as a warning — the operator is ahead of the constant.
    expect(JSON.stringify(overridden.construct.node.metadata))
      .toContain('abca:microvm-region-override');
  });

  test('skips the check for a region-agnostic (token) Region rather than rejecting it', () => {
    // `cdk synth` with no CDK_DEFAULT_REGION resolves Stack.region to the
    // AWS::Region pseudo-parameter; comparing that to a Region list would fail
    // every region-agnostic synth. The live probes cover this case instead.
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
  // Public because `stacks/agent.ts` must answer "will an image exist?" BEFORE
  // TaskApi is constructed (the cancel grant's Lazy ARN depends on it), while the
  // construct answers the same question later. One predicate, so they cannot
  // drift — a drift means either a missing cancel grant or a grant scoped to an
  // image that was never created.
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
    // The construct falls through to its no-image branch here, so the predicate
    // must agree — otherwise the stack would wire a cancel grant whose Lazy ARN
    // has nothing to resolve to.
    expect(isLambdaMicrovmImageConfigured({ baseImageArn: BASE_IMAGE_ARN })).toBe(false);
    expect(isLambdaMicrovmImageConfigured({ baseImageVersion: '1' })).toBe(false);
  });

  test('false when nothing is configured, and a version alone never counts', () => {
    expect(isLambdaMicrovmImageConfigured({})).toBe(false);
    expect(isLambdaMicrovmImageConfigured({ externalImageVersion: '7' })).toBe(false);
  });
});
