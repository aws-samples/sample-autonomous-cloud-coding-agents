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
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { GitHubScreenshotIntegration } from '../../src/constructs/github-screenshot-integration';

describe('GitHubScreenshotIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubToken');

    new GitHubScreenshotIntegration(stack, 'Screenshot', {
      api,
      githubTokenSecret,
    });

    template = Template.fromStack(stack);
  });

  test('creates the async-invoke DLQ with 14-day retention and SSL enforcement', () => {
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 'sqs:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('alarms on the first record landing in the processor DLQ', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      Dimensions: Match.arrayWith([
        Match.objectLike({
          Name: 'QueueName',
          Value: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('WebhookProcessorDlq')]),
          }),
        }),
      ]),
    });
  });

  test('alarms on the processor Lambda Errors metric (>=1 in 5min, 2 eval periods)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 2,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
      Dimensions: Match.arrayWith([
        Match.objectLike({
          Name: 'FunctionName',
          Value: Match.objectLike({
            Ref: Match.stringLikeRegexp('WebhookProcessorFn'),
          }),
        }),
      ]),
    });
  });

  test('wires the DLQ as the processor Lambda async-invoke dead-letter target', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Timeout: 120,
      DeadLetterConfig: {
        TargetArn: Match.objectLike({
          'Fn::GetAtt': Match.arrayWith([
            Match.stringLikeRegexp('WebhookProcessorDlq'),
          ]),
        }),
      },
    });
  });

  test('creates receiver and processor Lambdas plus the POST /github/webhook route', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 10 });
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 120 });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'github' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'webhook' });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
  });

  test('creates the webhook dedup table with TTL and PITR', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe('GitHubScreenshotIntegration — task-table grants (iteration-UX)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TaskTableStack');
    const api = new apigw.RestApi(stack, 'TestApi');
    const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubToken');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    taskTable.addGlobalSecondaryIndex({
      indexName: 'LinearIssueIndex',
      partitionKey: { name: 'linear_issue_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });

    const linearWorkspaceRegistryTable = dynamodb.Table.fromTableName(stack, 'LinearRegistry', 'LinearRegistry');
    new GitHubScreenshotIntegration(stack, 'Screenshot', { api, githubTokenSecret, taskTable, linearWorkspaceRegistryTable });
    template = Template.fromStack(stack);
  });

  test('grants dynamodb:Query scoped to the LinearIssueIndex GSI (not a blanket read)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'dynamodb:Query',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('index/LinearIssueIndex')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  test('grants dynamodb:GetItem on the TaskTable base ARN (head_sha attribution read)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'dynamodb:GetItem',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('table/')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });
});

describe('GitHubScreenshotIntegration without a tracker', () => {
  test('grants no issue-index Query, but keeps the base-table GetItem', () => {
    const stack = new Stack(new App(), 'ScreenshotsOnly');
    new GitHubScreenshotIntegration(stack, 'Screenshots', {
      api: new apigw.RestApi(stack, 'Api'),
      githubTokenSecret: new secretsmanager.Secret(stack, 'Token'),
      taskTable: dynamodb.Table.fromTableName(stack, 'Tasks', 'Tasks'),
    });
    const text = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(text).not.toContain('/index/LinearIssueIndex');
    expect(text).not.toContain('/index/JiraIssueIndex');
    expect(text).toContain('dynamodb:GetItem');
  });
});

describe('Jira screenshot delivery wiring', () => {
  let template: Template;
  beforeAll(() => {
    const stack = new Stack(new App(), 'JiraScreenshots');
    new GitHubScreenshotIntegration(stack, 'Screenshots', {
      api: new apigw.RestApi(stack, 'Api'),
      githubTokenSecret: new secretsmanager.Secret(stack, 'Token'),
      taskTable: dynamodb.Table.fromTableName(stack, 'Tasks', 'Tasks'),
      jiraWorkspaceRegistryTable: dynamodb.Table.fromTableName(stack, 'Jira', 'JiraRegistry'),
    });
    template = Template.fromStack(stack);
  });
  test('configures the registry and scoped Jira index/OAuth grants', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ JIRA_WORKSPACE_REGISTRY_TABLE_NAME: 'JiraRegistry' }) },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('Tasks/index/JiraIssueIndex');
    expect(policies).toContain('bgagent-jira-oauth-*');
    expect(policies).toContain('secretsmanager:PutSecretValue');
  });
});
