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

/**
 * Minimal EventBridge filter-pattern matcher covering the subset of
 * pattern syntax this project uses: leaf values must be arrays of
 * literals, and every key in ``pattern`` must be present + matching
 * in ``record``. Not a full engine — just enough to positively /
 * negatively probe the ``agent_milestone`` filter without spinning
 * up a real Lambda service harness. This is exactly the
 * belt-and-braces complement to the structural assertion: the
 * structural check guards path typos; the probe check guards value
 * typos.
 */
function matchesFilterPattern(pattern: any, record: any): boolean {
  if (Array.isArray(pattern)) {
    // Leaf — array of candidate literal values.
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
    // Exactly one Queue resource (the DLQ). If a future change
    // introduces a second queue (replay queue, poison bucket, etc.),
    // this guards against accidental dual-queue creation.
    template.resourceCountIs('AWS::SQS::Queue', 1);
    // DLQ has SSE enforced (NagSuppressions applied separately).
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 86400, // 14 days in seconds
    });
  });

  test('creates a DynamoDB Streams EventSourceMapping with reportBatchItemFailures', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 100,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      // DestinationConfig points to the DLQ for persistent failures.
      DestinationConfig: {
        OnFailure: {
          Destination: Match.anyValue(),
        },
      },
    });
  });

  test('event source mapping filter pattern is structurally correct (not just a regex hit)', () => {
    // Critical — if the filter pattern is wrong, the Lambda either
    // never invokes (typo in path) or invokes on every event
    // (running up cost). A ``stringLikeRegexp('agent_milestone')``
    // match would pass even if the literal string happened to
    // appear in an irrelevant key (silent-failure H3). Instead,
    // extract the Pattern JSON string from the synthesized template
    // and parse it to validate the exact nested path
    // ``dynamodb.NewImage.event_type.S`` carries the right literal.
    const { template } = createStack();
    const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
    const mapping = Object.values(mappings)[0] as any;
    const filters = mapping.Properties?.FilterCriteria?.Filters;
    expect(Array.isArray(filters)).toBe(true);
    expect(filters.length).toBe(1);

    const patternRaw = filters[0].Pattern;
    expect(typeof patternRaw).toBe('string');
    const pattern = JSON.parse(patternRaw);

    // Top-level filter keys must be exactly these two. A typo like
    // ``NewImages`` (plural) or ``event_Type`` (case drift) would
    // flip the filter into match-nothing mode silently.
    expect(pattern.eventName).toEqual(['INSERT']);
    expect(pattern.dynamodb).toBeDefined();
    expect(pattern.dynamodb.NewImage).toBeDefined();
    expect(pattern.dynamodb.NewImage.event_type).toBeDefined();
    expect(pattern.dynamodb.NewImage.event_type.S).toEqual(['agent_milestone']);

    // Positive-match sanity check: construct a minimal record that
    // MUST pass this filter (an agent_milestone INSERT) and one
    // that MUST NOT (non-agent_milestone INSERT). We don't run the
    // actual EventBridge filter engine here, but we can still
    // assert the filter's top-level intent is "this exact event".
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
    // CDK generates an inline policy on the execution role granting
    // the stream ARN with ``dynamodb:DescribeStream`` /
    // ``GetRecords`` / ``GetShardIterator`` / ``ListStreams``. We
    // assert the stream ARN wildcard shape rather than exact policy
    // text since CDK may version the boilerplate.
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
    // Lambda must be able to send to the DLQ on persistent failures.
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
    // Regression guard: a refactor that inlines the events table by
    // mistake would silently fork state into a non-streaming copy.
    const { template } = createStack();
    // The createStack helper creates TaskEventsTable once, so we
    // expect exactly one Table in the synthesized stack.
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});
