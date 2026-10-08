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
import { ConcurrencyReconciler } from '../../src/constructs/concurrency-reconciler';

function createStack(): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });

  const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
    partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  });

  new ConcurrencyReconciler(stack, 'ConcurrencyReconciler', {
    taskTable,
    userConcurrencyTable,
  });

  return Template.fromStack(stack);
}

describe('ConcurrencyReconciler construct', () => {
  let template: Template;
  beforeAll(() => { template = createStack(); });

  test('creates a Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 300,
    });
  });

  test('creates an EventBridge rule with rate schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
    });
  });

  test('Lambda has correct environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('can read reservations and update their markers without deleting or creating tasks', () => {
    const tableId = Object.keys(template.findResources('AWS::DynamoDB::Table')).find(id => id.startsWith('TaskTable'))!;
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement)
      .filter(statement => JSON.stringify(statement.Resource).includes(tableId));
    const actions = statements.flatMap(statement => [statement.Action].flat());
    expect(actions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']));
    expect(actions).not.toEqual(expect.arrayContaining(['dynamodb:PutItem']));
    expect(actions).not.toEqual(expect.arrayContaining(['dynamodb:DeleteItem']));
  });
});
