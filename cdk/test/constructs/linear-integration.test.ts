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

  test('creates three DynamoDB tables (project mapping + user mapping + dedup)', () => {
    // TaskTable + TaskEventsTable + LinearProjectMapping + LinearUserMapping + LinearWebhookDedup = 5
    template.resourceCountIs('AWS::DynamoDB::Table', 5);
  });

  test('creates three Lambda functions (webhook, processor, link)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('creates API Gateway resources under /linear', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'linear' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'webhook' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'link' });
  });

  test('creates two Secrets Manager secrets (webhook + API token)', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Linear webhook signing secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Linear personal API token'),
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

  test('processor handler env wires both mapping tables + task table', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LINEAR_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
          LINEAR_USER_MAPPING_TABLE_NAME: Match.anyValue(),
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
