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
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
const GITHUB_TOKEN_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:abca/github-token-AbCdEf';
/**
 * Physical name of the stand-in APPLICATION_LOGS group, spelled like the real one
 * (`stacks/agent.ts` → `RuntimeApplicationLogGroup`) so the grant assertions read
 * against a recognisable ARN rather than a CDK-generated one.
 */
const APPLICATION_LOG_GROUP_NAME =
  '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/TestStack';

interface BuildOptions {
  readonly region?: string;
  readonly context?: Record<string, unknown>;
  readonly withImage?: boolean;
  readonly externalImageIdentifier?: string;
  readonly externalImageVersion?: string;
  readonly withSessionRole?: boolean;
  /** Wire the P2 runtime-parity props (GitHub PAT secret + AgentCore Memory). */
  readonly withRuntimeParity?: boolean;
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
    ...(options.withRuntimeParity && {
      githubTokenSecret: secretsmanager.Secret.fromSecretCompleteArn(
        stack, 'GitHubTokenSecret', GITHUB_TOKEN_SECRET_ARN,
      ),
      agentMemory: new AgentMemory(stack, 'AgentMemory'),
      // Stands in for the stack's RuntimeApplicationLogGroup — the group whose
      // NAME travels to the guest as platform_config.log_group_name, so the grant
      // and the delivered value must come from one object (ADR-021 P2-F4).
      applicationLogGroup: new logs.LogGroup(stack, 'ApplicationLogGroup', {
        logGroupName: APPLICATION_LOG_GROUP_NAME,
      }),
    }),
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
    built = build({ withImage: true, withSessionRole: true, withRuntimeParity: true });
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
    //
    // `ARM_64`, not `arm64`: the CDK L1 types Architecture as a plain string and
    // documents no allowed values, and CloudFormation rejected the lowercase
    // spelling at change-set early validation — "arm64 is not a valid enum value.
    // Supported values: [ARM_64]" (ADR-021 P2-F2). The literal is spelled out here
    // rather than imported from the construct so the test fails if the constant is
    // "corrected" back to Docker's spelling.
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Resources: [{ MinimumMemoryInMiB: 8192 }],
    });
    expect(DEFAULT_MINIMUM_MEMORY_MIB).toBe(8192);
    expect(MICROVM_SUPPORTED_MEMORY_MIB).toEqual([512, 1024, 2048, 4096, 8192]);
    expect(Math.max(...MICROVM_SUPPORTED_MEMORY_MIB)).toBe(DEFAULT_MINIMUM_MEMORY_MIB);
  });

  test('declares EXACTLY the four hooks the agent serves (P2), and no more', () => {
    // `toEqual` on the whole object, not per-key assertions: the invariant runs in
    // BOTH directions. A hook the agent serves but the image does not declare is
    // never called (the P2 R2 regression this replaces — the agent gained
    // /validate and /terminate while the construct still advertised two hooks);
    // a hook the image declares but the agent does not serve fails the
    // corresponding build or lifecycle transition. Only an exact set catches both.
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;
    expect(hooks.Port).toBe(8080);

    // RUNTIME hooks. The VALUE of each hook field is the `ENABLED` enum, NOT the
    // agent's route: CloudFormation rejected all four paths at change-set early
    // validation — "/aws/lambda-microvms/runtime/v1/run is not a valid enum value.
    // Supported values: [DISABLED, ENABLED]" (ADR-021 P2-F2). The CFN surface is
    // identical to the API surface here; the routes are fixed and service-owned
    // (asserted separately against MICROVM_AGENT_HOOK_ROUTES below).
    expect(hooks.MicrovmHooks).toEqual({
      Run: 'ENABLED',
      RunTimeoutInSeconds: 60,
      Terminate: 'ENABLED',
      // Near the BOTTOM of the service's 1–60 s window on purpose: the handler is
      // a log-and-acknowledge with nothing to drain (progress writes are already
      // durable per event), and the budget bounds how long teardown waits on a
      // WEDGED guest that is still holding admission-gating memory quota.
      TerminateTimeoutInSeconds: 15,
    });

    // BUILD (image) hooks. /ready is MANDATORY: create-microvm-image refuses ANY
    // lifecycle hook without it, so "declare /run in P1, serve it in P2" was
    // unreachable.
    expect(hooks.MicrovmImageHooks).toEqual({
      Ready: 'ENABLED',
      // 300 s, not 60: since the P2-F5 fix /ready warms the 225 MiB `claude`
      // binary before the snapshot is captured, so it does real work whose
      // duration is a cold exec. Build hooks allow up to 3600 s, so a tight
      // budget here would trade a runtime failure for a build failure.
      ReadyTimeoutInSeconds: 300,
      Validate: 'ENABLED',
      // Decoupled from /ready by that same change: /validate's checks are still
      // sub-millisecond, so its budget is sized only for the still-initialising
      // 503 path and must NOT inherit /ready's warm-up allowance.
      ValidateTimeoutInSeconds: 60,
    });
  });

  test('sends NO hook path as a property value — the fields are enums (P2-F2)', () => {
    // The regression guard for the defect that made the whole CDK-managed image
    // path non-functional: the L1 types every hook field as `string` and documents
    // no allowed values, which is how four route strings got sent as property
    // values and were rejected at change-set validation — before the stack was
    // touched, so there was no rollback and no runtime symptom to trace back.
    // Asserting on the whole rendered resource (not just Hooks) also catches a
    // route leaking into Description, a tag, or a future property.
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const rendered = JSON.stringify(Object.values(images)[0]!);
    expect(rendered).not.toContain('/aws/lambda-microvms/runtime/v1');
    for (const route of Object.values(MICROVM_AGENT_HOOK_ROUTES)) {
      expect(rendered).not.toContain(route);
    }
  });

  test("the out-of-band script's API request matches the CDK-managed image", () => {
    // ADR-021 P2-F2/P2-F5 drift guard, and the reason it exists is that the prose
    // version of it FAILED: `cdk/scripts/package-microvm-artifact.sh` said "the
    // timeouts mirror the construct's constants … keep the two in step", and when
    // READY_HOOK_TIMEOUT_SECONDS went 60 → 300 for the /ready warm-up, the script
    // kept sending 60. Nothing caught it, because the two paths never meet in code:
    // a bash helper cannot import a TypeScript constant.
    //
    // The two requests MUST agree. An operator reaches for --create-image exactly
    // when the CDK path is failing, i.e. while debugging — so an out-of-band image
    // that behaves differently from a CDK-built one turns the fallback into a
    // second variable. This test parses the script's real flag values and compares
    // them to the synthesized template.
    const script = readFileSync(
      resolve(__dirname, '../../scripts/package-microvm-artifact.sh'), 'utf8',
    );

    /** Value of a single-quoted `--flag '<json>'` argument in the script. */
    const flagJson = (flag: string): unknown => {
      const match = new RegExp(`--${flag} '([^']+)'`).exec(script);
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!);
    };

    /** The API's camelCase keys → CloudFormation's PascalCase, recursively. */
    const toCfnKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(toCfnKeys);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, inner]) => [key[0]!.toUpperCase() + key.slice(1), toCfnKeys(inner)]),
      );
    };

    const image = Object.values(template.findResources('AWS::Lambda::MicrovmImage'))[0]!;
    // Hooks: all four states AND all four timeouts, in one comparison — which is
    // precisely the assertion the missing one would have been.
    expect(toCfnKeys(flagJson('hooks'))).toEqual(image.Properties.Hooks);
    // ...and the architecture enum, the other half of P2-F2.
    expect(toCfnKeys(flagJson('cpu-configurations'))).toEqual(image.Properties.CpuConfigurations);
  });

  test('does NOT declare /suspend or /resume — they are P3 and nothing answers them yet', () => {
    // The remaining half of the exactness rule, called out separately because it
    // is the one that must survive P3 landing suspend/resume in ONE commit across
    // all three strategies: until then, declaring either fails the corresponding
    // lifecycle transition on a real suspend attempt.
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const hooks = Object.values(images)[0]!.Properties.Hooks;
    expect(hooks.MicrovmHooks.Suspend).toBeUndefined();
    expect(hooks.MicrovmHooks.SuspendTimeoutInSeconds).toBeUndefined();
    expect(hooks.MicrovmHooks.Resume).toBeUndefined();
    expect(hooks.MicrovmHooks.ResumeTimeoutInSeconds).toBeUndefined();
  });

  test('the agent hook routes are exactly the four the service calls, under one prefix', () => {
    // The cross-package contract that used to be checked against the rendered
    // template. It cannot be any more: the template carries `ENABLED`, not a path
    // (P2-F2), so the routes now have a dedicated source — MICROVM_AGENT_HOOK_ROUTES
    // — and this asserts THAT against `MICROVM_HOOK_PREFIX` in
    // `agent/src/server.py`. A prefix drift is invisible at synth and at deploy; it
    // surfaces as a failed image build (/ready, /validate) or a failed lifecycle
    // transition on a real task (/run, /terminate). Live 2026-08-06 confirmed the
    // service POSTs to exactly these paths ("POST /aws/lambda-microvms/runtime/v1/
    // ready HTTP/1.1" 200 OK, and the same for the other three).
    const routes = Object.values(MICROVM_AGENT_HOOK_ROUTES);
    expect(routes).toHaveLength(4);
    for (const route of routes) {
      expect(route).toMatch(/^\/aws\/lambda-microvms\/runtime\/v1\/(ready|validate|run|terminate)$/);
    }
    expect([...routes].sort()).toEqual([
      '/aws/lambda-microvms/runtime/v1/ready',
      '/aws/lambda-microvms/runtime/v1/run',
      '/aws/lambda-microvms/runtime/v1/terminate',
      '/aws/lambda-microvms/runtime/v1/validate',
    ]);
    // The map's KEYS are the service's hook names, i.e. the same names the L1's
    // Hooks properties use — so "the agent serves every hook the image enables"
    // stays checkable from one place.
    expect(Object.keys(MICROVM_AGENT_HOOK_ROUTES).sort())
      .toEqual(['ready', 'run', 'terminate', 'validate']);
  });

  test('every declared hook timeout sits inside the service window for its kind', () => {
    // Runtime hooks are capped at 60 s; build hooks allow up to 3600 s. A value
    // outside its window is rejected at image-create time — minutes into a build,
    // after the artifact has already been packaged and uploaded. The build-hook
    // ceiling is what makes /ready's 300 s warm-up budget legal (P2-F5).
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

    // Same trust posture as the build/execution roles, and the same reason it
    // carries NO condition — see the dedicated test below. This role is where the
    // defect was FIRST observed: with aws:SourceAccount present, both connectors
    // CREATE_FAILED deterministically with "The service is unable to assume the
    // provided NetworkConnectorOperatorRole" (ADR-021 P2-F1).
    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('sts:AssumeRole');
    expect(statements[0].Principal).toEqual({ Service: 'lambda.amazonaws.com' });
    expect(statements[0].Condition).toBeUndefined();

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

  test('both roles are trusted by lambda.amazonaws.com for AssumeRole AND TagSession', () => {
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
      }
    }
  });

  test('NO source-key condition on any MicroVM-facing role trust (P2-F1/F3)', () => {
    // The sharpest IAM assertion in this file, and the one most likely to be
    // "fixed" back by a reviewer applying the standard service-principal
    // confused-deputy pattern. It must not be.
    //
    // The Lambda MicroVMs service presents NO source condition key when it assumes
    // these roles, so a trust policy carrying one is unassumable. Live 2026-08-06/07
    // (`docs/verification/645-p2-smoke-runbook.md`), one root cause, two symptoms:
    // both network connectors CREATE_FAILED deterministically on a freshly deleted
    // stack (P2-F1), and RunMicrovm reported a MISLEADING caller-side
    // `iam:PassRole` AccessDenied on the orchestrator (P2-F3) — with the grant
    // present, `simulate-principal-policy` returning `allowed`, no permissions
    // boundary, and an unconditioned PassRole ALSO denied. Removing the execution
    // role's trust conditions made the next submission reach RUNNING in 6 s.
    //
    // What compensates is asserted elsewhere in this file: these roles are only
    // passable by the orchestrator (scoped `iam:PassRole` + `iam:PassedToService`,
    // `test/constructs/task-orchestrator.test.ts`), and every resource they reach
    // is account-scoped by ARN.
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

  /**
   * Every statement on the execution role's inline policies, flattened. The role's
   * grants arrive from several sources (CDK `grantRead`/`grantReadWrite` plus
   * hand-written statements), and CDK may split them across policies, so the
   * assertions below work from one flattened list rather than a policy index.
   */
  function executionRoleStatements(): Array<{
    Action: string | string[];
    Resource?: unknown;
    Condition?: unknown;
  }> {
    return Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole'))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  }

  /** Statements whose action set includes `action`. */
  function statementsWithAction(action: string) {
    return executionRoleStatements().filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes(action);
    });
  }

  // --- ADR-021 P2 runtime parity on the execution role ---
  //
  // These replace P1's "the execution role has NO Bedrock / Secrets Manager /
  // DynamoDB grants" assertion, which was a scope marker rather than a property:
  // P2 is the phase that adds them. What remains a real, permanent property — and
  // is still asserted below — is that DynamoDB is NOT among them.

  test('execution role reads the GitHub PAT secret (needed before the SessionRole is assumed)', () => {
    const statements = statementsWithAction('secretsmanager:GetSecretValue');
    const rendered = JSON.stringify(statements);
    expect(rendered).toContain(GITHUB_TOKEN_SECRET_ARN);
    // grantRead, not write: the agent consumes the PAT, it never rotates it.
    expect(rendered).not.toContain('secretsmanager:PutSecretValue');
    expect(rendered).not.toContain('secretsmanager:UpdateSecret');
  });

  test('execution role gets the channel-OAuth PREFIX grant, GetSecretValue only', () => {
    // Per-workspace secrets are created by the CLI at setup, so the name is
    // unknown at synth and a prefix is the only expressible scope (mirroring
    // ecs-agent-cluster). Without it a Linear/Jira task's 👀→✅ reaction and the
    // channel MCP silently no-op.
    const prefixStatement = executionRoleStatements().find(
      statement => JSON.stringify(statement.Resource).includes('bgagent-linear-oauth-*'),
    )!;
    expect(prefixStatement).toBeDefined();
    expect(prefixStatement.Action).toBe('secretsmanager:GetSecretValue');
    const resources = JSON.stringify(prefixStatement.Resource);
    expect(resources).toContain('bgagent-linear-oauth-*');
    expect(resources).toContain('bgagent-jira-oauth-*');
    // Scoped to THIS account/Region's secrets, and to those two prefixes only —
    // never `secret:*`.
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
    // Two ARNs per model: the all-Regions foundation model and its `us.`
    // cross-Region inference profile — the same derivation the AgentCore runtime
    // and the ECS task role use, from the same shared model list.
    expect(resources).toHaveLength(DEFAULT_BEDROCK_MODEL_IDS.length * 2);
    const rendered = JSON.stringify(resources);
    for (const modelId of DEFAULT_BEDROCK_MODEL_IDS) {
      expect(rendered).toContain(`:bedrock:*::foundation-model/${modelId}`);
      expect(rendered).toContain(`inference-profile/us.${modelId}`);
    }
    // NEVER a wildcard resource — this role runs untrusted repo code.
    expect(resources).not.toContain('*');
  });

  test('execution role gets AgentCore Memory read+write so learning actually persists', () => {
    // MEMORY_ID reaches the agent in agent_payload either way, so without the
    // grant the write is ATTEMPTED and fails closed (AccessDenied → logged,
    // non-fatal), i.e. learning silently never persists on this substrate.
    const rendered = JSON.stringify(executionRoleStatements());
    expect(rendered).toContain('bedrock-agentcore:CreateEvent');
    expect(rendered).toContain('bedrock-agentcore:RetrieveMemoryRecords');
  });

  test('execution role can write to the APPLICATION_LOGS group platform_config names', () => {
    // ADR-021 P2-F4. P2 delivered `log_group_name` in platform_config — which makes
    // the agent ATTEMPT the write — without the matching grant, so every structured
    // per-task line AND the METRICS_REPORT were denied live:
    //   "…LambdaMicrovmComputeExecutionRo…/Lambda-microvmsExecutor-… is not
    //    authorized to perform: logs:CreateLogStream on resource:
    //    …:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/…"
    // Non-fatal (stdout fallback lands in the MicroVM log group) which is exactly
    // why it survived P2: the substrate looked fine while the platform's canonical
    // observability streams were empty.
    const statements = executionRoleStatements().filter((statement) => {
      const resource = JSON.stringify(statement.Resource);
      return resource.includes('ApplicationLogGroup');
    });
    expect(statements).toHaveLength(1);
    // Write-only, and only the two actions the agent's writer calls — no
    // CreateLogGroup (the stack owns the group and its retention), no read.
    expect(statements[0]!.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    // Scoped to that ONE group's ARN (whose trailing `:*` is the log-STREAM
    // wildcard — streams are minted per task), never to a log-group prefix.
    const rendered = JSON.stringify(statements[0]!.Resource);
    expect(rendered).toContain('ApplicationLogGroup');
    expect(rendered).not.toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
  });

  test('the two logs grants stay separate — one namespace cannot cover the other', () => {
    // The service's own `/aws/lambda-microvms/*` grant and the platform's
    // APPLICATION_LOGS grant are unrelated namespaces, so neither can be widened
    // into the other. Asserting both are present keeps a future "consolidation"
    // from silently dropping one.
    const logsStatements = executionRoleStatements().filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some(action => action.startsWith('logs:'));
    });
    expect(logsStatements).toHaveLength(2);
    const rendered = JSON.stringify(logsStatements);
    expect(rendered).toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
    expect(rendered).toContain('ApplicationLogGroup');
    // `logs:*` would satisfy both and is exactly what must not happen.
    expect(rendered).not.toContain('"logs:*"');
  });

  test('execution role can describe AZs, for a CDK target repo\'s synth build gate', () => {
    const statements = statementsWithAction('ec2:DescribeAvailabilityZones');
    expect(statements).toHaveLength(1);
    // EC2 describe actions have no resource-level scoping, so Resource:* is
    // mandatory; it is read-only with no mutation and no data access. Without it
    // `cdk synth` in a freshly-cloned CDK repo AccessDenies the AZ context lookup
    // and the build gate fails on code that builds fine everywhere else.
    expect(statements[0]!.Resource).toBe('*');
    // ...and it is the ONLY ec2 action granted — the connector operator role owns
    // ENI management, not this role.
    const ec2Actions = executionRoleStatements()
      .flatMap(st => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter(action => action.startsWith('ec2:'));
    expect(ec2Actions).toEqual(['ec2:DescribeAvailabilityZones']);
  });

  test('execution role still has NO direct DynamoDB grant — tenant data goes via the SessionRole', () => {
    // The permanent property. Every table the agent touches is task_id-partitioned
    // and reachable only through the SessionRole's `dynamodb:LeadingKeys`
    // condition; a direct grant here would hand a role running untrusted repo code
    // cross-task read/write and quietly break per-tenant isolation. Note the
    // asymmetry with ecs-agent-cluster, which keeps a legacy no-SessionRole
    // fallback branch — this backend has none.
    expect(JSON.stringify(executionRoleStatements())).not.toContain('dynamodb:');
  });

  test('execution role gets no artifacts/trace bucket grant (delivery rides the SessionRole)', () => {
    // The only S3 the execution role may reach is the payload bucket (read-only,
    // asserted above). Artifact delivery writes go through the SessionRole's
    // `artifacts/${task_id}/*` statement — the AgentCore runtime role has no direct
    // grant either, and granting the whole bucket here would let one task read or
    // clobber another's artifacts, traces and attachments.
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
    // The build role runs the /ready (and future /validate) hooks — i.e. code from
    // the repo under build, at image-build time — so it must stay at
    // "one artifact object + logs". A P2 grant leaking onto it would give
    // build-time repo code Bedrock/Secrets/Memory reach.
    const rendered = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeBuildRole')),
    );
    expect(rendered).not.toContain('bedrock:');
    expect(rendered).not.toContain('bedrock-agentcore:');
    expect(rendered).not.toContain('secretsmanager:');
    expect(rendered).not.toContain('dynamodb:');
    expect(rendered).not.toContain('ec2:');
    // ...including the P2-F4 application-log-group grant: the build hooks log to
    // stdout only (`_build_hook_log`), precisely so no build-time Logs write is
    // attempted, and the build role's own `/aws/lambda-microvms/*` grant is what
    // carries the service's build logs.
    expect(rendered).not.toContain('ApplicationLogGroup');
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

  test('warns that a configured image has no smoke-parity guarantee (hook phasing)', () => {
    // ADR-021 sub-decision 3, as corrected by the live P1 run and completed in P2:
    // all four served hooks are declared, so the image is creatable, launchable and
    // payload-deliverable — which makes it look even MORE like a working backend,
    // while nothing has exercised clone → change → PR on it.
    const warnings = built.construct.node.metadata.filter(m => m.type === 'aws:cdk:warning');
    const message = warnings.map(w => String(w.data)).join('\n');
    expect(JSON.stringify(built.construct.node.metadata))
      .toContain('abca:microvm-image-p1-smoke-unverified');
    // The superseded id must be gone, not merely reworded — operators grep for it.
    expect(JSON.stringify(built.construct.node.metadata))
      .not.toContain('abca:microvm-image-p1-not-runnable');
    expect(message).toContain('smoke');
    expect(message).toContain('P2');
    // It must state what IS true now, or it reads as the old (wrong) claim — and
    // the hook list here is what an operator compares against a failed build or a
    // failed lifecycle transition, so all four have to be named.
    for (const hook of ['/ready', '/validate', '/run', '/terminate']) {
      expect(message).toContain(hook);
    }
    // ...and it must still say which two are NOT declared, or the enumeration
    // above reads as "everything is wired".
    expect(message).toContain('/suspend');
    expect(message).toContain('/resume');
  });

  test('enables every hook the agent serves, and only those (rendered form)', () => {
    // Same invariant as the structural assertions above, checked against the
    // rendered template — this is the shape an operator reads in a `cdk diff`, and
    // the shape CloudFormation validates. `"ENABLED"`, never a path (P2-F2).
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    const rendered = JSON.stringify(Object.values(images)[0]!.Properties.Hooks);
    for (const hook of ['Run', 'Terminate', 'Ready', 'Validate']) {
      expect(rendered).toContain(`"${hook}":"ENABLED"`);
    }
    // P3, and nothing answers them yet. OMITTED rather than "DISABLED", so the
    // absence assertion stays meaningful.
    for (const hook of ['Suspend', 'Resume']) {
      expect(rendered).not.toContain(hook);
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

describe('LambdaMicrovmCompute — optional runtime-parity props omitted', () => {
  // Isolated-construct posture: the two PROP-driven parity grants disappear, while
  // the three that need no stack input stay. Worth pinning because "the grant is
  // conditional" is only half a contract — which half is conditional matters.
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
    // The application-log-group grant is prop-driven (isolated construct tests have
    // no stack log group), so its absence here is the contract — but the service's
    // own /aws/lambda-microvms/* grant must NOT be conditional, or a MicroVM cannot
    // write build/run logs at all.
    const rendered = executionRolePolicies();
    expect(rendered).not.toContain('ApplicationLogGroup');
    expect(rendered).toContain(`${MICROVM_LOG_GROUP_PREFIX}/*`);
  });

  test('the input-free parity grants are still there (Bedrock, channel OAuth, AZ describe)', () => {
    const rendered = executionRolePolicies();
    // These derive from the shared model list / a fixed secret-name prefix / no
    // resource at all, so nothing about a deployment can make them optional.
    expect(rendered).toContain('bedrock:InvokeModel');
    expect(rendered).toContain('bgagent-linear-oauth-*');
    expect(rendered).toContain('ec2:DescribeAvailabilityZones');
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
