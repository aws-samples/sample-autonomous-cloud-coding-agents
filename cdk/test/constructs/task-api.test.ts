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
import { TaskApi, type TaskApiProps } from '../../src/constructs/task-api';

function createStack(overrides?: Partial<TaskApiProps>): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });

  const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
  });

  new TaskApi(stack, 'TaskApi', {
    taskTable,
    taskEventsTable,
    ...overrides,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

function createStackWithWebhooks(overrides?: Partial<TaskApiProps>): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });

  const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
  });

  const webhookTable = new dynamodb.Table(stack, 'WebhookTable', {
    partitionKey: { name: 'webhook_id', type: dynamodb.AttributeType.STRING },
  });

  new TaskApi(stack, 'TaskApi', {
    taskTable,
    taskEventsTable,
    webhookTable,
    ...overrides,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskApi construct', () => {
  let baseTemplate: Template;
  let webhookTemplate: Template;

  beforeAll(() => {
    baseTemplate = createStack().template;
    webhookTemplate = createStackWithWebhooks().template;
  });

  test('creates a Cognito User Pool', () => {
    baseTemplate.resourceCountIs('AWS::Cognito::UserPool', 1);
    baseTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });

  test('creates a Cognito User Pool Client with correct auth flows', () => {
    baseTemplate.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    baseTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith([
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
      ]),
      GenerateSecret: false,
    });
  });

  test('creates a REST API with correct stage name', () => {
    baseTemplate.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    baseTemplate.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'TaskApi',
    });
    baseTemplate.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'v1',
    });
  });

  test('creates 6 Lambda functions without webhookTable', () => {
    // 6 = create, get, list, cancel, get-events, get-replay (#515).
    baseTemplate.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test('creates 11 Lambda functions with webhookTable', () => {
    webhookTemplate.resourceCountIs('AWS::Lambda::Function', 11);
  });

  test('Lambda functions use ARM_64 architecture and Node.js 24', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    const fnIds = Object.keys(functions);

    expect(fnIds.length).toBe(6);
    for (const fnId of fnIds) {
      expect(functions[fnId].Properties.Runtime).toBe('nodejs24.x');
      expect(functions[fnId].Properties.Architectures).toEqual(['arm64']);
    }
  });

  test('GetTaskReplayFn gets raised timeout/memory, not the 3s/128MB defaults (#523)', () => {
    // Replay is the heaviest read path (GetItem + multi-page Query + full-bundle
    // serialization); inheriting the defaults risks INIT-timeout 502s and OOM.
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    const replayFn = Object.entries(functions).find(([id]) => id.startsWith('TaskApiGetTaskReplayFn'));
    expect(replayFn).toBeDefined();
    expect(replayFn![1].Properties.Timeout).toBe(15);
    expect(replayFn![1].Properties.MemorySize).toBe(512);
  });

  test('Lambda functions have correct environment variables', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');

    for (const fnId of Object.keys(functions)) {
      const envVars = functions[fnId].Properties.Environment?.Variables ?? {};
      expect(envVars).toHaveProperty('TASK_TABLE_NAME');
      expect(envVars).toHaveProperty('TASK_EVENTS_TABLE_NAME');
      expect(envVars).toHaveProperty('TASK_RETENTION_DAYS', '90');
    }
  });

  test('creates API resources for /tasks and /tasks/{task_id}', () => {
    baseTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'tasks',
    });

    baseTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{task_id}',
    });

    baseTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'events',
    });

    // Replay sub-resource (#515): GET /tasks/{task_id}/replay.
    baseTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'replay',
    });
  });

  test('creates 6 API methods with Cognito authorization (no webhooks)', () => {
    const methods = baseTemplate.findResources('AWS::ApiGateway::Method');
    const nonOptionsMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.HttpMethod !== 'OPTIONS',
    );
    // 6 = POST /tasks, GET /tasks, GET+DELETE /tasks/{id}, GET events, GET replay.
    expect(nonOptionsMethods.length).toBe(6);

    for (const [_, resource] of nonOptionsMethods) {
      expect((resource as any).Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
    }
  });

  test('creates a WAFv2 Web ACL with managed rule groups', () => {
    baseTemplate.resourceCountIs('AWS::WAFv2::WebACL', 1);
    baseTemplate.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
        Match.objectLike({ Name: 'RateLimitRule' }),
      ]),
    });
  });

  test('allows large HMAC-verified Jira webhook bodies through the WAF common rule set', () => {
    const webAcls = baseTemplate.findResources('AWS::WAFv2::WebACL');
    const webAcl = Object.values(webAcls)[0] as any;
    const rules = webAcl.Properties.Rules as any[];
    const largeBodyRule = rules.find(
      rule => rule.Name === 'AWSManagedRulesCommonRuleSet-TaskPaths',
    );
    const fullCommonRule = rules.find(
      rule => rule.Name === 'AWSManagedRulesCommonRuleSet',
    );

    expect(
      largeBodyRule.Statement.ManagedRuleGroupStatement.ExcludedRules,
    ).toEqual([{ Name: 'SizeRestrictions_BODY' }]);
    expect(
      largeBodyRule.Statement.ManagedRuleGroupStatement.ScopeDownStatement
        .OrStatement.Statements,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ByteMatchStatement: expect.objectContaining({
          PositionalConstraint: 'EXACTLY',
          SearchString: '/v1/jira/webhook',
        }),
      }),
    ]));
    expect(
      fullCommonRule.Statement.ManagedRuleGroupStatement.ScopeDownStatement
        .AndStatement.Statements,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        NotStatement: expect.objectContaining({
          Statement: expect.objectContaining({
            ByteMatchStatement: expect.objectContaining({
              PositionalConstraint: 'EXACTLY',
              SearchString: '/v1/jira/webhook',
            }),
          }),
        }),
      }),
    ]));
  });

  test('associates WAF with the API Gateway stage', () => {
    baseTemplate.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  test('creates a Cognito User Pools authorizer', () => {
    baseTemplate.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    baseTemplate.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
  });

  test('createTask Lambda has ORCHESTRATOR_FUNCTION_ARN when provided', () => {
    const { template } = createStack({
      orchestratorFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orch:live',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATOR_FUNCTION_ARN: 'arn:aws:lambda:us-east-1:123456789012:function:orch:live',
        }),
      },
    });
  });

  test('createTask Lambda grants invoke on orchestrator when provided', () => {
    const { template } = createStack({
      orchestratorFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orch:live',
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: 'arn:aws:lambda:us-east-1:123456789012:function:orch:live',
          }),
        ]),
      },
    });
  });

  test('stage has throttle settings', () => {
    baseTemplate.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ThrottlingRateLimit: 60,
          ThrottlingBurstLimit: 100,
        }),
      ]),
    });
  });

  test('createTask Lambda has REPO_TABLE_NAME when repoTable is provided', () => {
    const app = new App();
    const stack = new Stack(app, 'RepoStack');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new TaskApi(stack, 'TaskApi', {
      taskTable,
      taskEventsTable,
      repoTable,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REPO_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('createTask Lambda has guardrail env vars when provided', () => {
    const { template } = createStack({
      guardrailId: 'gr-abc123',
      guardrailVersion: '1',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GUARDRAIL_ID: 'gr-abc123',
          GUARDRAIL_VERSION: '1',
        }),
      },
    });
  });

  test('cancelTask Lambda gets ECS_CLUSTER_ARN env var and ecs:StopTask when ecsClusterArn is set', () => {
    const { template } = createStack({
      ecsClusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123456789012:cluster/agent-cluster',
        }),
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecs:StopTask',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('cancelTask Lambda does not get ECS env vars when ecsClusterArn is not set', () => {
    const functions = baseTemplate.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(functions)) {
      const vars = (fn as any).Properties?.Environment?.Variables ?? {};
      expect(vars).not.toHaveProperty('ECS_CLUSTER_ARN');
    }
  });
});

