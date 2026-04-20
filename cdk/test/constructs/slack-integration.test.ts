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
import { SlackIntegration } from '../../src/constructs/slack-integration';

describe('SlackIntegration construct', () => {
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
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    new SlackIntegration(stack, 'SlackIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates two DynamoDB tables (installation + user mapping)', () => {
    // TaskTable + TaskEventsTable + SlackInstallation + SlackUserMapping = 4
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
  });

  test('creates 7 Lambda functions', () => {
    // oauth-callback, events, commands, command-processor, link, notify, interactions
    template.resourceCountIs('AWS::Lambda::Function', 7);
  });

  test('creates API Gateway resources under /slack', () => {
    // Verify /slack/* routes exist
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'slack',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'commands',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'events',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'link',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'interactions',
    });
  });

  test('slash command handler has 3-second timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 3,
      Environment: {
        Variables: Match.objectLike({
          SLACK_SIGNING_SECRET_ARN: Match.anyValue(),
          SLACK_COMMAND_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('notification handler has DynamoDB Streams event source', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: Match.anyValue(),
      StartingPosition: 'LATEST',
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 0,
      MaximumRetryAttempts: 3,
      BisectBatchOnFunctionError: true,
    });
  });

  test('creates 3 Secrets Manager secrets for Slack App credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('signing secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client ID'),
    });
  });

  test('OAuth callback has Secrets Manager permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:CreateSecret',
            Effect: 'Allow',
            Condition: {
              StringLike: { 'secretsmanager:Name': 'bgagent/slack/*' },
            },
          }),
        ]),
      },
    });
  });
});
