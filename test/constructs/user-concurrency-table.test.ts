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
import { UserConcurrencyTable } from '../../src/constructs/user-concurrency-table';

describe('UserConcurrencyTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new UserConcurrencyTable(stack, 'UserConcurrencyTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with user_id as partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'user_id', KeyType: 'HASH' },
      ],
    });
  });

  test('uses PAY_PER_REQUEST billing mode', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('does not enable point-in-time recovery', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: Match.absent(),
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

  test('declares exactly one attribute definition', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: [
        { AttributeName: 'user_id', AttributeType: 'S' },
      ],
    });
  });
});

describe('UserConcurrencyTable with custom props', () => {
  test('accepts custom table name', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new UserConcurrencyTable(stack, 'UserConcurrencyTable', { tableName: 'my-concurrency' });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'my-concurrency',
    });
  });

  test('accepts custom removal policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new UserConcurrencyTable(stack, 'UserConcurrencyTable', { removalPolicy: RemovalPolicy.RETAIN });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});