describe('TaskApi construct with webhooks', () => {
  let template: Template;

  beforeAll(() => {
    template = createStackWithWebhooks().template;
  });

  test('creates webhook API resources', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'webhooks',
    });

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{webhook_id}',
    });
  });

  test('creates both Cognito and REQUEST authorizers', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 2);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
    });
  });

  test('webhook Lambdas have WEBHOOK_TABLE_NAME and WEBHOOK_RETENTION_DAYS env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WEBHOOK_TABLE_NAME: Match.anyValue(),
          WEBHOOK_RETENTION_DAYS: '30',
        }),
      },
    });
  });

  test('creates 10 non-OPTIONS API methods with webhooks', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const nonOptionsMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.HttpMethod !== 'OPTIONS',
    );
    // 6 base (incl. GET replay #515) + 4 webhook (POST/GET /webhooks, DELETE /webhooks/{id}, POST /webhooks/tasks)
    expect(nonOptionsMethods.length).toBe(10);
  });

  test('webhook task creation uses CUSTOM authorization', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const customAuthMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.AuthorizationType === 'CUSTOM',
    );
    expect(customAuthMethods.length).toBe(1);
  });

  test('webhookCreateTask Lambda has Secrets Manager GetSecretValue permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('createWebhook Lambda has Secrets Manager CreateSecret and TagResource permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:CreateSecret',
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 'secretsmanager:TagResource',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});

