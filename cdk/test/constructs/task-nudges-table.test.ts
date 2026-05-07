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
import { TaskNudgesTable } from '../../src/constructs/task-nudges-table';

describe('TaskNudgesTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskNudgesTable(stack, 'TaskNudgesTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with task_id PK and nudge_id SK', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'task_id', KeyType: 'HASH' },
        { AttributeName: 'nudge_id', KeyType: 'RANGE' },
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

  test('does not create any GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.absent(),
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

  test('declares exactly two attribute definitions', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: [
        { AttributeName: 'task_id', AttributeType: 'S' },
        { AttributeName: 'nudge_id', AttributeType: 'S' },
      ],
    });
  });

  test('does not enable DynamoDB Streams (nudges are poll-consumed)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });
});

describe('TaskNudgesTable with custom props', () => {
  test('accepts custom table name', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskNudgesTable(stack, 'TaskNudgesTable', { tableName: 'my-nudges' });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'my-nudges',
    });
  });

  test('accepts custom removal policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskNudgesTable(stack, 'TaskNudgesTable', { removalPolicy: RemovalPolicy.RETAIN });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('accepts point-in-time recovery disabled', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskNudgesTable(stack, 'TaskNudgesTable', { pointInTimeRecovery: false });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
  });
});
