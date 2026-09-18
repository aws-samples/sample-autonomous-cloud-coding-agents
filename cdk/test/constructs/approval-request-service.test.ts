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
import * as iam from 'aws-cdk-lib/aws-iam';
import { ApprovalRequestService } from '../../src/constructs/approval-request-service';

let root: Template;
let child: Template;
beforeAll(() => {
  const stack = new Stack(new App(), 'ApprovalFixture', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });
  const service = new ApprovalRequestService(stack, 'ApprovalRequests', {
    taskTable: table('Tasks'), approvalsTable: table('Approvals'),
  });
  const worker = new iam.Role(stack, 'WorkerSession', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  service.grantRequests(worker);
  root = Template.fromStack(stack);
  child = Template.fromStack(service);
});

test('requires IAM authentication on the only writable endpoint', () => {
  child.resourceCountIs('AWS::ApiGateway::Method', 1);
  child.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST', AuthorizationType: 'AWS_IAM',
  });
});

test('binds invocation to the session task tag and grants no direct Lambda invocation', () => {
  const statements = Object.values(root.findResources('AWS::IAM::Policy'))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  expect(statements).toHaveLength(1);
  expect(statements[0].Action).toBe('execute-api:Invoke');
  expect(JSON.stringify(statements[0].Resource)).toContain('/v1/POST/tasks/${aws:PrincipalTag/task_id}');
  expect(statements[0].Condition).toEqual({ Null: { 'aws:PrincipalTag/task_id': 'false' } });
});

test('keeps the trusted writer and API infrastructure out of the parent resource budget', () => {
  root.resourceCountIs('AWS::Lambda::Function', 0);
  child.resourceCountIs('AWS::Lambda::Function', 1);
  child.resourceCountIs('AWS::DynamoDB::Table', 0);
});