describe('TaskApi construct — nudge endpoint (Phase 2)', () => {
  let nudgeTemplate: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'NudgeStack');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const taskNudgesTable = new dynamodb.Table(stack, 'TaskNudgesTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nudge_id', type: dynamodb.AttributeType.STRING },
    });
    new TaskApi(stack, 'TaskApi', {
      taskTable,
      taskEventsTable,
      taskNudgesTable,
      guardrailId: 'gr-abc',
      guardrailVersion: '1',
    });
    nudgeTemplate = Template.fromStack(stack);
  });

  test('does NOT create a nudge resource when taskNudgesTable is absent', () => {
    const { template } = createStack();

    const resources = template.findResources('AWS::ApiGateway::Resource');
    const nudgeRes = Object.values(resources).filter(
      r => (r as { Properties?: { PathPart?: string } }).Properties?.PathPart === 'nudge',
    );
    expect(nudgeRes).toHaveLength(0);
  });

  test('creates a /nudge resource when taskNudgesTable is provided', () => {
    nudgeTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'nudge',
    });
  });

  test('nudge route uses Cognito authorization on POST', () => {
    const methods = nudgeTemplate.findResources('AWS::ApiGateway::Method');
    const nudgePost = Object.values(methods).filter(m => {
      const p = (m as { Properties?: { HttpMethod?: string } }).Properties ?? {};
      return p.HttpMethod === 'POST';
    });
    const cognitoPosts = nudgePost.filter(m =>
      (m as { Properties?: { AuthorizationType?: string } }).Properties?.AuthorizationType === 'COGNITO_USER_POOLS',
    );
    expect(cognitoPosts.length).toBeGreaterThanOrEqual(1);
  });

  test('nudge Lambda has NUDGES_TABLE_NAME and NUDGE_RATE_LIMIT_PER_MINUTE env vars', () => {
    nudgeTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NUDGES_TABLE_NAME: Match.anyValue(),
          NUDGE_RATE_LIMIT_PER_MINUTE: '10',
        }),
      },
    });
  });

  test('nudge Lambda has guardrail env vars when provided', () => {
    nudgeTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NUDGES_TABLE_NAME: Match.anyValue(),
          GUARDRAIL_ID: 'gr-abc',
          GUARDRAIL_VERSION: '1',
        }),
      },
    });
  });

  test('nudge Lambda has bedrock:ApplyGuardrail permission when guardrail configured', () => {
    nudgeTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:ApplyGuardrail',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('respects custom nudgeRateLimitPerMinute', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomNudgeStack');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const taskNudgesTable = new dynamodb.Table(stack, 'TaskNudgesTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nudge_id', type: dynamodb.AttributeType.STRING },
    });
    new TaskApi(stack, 'TaskApi', {
      taskTable,
      taskEventsTable,
      taskNudgesTable,
      guardrailId: 'gr-abc',
      guardrailVersion: '1',
      nudgeRateLimitPerMinute: 25,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NUDGE_RATE_LIMIT_PER_MINUTE: '25',
        }),
      },
    });
  });
});

