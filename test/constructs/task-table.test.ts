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

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { TaskTable } from '../../src/constructs/task-table';

describe('TaskTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskTable(stack, 'TaskTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with task_id as partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'task_id', KeyType: 'HASH' },
      ],
    });
  });

  test('uses PAY_PER_REQUEST billing mode', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('enables point-in-time recovery by default', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('sets DESTROY removal policy by default', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('creates UserStatusIndex GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'UserStatusIndex',
          KeySchema: [
            { AttributeName: 'user_id', KeyType: 'HASH' },
            { AttributeName: 'status_created_at', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('creates StatusIndex GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'StatusIndex',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'created_at', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('creates IdempotencyIndex GSI with KEYS_ONLY projection', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'IdempotencyIndex',
          KeySchema: [
            { AttributeName: 'idempotency_key', KeyType: 'HASH' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
      ]),
    });
  });

  test('declares all required attribute definitions', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'task_id', AttributeType: 'S' },
        { AttributeName: 'user_id', AttributeType: 'S' },
        { AttributeName: 'status_created_at', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'created_at', AttributeType: 'S' },
        { AttributeName: 'idempotency_key', AttributeType: 'S' },
      ]),
    });
  });

  test('enables TTL on ttl attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('static index name constants match actual GSI names', () => {
    expect(TaskTable.USER_STATUS_INDEX).toBe('UserStatusIndex');
    expect(TaskTable.STATUS_INDEX).toBe('StatusIndex');
    expect(TaskTable.IDEMPOTENCY_INDEX).toBe('IdempotencyIndex');
  });
});

describe('TaskTable with custom props', () => {
  test('accepts custom table name', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskTable(stack, 'TaskTable', { tableName: 'my-tasks' });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'my-tasks',
    });
  });

  test('accepts custom removal policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskTable(stack, 'TaskTable', { removalPolicy: RemovalPolicy.RETAIN });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('accepts point-in-time recovery disabled', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskTable(stack, 'TaskTable', { pointInTimeRecovery: false });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
  });
});
