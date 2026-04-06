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
  test('creates a Cognito User Pool', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
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
    const { template } = createStack();
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith([
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
      ]),
      GenerateSecret: false,
    });
  });

  test('creates a REST API with correct stage name', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'TaskApi',
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'v1',
    });
  });

  test('creates 5 Lambda functions without webhookTable', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::Lambda::Function', 5);
  });

  test('creates 10 Lambda functions with webhookTable', () => {
    const { template } = createStackWithWebhooks();
    template.resourceCountIs('AWS::Lambda::Function', 10);
  });

  test('Lambda functions use ARM_64 architecture and Node.js 24', () => {
    const { template } = createStack();
    const functions = template.findResources('AWS::Lambda::Function');
    const fnIds = Object.keys(functions);

    expect(fnIds.length).toBe(5);
    for (const fnId of fnIds) {
      expect(functions[fnId].Properties.Runtime).toBe('nodejs24.x');
      expect(functions[fnId].Properties.Architectures).toEqual(['arm64']);
    }
  });

  test('Lambda functions have correct environment variables', () => {
    const { template } = createStack();
    const functions = template.findResources('AWS::Lambda::Function');

    for (const fnId of Object.keys(functions)) {
      const envVars = functions[fnId].Properties.Environment?.Variables ?? {};
      expect(envVars).toHaveProperty('TASK_TABLE_NAME');
      expect(envVars).toHaveProperty('TASK_EVENTS_TABLE_NAME');
      expect(envVars).toHaveProperty('TASK_RETENTION_DAYS', '90');
    }
  });

  test('creates API resources for /tasks and /tasks/{task_id}', () => {
    const { template } = createStack();

    // Check for tasks resource
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'tasks',
    });

    // Check for {task_id} resource
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{task_id}',
    });

    // Check for events resource
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'events',
    });
  });

  test('creates 5 API methods with Cognito authorization (no webhooks)', () => {
    const { template } = createStack();

    const methods = template.findResources('AWS::ApiGateway::Method');
    const nonOptionsMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.HttpMethod !== 'OPTIONS',
    );
    expect(nonOptionsMethods.length).toBe(5);

    // Verify all non-OPTIONS methods use COGNITO authorization
    for (const [_, resource] of nonOptionsMethods) {
      expect((resource as any).Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
    }
  });

  test('creates a WAFv2 Web ACL with managed rule groups', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
        Match.objectLike({ Name: 'RateLimitRule' }),
      ]),
    });
  });

  test('associates WAF with the API Gateway stage', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  test('creates a Cognito User Pools authorizer', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
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
    const { template } = createStack();
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
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
    const app = new App();
    const stack = new Stack(app, 'GuardrailStack');
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
      guardrailId: 'gr-abc123',
      guardrailVersion: '1',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GUARDRAIL_ID: 'gr-abc123',
          GUARDRAIL_VERSION: '1',
        }),
      },
    });
  });
});

describe('TaskApi construct with webhooks', () => {
  test('creates webhook API resources', () => {
    const { template } = createStackWithWebhooks();

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'webhooks',
    });

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{webhook_id}',
    });
  });

  test('creates both Cognito and REQUEST authorizers', () => {
    const { template } = createStackWithWebhooks();
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 2);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
    });
  });

  test('webhook Lambdas have WEBHOOK_TABLE_NAME and WEBHOOK_RETENTION_DAYS env vars', () => {
    const { template } = createStackWithWebhooks();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WEBHOOK_TABLE_NAME: Match.anyValue(),
          WEBHOOK_RETENTION_DAYS: '30',
        }),
      },
    });
  });

  test('creates 9 non-OPTIONS API methods with webhooks', () => {
    const { template } = createStackWithWebhooks();

    const methods = template.findResources('AWS::ApiGateway::Method');
    const nonOptionsMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.HttpMethod !== 'OPTIONS',
    );
    // 5 existing + 4 webhook (POST/GET /webhooks, DELETE /webhooks/{id}, POST /webhooks/tasks)
    expect(nonOptionsMethods.length).toBe(9);
  });

  test('webhook task creation uses CUSTOM authorization', () => {
    const { template } = createStackWithWebhooks();

    const methods = template.findResources('AWS::ApiGateway::Method');
    const customAuthMethods = Object.entries(methods).filter(
      ([_, resource]) => (resource as any).Properties.AuthorizationType === 'CUSTOM',
    );
    expect(customAuthMethods.length).toBe(1);
  });

  test('webhookCreateTask Lambda has Secrets Manager GetSecretValue permission', () => {
    const { template } = createStackWithWebhooks();
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
    const { template } = createStackWithWebhooks();
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
