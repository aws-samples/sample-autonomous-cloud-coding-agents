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

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PrOutcomeSweep } from '../../src/constructs/pr-outcome-sweep';
import { TaskEventsTable } from '../../src/constructs/task-events-table';
import { TaskTable } from '../../src/constructs/task-table';

function idOf(template: Template, type: string, prefix: string): string {
  const ids = Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe('PrOutcomeSweep', () => {
  let template: Template;
  let nagFindings: string[];
  let table: string;
  let eventsTable: string;
  let secret: string;
  let fn: string;

  beforeAll(() => {
    const stack = new Stack(new App(), 'TestStack');
    const taskTable = new TaskTable(stack, 'TaskTable');
    const taskEventsTable = new TaskEventsTable(stack, 'TaskEventsTable');
    const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');
    new PrOutcomeSweep(stack, 'PrOutcomeSweep', { taskTable: taskTable.table, taskEventsTable: taskEventsTable.table, githubTokenSecret });
    Aspects.of(stack).add(new AwsSolutionsChecks());

    template = Template.fromStack(stack);
    nagFindings = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-'))
      .filter((finding) => finding.id.startsWith('/TestStack/PrOutcomeSweep/'))
      .map((finding) => `${finding.id}: ${String(finding.entry.data)}`);
    table = idOf(template, 'AWS::DynamoDB::Table', 'TaskTable');
    eventsTable = idOf(template, 'AWS::DynamoDB::Table', 'TaskEventsTable');
    secret = idOf(template, 'AWS::SecretsManager::Secret', 'GitHubTokenSecret');
    fn = idOf(template, 'AWS::Lambda::Function', 'PrOutcomeSweepSweepFn');
  });

  test('adds the function, its role and policy, the rule and its permission, and an alarm on the function\'s errors', () => {
    const types = Object.entries(template.toJSON().Resources as Record<string, { Type: string }>)
      .filter(([id]) => id.startsWith('PrOutcomeSweep'))
      .map(([, resource]) => resource.Type);
    expect(types.sort()).toEqual([
      'AWS::CloudWatch::Alarm',
      'AWS::Events::Rule',
      'AWS::IAM::Policy',
      'AWS::IAM::Role',
      'AWS::Lambda::Function',
      'AWS::Lambda::Permission',
    ]);
  });

  test('runs one function on Node 24 and ARM, with five minutes and 256 MB', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Timeout: 300,
      MemorySize: 256,
    });
  });

  test('runs it once an hour, and does not retry a failed invocation', () => {
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
      Targets: [Match.objectLike({
        Arn: { 'Fn::GetAtt': [fn, 'Arn'] },
        RetryPolicy: { MaximumRetryAttempts: 0 },
      })],
    });
  });

  test('alarms when the function errors, over the hour it runs', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 1,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: fn } }],
    });
  });

  test('tells the handler its two tables, its index, the token secret and its component label, and nothing else', () => {
    expect(template.findResources('AWS::Lambda::Function')[fn].Properties.Environment.Variables).toEqual({
      ABCA_COMPONENT: 'orchestr',
      TASK_TABLE_NAME: { Ref: table },
      TASK_STATUS_INDEX_NAME: 'StatusIndex',
      TASK_EVENTS_TABLE_NAME: { Ref: eventsTable },
      GITHUB_TOKEN_SECRET_ARN: { Ref: secret },
      TASK_RETENTION_DAYS: '90',
    });
  });

  test('may query the status index, update a task, put an event and read the token secret, and nothing else', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    const role = idOf(template, 'AWS::IAM::Role', 'PrOutcomeSweepSweepFnServiceRole');
    expect(policies[0].Properties.Roles).toEqual([{ Ref: role }]);
    expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
      {
        Action: 'dynamodb:Query',
        Effect: 'Allow',
        Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [table, 'Arn'] }, '/index/StatusIndex']] },
      },
      {
        Action: 'dynamodb:UpdateItem',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [table, 'Arn'] },
      },
      {
        Action: 'dynamodb:PutItem',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [eventsTable, 'Arn'] },
      },
      {
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        Effect: 'Allow',
        Resource: { Ref: secret },
      },
    ]);
    expect(template.findResources('AWS::IAM::Role')[role].Properties.ManagedPolicyArns).toEqual([
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']] },
    ]);
  });

  test('leaves cdk-nag nothing to report', () => {
    expect(nagFindings).toEqual([]);
  });
});
