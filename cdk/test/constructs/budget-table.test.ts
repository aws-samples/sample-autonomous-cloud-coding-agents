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
import { Template } from 'aws-cdk-lib/assertions';
import { BudgetTable } from '../../src/constructs/budget-table';

describe('BudgetTable', () => {
  test('uses the scope/month composite key with TTL, PITR, and a config index', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new BudgetTable(stack, 'BudgetTable');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'scope_key', KeyType: 'HASH' },
        { AttributeName: 'period', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'scope_key', AttributeType: 'S' },
        { AttributeName: 'period', AttributeType: 'S' },
        { AttributeName: 'record_type', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      GlobalSecondaryIndexes: [{
        IndexName: 'record_type-scope_key-index',
        KeySchema: [
          { AttributeName: 'record_type', KeyType: 'HASH' },
          { AttributeName: 'scope_key', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
    });
  });

  test('supports custom lifecycle settings', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new BudgetTable(stack, 'BudgetTable', {
      tableName: 'budgets',
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: false,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'budgets',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});
