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

import * as path from 'path';
import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentMemory } from '../../src/constructs/agent-memory';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import { DEFAULT_BEDROCK_MODEL_IDS } from '../../src/constructs/bedrock-models';
import { EcsAgentCluster, resolveEcsTaskSizing } from '../../src/constructs/ecs-agent-cluster';
import { LinearIdentityVault } from '../../src/constructs/linear-identity-vault';

function createStack(overrides?: {
  memoryId?: string;
  bedrockModels?: string[];
  bedrockGeoRegion?: string;
  withMemory?: boolean;
  withNudgesTable?: boolean;
  withLinearVault?: boolean;
  withApprovals?: boolean;
  withNagChecks?: boolean;
  taskSizing?: {
    buildTaskCpu?: number;
    buildTaskMemoryMiB?: number;
    buildTaskEphemeralStorageGiB?: number;
    planningTaskCpu?: number;
    planningTaskMemoryMiB?: number;
    extraBuildEnvironment?: Record<string, string>;
  };
}): { stack: Stack; template: Template } {
  const app = new App({
    context: {
      ...(overrides?.bedrockModels && { bedrockModels: overrides.bedrockModels }),
      ...(overrides?.bedrockGeoRegion && { bedrockGeoRegion: overrides.bedrockGeoRegion }),
    },
  });
  const stack = new Stack(app, 'TestStack');
  if (overrides?.withNagChecks) Aspects.of(stack).add(new AwsSolutionsChecks());

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });

  const agentImageAsset = new ecr_assets.DockerImageAsset(stack, 'AgentImage', {
    directory: path.join(__dirname, '..', '..', '..', 'agent'),
  });

  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });

  const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
  });

  const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
    partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  });
  const taskApprovalsTable = overrides?.withApprovals
    ? new dynamodb.Table(stack, 'TaskApprovalsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'request_id', type: dynamodb.AttributeType.STRING },
    })
    : undefined;

  const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');

  const agentMemory = overrides?.withMemory ? new AgentMemory(stack, 'AgentMemory') : undefined;

  const taskNudgesTable = overrides?.withNudgesTable
    ? new dynamodb.Table(stack, 'TaskNudgesTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nudge_id', type: dynamodb.AttributeType.STRING },
    })
    : undefined;

  const linearIdentityVault = overrides?.withLinearVault
    ? new LinearIdentityVault(stack, 'LinearIdentityVault', {
      workloadName: 'abca_linear_oauth',
      allowedReturnUrls: ['http://localhost:8080/oauth/callback'],
    })
    : undefined;

  new EcsAgentCluster(stack, 'EcsAgentCluster', {
    vpc,
    agentImageAsset,
    taskTable,
    taskEventsTable,
    taskApprovalsTable,
    userConcurrencyTable,
    githubTokenSecret,
    memoryId: overrides?.memoryId,
    agentMemory,
    taskNudgesTable,
    ...(linearIdentityVault && { linearIdentityVault }),
    ...(overrides?.taskSizing && { taskSizing: overrides.taskSizing }),
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('resolveEcsTaskSizing — the sizing knobs must be reachable at deploy time', () => {
  const nodeWith = (context: Record<string, unknown>) => new Stack(new App({ context }), 'S').node;

  test('returns undefined when nothing is set, so construct defaults apply', () => {
    expect(resolveEcsTaskSizing(nodeWith({}))).toBeUndefined();
  });

  test('a heavy monorepo can reach the Fargate ceiling from context alone', () => {
    expect(resolveEcsTaskSizing(nodeWith({
      ecsBuildTaskCpu: '16384',
      ecsBuildTaskMemoryMiB: '122880',
      ecsBuildTaskEphemeralStorageGiB: '100',
    }))).toEqual({
      buildTaskCpu: 16384,
      buildTaskMemoryMiB: 122880,
      buildTaskEphemeralStorageGiB: 100,
    });
  });

  test('a malformed number throws at synth rather than silently defaulting', () => {
    expect(() => resolveEcsTaskSizing(nodeWith({ ecsBuildTaskCpu: 'lots' })))
      .toThrow(/must be a positive integer/);
    expect(() => resolveEcsTaskSizing(nodeWith({ ecsBuildTaskMemoryMiB: '-1' })))
      .toThrow(/must be a positive integer/);
  });

  test('build-tool env overrides come through as JSON', () => {
    expect(resolveEcsTaskSizing(nodeWith({ ecsExtraBuildEnv: '{"MISE_JOBS":"8"}' })))
      .toEqual({ extraBuildEnvironment: { MISE_JOBS: '8' } });
  });

  test('a RESERVED platform env key is REJECTED, not merged', () => {
    expect(() => resolveEcsTaskSizing(nodeWith({
      ecsExtraBuildEnv: '{"AGENT_SESSION_ROLE_ARN":""}',
    }))).toThrow(/cannot set 'AGENT_SESSION_ROLE_ARN'/);
    expect(() => resolveEcsTaskSizing(nodeWith({
      ecsExtraBuildEnv: '{"TASK_TABLE_NAME":"attacker-table"}',
    }))).toThrow(/platform wiring/);
  });

  test('a non-string env value is rejected', () => {
    expect(() => resolveEcsTaskSizing(nodeWith({ ecsExtraBuildEnv: '{"MISE_JOBS":8}' })))
      .toThrow(/must be a string/);
  });
});

describe('EcsAgentCluster construct', () => {
  let baseTemplate: Template;

  beforeAll(() => {
    baseTemplate = createStack().template;
  });

  test('creates an ECS Cluster with container insights', () => {
    baseTemplate.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: Match.arrayWith([
        Match.objectLike({
          Name: 'containerInsights',
          Value: 'enabled',
        }),
      ]),
    });
  });

  test('the BUILD def defaults to a MODEST size, not the Fargate maximum', () => {
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
  });

  test('the BUILD def keeps real DISK margin, unlike CPU and memory', () => {
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      EphemeralStorage: { SizeInGiB: 50 },
    });
  });

  test('a heavy monorepo can raise the build task to the Fargate ceiling', () => {
    createStack({
      taskSizing: {
        buildTaskCpu: 16384,
        buildTaskMemoryMiB: 122880,
        buildTaskEphemeralStorageGiB: 100,
      },
    }).template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '16384',
      Memory: '122880',
      EphemeralStorage: { SizeInGiB: 100 },
    });
  });

  test('build-tool env vars are overridable, so tuned values are not everyone\'s default', () => {
    const template = createStack({
      taskSizing: { extraBuildEnvironment: { MISE_JOBS: '8', JEST_MAX_WORKERS: '50%' } },
    }).template;
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const build = Object.values(taskDefs).find(
      (d) => (d as { Properties: { Cpu: string } }).Properties.Cpu === '4096',
    );
    expect(build).toBeDefined();
    const env = ((build as {
      Properties: { ContainerDefinitions: Array<{ Environment?: Array<{ Name: string; Value: string }> }> };
    }).Properties.ContainerDefinitions[0].Environment ?? []);
    const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
    expect(byName.MISE_JOBS).toBe('8');
    expect(byName.JEST_MAX_WORKERS).toBe('50%');
    expect(byName.BUILD_VERIFY_TIMEOUT_S).toBe('3600');
  });

  test('the PLANNING def keeps the 20 GiB default (no EphemeralStorage — a clone+read planner needs no extra disk)', () => {
    const taskDefs = baseTemplate.findResources('AWS::ECS::TaskDefinition');
    const planning = Object.values(taskDefs).find(
      d => d.Properties.Cpu === '2048' && d.Properties.Memory === '8192',
    );
    expect(planning).toBeDefined();
    expect(planning!.Properties.EphemeralStorage).toBeUndefined();
  });

  test('creates a second, smaller PLANNING task def (2 vCPU / 8 GB) for read-only workflows (#299 ECS_RIGHTSIZED_PLANNING)', () => {
    baseTemplate.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '2048',
      Memory: '8192',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
  });

  test('taskSizing prop overrides the build def size; fields left unset keep the default', () => {
    const { template } = createStack({
      taskSizing: {
        buildTaskCpu: 4096,
        buildTaskMemoryMiB: 16384,
        buildTaskEphemeralStorageGiB: 40,
      },
    });
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
      EphemeralStorage: { SizeInGiB: 40 },
    });
    const planning = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .find(d => d.Properties.Cpu === '2048' && d.Properties.Memory === '8192');
    expect(planning).toBeDefined();
  });

  test('both task defs share ONE task role and ONE execution role (parity by construction — the ABCA-488/#502 lesson)', () => {
    const roles = baseTemplate.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
            }),
          ]),
        },
      },
    });
    expect(Object.keys(roles)).toHaveLength(2);

    const taskDefs = baseTemplate.findResources('AWS::ECS::TaskDefinition');
    const taskRoleRefs = new Set<string>();
    const execRoleRefs = new Set<string>();
    for (const def of Object.values(taskDefs)) {
      taskRoleRefs.add(JSON.stringify(def.Properties.TaskRoleArn));
      execRoleRefs.add(JSON.stringify(def.Properties.ExecutionRoleArn));
    }
    expect(taskRoleRefs.size).toBe(1);
    expect(execRoleRefs.size).toBe(1);
  });

  test('the PLANNING def carries no BUILD_VERIFY_TIMEOUT_S (a read-only planner runs no build verify)', () => {
    const taskDefs = baseTemplate.findResources('AWS::ECS::TaskDefinition');
    const planningDef = Object.values(taskDefs).find(
      d => d.Properties.Cpu === '2048' && d.Properties.Memory === '8192',
    );
    expect(planningDef).toBeDefined();
    const env = planningDef!.Properties.ContainerDefinitions[0].Environment ?? [];
    expect(env.some((e: { Name: string }) => e.Name === 'BUILD_VERIFY_TIMEOUT_S')).toBe(false);
    expect(env.some((e: { Name: string }) => e.Name === 'CLAUDE_CODE_USE_BEDROCK')).toBe(true);
    expect(env.some((e: { Name: string }) => e.Name === 'TASK_TABLE_NAME')).toBe(true);
  });

  test('creates a security group with TCP 443 egress only', () => {
    baseTemplate.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'ECS Agent Tasks - egress TCP 443 only',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
        }),
      ]),
    });
  });

  test('creates a CloudWatch log group with 3-month retention and CDK-generated name', () => {
    baseTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
    });
    const logGroups = baseTemplate.findResources('AWS::Logs::LogGroup');
    for (const [, lg] of Object.entries(logGroups)) {
      expect((lg as any).Properties).not.toHaveProperty('LogGroupName');
    }
  });

  test('task role has DynamoDB read/write permissions', () => {
    baseTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('task role has Secrets Manager read permission', () => {
    baseTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'secretsmanager:GetSecretValue',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('task role can read the per-workspace Linear/Jira OAuth secrets (ABCA-488)', () => {
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    let hasLinearOauthGrant = false;
    for (const p of Object.values(policies)) {
      for (const s of p.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (!actions.includes('secretsmanager:GetSecretValue')) continue;
        if (JSON.stringify(s.Resource).includes('bgagent-linear-oauth-')) hasLinearOauthGrant = true;
      }
    }
    expect(hasLinearOauthGrant).toBe(true);
  });

  test('task role Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard)', () => {
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    let bedrockStatement: { Resource: unknown } | undefined;
    for (const policy of Object.values(policies)) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('bedrock:InvokeModel')) {
          bedrockStatement = s;
        }
      }
    }
    expect(bedrockStatement).toBeDefined();
    expect(bedrockStatement!.Resource).not.toEqual('*');
    const serialized = JSON.stringify(bedrockStatement!.Resource);
    expect(serialized).toContain('foundation-model/anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('anthropic.claude-opus-4-8');
    expect(serialized).toContain('anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-5');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-5');
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-5-5');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-5-5');
    expect(serialized).toContain('foundation-model/anthropic.claude-haiku-5-5');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-haiku-5-5');
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
  });

  test('default-context Bedrock grants are the exact expected set, nothing wider', () => {
    const EXPECTED_BEDROCK_RESOURCE_NAMES = [
      'foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      'foundation-model/anthropic.claude-haiku-5-5',
      'foundation-model/anthropic.claude-opus-4-8',
      'foundation-model/anthropic.claude-opus-5',
      'foundation-model/anthropic.claude-opus-5-5',
      'foundation-model/anthropic.claude-sonnet-4-6',
      'inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'inference-profile/us.anthropic.claude-haiku-5-5',
      'inference-profile/us.anthropic.claude-opus-4-8',
      'inference-profile/us.anthropic.claude-opus-5',
      'inference-profile/us.anthropic.claude-opus-5-5',
      'inference-profile/us.anthropic.claude-sonnet-4-6',
    ];
    // CDK splits a role's default policy into managed-policy chunks past the IAM size limit.
    const policies = {
      ...baseTemplate.findResources('AWS::IAM::Policy'),
      ...baseTemplate.findResources('AWS::IAM::ManagedPolicy'),
    };
    const serialized = JSON.stringify(Object.values(policies).map(policy => policy.Properties.PolicyDocument));
    const found = [...new Set(
      serialized.match(/(?:foundation-model|inference-profile)\/[^"]+/g) ?? [],
    )].sort();
    expect(found).toEqual(EXPECTED_BEDROCK_RESOURCE_NAMES);
    expect(found).toHaveLength(DEFAULT_BEDROCK_MODEL_IDS.length * 2);
  });

  test.each(['global', 'eu'])('bedrockGeoRegion=%s injects both models into BOTH task definitions', (geo) => {
    const template = createStack({ bedrockGeoRegion: geo }).template;
    const defs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(defs.length).toBe(2);
    for (const def of defs) {
      const containers = (def as { Properties?: { ContainerDefinitions?: Array<{ Environment?: Array<{ Name: string; Value: string }> }> } })
        .Properties?.ContainerDefinitions ?? [];
      expect(containers.length).toBeGreaterThan(0);
      for (const c of containers) {
        const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
        expect(env.ANTHROPIC_MODEL).toBe(`${geo}.anthropic.claude-opus-5-5`);
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
          .toBe(`${geo}.anthropic.claude-haiku-5-5`);
      }
    }
  });

  test.each(['global', 'eu'])('bedrockGeoRegion=%s re-prefixes the task role inference-profile ARNs', (geo) => {
    const template = createStack({ bedrockGeoRegion: geo }).template;
    const policies = template.findResources('AWS::IAM::Policy');
    let bedrockStatement: { Resource: unknown } | undefined;
    for (const policy of Object.values(policies)) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('bedrock:InvokeModel')) bedrockStatement = s;
      }
    }
    expect(bedrockStatement).toBeDefined();
    const serialized = JSON.stringify(bedrockStatement!.Resource);
    for (const modelId of DEFAULT_BEDROCK_MODEL_IDS) {
      expect(serialized).toContain(`inference-profile/${geo}.${modelId}`);
      expect(serialized).not.toContain(`inference-profile/us.${modelId}`);
      expect(serialized).toContain(`foundation-model/${modelId}`);
    }
    expect(bedrockStatement!.Resource).not.toEqual('*');
    expect(serialized).not.toContain('"*"');
  });

  test('an unknown bedrockGeoRegion fails at synth', () => {
    expect(() => createStack({ bedrockGeoRegion: 'usa' })).toThrow(/must be one of/);
  });

  test('task role can DescribeAvailabilityZones so a CDK target repo can `cdk synth` on a fresh clone (ECS-parity)', () => {
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    let azStatement: { Resource: unknown } | undefined;
    for (const p of Object.values(policies)) {
      for (const s of p.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('ec2:DescribeAvailabilityZones')) azStatement = s;
      }
    }
    expect(azStatement).toBeDefined();
    // ec2:DescribeAvailabilityZones does not support resource-level permissions.
    expect(azStatement!.Resource).toEqual('*');
  });

  test('bedrockModels context override changes the granted model ARNs (#433)', () => {
    const template = createStack({ bedrockModels: ['anthropic.claude-opus-4-8'] }).template;
    const policies = template.findResources('AWS::IAM::Policy');
    let bedrockStatement: { Resource: unknown } | undefined;
    for (const policy of Object.values(policies)) {
      for (const s of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('bedrock:InvokeModel')) {
          bedrockStatement = s;
        }
      }
    }
    expect(bedrockStatement).toBeDefined();
    const serialized = JSON.stringify(bedrockStatement!.Resource);
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
    expect(serialized).not.toContain('claude-sonnet-4-6');
    expect(bedrockStatement!.Resource).not.toEqual('*');
  });

  test('the task role\'s IAM5 exception follows the policies CDK splits off for a large model list', () => {
    const { stack, template } = createStack({
      withNagChecks: true,
      bedrockModels: Array.from({ length: 40 }, (_, index) => `anthropic.claude-audit-${index}-v1:0`),
    });
    const policiesOf = (type: string, role: string) => Object.entries(template.findResources(type))
      .filter(([id]) => id.includes(role)).map(([, policy]) => policy);
    const overflow = policiesOf('AWS::IAM::ManagedPolicy', 'TaskRoleOverflowPolicy');
    expect(overflow.length).toBeGreaterThan(0);
    expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-IAM5'))
      .filter(finding => finding.id.includes('/TaskRole/'))
      .map(finding => String(finding.entry.data))).toEqual([]);
    const iam5 = (policy: Record<string, any>) => policy.Metadata.cdk_nag.rules_to_suppress
      .filter((rule: { id: string }) => rule.id === 'AwsSolutions-IAM5');
    const [defaultPolicy] = policiesOf('AWS::IAM::Policy', 'TaskRoleDefaultPolicy');
    for (const policy of overflow) expect(policy.Metadata.cdk_nag.rules_to_suppress).toEqual(iam5(defaultPolicy));
  });

  test('container has required environment variables', () => {
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'AgentContainer',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'CLAUDE_CODE_USE_BEDROCK', Value: '1' }),
            Match.objectLike({ Name: 'TASK_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'TASK_EVENTS_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'USER_CONCURRENCY_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'LOG_GROUP_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'BUILD_VERIFY_TIMEOUT_S', Value: '3600' }),
          ]),
        }),
      ]),
    });
  });

  test('build def caps build parallelism to prevent OOM (K14 / ABCA-691)', () => {
    // The CDK assertions matcher matches one arrayWith with several objectLike entries unreliably,
    // so each variable gets its own hasResourceProperties call.
    const envHas = (name: string, value: string) =>
      baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([Match.objectLike({ Name: name, Value: value })]),
          }),
        ]),
      });
    envHas('MISE_JOBS', '1');
    envHas('JEST_MAX_WORKERS', '4');
    envHas('BUILD_VERIFY_TIMEOUT_S', '3600');
  });

  test('includes MEMORY_ID in container env when provided', () => {
    const { template } = createStack({ memoryId: 'mem-test-123' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MEMORY_ID', Value: 'mem-test-123' }),
          ]),
        }),
      ]),
    });
  });

  describe('AgentCore Memory grant (F-2)', () => {
    test('grants the task role bedrock-agentcore write when agentMemory is passed', () => {
      const { template } = createStack({ withMemory: true });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith([Match.stringLikeRegexp('bedrock-agentcore:.*Event')]),
            }),
          ]),
        },
      });
    });

    test('does NOT grant bedrock-agentcore write when agentMemory is omitted', () => {
      const { stack } = createStack();
      const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
      const asJson = JSON.stringify(policies);
      expect(asJson).not.toMatch(/bedrock-agentcore:[A-Za-z]*Event/);
    });
  });

  describe('Linear identity vault parity (#809)', () => {
    test('wires the vault env AND the token grant onto the task role', () => {
      const { template } = createStack({ withLinearVault: true });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'LINEAR_VAULT_ENABLED', Value: 'true' }),
              Match.objectLike({ Name: 'LINEAR_WORKLOAD_IDENTITY_NAME', Value: 'abca_linear_oauth' }),
            ]),
          }),
        ]),
      });
      const asJson = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(asJson).toContain('bedrock-agentcore:GetWorkloadAccessTokenForUserId');
      expect(asJson).toContain('bedrock-agentcore:GetResourceOauth2Token');
      expect(asJson).toContain('workload-identity-directory/default');
    });

    test('omits both the env and the grant when the vault is not passed', () => {
      const { stack, template } = createStack();
      const asJson = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(asJson).not.toContain('GetResourceOauth2Token');
      expect(JSON.stringify(Template.fromStack(stack).toJSON()))
        .not.toContain('LINEAR_WORKLOAD_IDENTITY_NAME');
    });
  });

  describe('with a SessionRole wired (#209)', () => {
    function createWithSessionRole(): Template {
      const app = new App();
      const stack = new Stack(app, 'EcsSessionStack');
      const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
      const agentImageAsset = new ecr_assets.DockerImageAsset(stack, 'AgentImage', {
        directory: path.join(__dirname, '..', '..', '..', 'agent'),
      });
      const mk = (id: string) =>
        new dynamodb.Table(stack, id, {
          partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
        });
      const taskTable = mk('TaskTable');
      const taskEventsTable = mk('TaskEventsTable');
      const taskApprovalsTable = mk('TaskApprovalsTable');
      const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
        partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      });
      const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');
      const sessionRole = new AgentSessionRole(stack, 'AgentSessionRole', {
        assumingRoles: [
          new iam.Role(stack, 'AgentCoreRole', {
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
          }),
        ],
        taskScopedTables: [taskTable, taskEventsTable, taskApprovalsTable],
        traceArtifactsBucket: new s3.Bucket(stack, 'TraceBucket'),
        attachmentsBucket: new s3.Bucket(stack, 'AttachmentsBucket'),
      });

      new EcsAgentCluster(stack, 'EcsAgentCluster', {
        vpc,
        agentImageAsset,
        taskTable,
        taskEventsTable,
        taskApprovalsTable,
        userConcurrencyTable,
        githubTokenSecret,
        agentSessionRole: sessionRole,
      });
      return Template.fromStack(stack);
    }

    test('injects AGENT_SESSION_ROLE_ARN into the container', () => {
      createWithSessionRole().hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'AGENT_SESSION_ROLE_ARN', Value: Match.anyValue() }),
            ]),
          }),
        ]),
      });
    });

    test('task role gets sts:AssumeRole on the SessionRole, not direct task-table DDB grants', () => {
      const template = createWithSessionRole();
      const policies = template.findResources('AWS::IAM::Policy');

      const taskRolePolicies = Object.entries(policies).filter(([id, p]) =>
        id.includes('TaskRole')
        && p.Properties.PolicyDocument.Statement.some((s: { Action: string | string[] }) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('sts:AssumeRole');
        }),
      );
      expect(taskRolePolicies).toHaveLength(1);

      const taskRoleStatements = taskRolePolicies[0][1].Properties.PolicyDocument.Statement;
      const ddbItemStatements = taskRoleStatements.filter((s: { Action: string | string[] }) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a: string) =>
          ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'].includes(a),
        );
      });
      const serialized = JSON.stringify(ddbItemStatements);
      expect(serialized).not.toContain('TaskTable');
      expect(serialized).not.toContain('TaskEventsTable');

      let conditioned = 0;
      for (const policy of Object.values(policies)) {
        for (const s of policy.Properties.PolicyDocument.Statement) {
          if (s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys']) {
            conditioned += 1;
          }
        }
      }
      expect(conditioned).toBe(3);
    });

    test('both task definitions point at the approval table authorized by the SessionRole', () => {
      const sessionTemplate = createWithSessionRole();
      const tables = sessionTemplate.findResources('AWS::DynamoDB::Table');
      const approvalId = Object.keys(tables).find(id => id.startsWith('TaskApprovalsTable'));
      expect(approvalId).toBeDefined();
      const definitions = Object.values(sessionTemplate.findResources('AWS::ECS::TaskDefinition'));
      expect(definitions).toHaveLength(2);
      for (const definition of definitions) {
        expect(definition.Properties.ContainerDefinitions[0].Environment).toContainEqual({
          Name: 'TASK_APPROVALS_TABLE_NAME',
          Value: { Ref: approvalId },
        });
      }
    });
  });
});

