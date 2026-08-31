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
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { TaskOrchestrator } from '../../src/constructs/task-orchestrator';

interface StackOverrides {
  maxConcurrentTasksPerUser?: number;
  githubTokenSecretArn?: string;
  userPromptTokenBudget?: number;
  includeRepoTable?: boolean;
  additionalRuntimeArns?: string[];
  additionalSecretArns?: string[];
  memoryId?: string;
  guardrailId?: string;
  guardrailVersion?: string;
  /** ADR-021 P2: the identifiers the orchestrator forwards as `platform_config`. */
  agentPlatformConfig?: {
    taskApprovalsTableName: string;
    nudgesTableName: string;
    logGroupName: string;
    artifactsBucketName: string;
    traceArtifactsBucketName: string;
    agentSessionRoleArn: string;
    anthropicDefaultHaikuModel: string;
  };
  ecsConfig?: {
    clusterArn: string;
    taskDefinitionArn: string;
    planningTaskDefinitionArn: string;
    subnets: string;
    securityGroup: string;
    containerName: string;
    taskRoleArn: string;
    executionRoleArn: string;
  };
  agentRegistryId?: string;
}

function createStack(overrides?: StackOverrides): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

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

  const repoTable = overrides?.includeRepoTable
    ? new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    })
    : undefined;

  const {
    includeRepoTable: _,
    additionalRuntimeArns,
    additionalSecretArns,
    memoryId,
    guardrailId,
    guardrailVersion,
    ecsConfig,
    ...rest
  } = overrides ?? {};

  new TaskOrchestrator(stack, 'TaskOrchestrator', {
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
    ...(repoTable && { repoTable }),
    ...(additionalRuntimeArns && { additionalRuntimeArns }),
    ...(additionalSecretArns && { additionalSecretArns }),
    ...(memoryId && { memoryId }),
    ...(guardrailId && { guardrailId }),
    ...(guardrailVersion && { guardrailVersion }),
    ...(ecsConfig && { ecsConfig }),
    ...rest,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskOrchestrator construct', () => {
  let baseTemplate: Template;
  let githubTokenTemplate: Template;
  let repoTableTemplate: Template;
  let ecsTemplate: Template;

  const ecsOverrides: StackOverrides = {
    ecsConfig: {
      clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
      taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/agent:1',
      planningTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-planning:1',
      subnets: 'subnet-aaa,subnet-bbb',
      securityGroup: 'sg-12345',
      containerName: 'AgentContainer',
      taskRoleArn: 'arn:aws:iam::123456789012:role/TaskRole',
      executionRoleArn: 'arn:aws:iam::123456789012:role/ExecutionRole',
    },
  };

  beforeAll(() => {
    baseTemplate = createStack().template;
    githubTokenTemplate = createStack({
      githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
    }).template;
    repoTableTemplate = createStack({ includeRepoTable: true }).template;
    ecsTemplate = createStack(ecsOverrides).template;
  });

  test('creates a Lambda function with NODEJS_24_X runtime', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  test('Lambda function has correct environment variables', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
          RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
          MAX_CONCURRENT_TASKS_PER_USER: '10',
          TASK_RETENTION_DAYS: '90',
        }),
      },
    });
  });

  test('orchestrator Lambda carries the ABCA_COMPONENT=orchestr label (#319)', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ABCA_COMPONENT: 'orchestr',
        }),
      },
    });
  });

  test('respects custom maxConcurrentTasksPerUser', () => {
    const { template } = createStack({ maxConcurrentTasksPerUser: 5 });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MAX_CONCURRENT_TASKS_PER_USER: '5',
        }),
      },
    });
  });

  test('creates a Lambda alias', () => {
    baseTemplate.resourceCountIs('AWS::Lambda::Alias', 1);
    baseTemplate.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
    });
  });

  test('grants AgentCore runtime invocation permissions with wildcard sub-resource', () => {
    baseTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:InvokeAgentRuntime',
              'bedrock-agentcore:InvokeAgentRuntimeForUser',
              'bedrock-agentcore:StopRuntimeSession',
            ],
            Effect: 'Allow',
            Resource: [
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime/*',
            ],
          }),
        ]),
      },
    });
  });

  test('attaches durable execution managed policy', () => {
    baseTemplate.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('AWSLambdaBasicDurableExecutionRolePolicy'),
            ]),
          ]),
        }),
      ]),
    });
  });

  test('Lambda function has 60s timeout', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 60,
    });
  });

  test('includes GITHUB_TOKEN_SECRET_ARN when provided', () => {
    githubTokenTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
        }),
      },
    });
  });

  test('grants Secrets Manager read when githubTokenSecretArn is provided', () => {
    githubTokenTemplate.hasResourceProperties('AWS::IAM::Policy', {
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

  test('does not include GITHUB_TOKEN_SECRET_ARN when not provided', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        if (Array.isArray(stmt.Action)) {
          expect(stmt.Action).not.toContain('secretsmanager:GetSecretValue');
        }
      }
    }
  });

  test('includes USER_PROMPT_TOKEN_BUDGET when provided', () => {
    const { template } = createStack({ userPromptTokenBudget: 50000 });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          USER_PROMPT_TOKEN_BUDGET: '50000',
        }),
      },
    });
  });

  test('includes REPO_TABLE_NAME when repoTable is provided', () => {
    repoTableTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REPO_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('does not include REPO_TABLE_NAME when repoTable is not provided', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(functions)) {
      const envVars = (fn as any).Properties.Environment?.Variables ?? {};
      expect(envVars).not.toHaveProperty('REPO_TABLE_NAME');
    }
  });

  test('grants read access on repo table when provided', () => {
    repoTableTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:GetItem',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('includes additional runtime ARNs in IAM policy', () => {
    const { template } = createStack({
      additionalRuntimeArns: [
        'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/extra-runtime',
      ],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:InvokeAgentRuntime',
              'bedrock-agentcore:InvokeAgentRuntimeForUser',
              'bedrock-agentcore:StopRuntimeSession',
            ],
            Effect: 'Allow',
            Resource: Match.arrayWith([
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/extra-runtime',
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/extra-runtime/*',
            ]),
          }),
        ]),
      },
    });
  });

  test('includes MEMORY_ID when provided', () => {
    const { template } = createStack({ memoryId: 'mem-abc-123' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MEMORY_ID: 'mem-abc-123',
        }),
      },
    });
  });

  test('does not include MEMORY_ID when not provided', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(functions)) {
      const envVars = (fn as any).Properties.Environment?.Variables ?? {};
      expect(envVars).not.toHaveProperty('MEMORY_ID');
    }
  });

  test('grants Secrets Manager read for additional secret ARNs', () => {
    const { template } = createStack({
      additionalSecretArns: [
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:per-repo-token-abc123',
      ],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
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

  test('creates a CloudWatch alarm for orchestrator errors', () => {
    baseTemplate.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    baseTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      EvaluationPeriods: 2,
      Threshold: 3,
      TreatMissingData: 'notBreaching',
    });
  });

  test('configures async invoke with zero retry attempts', () => {
    baseTemplate.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });

  test('includes GUARDRAIL_ID and GUARDRAIL_VERSION when provided', () => {
    const { template } = createStack({ guardrailId: 'gr-test-123', guardrailVersion: '1' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GUARDRAIL_ID: 'gr-test-123',
          GUARDRAIL_VERSION: '1',
        }),
      },
    });
  });

  test('does not include GUARDRAIL_ID when not provided', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(functions)) {
      const envVars = (fn as any).Properties.Environment?.Variables ?? {};
      expect(envVars).not.toHaveProperty('GUARDRAIL_ID');
      expect(envVars).not.toHaveProperty('GUARDRAIL_VERSION');
    }
  });

  test('grants bedrock:ApplyGuardrail scoped to guardrail ARN when guardrailId is provided', () => {
    const { template } = createStack({ guardrailId: 'gr-test-123', guardrailVersion: '1' });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:ApplyGuardrail',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([
                  Match.stringLikeRegexp('guardrail/gr-test-123'),
                ]),
              ]),
            },
          }),
        ]),
      },
    });
  });

  test('does not grant bedrock:ApplyGuardrail when guardrailId is not provided', () => {
    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        if (typeof stmt.Action === 'string') {
          expect(stmt.Action).not.toBe('bedrock:ApplyGuardrail');
        } else if (Array.isArray(stmt.Action)) {
          expect(stmt.Action).not.toContain('bedrock:ApplyGuardrail');
        }
      }
    }
  });

  test('throws when guardrailId is provided without guardrailVersion', () => {
    expect(() => createStack({ guardrailId: 'gr-test-123' })).toThrow(
      'guardrailVersion is required when guardrailId is provided',
    );
  });

  test('throws when guardrailVersion is provided without guardrailId', () => {
    expect(() => createStack({ guardrailVersion: '1' })).toThrow(
      'guardrailId is required when guardrailVersion is provided',
    );
  });

  test('registry read grant is scoped to the wired registry id — no bare "*" (#246 review)', () => {
    const { template } = createStack({ agentRegistryId: 'AbCdEfGh1234' });
    const policies = template.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    // The wired registry id must appear in the resource ARNs...
    expect(serialized).toContain('AbCdEfGh1234');
    // ...and no Agent Registry statement may grant a bare "*" or a
    // registry/* wildcard (the finding: it should scope to registry/{id}).
    for (const policy of Object.values(policies)) {
      const statements = (policy as {
        Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
      }).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = JSON.stringify(stmt.Action);
        if (actions.includes('agent-registry:GetRegistryRecord')) {
          const resources = JSON.stringify(stmt.Resource);
          expect(resources).not.toContain('registry/*');
          expect(stmt.Resource).not.toBe('*');
        }
      }
    }
  });

  test('omits registry environment and IAM when no registry id is provided', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties?.Environment?.Variables ?? {}).not.toHaveProperty('AGENT_REGISTRY_ID');
    }

    const policies = baseTemplate.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const statement of statements) {
        expect(JSON.stringify(statement.Action)).not.toContain('agent-registry:');
      }
    }
  });

  describe('ECS compute strategy', () => {
    test('includes ECS env vars when ECS props are provided', () => {
      ecsTemplate.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
            ECS_TASK_DEFINITION_ARN: 'arn:aws:ecs:us-east-1:123456789012:task-definition/agent:1',
            // Read-only workflows run on the smaller planning task definition.
            // See docs/design/ECS_RIGHTSIZED_PLANNING.md.
            ECS_PLANNING_TASK_DEFINITION_ARN: 'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-planning:1',
            ECS_SUBNETS: 'subnet-aaa,subnet-bbb',
            ECS_SECURITY_GROUP: 'sg-12345',
            ECS_CONTAINER_NAME: 'AgentContainer',
          }),
        },
      });
    });

    test('does not include ECS env vars when ECS props are omitted', () => {
      const functions = baseTemplate.findResources('AWS::Lambda::Function');
      for (const [, fn] of Object.entries(functions)) {
        const envVars = (fn as any).Properties.Environment?.Variables ?? {};
        expect(envVars).not.toHaveProperty('ECS_CLUSTER_ARN');
        expect(envVars).not.toHaveProperty('ECS_TASK_DEFINITION_ARN');
      }
    });

    test('grants ECS RunTask/DescribeTasks/StopTask permissions when ECS props are provided', () => {
      ecsTemplate.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                'ecs:RunTask',
                'ecs:DescribeTasks',
                'ecs:StopTask',
              ],
              Effect: 'Allow',
              Resource: '*',
              Condition: {
                ArnEquals: {
                  'ecs:cluster': 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
                },
              },
            }),
          ]),
        },
      });
    });

    test('grants iam:PassRole scoped to task/execution role ARNs', () => {
      ecsTemplate.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iam:PassRole',
              Effect: 'Allow',
              Resource: Match.arrayWith([
                'arn:aws:iam::123456789012:role/TaskRole',
                'arn:aws:iam::123456789012:role/ExecutionRole',
              ]),
              Condition: {
                StringEquals: {
                  'iam:PassedToService': 'ecs-tasks.amazonaws.com',
                },
              },
            }),
          ]),
        },
      });
    });

    test('does not grant ECS permissions when ECS props are omitted', () => {
      const policies = baseTemplate.findResources('AWS::IAM::Policy');
      for (const [, policy] of Object.entries(policies)) {
        const statements = (policy as any).Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          if (Array.isArray(stmt.Action)) {
            expect(stmt.Action).not.toContain('ecs:RunTask');
          }
        }
      }
    });
  });
});

describe('TaskOrchestrator with the Lambda MicroVMs backend (ADR-021)', () => {
  const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:abca-agent';
  /** What the construct derives from the bare image name `abca-agent`. */
  const NAME_DERIVED_IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:abca-agent';
  const EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/MicrovmExecutionRole';
  const CONNECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector:nc-123';
  // What LambdaMicrovmCompute always supplies: the Lambda-managed NO_INGRESS
  // connector. Service-owned, hence the literal `aws` account segment.
  const NO_INGRESS_ARN = 'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS';

  /**
   * Build a stack with `microvmConfig` wired. Separate from `createStack` above
   * because the payload bucket has to be a real construct (the prop takes an
   * `s3.IBucket` so the grant can be rendered), which the shared helper's
   * override shape does not model.
   */
  function createMicrovmStack(config?: {
    imageIdentifier?: string;
    imageArn?: string;
    imageVersion?: string;
    ingressConnectorArns?: string[];
  }): { template: Template } {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const mkTable = (id: string, sortKey?: string) => new dynamodb.Table(stack, id, {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      ...(sortKey ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } } : {}),
    });

    new TaskOrchestrator(stack, 'TaskOrchestrator', {
      taskTable: mkTable('TaskTable'),
      taskEventsTable: mkTable('TaskEventsTable', 'event_id'),
      userConcurrencyTable: new dynamodb.Table(stack, 'UserConcurrencyTable', {
        partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      }),
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
      microvmConfig: {
        imageIdentifier: config?.imageIdentifier ?? IMAGE_ARN,
        imageArn: config?.imageArn ?? IMAGE_ARN,
        imageVersion: config?.imageVersion,
        executionRoleArn: EXECUTION_ROLE_ARN,
        egressConnectorArns: [CONNECTOR_ARN],
        // REQUIRED prop — mirrors what LambdaMicrovmCompute passes on every
        // deploy. There is no "unset" case to fixture, by design.
        ingressConnectorArns: config?.ingressConnectorArns ?? [NO_INGRESS_ARN],
        payloadBucket: new s3.Bucket(stack, 'MicrovmPayloadBucket'),
      },
    });

    return { template: Template.fromStack(stack) };
  }

  function orchestratorEnv(template: Template): Record<string, unknown> {
    const [, fn] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.includes('OrchestratorFn'))!;
    return fn.Properties.Environment.Variables as Record<string, unknown>;
  }

  function microvmStatements(template: Template): Array<{
    Sid?: string;
    Action: string | string[];
    Resource: unknown;
    Condition?: unknown;
  }> {
    return Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(p => p.Properties.PolicyDocument.Statement)
      .filter((s: { Sid?: string }) => (s.Sid ?? '').startsWith('Microvm'));
  }

  // Three distinct configurations, synthesized once each in beforeAll per
  // cdk/AGENTS.md: the default wiring, the same wiring with an image version +
  // ingress connectors pinned, and a name-derived (not operator-supplied) image
  // ARN. `noMicrovmTemplate` is the negative control.
  let template: Template;
  let pinnedTemplate: Template;
  let nameDerivedTemplate: Template;
  let noMicrovmTemplate: Template;

  beforeAll(() => {
    template = createMicrovmStack().template;
    pinnedTemplate = createMicrovmStack({
      imageVersion: '4',
      ingressConnectorArns: ['arn:aws:lambda:us-east-1:aws:network-connector:x', 'arn:y'],
    }).template;
    // What LambdaMicrovmCompute passes when the operator gave a bare image NAME:
    // the exact ARN it derived, never a wildcard.
    nameDerivedTemplate = createMicrovmStack({
      imageIdentifier: 'abca-agent',
      imageArn: NAME_DERIVED_IMAGE_ARN,
    }).template;
    noMicrovmTemplate = createStack().template;
  });

  test('injects the required MICROVM_* env vars verbatim (the strategy contract)', () => {
    const env = orchestratorEnv(template);
    expect(env.MICROVM_IMAGE_IDENTIFIER).toBe(IMAGE_ARN);
    expect(env.MICROVM_EXECUTION_ROLE_ARN).toBe(EXECUTION_ROLE_ARN);
    expect(env.MICROVM_EGRESS_CONNECTOR_ARNS).toBe(CONNECTOR_ARN);
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).toBe(NO_INGRESS_ARN);
    expect(env.MICROVM_PAYLOAD_BUCKET).toBeDefined();
  });

  test('ALWAYS injects the ingress var, carrying the NO_INGRESS control', () => {
    // OUTCOME assertion, not an omission assertion. This var used to be injected
    // only when non-empty, and the test asserted it was `undefined` — which is
    // precisely the shape of test that passes while the service silently picks
    // something wider: `RunMicrovm` attaches a PUBLIC HTTP_INGRESS connector (and
    // a public *.lambda-microvm.<region>.on.aws endpoint) when the request omits
    // the field. So "no inbound" has to be a value we can SEE in the template.
    const env = orchestratorEnv(template);
    expect(Object.keys(env)).toContain('MICROVM_INGRESS_CONNECTOR_ARNS');
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).toBe(NO_INGRESS_ARN);
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).toContain('NO_INGRESS');
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).not.toContain('HTTP_INGRESS');
    // Not an empty string either — the strategy would then fall back rather than
    // pass what the deployment configured.
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).not.toBe('');
  });

  test('the ingress var belongs to the all-or-nothing block, not the optional one', () => {
    // Exactly one MICROVM_* var is genuinely optional (`imageVersion`, whose
    // absent state means "resolve the latest ACTIVE version"). Everything else,
    // ingress included, is present whenever microvmConfig is.
    const env = orchestratorEnv(template);
    expect(Object.keys(env).filter((k) => k.startsWith('MICROVM_')).sort()).toEqual([
      'MICROVM_EGRESS_CONNECTOR_ARNS',
      'MICROVM_EXECUTION_ROLE_ARN',
      'MICROVM_IMAGE_IDENTIFIER',
      'MICROVM_INGRESS_CONNECTOR_ARNS',
      'MICROVM_PAYLOAD_BUCKET',
    ]);
    expect(env.MICROVM_IMAGE_VERSION).toBeUndefined();
  });

  test('pins the image version, and real ingress connectors WIN over NO_INGRESS', () => {
    // How #391 (operator shell access) lands without a strategy change: the
    // construct supplies different connectors and they are joined verbatim.
    const env = orchestratorEnv(pinnedTemplate);
    expect(env.MICROVM_IMAGE_VERSION).toBe('4');
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).toBe('arn:aws:lambda:us-east-1:aws:network-connector:x,arn:y');
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).not.toContain('NO_INGRESS');
  });

  test('grants exactly the four P1 lifecycle actions and nothing more', () => {
    const actions = microvmStatements(template)
      .flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action])
      .filter(a => a.startsWith('lambda:'));
    expect(actions.sort()).toEqual([
      'lambda:GetMicrovm',
      'lambda:PassNetworkConnector',
      'lambda:RunMicrovm',
      'lambda:TerminateMicrovm',
    ]);
  });

  test('scopes the lifecycle statement to the one platform image ARN', () => {
    const lifecycle = microvmStatements(template).find(s => s.Sid === 'MicrovmLifecycle')!;
    // Exact ARN plus the `<arn>:*` version-suffix hedge — both pinned to this
    // image's name, so neither can match another image.
    expect(lifecycle.Resource).toEqual([IMAGE_ARN, `${IMAGE_ARN}:*`]);
  });

  test('a name-derived image ARN is scoped to that exact name, never a wildcard', () => {
    // An out-of-band image referenced by bare NAME is a valid RunMicrovm
    // identifier but not an IAM resource. LambdaMicrovmCompute resolves it to the
    // exact `microvmImage` ARN, so ADR-021's "scoped to platform-created images"
    // holds here too — the account/Region-wide `microvm-image:*` widening this
    // test previously accepted is a compliance violation, not a fallback.
    const lifecycle = microvmStatements(nameDerivedTemplate).find(s => s.Sid === 'MicrovmLifecycle')!;
    expect(lifecycle.Resource).toEqual([
      NAME_DERIVED_IMAGE_ARN,
      `${NAME_DERIVED_IMAGE_ARN}:*`,
    ]);
    expect(JSON.stringify(lifecycle.Resource)).not.toContain('microvm-image:*');
    expect(JSON.stringify(lifecycle.Resource)).toContain('microvm-image:abca-agent');
  });

  test('PassNetworkConnector must be Resource:* (the action has no resource type)', () => {
    const pass = microvmStatements(template).find(s => s.Sid === 'MicrovmPassNetworkConnector')!;
    expect(pass.Resource).toBe('*');
  });

  test('passes ONLY the exact execution-role ARN, with NO iam:PassedToService condition', () => {
    // ADR-021 P2r2-F10, and the sharpest IAM assertion in this file: the condition
    // must NOT come back. A controlled two-arm experiment (same exact-ARN resource,
    // same ~5-minute settle, one variable) showed the Lambda MicroVMs service does
    // not present a usable `iam:PassedToService` value on the RunMicrovm PassRole
    // path — with the condition every submission was DENIED, without it the next
    // one reached RUNNING in 9 s. An earlier revision asserted the opposite
    // ("exonerated live"); that was a false negative from a contaminated control
    // (run 1's temporary unconditioned grant was still attached during its
    // "control" arm). See the comment on the statement in task-orchestrator.ts.
    const passRole = microvmStatements(template).find(s => s.Sid === 'MicrovmPassExecutionRole')!;
    expect(passRole.Action).toBe('iam:PassRole');
    expect(passRole.Condition).toBeUndefined();
    // With the condition gone, the exact-ARN resource is the WHOLE of the scoping —
    // so a widening here (a name prefix, or `*`) would leave the grant unbounded.
    expect(passRole.Resource).toBe(EXECUTION_ROLE_ARN);
    expect(JSON.stringify(passRole.Resource)).not.toContain('*');
  });

  test('grants NO suspend/resume (P3) and NO auth-token minting (never)', () => {
    const actions = new Set(
      Object.values(template.findResources('AWS::IAM::Policy'))
        .flatMap(p => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>)
        .flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]),
    );
    expect(actions.has('lambda:SuspendMicrovm')).toBe(false);
    expect(actions.has('lambda:ResumeMicrovm')).toBe(false);
    expect(actions.has('lambda:CreateMicrovmAuthToken')).toBe(false);
    expect(actions.has('lambda:CreateMicrovmShellAuthToken')).toBe(false);
  });

  test('gets write on the payload bucket but NOT delete (lifecycle rule is the reaper)', () => {
    const payloadStatements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(p => p.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>)
      .filter(s => JSON.stringify(s.Resource).includes('MicrovmPayloadBucket'));

    const actions = payloadStatements.flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions).toContain('s3:PutObject');
    expect(actions).not.toContain('s3:DeleteObject');
  });

  test('adds no MicroVM statements when microvmConfig is omitted', () => {
    expect(microvmStatements(noMicrovmTemplate)).toEqual([]);
    expect(orchestratorEnv(noMicrovmTemplate).MICROVM_IMAGE_IDENTIFIER).toBeUndefined();
  });
});