describe('TaskApi construct — trace endpoint (design §10.1)', () => {
  let traceTemplate: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TraceStack');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const traceBucket = new s3.Bucket(stack, 'TraceBucket');
    new TaskApi(stack, 'TaskApi', {
      taskTable,
      taskEventsTable,
      traceArtifactsBucket: traceBucket,
    });
    traceTemplate = Template.fromStack(stack);
  });

  test('does NOT create a trace resource when traceArtifactsBucket is absent', () => {
    const { template } = createStack();

    const resources = template.findResources('AWS::ApiGateway::Resource');
    const pathParts = Object.values(resources).map(r => r.Properties.PathPart);
    expect(pathParts).not.toContain('trace');
  });

  test('creates a GET /tasks/{task_id}/trace resource when traceArtifactsBucket is provided', () => {
    const resources = traceTemplate.findResources('AWS::ApiGateway::Resource');
    const tracePath = Object.values(resources).find(r => r.Properties.PathPart === 'trace');
    expect(tracePath).toBeDefined();

    traceTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      ResourceId: Match.anyValue(),
    });
  });

  test('creates the GetTraceUrlFn Lambda with TRACE_ARTIFACTS_BUCKET_NAME env var', () => {
    const functions = traceTemplate.findResources('AWS::Lambda::Function');
    const traceFns = Object.entries(functions).filter(([id]) =>
      id.startsWith('TaskApiGetTraceUrlFn'),
    );
    expect(traceFns).toHaveLength(1);
    const [, resource] = traceFns[0];
    const envVars = resource.Properties.Environment?.Variables;
    expect(envVars).toBeDefined();
    expect(envVars.TRACE_ARTIFACTS_BUCKET_NAME).toBeDefined();
    expect(envVars.TASK_TABLE_NAME).toBeDefined();
  });

  test('grants the handler read-only access to the trace bucket (GetObject, not PutObject)', () => {
    const policies = traceTemplate.findResources('AWS::IAM::Policy');
    const handlerPolicies = Object.entries(policies).filter(([id]) =>
      id.includes('GetTraceUrlFn'),
    );
    expect(handlerPolicies.length).toBeGreaterThan(0);

    const allS3Actions: string[] = [];
    for (const [, resource] of handlerPolicies) {
      const statements = resource.Properties.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actionList = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actionList) {
          if (typeof a === 'string' && a.startsWith('s3:')) {
            allS3Actions.push(a);
          }
        }
      }
    }

    expect(allS3Actions).toContain('s3:GetObject');
    expect(allS3Actions).not.toContain('s3:GetObject*');
    expect(allS3Actions).not.toContain('s3:ListBucket');
    expect(allS3Actions.some(a => a.startsWith('s3:List'))).toBe(false);
    expect(allS3Actions.some(a => a.startsWith('s3:GetBucket'))).toBe(false);
    expect(allS3Actions.some(a => a.startsWith('s3:PutObject'))).toBe(false);
    expect(allS3Actions.some(a => a.startsWith('s3:DeleteObject'))).toBe(false);
    expect(allS3Actions).not.toContain('s3:*');
  });

  test('grants the handler read access to the task table for ownership checks', () => {
    const policies = traceTemplate.findResources('AWS::IAM::Policy');
    const handlerPolicies = Object.entries(policies).filter(([id]) =>
      id.includes('GetTraceUrlFn'),
    );

    const allDdbActions: string[] = [];
    for (const [, resource] of handlerPolicies) {
      const statements = resource.Properties.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actionList = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actionList) {
          if (typeof a === 'string' && a.startsWith('dynamodb:')) {
            allDdbActions.push(a);
          }
        }
      }
    }
    expect(allDdbActions).toContain('dynamodb:GetItem');
    expect(allDdbActions).not.toContain('dynamodb:PutItem');
    expect(allDdbActions).not.toContain('dynamodb:UpdateItem');
  });

  test('trace endpoint uses Cognito authorization (same as other task endpoints)', () => {
    const methods = traceTemplate.findResources('AWS::ApiGateway::Method');
    const traceMethods = Object.values(methods).filter(m =>
      m.Properties.HttpMethod === 'GET',
    );
    const cognitoGetMethods = traceMethods.filter(m => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS');
    expect(cognitoGetMethods.length).toBeGreaterThanOrEqual(4);
  });

  test('GetTraceUrlFn has adequate timeout and memory for SDK cold-start', () => {
    const functions = traceTemplate.findResources('AWS::Lambda::Function');
    const traceFn = Object.values(functions).find(
      f => f.Properties.Environment?.Variables?.TRACE_ARTIFACTS_BUCKET_NAME !== undefined,
    );
    expect(traceFn).toBeDefined();
    expect(traceFn!.Properties.Timeout).toBe(15);
    expect(traceFn!.Properties.MemorySize).toBe(512);
  });
});