describe('EcsAgentCluster approval wiring without a SessionRole', () => {
  let template: Template;
  beforeAll(() => { template = createStack({ withApprovals: true }).template; });

  test('grants only the approval item operations used by the agent', () => {
    const approvalId = Object.keys(template.findResources('AWS::DynamoDB::Table'))
      .find(id => id.startsWith('TaskApprovalsTable'));
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement);
    const grants = statements.filter(statement =>
      JSON.stringify(statement.Resource).includes(approvalId!),
    );
    expect(grants).toEqual([expect.objectContaining({
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    })]);
  });

  test('rejects a build setting that would erase approval-table wiring', () => {
    const node = new Stack(new App({
      context: { ecsExtraBuildEnv: { TASK_APPROVALS_TABLE_NAME: '' } },
    }), 'S').node;
    expect(() => resolveEcsTaskSizing(node)).toThrow('TASK_APPROVALS_TABLE_NAME');
  });
});

describe('EcsAgentCluster payload bucket (#502)', () => {
  function createWithPayloadBucket(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
    const agentImageAsset = new ecr_assets.DockerImageAsset(stack, 'AgentImage', {
      directory: path.join(__dirname, '..', '..', '..', 'agent'),
    });
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
    });
    const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');
    const payloadBucket = new s3.Bucket(stack, 'PayloadBucket');

    new EcsAgentCluster(stack, 'EcsAgentCluster', {
      vpc,
      agentImageAsset,
      taskTable,
      taskEventsTable,
      userConcurrencyTable,
      githubTokenSecret,
      payloadBucket,
    });
    return Template.fromStack(stack);
  }

  test('injects ECS_PAYLOAD_BUCKET into the container env', () => {
    createWithPayloadBucket().hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'ECS_PAYLOAD_BUCKET', Value: Match.anyValue() }),
          ]),
        }),
      ]),
    });
  });

  test('grants the task role READ on the payload bucket, never write/delete', () => {
    const template = createWithPayloadBucket();
    const policies = template.findResources('AWS::IAM::Policy');
    const s3Actions = new Set<string>();
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actions) {
          if (typeof a === 'string' && a.startsWith('s3:')) s3Actions.add(a);
        }
      }
    }
    expect([...s3Actions].some(a => a === 's3:GetObject' || a === 's3:GetObject*')).toBe(true);
    expect(s3Actions.has('s3:PutObject')).toBe(false);
    expect(s3Actions.has('s3:DeleteObject')).toBe(false);
    expect([...s3Actions].some(a => a.startsWith('s3:Put') || a.startsWith('s3:Delete'))).toBe(false);
  });

  test('omits ECS_PAYLOAD_BUCKET when no payload bucket is provided', () => {
    const { template } = createStack();
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const def of Object.values(taskDefs)) {
      const env = def.Properties.ContainerDefinitions[0].Environment ?? [];
      expect(env.some((e: { Name: string }) => e.Name === 'ECS_PAYLOAD_BUCKET')).toBe(false);
    }
  });
});

