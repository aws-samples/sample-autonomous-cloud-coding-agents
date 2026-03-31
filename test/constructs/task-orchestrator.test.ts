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
import { TaskOrchestrator } from '../../src/constructs/task-orchestrator';

interface StackOverrides {
  maxConcurrentTasksPerUser?: number;
  githubTokenSecretArn?: string;
  userPromptTokenBudget?: number;
  includeRepoTable?: boolean;
  additionalRuntimeArns?: string[];
  additionalSecretArns?: string[];
  memoryId?: string;
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

  const { includeRepoTable: _, additionalRuntimeArns, additionalSecretArns, memoryId, ...rest } = overrides ?? {};

  new TaskOrchestrator(stack, 'TaskOrchestrator', {
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
    ...(repoTable && { repoTable }),
    ...(additionalRuntimeArns && { additionalRuntimeArns }),
    ...(additionalSecretArns && { additionalSecretArns }),
    ...(memoryId && { memoryId }),
    ...rest,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskOrchestrator construct', () => {
  test('creates a Lambda function with NODEJS_24_X runtime', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  test('Lambda function has correct environment variables', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
          RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
          MAX_CONCURRENT_TASKS_PER_USER: '3',
          TASK_RETENTION_DAYS: '90',
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
    const { template } = createStack();
    template.resourceCountIs('AWS::Lambda::Alias', 1);
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
    });
  });

  test('grants AgentCore runtime invocation permissions with wildcard sub-resource', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:InvokeAgentRuntime',
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
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Role', {
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
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 60,
    });
  });

  test('includes GITHUB_TOKEN_SECRET_ARN when provided', () => {
    const { template } = createStack({
      githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
        }),
      },
    });
  });

  test('grants Secrets Manager read when githubTokenSecretArn is provided', () => {
    const { template } = createStack({
      githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-abc123',
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

  test('does not include GITHUB_TOKEN_SECRET_ARN when not provided', () => {
    const { template } = createStack();
    // Verify the env vars do NOT contain GITHUB_TOKEN_SECRET_ARN
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    // Check that no Secrets Manager policy exists (only DynamoDB + AgentCore)
    const policies = template.findResources('AWS::IAM::Policy');
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
    const { template } = createStack({ includeRepoTable: true });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REPO_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('does not include REPO_TABLE_NAME when repoTable is not provided', () => {
    const { template } = createStack();
    const functions = template.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(functions)) {
      const envVars = (fn as any).Properties.Environment?.Variables ?? {};
      expect(envVars).not.toHaveProperty('REPO_TABLE_NAME');
    }
  });

  test('grants read access on repo table when provided', () => {
    const { template } = createStack({ includeRepoTable: true });
    template.hasResourceProperties('AWS::IAM::Policy', {
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
    const { template } = createStack();
    const functions = template.findResources('AWS::Lambda::Function');
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
    const { template } = createStack();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      EvaluationPeriods: 2,
      Threshold: 3,
      TreatMissingData: 'notBreaching',
    });
  });

  test('configures async invoke with zero retry attempts', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });
});
