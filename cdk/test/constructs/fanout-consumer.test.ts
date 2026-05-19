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

// PR #79 test gap #34. The construct shipped on issue #64 with no
// unit-level coverage of its IAM contract — the only synth-level
// signal lived inside slack-integration.test.ts ("0 EventSourceMapping")
// which proved the migration didn't regress the OTHER construct.
// These tests pin the FanOutConsumer's own surface: the Slack secret
// grant must be guarded by ``slackSecretArnPattern`` (review #2), the
// stream binding must exist, and the DLQ must be wired.

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

    // Exactly one event-source mapping — the architectural invariant
    // issue #64 was about. Adding a second consumer to TaskEventsTable
    // must fail this test loudly.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      // Larger batch size than the old SlackNotifyFn (10) because the
      // dispatcher fans out across channels — fewer Lambda
      // invocations, better throughput.
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
      MessageRetentionPeriod: 14 * 24 * 60 * 60, // 14 days
    });
  });

  test('omits the bgagent/slack/* grant when slackSecretArnPattern is not provided (PR #79 review #2)', () => {
    // Pre-fix: the policy attached unconditionally so dev stacks
    // without Slack onboarding accumulated a dangling IAM permission.
    // Post-fix: the policy only attaches when the prop is set, so
    // construct consumers stay symmetric with taskTable / repoTable /
    // githubTokenSecret (also guarded by their respective props).
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new FanOutConsumer(stack, 'FanOut', {
      taskEventsTable: makeTaskEventsTable(stack),
      // intentionally no slackSecretArnPattern
    });
    const template = Template.fromStack(stack);

    // Iterate every IAM::Policy and assert NONE of them grant
    // ``secretsmanager:GetSecretValue`` on a ``bgagent/slack/*`` ARN.
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

  test('passes TASK_TABLE_NAME env var when taskTable is provided', () => {
    // The Slack dispatcher requires this env var (review #3); the
    // construct must wire it from the prop. Its absence triggers the
    // FANOUT_SLACK_MISSING_TASK_TABLE error on dispatch.
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
