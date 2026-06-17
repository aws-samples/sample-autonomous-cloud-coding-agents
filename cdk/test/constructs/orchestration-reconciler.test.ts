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
import { OrchestrationReconciler } from '../../src/constructs/orchestration-reconciler';
import { OrchestrationTable } from '../../src/constructs/orchestration-table';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskTable } from '../../src/constructs/task-table';

function synth(): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const taskTable = new TaskTable(stack, 'TaskTable');
  const orchestrationTable = new OrchestrationTable(stack, 'OrchestrationTable');
  const taskEventsTable = new TaskEventsTable(stack, 'TaskEventsTable');
  new OrchestrationReconciler(stack, 'OrchestrationReconciler', {
    taskTable: taskTable.table,
    orchestrationTable: orchestrationTable.table,
    taskEventsTable: taskEventsTable.table,
    orchestratorFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orch',
  });
  return Template.fromStack(stack);
}

describe('OrchestrationReconciler', () => {
  let template: Template;
  beforeEach(() => {
    template = synth();
  });

  test('creates the reconciler Lambda with the orchestration table env', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE_NAME: Match.anyValue(),
          TASK_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('subscribes to the TaskTable stream via an event-source mapping', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BisectBatchOnFunctionError: true,
    });
  });

  test('provisions a DLQ for poison stream records', () => {
    // At least one SQS queue (the reconciler DLQ).
    const queues = template.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues).length).toBeGreaterThanOrEqual(1);
  });

  test('TaskTable has a stream enabled (reconciler source)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
  });
});

describe('OrchestrationReconciler — grants', () => {
  test('grants the function read/write on the orchestration table', () => {
    const template = synth();
    // The function role should have a policy referencing dynamodb actions.
    const policies = template.findResources('AWS::IAM::Policy');
    const hasDdb = Object.values(policies).some((p) => {
      const statements = (p.Properties as { PolicyDocument: { Statement: Array<{ Action?: unknown }> } })
        .PolicyDocument.Statement;
      return JSON.stringify(statements).includes('dynamodb:');
    });
    expect(hasDdb).toBe(true);
  });
});

// Minimal sanity that the props type accepts an ITable.
describe('OrchestrationReconciler — typing', () => {
  test('accepts imported tables', () => {
    const app = new App();
    const stack = new Stack(app, 'T2');
    const taskTable = dynamodb.Table.fromTableAttributes(stack, 'TT', {
      tableName: 'tasks',
      tableStreamArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/tasks/stream/2026',
    });
    const orch = dynamodb.Table.fromTableName(stack, 'OT', 'orch');
    const events = dynamodb.Table.fromTableName(stack, 'ET', 'events');
    expect(() => new OrchestrationReconciler(stack, 'R', {
      taskTable,
      orchestrationTable: orch,
      taskEventsTable: events,
    })).not.toThrow();
  });
});
