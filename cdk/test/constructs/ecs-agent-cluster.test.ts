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
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import { EcsAgentCluster } from '../../src/constructs/ecs-agent-cluster';

function createStack(overrides?: { memoryId?: string; bedrockModels?: string[] }): { stack: Stack; template: Template } {
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

  new EcsAgentCluster(stack, 'EcsAgentCluster', {
    vpc,
    agentImageAsset,
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    githubTokenSecret,
    memoryId: overrides?.memoryId,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

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

  test('creates a Fargate task definition with 2 vCPU and 4 GB', () => {
    baseTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '2048',
      Memory: '4096',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
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
          ]),
        }),
      ]),
    });
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
        id.includes('TaskDefTaskRole')
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