describe('EcsAgentCluster artifacts bucket (#299 ECS-parity)', () => {
  function createWithArtifactsBucket(): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
    const agentImageAsset = new ecr_assets.DockerImageAsset(stack, 'AgentImage', {
      directory: path.join(__dirname, '..', '..', '..', 'agent'),
    });
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
    });
    const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');
    const artifactsBucket = new s3.Bucket(stack, 'ArtifactsBucket');

    new EcsAgentCluster(stack, 'EcsAgentCluster', {
      vpc,
      agentImageAsset,
      taskTable,
      taskEventsTable,
      userConcurrencyTable,
      githubTokenSecret,
      artifactsBucket,
    });
    return Template.fromStack(stack);
  }

  test('injects ARTIFACTS_BUCKET_NAME into the container env (parity with the AgentCore runtime)', () => {
    createWithArtifactsBucket().hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'ARTIFACTS_BUCKET_NAME', Value: Match.anyValue() }),
          ]),
        }),
      ]),
    });
  });

  test('does NOT grant the task role write on the artifacts bucket (the scoped SessionRole owns delivery)', () => {
    const template = createWithArtifactsBucket();
    const policies = template.findResources('AWS::IAM::Policy');
    const s3WriteActions = new Set<string>();
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actions) {
          if (typeof a === 'string' && /^s3:(Put|Delete)/.test(a)) s3WriteActions.add(a);
        }
      }
    }
    expect([...s3WriteActions]).toEqual([]);
  });

  test('omits ARTIFACTS_BUCKET_NAME when no artifacts bucket is provided', () => {
    const { template } = createStack();
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const def of Object.values(taskDefs)) {
      const env = def.Properties.ContainerDefinitions[0].Environment ?? [];
      expect(env.some((e: { Name: string }) => e.Name === 'ARTIFACTS_BUCKET_NAME')).toBe(false);
    }
  });
});

