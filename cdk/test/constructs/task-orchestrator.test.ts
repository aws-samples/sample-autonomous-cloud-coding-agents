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

  test('passes the execution role to lambda.amazonaws.com only', () => {
    const passRole = microvmStatements(template).find(s => s.Sid === 'MicrovmPassExecutionRole')!;
    expect(passRole.Action).toBe('iam:PassRole');
    expect(passRole.Resource).toBe(EXECUTION_ROLE_ARN);
    expect(passRole.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
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
