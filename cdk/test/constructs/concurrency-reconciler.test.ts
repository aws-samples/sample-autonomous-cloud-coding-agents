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
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
  test('creates a Lambda function', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 300,
    });
  });

  test('creates an EventBridge rule with rate schedule', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
    });
  });

  test('Lambda has correct environment variables', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TASK_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });
});

describe('ConcurrencyReconciler Linear grant probe trigger (#1004)', () => {
  function build(withProbe: boolean): Template {
    const stack = new Stack(new App(), 'ProbeStack');
    const table = (id: string, pk: string) => new dynamodb.Table(stack, id, {
      partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
    });
    const reconciler = new ConcurrencyReconciler(stack, 'ConcurrencyReconciler', {
      taskTable: table('Tasks', 'task_id'),
      userConcurrencyTable: table('Users', 'user_id'),
    });
    const processor = new lambda.Function(stack, 'Processor', {
      runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>{}'),
    });
    if (withProbe) reconciler.triggerLinearGrantProbe(processor);
    return Template.fromStack(stack);
  }

  test('grants invoke and passes the target without adding any resource', () => {
    const without = build(false);
    const template = build(true);
    const types = (t: Template) => Object.entries(t.toJSON().Resources as Record<string, { Type: string }>)
      .map(([id, r]) => `${r.Type} ${id}`).sort();

    expect(types(template)).toEqual(types(without));
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RECONCILER_TICK_MINUTES: '15',
          LINEAR_GRANT_PROBE_FUNCTION_ARN: { 'Fn::GetAtt': [Match.stringLikeRegexp('Processor'), 'Arn'] },
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:InvokeFunction' })]) },
    });
  });
});
