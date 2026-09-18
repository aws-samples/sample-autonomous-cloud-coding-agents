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
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ContinuationBucket } from '../../src/constructs/continuation-bucket';
import { MicrovmContinuationManager } from '../../src/constructs/microvm-continuation-manager';
import { TaskApi } from '../../src/constructs/task-api';

test('scheduled recovery and decisions invoke retained versions of only the original coordinator', () => {
  const stack = new Stack(new App(), 'Continuations');
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });
  const taskTable = table('Tasks');
  const approvalsTable = table('Approvals');
  const userConcurrencyTable = table('Counters');
  const bucket = new ContinuationBucket(stack, 'Saved');
  const coordinator = 'arn:aws:lambda:us-west-2:123456789012:function:coordinator';
  const imageArn = 'arn:aws:lambda:us-west-2:123456789012:microvm-image:agent';
  new MicrovmContinuationManager(stack, 'Manager', {
    taskTable,
    approvalsTable,
    userConcurrencyTable,
    continuationBucket: bucket,
    orchestratorFunctionArn: coordinator,
    imageArn,
  });
  const api = new TaskApi(stack, 'Api', { taskTable, taskEventsTable: table('Events'), taskApprovalsTable: approvalsTable });
  api.enableMicrovmContinuations(bucket.bucket.bucketName, coordinator, userConcurrencyTable);
  const template = Template.fromStack(stack);
  const policies = Object.entries(template.findResources('AWS::IAM::Policy'));
  for (const name of ['ManagerReconcilerFn', 'ApproveTaskFn', 'DenyTaskFn']) {
    const statements = policies.filter(([id]) => id.includes(name))
      .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
    expect(statements).toContainEqual(expect.objectContaining({
      Action: 'lambda:InvokeFunction', Resource: `${coordinator}:*`,
    }));
    expect(statements.some(statement => JSON.stringify(statement.Action).includes('RunMicrovm'))).toBe(false);
  }
  const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
  for (const name of ['ManagerReconcilerFn', 'ApproveTaskFn', 'DenyTaskFn']) {
    const fn = functions.find(([id]) => id.includes(name))![1];
    expect(fn.Properties.Environment.Variables.ORCHESTRATOR_FUNCTION_ARN).toBe(coordinator);
    expect(fn.Properties.Environment.Variables.CONTINUATION_BUCKET_NAME).toBeDefined();
  }
});
