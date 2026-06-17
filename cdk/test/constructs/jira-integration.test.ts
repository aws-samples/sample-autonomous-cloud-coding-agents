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
import { JiraIntegration } from '../../src/constructs/jira-integration';

describe('JiraIntegration construct', () => {
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

    new JiraIntegration(stack, 'JiraIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates one Secrets Manager secret (webhook signing) — OAuth tokens are CLI-created at runtime', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Jira webhook signing secret'),
    });
  });

  // #368: the webhook secret MUST seed an explicit JSON placeholder so the CLI
  // can distinguish "never configured" from an operator-set value. A bare
  // generated string (CDK's default with no GenerateSecretString) caused
  // `bgagent jira setup` to skip seeding, leaving every admin-UI webhook
  // delivery to fail HMAC verification with 401.
  test('webhook secret seeds a JSON placeholder carrying the explicit marker key (#368)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        // secretStringTemplate is the JSON object carrying the marker key.
        SecretStringTemplate: Match.stringLikeRegexp('abca_jira_webhook_placeholder'),
        GenerateStringKey: 'value',
      }),
    });
  });
});
