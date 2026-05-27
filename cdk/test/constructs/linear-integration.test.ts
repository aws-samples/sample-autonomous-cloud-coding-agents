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
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { LinearIntegration } from '../../src/constructs/linear-integration';

describe('LinearIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });

    new LinearIntegration(stack, 'LinearIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates four Linear DynamoDB tables (project mapping + user mapping + workspace registry + dedup)', () => {
    // TaskTable + TaskEventsTable + LinearProjectMapping + LinearUserMapping
    // + LinearWorkspaceRegistry + LinearWebhookDedup = 6
    template.resourceCountIs('AWS::DynamoDB::Table', 6);
  });

  test('workspace registry table is keyed on linear_workspace_id', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'linear_workspace_id', KeyType: 'HASH' }],
    });
  });

  test('creates three Lambda functions (webhook, processor, link)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('creates API Gateway resources under /linear', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'linear' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'webhook' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'link' });
  });

  test('creates one Secrets Manager secret (webhook signing) — OAuth tokens are CLI-created at runtime', () => {
    // Phase 2.0b-O2: per-workspace OAuth tokens live in
    // `bgagent-linear-oauth-<slug>` secrets created by `bgagent linear setup`,
    // NOT by CDK. Only the webhook signing secret is CDK-managed.
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Linear webhook signing secret'),
    });
  });

  test('has NO DynamoDB Streams event-source mapping (outbound goes through MCP)', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('webhook handler env wires dedup table + processor + secret ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LINEAR_WEBHOOK_SECRET_ARN: Match.anyValue(),
          LINEAR_WEBHOOK_DEDUP_TABLE_NAME: Match.anyValue(),
          LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processor handler env wires all mapping tables + task table + workspace registry', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LINEAR_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
          LINEAR_USER_MAPPING_TABLE_NAME: Match.anyValue(),
          LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: Match.anyValue(),
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('webhook dedup table has TTL attribute for 60s expiry', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });
});

describe('LinearIntegration construct — attachmentsBucket wiring', () => {
  // Regression-guard: webhook processor needs ATTACHMENTS_BUCKET_NAME and S3
  // Put/Delete on the bucket so `extractImageUrlAttachments` can reach the
  // bucket via createTaskCore. Without this, Linear-triggered tasks with
  // markdown image attachments fail with 503 ("Attachment storage is not
  // configured.") — the symptom that bit `linear-vercel` 2026-05-27.
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const attachmentsBucket = new s3.Bucket(stack, 'AttachmentsBucket');

    new LinearIntegration(stack, 'LinearIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
      attachmentsBucket,
    });

    template = Template.fromStack(stack);
  });

  test('processor env includes ATTACHMENTS_BUCKET_NAME when bucket provided', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ATTACHMENTS_BUCKET_NAME: Match.anyValue(),
          LINEAR_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processor role can PutObject and DeleteObject on the attachments bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 's3:DeleteObject*',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
