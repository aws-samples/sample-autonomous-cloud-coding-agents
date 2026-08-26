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
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AgentMemory } from '../../src/constructs/agent-memory';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import { EcsAgentCluster, resolveEcsTaskSizing } from '../../src/constructs/ecs-agent-cluster';

function createStack(overrides?: {
  memoryId?: string;
  bedrockModels?: string[];
  withMemory?: boolean;
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
    context: overrides?.bedrockModels ? { bedrockModels: overrides.bedrockModels } : undefined,
  });
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

  const agentMemory = overrides?.withMemory ? new AgentMemory(stack, 'AgentMemory') : undefined;

  new EcsAgentCluster(stack, 'EcsAgentCluster', {
    vpc,
    agentImageAsset,
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    githubTokenSecret,
    memoryId: overrides?.memoryId,
    agentMemory,
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
    // The whole point of the modest default: raising it must NOT require editing
    // the construct. Before this was wired, taskSizing had no caller and the
    // ceiling was unreachable by any supported route.
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
    // "I set the flag and the build still OOM'd" is a worse afternoon than a
    // failed synth.
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
    // extraBuildEnvironment spreads over the whole base container env, so without
    // this guard a build-tool override could unset platform wiring. The sharp one
    // is AGENT_SESSION_ROLE_ARN: absent, the agent falls back to ambient
    // credentials and per-tenant scoping is silently off.
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
    // A default is what an adopter who changes nothing pays for. At the Fargate
    // ceiling (16 vCPU / 120 GB) that is roughly 5x the per-build cost of this
    // size. Under-provisioning is a slow or OOM-ing build — diagnosable, and one
    // prop away from fixed; over-provisioning is a silent bill.
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
    // Measured, not guessed. A full parallel build of a large TypeScript + Python
    // monorepo peaked at ~3.1 GB of memory (~5x headroom at 16 GB, because
    // MISE_JOBS=1 serialises the packages) but ~14.7 GiB of DISK. At Fargate's
    // 21 GiB floor that is only ~1.4x, and running out of space surfaces as a
    // spurious build failure rather than an obvious resource error — so disk is
    // deliberately sized less aggressively than CPU and memory. Ephemeral storage
    // is also a small fraction of the per-task cost, so this keeps the cost win.
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      EphemeralStorage: { SizeInGiB: 50 },
    });
  });

  test('a heavy monorepo can raise the build task to the Fargate ceiling', () => {
    // The size that a large TypeScript + Python monorepo actually needs, reached
    // through the prop rather than by being everyone's default.
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
    // The platform sets a verify timeout and parallelism caps measured against one
    // monorepo's toolchain. A deployment with a different build shape replaces them
    // through the prop instead of editing the construct.
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
    // A key the caller did NOT override keeps the platform value.
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
    // Two task defs now exist: the 64 GB build def (asserted above) and this
    // 8 GB planning def. A read_only workflow runs on the smaller one so a
    // clone+read plan doesn't over-allocate the build box.
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

  // The default task sizes are generous (tuned for a large monorepo build). A
  // consumer with a lighter repo can override them per substrate to cut Fargate
  // cost, so the sizing is configuration, not a fixed value.
  test('taskSizing prop overrides the build def size; fields left unset keep the default', () => {
    const { template } = createStack({
      taskSizing: {
        buildTaskCpu: 4096, // 4 vCPU
        buildTaskMemoryMiB: 16384, // 16 GB
        buildTaskEphemeralStorageGiB: 40,
        // planning sizes intentionally omitted -> they should stay at their defaults
      },
    });
    // The override changes the existing build task def in place — it does not
    // add a third one. There should still be exactly two: build + planning.
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    // The build task def reflects the overridden sizes.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
      EphemeralStorage: { SizeInGiB: 40 },
    });
    // The planning task def is unchanged: omitted fields fall back to the default.
    const planning = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .find(d => d.Properties.Cpu === '2048' && d.Properties.Memory === '8192');
    expect(planning).toBeDefined();
  });

  test('both task defs share ONE task role and ONE execution role (parity by construction — the ABCA-488/#502 lesson)', () => {
    // The build and planning defs pass the SAME shared task+execution roles, so a
    // grant added for one is present on the other by construction (no drift). The
    // template therefore holds exactly two ECS roles (task + execution), each
    // referenced by both defs' TaskRoleArn/ExecutionRoleArn.
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
    // Both defs point at the same single task role and same single exec role.
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
    // …but the shared env (Bedrock, task table) IS present on the planning def too.
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
    // REGRESSION: a Linear/Jira-channel task resolves its per-workspace OAuth
    // token (bgagent-linear-oauth-<slug>) at startup to fire the 👀→✅ reaction
    // and drive the channel MCP. Without a prefix grant on the ECS task role the
    // fetch hit AccessDenied and reactions/MCP silently no-op'd on ECS (worked on
    // AgentCore). Pin a GetSecretValue statement whose resource ARN names the
    // bgagent-linear-oauth-* prefix.
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
    // Must NOT be a bare wildcard.
    expect(bedrockStatement!.Resource).not.toEqual('*');
    const serialized = JSON.stringify(bedrockStatement!.Resource);
    expect(serialized).toContain('foundation-model/anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('anthropic.claude-opus-4-20250514-v1:0');
    expect(serialized).toContain('anthropic.claude-haiku-4-5-20251001-v1:0');
    // Claude Opus 5 (#744) — AgentCore/ECS parity. Both ARNs: the bare id isn't
    // on-demand invocable, so the `us.` profile is the one actually called.
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-5');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-5');
    // REGRESSION (#744): Opus 4.8 stays granted alongside Opus 5 — blueprints may
    // pin it per-repo, so dropping it would fail those repos at turn 0.
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
  });

  test('task role can DescribeAvailabilityZones so a CDK target repo can `cdk synth` on a fresh clone (ECS-parity)', () => {
    // REGRESSION: `mise run build` on a CDK-based target repo runs `cdk synth`,
    // and a stack wired to a concrete env does a synth-time AZ context lookup
    // (ec2:DescribeAvailabilityZones). A dev box caches the answer in the
    // gitignored cdk.context.json; the agent clones fresh (no cache) → the live
    // lookup fires. Without this grant the ECS task role hit AccessDenied →
    // "Synthesis finished with errors" → a FALSE build-gate failure. Pin the
    // read-only describe (Resource:* — EC2 describe has no resource scoping).
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    let azStatement: { Resource: unknown } | undefined;
    for (const p of Object.values(policies)) {
      for (const s of p.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.includes('ec2:DescribeAvailabilityZones')) azStatement = s;
      }
    }
    expect(azStatement).toBeDefined();
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
    // The override model is granted...
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
    // ...and the defaults are NOT (the override replaces, not appends).
    expect(serialized).not.toContain('claude-sonnet-4-6');
    // Still scoped, never a wildcard.
    expect(bedrockStatement!.Resource).not.toEqual('*');
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
            // K14: ECS big-box substrate raises the build-verify cap so a
            // slow-but-healthy CI-parity build isn't mis-flagged as a timeout.
            Match.objectLike({ Name: 'BUILD_VERIFY_TIMEOUT_S', Value: '3600' }),
          ]),
        }),
      ]),
    });
  });

  test('build def caps build parallelism to prevent OOM (K14 / ABCA-691)', () => {
    // The build task def serializes the mise DAG (MISE_JOBS=1) and pins the jest
    // fleet (JEST_MAX_WORKERS=4) so the cross-package build storm can't OOM the
    // box while the coding agent is still resident. Asserted per-var (one
    // arrayWith objectLike each): a single arrayWith with multiple objectLike
    // entries is matched unreliably by the CDK assertions matcher, so each env
    // var gets its own hasResourceProperties call — which also pins each to the
    // SAME build container (the one carrying BUILD_VERIFY_TIMEOUT_S).
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

  // F-2 ECS-parity regression guard. The task role must be able to WRITE cross-
  // task memory (bedrock-agentcore:CreateEvent), or episodic/semantic writes fail
  // closed on ECS (memory_written: false — live-caught on the fork). This
  // regressed silently because MEMORY_ID was wired into the env WITHOUT the
  // matching grant, so the agent attempted a write it had no permission for.
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
      // Negative proof: the isolated-construct default (no memory) must not
      // emit a memory grant — otherwise the positive test proves nothing.
      const { stack } = createStack();
      const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
      const asJson = JSON.stringify(policies);
      expect(asJson).not.toMatch(/bedrock-agentcore:[A-Za-z]*Event/);
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
        taskScopedTables: [taskTable, taskEventsTable],
        traceArtifactsBucket: new s3.Bucket(stack, 'TraceBucket'),
        attachmentsBucket: new s3.Bucket(stack, 'AttachmentsBucket'),
      });

      new EcsAgentCluster(stack, 'EcsAgentCluster', {
        vpc,
        agentImageAsset,
        taskTable,
        taskEventsTable,
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

      // Identify the task role's own inline policy: it is the one carrying the
      // sts:AssumeRole grant (only the compute role receives that), as opposed
      // to the SessionRole's policy (which carries the conditioned DDB
      // statements). The task-role policy must NOT contain any unconditioned
      // task-table DDB grant — that access now lives only on the SessionRole.
      const taskRolePolicies = Object.entries(policies).filter(([id, p]) =>
        // #299 ECS_RIGHTSIZED_PLANNING: the task role is now a SHARED standalone
        // `TaskRole` construct (was the auto-generated role nested under the single
        // FargateTaskDefinition, id `...TaskDefTaskRole...`), so both the build and
        // planning defs pass the same role — its logical id is `...TaskRole...` and
        // `ExecutionRole` doesn't match this substring.
        id.includes('TaskRole')
        && p.Properties.PolicyDocument.Statement.some((s: { Action: string | string[] }) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('sts:AssumeRole');
        }),
      );
      expect(taskRolePolicies).toHaveLength(1);

      const taskRoleStatements = taskRolePolicies[0][1].Properties.PolicyDocument.Statement;
      // No unconditioned dynamodb item grant on the task role (the only DDB the
      // task role may touch directly is UserConcurrencyTable — assert that any
      // DDB statement present is NOT a leading-key-less task-table grant by
      // checking none grant dynamodb write actions without a condition beyond
      // the concurrency table). Simplest robust check: the task role carries no
      // dynamodb:GetItem/Query/BatchWriteItem statement at all for the task
      // tables — grantReadWriteData on a removed table would have produced one.
      const ddbItemStatements = taskRoleStatements.filter((s: { Action: string | string[] }) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a: string) =>
          ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'].includes(a),
        );
      });
      // The only permitted DDB item access on the task role is the
      // UserConcurrencyTable grant. The two task-scoped tables (TaskTable,
      // TaskEventsTable) must NOT appear — assert no statement references them.
      const serialized = JSON.stringify(ddbItemStatements);
      expect(serialized).not.toContain('TaskTable');
      expect(serialized).not.toContain('TaskEventsTable');

      // The conditioned (SessionRole) DDB statements still exist — exactly two
      // task-scoped tables, each leading-key gated.
      let conditioned = 0;
      for (const policy of Object.values(policies)) {
        for (const s of policy.Properties.PolicyDocument.Statement) {
          if (s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys']) {
            conditioned += 1;
          }
        }
      }
      expect(conditioned).toBe(2);
    });
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
    // Read actions present...
    expect([...s3Actions].some(a => a === 's3:GetObject' || a === 's3:GetObject*')).toBe(true);
    // ...and NO write/delete on the payload bucket from the task role.
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
    // An artifact workflow delivers via the assumed SessionRole
    // (scoped to artifacts/${task_id}/*), exactly like the AgentCore runtime —
    // whose task role likewise has no direct artifacts grant. A whole-bucket
    // grantReadWrite here would over-privilege the untrusted-code role and break
    // cross-task isolation. The task role gets only the ARTIFACTS_BUCKET_NAME env.
    const template = createWithArtifactsBucket();
    const policies = template.findResources('AWS::IAM::Policy');
    const s3WriteActions = new Set<string>();
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actions) {
          // Only true S3 mutations — Put*/Delete*. The read-only payload bucket
          // (#502) legitimately grants GetObject*/List* on the task role, so those
          // are NOT flagged; what must be absent is any write to any S3 bucket.
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
