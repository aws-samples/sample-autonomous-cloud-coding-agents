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

// SPDX-License-Identifier: MIT-0

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { TaskApi } from '../../src/constructs/task-api';

const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:agent';
let configured: Template;
let unconfigured: Template;
function fixture(imageArn?: string): Template {
  const stack = new Stack(new App(), 'ApiTest');
  const table = (id: string, sortKey?: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    ...(sortKey && { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } }),
  });
  new TaskApi(stack, 'Api', {
    taskTable: table('Tasks'),
    taskEventsTable: table('Events', 'event_id'),
    taskApprovalsTable: table('Approvals', 'request_id'),
    lambdaMicrovmImageArn: imageArn,
  });
  return Template.fromStack(stack);
}
type Statement = { Action: string | string[]; Resource: unknown };
function grants(template: Template, functionName: string): Statement[] {
  return Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.includes(functionName))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as Statement[])
    .filter(statement => JSON.stringify(statement.Action).includes('Microvm'));
}
beforeAll(() => {
  configured = fixture(IMAGE_ARN);
  unconfigured = fixture();
});

test.each(['ApproveTaskFn', 'DenyTaskFn'])('%s gets only Get/Resume against this image', name => {
  expect(grants(configured, name)).toEqual([expect.objectContaining({
    Action: ['lambda:GetMicrovm', 'lambda:ResumeMicrovm'],
    Resource: [IMAGE_ARN, `${IMAGE_ARN}:*`],
  })]);
});

test('cancel keeps only Terminate against the same image', () => {
  expect(grants(configured, 'CancelTaskFn')).toEqual([expect.objectContaining({
    Action: 'lambda:TerminateMicrovm', Resource: [IMAGE_ARN, `${IMAGE_ARN}:*`],
  })]);
});

test.each(['ApproveTaskFn', 'DenyTaskFn', 'CancelTaskFn'])('%s gets no lifecycle grant without an image', name => {
  expect(grants(unconfigured, name)).toEqual([]);
});

test('the decision APIs keep their15s Lambda budget and read worker IDs from saved task metadata', () => {
  const functions = Object.entries(configured.findResources('AWS::Lambda::Function'))
    .filter(([id]) => id.includes('ApproveTaskFn') || id.includes('DenyTaskFn'));
  expect(functions).toHaveLength(2);
  for (const [, resource] of functions) {
    expect(resource.Properties.Timeout).toBe(15);
    expect(resource.Properties.Environment.Variables.MICROVM_IMAGE_IDENTIFIER).toBeUndefined();
  }
});

test('cancellation and pending listing receive their approval workflow permissions', () => {
  const functions = configured.findResources('AWS::Lambda::Function');
  const cancel = Object.entries(functions).find(([id]) => id.includes('CancelTaskFn'))![1];
  expect(cancel.Properties.Environment.Variables.TASK_APPROVALS_TABLE_NAME).toBeDefined();
  const policies = Object.entries(configured.findResources('AWS::IAM::Policy'));
  const cancelPolicy = policies.find(([id]) => id.includes('CancelTaskFn'))![1];
  expect(cancelPolicy.Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining([
    expect.objectContaining({
      Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      Resource: expect.arrayContaining([expect.objectContaining({ 'Fn::GetAtt': expect.arrayContaining([expect.stringContaining('Approvals')]) })]),
    }),
  ]));
  const pendingPolicy = policies.find(([id]) => id.includes('GetPendingFn'))![1];
  expect(pendingPolicy.Properties.PolicyDocument.Statement).toEqual(expect.arrayContaining([
    expect.objectContaining({
      Action: 'dynamodb:BatchGetItem',
      Resource: expect.arrayContaining([expect.objectContaining({ 'Fn::GetAtt': expect.arrayContaining([expect.stringContaining('Tasks')]) })]),
    }),
  ]));
});
