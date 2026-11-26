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
import { FanOutConsumer } from '../../src/constructs/fanout-consumer';

function makeTaskEventsTable(stack: Stack): dynamodb.Table {
  return new dynamodb.Table(stack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_IMAGE,
  });
}

describe('FanOutConsumer', () => {
  test('attaches a single DynamoEventSource on the TaskEventsTable stream', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 100,
      MaximumRetryAttempts: 3,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('creates a DLQ for the fanout Lambda', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });

  test('omits the bgagent/slack/* grant when slackSecretArnPattern is not provided (PR #79 review #2)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const stmts = (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
        .Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const action = (stmt as { Action?: unknown }).Action;
        const resource = JSON.stringify((stmt as { Resource?: unknown }).Resource ?? '');
        const isSlackSecretGrant =
          (action === 'secretsmanager:GetSecretValue'
            || (Array.isArray(action) && action.includes('secretsmanager:GetSecretValue')))
          && resource.includes('bgagent/slack');
        expect(isSlackSecretGrant).toBe(false);
      }
    }
  });

  test('attaches the bgagent/slack/* grant only when slackSecretArnPattern is provided', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
      slackSecretArnPattern:
        'arn:aws:secretsmanager:us-east-1:111122223333:secret:bgagent/slack/*',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Effect: 'Allow',
            Resource: Match.stringLikeRegexp('bgagent/slack/\\*'),
          }),
        ]),
      },
    });
  });

  test('alarms on the first record landing in the DLQ', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Dimensions: Match.arrayWith([
        Match.objectLike({
          Name: 'QueueName',
          Value: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('FanOutDlq')]),
          }),
        }),
      ]),
    });
  });

  test('wires JIRA_WORKSPACE_REGISTRY_TABLE_NAME + the bgagent-jira-oauth-* grant when the Jira props are provided (#573)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const jiraRegistry = new dynamodb.Table(stack, 'JiraRegistry', {
      partitionKey: { name: 'jira_cloud_id', type: dynamodb.AttributeType.STRING },
    });
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
      jiraWorkspaceRegistryTable: jiraRegistry,
      jiraOauthSecretArnPattern:
        'arn:aws:secretsmanager:us-east-1:111122223333:secret:bgagent-jira-oauth-*',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JIRA_WORKSPACE_REGISTRY_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
            Effect: 'Allow',
            Resource: Match.stringLikeRegexp('bgagent-jira-oauth-\\*'),
          }),
        ]),
      },
    });
  });

  test('omits the JIRA env var + bgagent-jira-oauth-* grant when the Jira props are absent (graceful degrade)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const vars = ((fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables) ?? {};
      expect(vars.JIRA_WORKSPACE_REGISTRY_TABLE_NAME).toBeUndefined();
    }
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const stmts = (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
        .Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resource = JSON.stringify((stmt as { Resource?: unknown }).Resource ?? '');
        expect(resource.includes('bgagent-jira-oauth')).toBe(false);
      }
    }
  });

  test('sets LINEAR_AGENT_SESSIONS_ENABLED only when linearAgentSessionsEnabled is true (ADR-018 Phase 2)', () => {
    const synth = (enabled?: boolean) => {
      const stack = new Stack(new App(), 'TestStack');
      new FanOutConsumer(stack, 'FanOut', {
        taskEventsTable: makeTaskEventsTable(stack),
        ...(enabled !== undefined && { linearAgentSessionsEnabled: enabled }),
      });
      return Template.fromStack(stack);
    };
    synth(true).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ LINEAR_AGENT_SESSIONS_ENABLED: 'true' }) },
    });
    for (const off of [synth(false), synth()]) {
      for (const fn of Object.values(off.findResources('AWS::Lambda::Function'))) {
        const vars = (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment?.Variables ?? {};
        expect(vars).not.toHaveProperty('LINEAR_AGENT_SESSIONS_ENABLED');
      }
    }
  });

  test('passes TASK_TABLE_NAME env var when taskTable is provided', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
      taskTable,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('omits TASK_TABLE_NAME env var when taskTable is not provided (graceful degrade)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
    });
    const template = Template.fromStack(stack);

    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const vars = ((fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables) ?? {};
      expect(vars.TASK_TABLE_NAME).toBeUndefined();
    }
  });
});
