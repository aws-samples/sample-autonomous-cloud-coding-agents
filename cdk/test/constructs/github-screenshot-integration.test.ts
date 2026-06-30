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
    // The processor handler swallows its own errors, so an init-time
    // crash (missing env at cold start, bundling defect) would vanish
    // after Lambda's built-in async retries without this queue. Pin its
    // existence and retention so a refactor can't silently drop the
    // backstop.
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 60 * 60, // 14 days
    });
    // enforceSSL renders as a deny-insecure-transport queue policy.
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
    // The processor handler swallows its own errors, so only init-time
    // crashes reach the queue — each one means the screenshot pipeline is
    // silently down. Without the alarm the queue is "for operator
    // inspection" that no operator is ever told to make.
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
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

  test('wires the DLQ as the processor Lambda async-invoke dead-letter target', () => {
    // The queue existing is not enough — it must be bound to the
    // processor function's DeadLetterConfig or failed async invokes
    // still evaporate.
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
    // Receiver (10s) + processor (120s); the bucket may add its own
    // CDK-internal functions, so assert presence rather than count.
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
    // A table carrying the LinearIssueIndex GSI the processor must Query to
    // find the iteration's maturing reply (to append the `· [preview]` link).
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    taskTable.addGlobalSecondaryIndex({
      indexName: 'LinearIssueIndex',
      partitionKey: { name: 'linear_issue_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });

    new GitHubScreenshotIntegration(stack, 'Screenshot', { api, githubTokenSecret, taskTable });
    template = Template.fromStack(stack);
  });

  test('grants dynamodb:Query scoped to the LinearIssueIndex GSI (not a blanket read)', () => {
    // REGRESSION: the preview-link append (findIterationReplyId) Queries
    // LinearIssueIndex, but grantWriteData covers only UpdateItem — without an
    // explicit Query grant the processor hit AccessDenied at runtime and
    // silently logged "no reply id found" (unit-mocked ddb never caught it).
    // Pin a Query statement whose resource ARN names the index.
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
    // REGRESSION (DEM-33 / PR #339, 2026-06-30): findIterationReplyId Queries
    // the GSI (granted above) then GetItems each candidate's head_sha on the
    // BASE table to attribute a deploy to the right iteration (ABCA-438). The
    // Query GSI grant does NOT cover GetItem on the base table, so the read
    // threw AccessDenied, was swallowed non-fatally, and the preview was posted
    // to the PR but never appended to the Linear iteration reply. Pin a GetItem
    // statement whose resource ARN is the base table (no index/ suffix).
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
