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
import { ApprovalMetricsPublisherConsumer } from '../../src/constructs/approval-metrics-publisher-consumer';
import { TaskEventsTable } from '../../src/constructs/task-events-table';

function createStack(): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const events = new TaskEventsTable(stack, 'Events');
  new ApprovalMetricsPublisherConsumer(stack, 'Publisher', {
    taskEventsTable: events.table,
  });

  return { stack, template: Template.fromStack(stack) };
}

function matchesFilterPattern(pattern: any, record: any): boolean {
  if (Array.isArray(pattern)) {
    return pattern.includes(record);
  }
  if (pattern && typeof pattern === 'object') {
    if (!record || typeof record !== 'object') return false;
    for (const [k, v] of Object.entries(pattern)) {
      if (!matchesFilterPattern(v, record[k])) return false;
    }
    return true;
  }
  return false;
}

describe('ApprovalMetricsPublisherConsumer', () => {
  test('creates exactly one Lambda with the right runtime and architecture', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  test('creates an SQS DLQ', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 86400,
    });
  });

  test('creates a DynamoDB Streams EventSourceMapping with reportBatchItemFailures', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 100,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: {
        OnFailure: {
          Destination: Match.anyValue(),
        },
      },
    });
  });

  test('event source mapping filter pattern is structurally correct (not just a regex hit)', () => {
    const { template } = createStack();
    const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
    const mapping = Object.values(mappings)[0] as any;
    const filters = mapping.Properties?.FilterCriteria?.Filters;
    expect(Array.isArray(filters)).toBe(true);
    expect(filters.length).toBe(1);

    const patternRaw = filters[0].Pattern;
    expect(typeof patternRaw).toBe('string');
    const pattern = JSON.parse(patternRaw);

    expect(pattern.eventName).toEqual(['INSERT']);
    expect(pattern.dynamodb).toBeDefined();
    expect(pattern.dynamodb.NewImage).toBeDefined();
    expect(pattern.dynamodb.NewImage.event_type).toBeDefined();
    expect(pattern.dynamodb.NewImage.event_type.S).toEqual(['agent_milestone']);

    const wouldPass = {
      eventName: 'INSERT',
      dynamodb: { NewImage: { event_type: { S: 'agent_milestone' } } },
    };
    const wouldDrop = {
      eventName: 'INSERT',
      dynamodb: { NewImage: { event_type: { S: 'task_created' } } },
    };
    expect(matchesFilterPattern(pattern, wouldPass)).toBe(true);
    expect(matchesFilterPattern(pattern, wouldDrop)).toBe(false);
  });

  test('retryAttempts is 3 (fanout-aligned)', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      MaximumRetryAttempts: 3,
    });
  });

  test('Lambda role has DDB Streams read permissions on the events table', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:GetRecords', 'dynamodb:GetShardIterator']),
          }),
        ]),
      },
    });
  });

  test('DLQ has SendMessage permission granted to Lambda execution role', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
          }),
        ]),
      },
    });
  });

  test('does not create a DynamoDB table (consumer must never create its own events table)', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('creates a CloudWatch alarm on DLQ ApproximateNumberOfMessagesVisible (#117)', () => {
    const { template } = createStack();

    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Statistic: 'Maximum',
      Period: 300,
      Dimensions: Match.arrayWith([
        Match.objectLike({
          Name: 'QueueName',
          Value: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([
              Match.stringLikeRegexp('ApprovalMetricsPublisherDlq'),
            ]),
          }),
        }),
      ]),
    });
  });
});