describe('EcsAgentCluster nudges table', () => {
  let template: Template;
  let nudgesTable: string;
  beforeAll(() => {
    template = createStack({ withNudgesTable: true }).template;
    nudgesTable = Object.keys(template.findResources('AWS::DynamoDB::Table'))
      .find(id => id.startsWith('TaskNudgesTable'))!;
  });

  test('both task definitions name the table', () => {
    const definitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      expect(definition.Properties.ContainerDefinitions[0].Environment).toContainEqual({
        Name: 'NUDGES_TABLE_NAME',
        Value: { Ref: nudgesTable },
      });
    }
  });

  test('without a SessionRole the task role gets the two calls the nudge reader makes', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement)
      .filter(statement => JSON.stringify(statement.Resource).includes(nudgesTable));
    expect(statements).toEqual([expect.objectContaining({
      Effect: 'Allow',
      Action: ['dynamodb:Query', 'dynamodb:UpdateItem'],
    })]);
  });

  test('a build-tool override cannot unset the table name', () => {
    const node = new Stack(new App({ context: { ecsExtraBuildEnv: { NUDGES_TABLE_NAME: '' } } }), 'S').node;
    expect(() => resolveEcsTaskSizing(node)).toThrow(/cannot set 'NUDGES_TABLE_NAME'/);
  });

  test('omits NUDGES_TABLE_NAME when no table is passed', () => {
    const definitions = Object.values(createStack().template.findResources('AWS::ECS::TaskDefinition'));
    for (const definition of definitions) {
      const env = definition.Properties.ContainerDefinitions[0].Environment ?? [];
      expect(env.some((e: { Name: string }) => e.Name === 'NUDGES_TABLE_NAME')).toBe(false);
    }
  });
});
