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
import { AdmissionQueuePickup } from '../../src/constructs/admission-queue-pickup';

const ORCHESTRATOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';

let cachedTemplate: Template | undefined;

function createStack(): Template {
  if (cachedTemplate) return cachedTemplate;
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

  new AdmissionQueuePickup(stack, 'AdmissionQueuePickup', {
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    orchestratorFunctionArn: ORCHESTRATOR_ARN,
  });

  cachedTemplate = Template.fromStack(stack);
  return cachedTemplate;
}

describe('AdmissionQueuePickup construct', () => {
  test('creates a Lambda function on Node 24 / ARM', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Timeout: 300,
    });
  });

  test('schedules the pickup every minute by default (queue latency is user-visible wait)', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
    });
  });

  test('threads queue configuration into the handler environment', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
          ORCHESTRATOR_FUNCTION_ARN: ORCHESTRATOR_ARN,
          MAX_CONCURRENT_TASKS_PER_USER: '10',
          QUEUE_MAX_AGE_SECONDS: '86400',
        }),
      },
    });
  });

  test('grants lambda:InvokeFunction on the orchestrator alias only', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: ORCHESTRATOR_ARN,
          }),
        ]),
      },
    });
  });

  test('concurrency table access is read-only (admissionControl stays the single counter writer)', () => {
    const template = createStack();
    const policies = template.findResources('AWS::IAM::Policy');
    // Collect every statement that touches the concurrency table and
    // assert none of them include write actions.
    const statements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement as any[],
    );
    const concurrencyWrites = statements.filter(s => {
      const actions: string[] = Array.isArray(s.Action) ? s.Action : [s.Action];
      const resources = JSON.stringify(s.Resource ?? '');
      return resources.includes('UserConcurrencyTable')
        && actions.some(a => /PutItem|UpdateItem|DeleteItem|BatchWriteItem/.test(a));
    });
    expect(concurrencyWrites).toHaveLength(0);
  });
});