describe('TaskOrchestrator agentPlatformConfig (ADR-021 P2 platform_config transport)', () => {
  const SESSION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaAgentSessionRole';
  const HAIKU_PROFILE = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

  /**
   * Stack with real approvals/nudges tables and buckets, so the "forwards the
   * NAME, grants nothing" property can be asserted against actual logical IDs
   * rather than string literals.
   */
  function createPlatformConfigStack(withConfig: boolean): { template: Template } {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const mkTable = (id: string) => new dynamodb.Table(stack, id, {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const approvalsTable = mkTable('TaskApprovalsTable');
    const nudgesTable = mkTable('TaskNudgesTable');
    const traceBucket = new s3.Bucket(stack, 'TraceArtifactsBucket');

    new TaskOrchestrator(stack, 'TaskOrchestrator', {
      taskTable: mkTable('TaskTable'),
      taskEventsTable: mkTable('TaskEventsTable'),
      userConcurrencyTable: new dynamodb.Table(stack, 'UserConcurrencyTable', {
        partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      }),
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
      ...(withConfig && {
        agentPlatformConfig: {
          taskApprovalsTableName: approvalsTable.tableName,
          nudgesTableName: nudgesTable.tableName,
          logGroupName: '/aws/abca/application',
          artifactsBucketName: traceBucket.bucketName,
          traceArtifactsBucketName: traceBucket.bucketName,
          agentSessionRoleArn: SESSION_ROLE_ARN,
          anthropicDefaultHaikuModel: HAIKU_PROFILE,
        },
      }),
    });

    return { template: Template.fromStack(stack) };
  }

  function orchestratorEnvVars(template: Template): Record<string, unknown> {
    const [, fn] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.includes('OrchestratorFn'))!;
    return fn.Properties.Environment.Variables as Record<string, unknown>;
  }

  let template: Template;
  let withoutConfigTemplate: Template;

  beforeAll(() => {
    template = createPlatformConfigStack(true).template;
    withoutConfigTemplate = createPlatformConfigStack(false).template;
  });

  test('injects the seven forwarded identifiers under the names the strategy reads', () => {
    // These names are a CONTRACT with
    // `handlers/shared/strategies/lambda-microvm-strategy.ts`'s
    // PLATFORM_CONFIG_ENV_VARS map, and with the AgentCore runtime env block in
    // `stacks/agent.ts` — one stack value, one name, three backends. Renaming one
    // side silently strips a key from every MicroVM task's platform_config.
    const env = orchestratorEnvVars(template);
    expect(env.TASK_APPROVALS_TABLE_NAME).toEqual({ Ref: expect.stringMatching(/^TaskApprovalsTable/) });
    expect(env.NUDGES_TABLE_NAME).toEqual({ Ref: expect.stringMatching(/^TaskNudgesTable/) });
    expect(env.LOG_GROUP_NAME).toBe('/aws/abca/application');
    expect(env.ARTIFACTS_BUCKET_NAME).toEqual({ Ref: expect.stringMatching(/^TraceArtifactsBucket/) });
    expect(env.TRACE_ARTIFACTS_BUCKET_NAME).toEqual({ Ref: expect.stringMatching(/^TraceArtifactsBucket/) });
    expect(env.AGENT_SESSION_ROLE_ARN).toBe(SESSION_ROLE_ARN);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(HAIKU_PROFILE);
  });

  test('carries the four REQUIRED platform_config sources together (never a partial set)', () => {
    // The strategy refuses to start a lambda-microvm session without these four.
    // Three come from the orchestrator's own wiring and one from this block, so
    // this is the assertion that they are all reachable from ONE deploy.
    const env = orchestratorEnvVars(createStack({
      githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
      agentPlatformConfig: {
        taskApprovalsTableName: 'approvals',
        nudgesTableName: 'nudges',
        logGroupName: '/aws/abca/application',
        artifactsBucketName: 'artifacts',
        traceArtifactsBucketName: 'traces',
        agentSessionRoleArn: SESSION_ROLE_ARN,
        anthropicDefaultHaikuModel: HAIKU_PROFILE,
      },
    }).template);
    expect(env.TASK_TABLE_NAME).toBeDefined();
    expect(env.TASK_EVENTS_TABLE_NAME).toBeDefined();
    expect(env.GITHUB_TOKEN_SECRET_ARN).toBeDefined();
    expect(env.AGENT_SESSION_ROLE_ARN).toBe(SESSION_ROLE_ARN);
  });

  test('omits every one of them when the prop is absent (isolated-construct posture)', () => {
    const env = orchestratorEnvVars(withoutConfigTemplate);
    for (const key of [
      'TASK_APPROVALS_TABLE_NAME',
      'NUDGES_TABLE_NAME',
      'LOG_GROUP_NAME',
      'ARTIFACTS_BUCKET_NAME',
      'TRACE_ARTIFACTS_BUCKET_NAME',
      'AGENT_SESSION_ROLE_ARN',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  test('grants NOTHING for the forwarded resources — names only, no new reach', () => {
    // The load-bearing property of this block. The orchestrator transports these
    // identifiers to the agent and never calls the resources itself, so a
    // "while I'm here" grant would hand the orchestration plane approvals/nudges
    // tenant-data access it has never needed. The agent reaches them through its
    // own execution role / the task-scoped SessionRole.
    const orchestratorPolicies = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('TaskOrchestrator')),
    );
    expect(orchestratorPolicies).not.toContain('TaskApprovalsTable');
    expect(orchestratorPolicies).not.toContain('TaskNudgesTable');
    expect(orchestratorPolicies).not.toContain('TraceArtifactsBucket');
    // ...and no sts:AssumeRole on the SessionRole either: forwarding the ARN is
    // not assuming the role.
    expect(orchestratorPolicies).not.toContain(SESSION_ROLE_ARN);
    expect(orchestratorPolicies).not.toContain('sts:AssumeRole');
  });
});
