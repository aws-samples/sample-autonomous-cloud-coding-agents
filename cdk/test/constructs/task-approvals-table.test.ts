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
import { TaskApprovalsTable, USER_STATUS_INDEX_NAME } from '../../src/constructs/task-approvals-table';

describe('TaskApprovalsTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with task_id PK and request_id SK', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'task_id', KeyType: 'HASH' },
        { AttributeName: 'request_id', KeyType: 'RANGE' },
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

  test('uses ttl attribute for row expiry', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('does NOT enable DynamoDB streams (§11.2)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });

  test('creates user_id-status-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: USER_STATUS_INDEX_NAME,
          KeySchema: [
            { AttributeName: 'user_id', KeyType: 'HASH' },
            { AttributeName: 'status', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: Match.arrayWith([
              'task_id',
              'request_id',
              'tool_name',
              'tool_input_preview',
              'severity',
              'reason',
              'created_at',
              'timeout_s',
              'matching_rule_ids',
            ]),
          },
        }),
      ]),
    });
  });

  test('GSI does not include deny-sensitive attributes', () => {
    const tableResource = template.findResources('AWS::DynamoDB::Table');
    const tableProps = Object.values(tableResource)[0].Properties;
    const gsi = tableProps.GlobalSecondaryIndexes.find(
      (index: { IndexName: string }) => index.IndexName === USER_STATUS_INDEX_NAME,
    );
    expect(gsi.Projection.NonKeyAttributes).not.toContain('deny_reason');
    expect(gsi.Projection.NonKeyAttributes).not.toContain('scope');
    expect(gsi.Projection.NonKeyAttributes).not.toContain('tool_input_sha256');
  });

  test('exposes the GSI name via an exported constant', () => {
    expect(USER_STATUS_INDEX_NAME).toBe('user_id-status-index');
  });

  test('sets DESTROY removal policy by default', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('removal policy can be overridden to RETAIN', () => {
    const app = new App();
    const stack = new Stack(app, 'RetainStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable', {
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const retainTemplate = Template.fromStack(stack);
    retainTemplate.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('point-in-time recovery can be disabled via props', () => {
    const app = new App();
    const stack = new Stack(app, 'NoPitrStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable', {
      pointInTimeRecovery: false,
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
  });

  test('exposes the userStatusIndexName field on the construct', () => {
    const app = new App();
    const stack = new Stack(app, 'FieldStack');
    const approvals = new TaskApprovalsTable(stack, 'TaskApprovalsTable');
    expect(approvals.userStatusIndexName).toBe(USER_STATUS_INDEX_NAME);
  });
});
